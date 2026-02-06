import type {
  OnboardingActionType,
  OnboardingErrorCategory,
  OnboardingErrorCode,
  OnboardingState,
  OnboardingStateSnapshot,
  OnboardingStepDefinition,
  OnboardingStepError,
  OnboardingStepSnapshot,
  OnboardingStepStatus,
  OnboardingTransitionResult,
} from './types.js';

// Minimal SWARM-012-compatible step contract for SWARM-013 orchestrator bootstrap.
// Follow-up: replace with shared SWARM-012 contract helper once it is available in this branch.
const STEP_DEFINITIONS: ReadonlyArray<OnboardingStepDefinition> = [
  { stepId: 'connect_wallet', order: 1, optional: false },
  { stepId: 'connect_telegram', order: 2, optional: false },
  { stepId: 'configure_persona', order: 3, optional: false },
  { stepId: 'connect_discord', order: 4, optional: true },
  { stepId: 'activate_avatar', order: 5, optional: false },
];

export class OnboardingTransitionError extends Error {
  readonly code: OnboardingErrorCode;
  readonly category: OnboardingErrorCategory;
  readonly retryable: boolean;
  readonly statusCode: number;
  readonly details: Record<string, unknown> | null;

  constructor(params: {
    code: OnboardingErrorCode;
    category: OnboardingErrorCategory;
    message: string;
    retryable: boolean;
    statusCode: number;
    details?: Record<string, unknown> | null;
  }) {
    super(params.message);
    this.name = 'OnboardingTransitionError';
    this.code = params.code;
    this.category = params.category;
    this.retryable = params.retryable;
    this.statusCode = params.statusCode;
    this.details = params.details ?? null;
  }
}

export function getOnboardingStepDefinitions(): OnboardingStepDefinition[] {
  return STEP_DEFINITIONS.map(definition => ({ ...definition }));
}

export function createEmptyStepError(): OnboardingStepError {
  return {
    code: null,
    category: null,
    message: null,
    retryable: null,
  };
}

function isValidStepStatus(status: unknown): status is OnboardingStepStatus {
  return status === 'pending'
    || status === 'in_progress'
    || status === 'completed'
    || status === 'failed'
    || status === 'skipped'
    || status === 'blocked';
}

function isTerminalStepStatus(status: OnboardingStepStatus): boolean {
  return status === 'completed' || status === 'skipped';
}

function cloneStep(step: OnboardingStepSnapshot): OnboardingStepSnapshot {
  return {
    ...step,
    lastError: { ...step.lastError },
  };
}

function cloneSnapshot(snapshot: OnboardingStateSnapshot): OnboardingStateSnapshot {
  return {
    ...snapshot,
    steps: snapshot.steps.map(cloneStep),
  };
}

function deriveNextStepId(steps: OnboardingStepSnapshot[]): string | null {
  const next = steps.find(step => !isTerminalStepStatus(step.status));
  return next?.stepId ?? null;
}

function deriveState(steps: OnboardingStepSnapshot[], revision: number, preferred: OnboardingState): OnboardingState {
  const hasActive = steps.some(step => !isTerminalStepStatus(step.status));
  if (!hasActive) return 'completed';

  if (preferred === 'blocked') {
    return 'blocked';
  }

  const allPending = steps.every(step => step.status === 'pending');
  if (allPending && revision === 0 && preferred === 'not_started') {
    return 'not_started';
  }

  return 'in_progress';
}

function normalizeStepError(error: unknown): OnboardingStepError {
  if (!error || typeof error !== 'object') {
    return createEmptyStepError();
  }

  const value = error as Partial<OnboardingStepError>;
  const category = value.category === 'validation'
    || value.category === 'transient'
    || value.category === 'dependency'
    || value.category === 'auth'
    || value.category === 'configuration'
    ? value.category
    : null;

  return {
    code: typeof value.code === 'string' ? value.code : null,
    category,
    message: typeof value.message === 'string' ? value.message : null,
    retryable: typeof value.retryable === 'boolean' ? value.retryable : null,
  };
}

function normalizeStep(definition: OnboardingStepDefinition, stored: OnboardingStepSnapshot | undefined): OnboardingStepSnapshot {
  const status = stored && isValidStepStatus(stored.status)
    ? stored.status
    : 'pending';

  return {
    stepId: definition.stepId,
    order: definition.order,
    optional: definition.optional,
    status,
    attemptCount: stored && Number.isInteger(stored.attemptCount) && stored.attemptCount >= 0
      ? stored.attemptCount
      : 0,
    retryable: Boolean(stored?.retryable),
    nextRetryAt: typeof stored?.nextRetryAt === 'number' ? stored.nextRetryAt : null,
    lastError: normalizeStepError(stored?.lastError),
  };
}

export function createInitialOnboardingState(now: number): OnboardingStateSnapshot {
  return {
    state: 'not_started',
    currentStepId: STEP_DEFINITIONS[0]?.stepId ?? null,
    revision: 0,
    updatedAt: now,
    steps: STEP_DEFINITIONS.map(definition => normalizeStep(definition, undefined)),
  };
}

export function normalizeOnboardingStateSnapshot(
  snapshot: Partial<OnboardingStateSnapshot> | null | undefined,
  now: number
): OnboardingStateSnapshot {
  if (!snapshot) {
    return createInitialOnboardingState(now);
  }

  const storedSteps = Array.isArray(snapshot.steps)
    ? snapshot.steps
    : [];

  const stepsById = new Map(storedSteps.map(step => [step.stepId, step]));
  const normalizedSteps = STEP_DEFINITIONS.map(definition => normalizeStep(definition, stepsById.get(definition.stepId)));

  const revision = Number.isInteger(snapshot.revision) && (snapshot.revision ?? 0) >= 0
    ? snapshot.revision as number
    : 0;

  const preferredState = snapshot.state === 'not_started'
    || snapshot.state === 'in_progress'
    || snapshot.state === 'blocked'
    || snapshot.state === 'completed'
    ? snapshot.state
    : 'not_started';

  const derivedState = deriveState(normalizedSteps, revision, preferredState);
  const derivedCurrentStepId = deriveNextStepId(normalizedSteps);

  if (derivedState === 'in_progress' && derivedCurrentStepId) {
    const current = normalizedSteps.find(step => step.stepId === derivedCurrentStepId);
    if (current && current.status === 'pending') {
      current.status = 'in_progress';
    }
  }

  if (derivedState === 'not_started') {
    for (const step of normalizedSteps) {
      step.status = 'pending';
      step.attemptCount = 0;
      step.retryable = false;
      step.nextRetryAt = null;
      step.lastError = createEmptyStepError();
    }
  }

  return {
    state: derivedState,
    currentStepId: derivedState === 'completed' ? null : derivedCurrentStepId,
    revision,
    updatedAt: typeof snapshot.updatedAt === 'number' ? snapshot.updatedAt : now,
    steps: normalizedSteps,
  };
}

function ensureCurrentStep(snapshot: OnboardingStateSnapshot, stepId: string): void {
  if (snapshot.state === 'completed') {
    throw new OnboardingTransitionError({
      code: 'invalid_state_transition',
      category: 'validation',
      message: 'Onboarding is already completed.',
      retryable: false,
      statusCode: 409,
      details: {
        currentState: snapshot.state,
        expectedStates: ['in_progress', 'not_started'],
      },
    });
  }

  const currentStepId = snapshot.currentStepId;
  if (!currentStepId || currentStepId !== stepId) {
    throw new OnboardingTransitionError({
      code: 'invalid_state_transition',
      category: 'validation',
      message: 'Step cannot be executed from current state.',
      retryable: false,
      statusCode: 409,
      details: {
        currentState: snapshot.state,
        currentStepId,
        requestedStepId: stepId,
      },
    });
  }
}

function applyProgress(snapshot: OnboardingStateSnapshot, now: number): OnboardingStateSnapshot {
  const nextSnapshot = cloneSnapshot(snapshot);
  nextSnapshot.currentStepId = deriveNextStepId(nextSnapshot.steps);

  if (!nextSnapshot.currentStepId) {
    nextSnapshot.state = 'completed';
  } else {
    nextSnapshot.state = 'in_progress';
    const current = nextSnapshot.steps.find(step => step.stepId === nextSnapshot.currentStepId);
    if (current && current.status === 'pending') {
      current.status = 'in_progress';
    }
  }

  nextSnapshot.updatedAt = now;
  return nextSnapshot;
}

function getStepOrThrow(snapshot: OnboardingStateSnapshot, stepId: string): OnboardingStepSnapshot {
  const step = snapshot.steps.find(candidate => candidate.stepId === stepId);
  if (!step) {
    throw new OnboardingTransitionError({
      code: 'step_not_found',
      category: 'validation',
      message: `Unknown onboarding step: ${stepId}`,
      retryable: false,
      statusCode: 404,
      details: { stepId },
    });
  }
  return step;
}

export function executeStepTransition(
  sourceSnapshot: OnboardingStateSnapshot,
  stepId: string,
  now: number
): OnboardingTransitionResult {
  const step = getStepOrThrow(sourceSnapshot, stepId);

  if (step.status === 'completed' || step.status === 'skipped') {
    return {
      snapshot: cloneSnapshot(sourceSnapshot),
      actionResult: 'no_op',
      reasonCode: 'already_terminal',
    };
  }

  ensureCurrentStep(sourceSnapshot, stepId);

  const snapshot = cloneSnapshot(sourceSnapshot);
  if (snapshot.state === 'not_started') {
    snapshot.state = 'in_progress';
  }

  const currentStep = getStepOrThrow(snapshot, stepId);
  currentStep.status = 'completed';
  currentStep.attemptCount += 1;
  currentStep.retryable = false;
  currentStep.nextRetryAt = null;
  currentStep.lastError = createEmptyStepError();

  snapshot.revision += 1;

  return {
    snapshot: applyProgress(snapshot, now),
    actionResult: 'applied',
    reasonCode: null,
  };
}

export function skipOptionalStepTransition(
  sourceSnapshot: OnboardingStateSnapshot,
  stepId: string,
  now: number
): OnboardingTransitionResult {
  const step = getStepOrThrow(sourceSnapshot, stepId);

  if (!step.optional) {
    throw new OnboardingTransitionError({
      code: 'step_not_optional',
      category: 'validation',
      message: 'Only optional steps can be skipped.',
      retryable: false,
      statusCode: 422,
      details: { stepId },
    });
  }

  if (step.status === 'completed' || step.status === 'skipped') {
    return {
      snapshot: cloneSnapshot(sourceSnapshot),
      actionResult: 'no_op',
      reasonCode: 'already_terminal',
    };
  }

  ensureCurrentStep(sourceSnapshot, stepId);

  const snapshot = cloneSnapshot(sourceSnapshot);
  if (snapshot.state === 'not_started') {
    snapshot.state = 'in_progress';
  }

  const currentStep = getStepOrThrow(snapshot, stepId);
  currentStep.status = 'skipped';
  currentStep.retryable = false;
  currentStep.nextRetryAt = null;
  currentStep.lastError = createEmptyStepError();

  snapshot.revision += 1;

  return {
    snapshot: applyProgress(snapshot, now),
    actionResult: 'applied',
    reasonCode: null,
  };
}

function isInitialState(snapshot: OnboardingStateSnapshot): boolean {
  if (snapshot.state !== 'not_started') {
    return false;
  }

  if (snapshot.currentStepId !== (STEP_DEFINITIONS[0]?.stepId ?? null)) {
    return false;
  }

  return snapshot.steps.every(step => (
    step.status === 'pending'
    && step.attemptCount === 0
    && step.retryable === false
    && step.nextRetryAt === null
    && step.lastError.code === null
    && step.lastError.category === null
    && step.lastError.message === null
    && step.lastError.retryable === null
  ));
}

export function restartTransition(
  sourceSnapshot: OnboardingStateSnapshot,
  now: number
): OnboardingTransitionResult {
  if (isInitialState(sourceSnapshot)) {
    return {
      snapshot: cloneSnapshot(sourceSnapshot),
      actionResult: 'no_op',
      reasonCode: 'already_initial_state',
    };
  }

  const restarted = createInitialOnboardingState(now);
  restarted.revision = sourceSnapshot.revision + 1;

  return {
    snapshot: restarted,
    actionResult: 'applied',
    reasonCode: null,
  };
}

export function computeAllowedActions(snapshot: OnboardingStateSnapshot): OnboardingActionType[] {
  if (snapshot.state === 'completed') {
    return ['restart'];
  }

  const actions: OnboardingActionType[] = ['execute_step'];
  const currentStep = snapshot.currentStepId
    ? snapshot.steps.find(step => step.stepId === snapshot.currentStepId)
    : null;

  if (currentStep?.optional) {
    actions.push('skip_optional');
  }

  actions.push('restart');

  if (snapshot.state === 'blocked' && currentStep && !currentStep.retryable) {
    return currentStep.optional ? ['skip_optional', 'restart'] : ['restart'];
  }

  return actions;
}
