export const ONBOARDING_CONTRACT_VERSION_V1 = 'onboarding_contract_v1' as const;

export type OnboardingContractVersion = typeof ONBOARDING_CONTRACT_VERSION_V1;

export const ONBOARDING_STATES_V1 = [
  'not_started',
  'auth_pending',
  'profile_pending',
  'integration_pending',
  'readiness_pending',
  'ready_to_activate',
  'blocked',
  'completed',
  'cancelled',
] as const;

export type OnboardingState = typeof ONBOARDING_STATES_V1[number];

export const ONBOARDING_TERMINAL_STATES_V1 = ['completed', 'cancelled'] as const;

export type OnboardingTerminalState = typeof ONBOARDING_TERMINAL_STATES_V1[number];

export type OnboardingNonTerminalState = Exclude<OnboardingState, OnboardingTerminalState>;

export const ONBOARDING_RESUMABLE_STATES_V1 = [
  'auth_pending',
  'profile_pending',
  'integration_pending',
  'readiness_pending',
  'ready_to_activate',
] as const;

export type OnboardingResumableState = typeof ONBOARDING_RESUMABLE_STATES_V1[number];

export const ONBOARDING_EVENTS_V1 = [
  'start_onboarding',
  'auth_verified',
  'profile_saved',
  'integration_verified',
  'skip_optional_integration',
  'readiness_verified',
  'activation_succeeded',
  'block_transition',
  'resolve_blocker',
  'restart_onboarding',
  'cancel_onboarding',
] as const;

export type OnboardingEvent = typeof ONBOARDING_EVENTS_V1[number];

export const ONBOARDING_GUARDS_V1 = [
  'actor_authorized',
  'event_allowed_in_state',
  'idempotency_key_consistent',
  'required_prerequisites_complete',
  'step_is_optional',
  'blocker_is_resolved',
  'resume_target_present',
  'readiness_checks_passed',
  'activation_not_already_completed',
  'failure_is_non_retryable',
] as const;

export type OnboardingGuard = typeof ONBOARDING_GUARDS_V1[number];

export type OnboardingTransitionTarget = OnboardingState | 'resume_target_state';

export interface OnboardingTransitionDefinition {
  readonly from_state: OnboardingState;
  readonly event: OnboardingEvent;
  readonly to_state: OnboardingTransitionTarget;
  readonly guards: readonly OnboardingGuard[];
}

const BASE_MUTATION_GUARDS = [
  'actor_authorized',
  'event_allowed_in_state',
  'idempotency_key_consistent',
] as const satisfies readonly OnboardingGuard[];

export const ONBOARDING_TRANSITIONS_V1 = [
  {
    from_state: 'not_started',
    event: 'start_onboarding',
    to_state: 'auth_pending',
    guards: BASE_MUTATION_GUARDS,
  },
  {
    from_state: 'auth_pending',
    event: 'auth_verified',
    to_state: 'profile_pending',
    guards: [...BASE_MUTATION_GUARDS, 'required_prerequisites_complete'],
  },
  {
    from_state: 'profile_pending',
    event: 'profile_saved',
    to_state: 'integration_pending',
    guards: [...BASE_MUTATION_GUARDS, 'required_prerequisites_complete'],
  },
  {
    from_state: 'integration_pending',
    event: 'integration_verified',
    to_state: 'readiness_pending',
    guards: [...BASE_MUTATION_GUARDS, 'required_prerequisites_complete'],
  },
  {
    from_state: 'integration_pending',
    event: 'skip_optional_integration',
    to_state: 'readiness_pending',
    guards: [...BASE_MUTATION_GUARDS, 'step_is_optional'],
  },
  {
    from_state: 'readiness_pending',
    event: 'readiness_verified',
    to_state: 'ready_to_activate',
    guards: [...BASE_MUTATION_GUARDS, 'readiness_checks_passed'],
  },
  {
    from_state: 'ready_to_activate',
    event: 'activation_succeeded',
    to_state: 'completed',
    guards: [...BASE_MUTATION_GUARDS, 'activation_not_already_completed'],
  },
  {
    from_state: 'auth_pending',
    event: 'block_transition',
    to_state: 'blocked',
    guards: [...BASE_MUTATION_GUARDS, 'failure_is_non_retryable'],
  },
  {
    from_state: 'profile_pending',
    event: 'block_transition',
    to_state: 'blocked',
    guards: [...BASE_MUTATION_GUARDS, 'failure_is_non_retryable'],
  },
  {
    from_state: 'integration_pending',
    event: 'block_transition',
    to_state: 'blocked',
    guards: [...BASE_MUTATION_GUARDS, 'failure_is_non_retryable'],
  },
  {
    from_state: 'readiness_pending',
    event: 'block_transition',
    to_state: 'blocked',
    guards: [...BASE_MUTATION_GUARDS, 'failure_is_non_retryable'],
  },
  {
    from_state: 'ready_to_activate',
    event: 'block_transition',
    to_state: 'blocked',
    guards: [...BASE_MUTATION_GUARDS, 'failure_is_non_retryable'],
  },
  {
    from_state: 'blocked',
    event: 'resolve_blocker',
    to_state: 'resume_target_state',
    guards: [...BASE_MUTATION_GUARDS, 'blocker_is_resolved', 'resume_target_present'],
  },
  {
    from_state: 'auth_pending',
    event: 'restart_onboarding',
    to_state: 'auth_pending',
    guards: BASE_MUTATION_GUARDS,
  },
  {
    from_state: 'profile_pending',
    event: 'restart_onboarding',
    to_state: 'auth_pending',
    guards: BASE_MUTATION_GUARDS,
  },
  {
    from_state: 'integration_pending',
    event: 'restart_onboarding',
    to_state: 'auth_pending',
    guards: BASE_MUTATION_GUARDS,
  },
  {
    from_state: 'readiness_pending',
    event: 'restart_onboarding',
    to_state: 'auth_pending',
    guards: BASE_MUTATION_GUARDS,
  },
  {
    from_state: 'ready_to_activate',
    event: 'restart_onboarding',
    to_state: 'auth_pending',
    guards: BASE_MUTATION_GUARDS,
  },
  {
    from_state: 'blocked',
    event: 'restart_onboarding',
    to_state: 'auth_pending',
    guards: BASE_MUTATION_GUARDS,
  },
  {
    from_state: 'auth_pending',
    event: 'cancel_onboarding',
    to_state: 'cancelled',
    guards: BASE_MUTATION_GUARDS,
  },
  {
    from_state: 'profile_pending',
    event: 'cancel_onboarding',
    to_state: 'cancelled',
    guards: BASE_MUTATION_GUARDS,
  },
  {
    from_state: 'integration_pending',
    event: 'cancel_onboarding',
    to_state: 'cancelled',
    guards: BASE_MUTATION_GUARDS,
  },
  {
    from_state: 'readiness_pending',
    event: 'cancel_onboarding',
    to_state: 'cancelled',
    guards: BASE_MUTATION_GUARDS,
  },
  {
    from_state: 'ready_to_activate',
    event: 'cancel_onboarding',
    to_state: 'cancelled',
    guards: BASE_MUTATION_GUARDS,
  },
  {
    from_state: 'blocked',
    event: 'cancel_onboarding',
    to_state: 'cancelled',
    guards: BASE_MUTATION_GUARDS,
  },
] as const satisfies readonly OnboardingTransitionDefinition[];

export const onboarding_contract_v1 = {
  version: ONBOARDING_CONTRACT_VERSION_V1,
  states: ONBOARDING_STATES_V1,
  events: ONBOARDING_EVENTS_V1,
  guards: ONBOARDING_GUARDS_V1,
  terminal_states: ONBOARDING_TERMINAL_STATES_V1,
  transitions: ONBOARDING_TRANSITIONS_V1,
} as const;

export const ONBOARDING_ERROR_CATEGORIES = [
  'validation',
  'transient',
  'dependency',
  'auth',
  'configuration',
] as const;

export type OnboardingErrorCategory = typeof ONBOARDING_ERROR_CATEGORIES[number];

export const ONBOARDING_TRANSITION_ERROR_CODES = [
  'invalid_transition',
  'prerequisite_not_met',
  'step_not_skippable',
  'readiness_checks_failed',
  'blocker_unresolved',
  'terminal_state_transition_denied',
  'actor_not_authorized',
  'idempotency_key_conflict',
  'transition_write_conflict',
  'resume_target_missing',
  'activation_already_completed',
  'failure_retryable',
] as const;

export type OnboardingTransitionErrorCode = typeof ONBOARDING_TRANSITION_ERROR_CODES[number];

export const ONBOARDING_ERROR_CATEGORY_BY_CODE: Record<OnboardingTransitionErrorCode, OnboardingErrorCategory> = {
  invalid_transition: 'validation',
  prerequisite_not_met: 'dependency',
  step_not_skippable: 'validation',
  readiness_checks_failed: 'configuration',
  blocker_unresolved: 'configuration',
  terminal_state_transition_denied: 'validation',
  actor_not_authorized: 'auth',
  idempotency_key_conflict: 'validation',
  transition_write_conflict: 'transient',
  resume_target_missing: 'configuration',
  activation_already_completed: 'configuration',
  failure_retryable: 'validation',
};

export interface OnboardingStateSnapshot {
  contract_version: OnboardingContractVersion;
  state: OnboardingState;
  resume_target_state: OnboardingResumableState | null;
}

export interface OnboardingGuardContext {
  actor_authorized: boolean;
  idempotency_key_consistent: boolean;
  required_prerequisites_complete?: boolean;
  step_is_optional?: boolean;
  blocker_is_resolved?: boolean;
  resume_target_state?: OnboardingResumableState | null;
  readiness_checks_passed?: boolean;
  activation_not_already_completed?: boolean;
  failure_is_non_retryable?: boolean;
}

export interface OnboardingTransitionError {
  code: OnboardingTransitionErrorCode;
  category: OnboardingErrorCategory;
  message: string;
  from_state: OnboardingState;
  event: OnboardingEvent;
  guard?: OnboardingGuard;
}

export interface OnboardingTransitionSuccess {
  ok: true;
  previous: OnboardingStateSnapshot;
  next: OnboardingStateSnapshot;
  transition: {
    from_state: OnboardingState;
    event: OnboardingEvent;
    to_state: OnboardingState;
    guards: readonly OnboardingGuard[];
  };
}

export interface OnboardingTransitionFailure {
  ok: false;
  error: OnboardingTransitionError;
}

export type OnboardingTransitionResult = OnboardingTransitionSuccess | OnboardingTransitionFailure;

export interface OnboardingAllowedAction {
  event: OnboardingEvent;
  to_state: OnboardingTransitionTarget;
  guards: readonly OnboardingGuard[];
}

type OnboardingStateInput = OnboardingStateSnapshot | OnboardingState;

const STEP_EVENT_REQUIRED_STATE: Partial<Record<OnboardingEvent, OnboardingState>> = {
  auth_verified: 'auth_pending',
  profile_saved: 'profile_pending',
  integration_verified: 'integration_pending',
  skip_optional_integration: 'integration_pending',
  readiness_verified: 'readiness_pending',
  activation_succeeded: 'ready_to_activate',
};

const STATE_SEQUENCE_RANK: Partial<Record<OnboardingState, number>> = {
  not_started: 0,
  auth_pending: 1,
  profile_pending: 2,
  integration_pending: 3,
  readiness_pending: 4,
  ready_to_activate: 5,
};

const TRANSITION_MAP = new Map<string, OnboardingTransitionDefinition>(
  ONBOARDING_TRANSITIONS_V1.map((transition) => [toTransitionKey(transition.from_state, transition.event), transition]),
);

export function createInitialOnboardingState(): OnboardingStateSnapshot {
  return {
    contract_version: ONBOARDING_CONTRACT_VERSION_V1,
    state: 'not_started',
    resume_target_state: null,
  };
}

export function isTerminalOnboardingState(state: OnboardingState): state is OnboardingTerminalState;
export function isTerminalOnboardingState(state: OnboardingStateSnapshot): boolean;
export function isTerminalOnboardingState(state: OnboardingStateInput): boolean {
  const snapshot = normalizeStateSnapshot(state);
  return snapshot.state === 'completed' || snapshot.state === 'cancelled';
}

export function listAllowedOnboardingActions(state: OnboardingStateInput): readonly OnboardingAllowedAction[] {
  const snapshot = normalizeStateSnapshot(state);
  if (isTerminalOnboardingState(snapshot.state)) {
    return [];
  }

  return ONBOARDING_TRANSITIONS_V1
    .filter((transition) => transition.from_state === snapshot.state)
    .map((transition) => ({
      event: transition.event,
      to_state: transition.to_state,
      guards: transition.guards,
    }));
}

export function canRestartOnboarding(state: OnboardingStateInput): boolean {
  return listAllowedOnboardingActions(state).some((action) => action.event === 'restart_onboarding');
}

export function restartOnboardingState(
  state: OnboardingStateInput,
  context: OnboardingGuardContext,
): OnboardingTransitionResult {
  return applyOnboardingEvent(state, 'restart_onboarding', context);
}

export function applyOnboardingEvent(
  state: OnboardingStateInput,
  event: OnboardingEvent,
  context: OnboardingGuardContext,
): OnboardingTransitionResult {
  const current = normalizeStateSnapshot(state);
  const actorError = evaluateGuard('actor_authorized', current, event, context);
  if (actorError) {
    return transitionFailure(actorError);
  }

  if (isTerminalOnboardingState(current.state)) {
    return transitionFailure({
      code: 'terminal_state_transition_denied',
      from_state: current.state,
      event,
      message: `state '${current.state}' is terminal in onboarding_contract_v1`,
    });
  }

  const transition = TRANSITION_MAP.get(toTransitionKey(current.state, event));
  if (!transition) {
    return transitionFailure(classifyInvalidTransition(current.state, event, context));
  }

  for (const guard of transition.guards) {
    if (guard === 'actor_authorized') {
      continue;
    }
    const guardError = evaluateGuard(guard, current, event, context);
    if (guardError) {
      return transitionFailure(guardError);
    }
  }

  const toState = resolveTargetState(transition.to_state, current, context);
  if (!toState) {
    return transitionFailure({
      code: 'resume_target_missing',
      from_state: current.state,
      event,
      guard: 'resume_target_present',
      message: 'blocked state is missing a resumable target state',
    });
  }

  const next: OnboardingStateSnapshot = {
    contract_version: ONBOARDING_CONTRACT_VERSION_V1,
    state: toState,
    resume_target_state: toState === 'blocked' && isOnboardingResumableState(current.state) ? current.state : null,
  };

  return {
    ok: true,
    previous: current,
    next,
    transition: {
      from_state: transition.from_state,
      event: transition.event,
      to_state: toState,
      guards: transition.guards,
    },
  };
}

function evaluateGuard(
  guard: OnboardingGuard,
  current: OnboardingStateSnapshot,
  event: OnboardingEvent,
  context: OnboardingGuardContext,
): Omit<OnboardingTransitionError, 'category'> | null {
  if (guard === 'event_allowed_in_state') {
    return null;
  }

  if (guard === 'actor_authorized') {
    return context.actor_authorized
      ? null
      : {
          code: 'actor_not_authorized',
          from_state: current.state,
          event,
          guard,
          message: 'actor is not authorized for this onboarding transition',
        };
  }

  if (guard === 'idempotency_key_consistent') {
    return context.idempotency_key_consistent
      ? null
      : {
          code: 'idempotency_key_conflict',
          from_state: current.state,
          event,
          guard,
          message: 'idempotency key replay payload mismatch',
        };
  }

  if (guard === 'required_prerequisites_complete') {
    return context.required_prerequisites_complete
      ? null
      : {
          code: 'prerequisite_not_met',
          from_state: current.state,
          event,
          guard,
          message: 'required prerequisites are incomplete for this transition',
        };
  }

  if (guard === 'step_is_optional') {
    return context.step_is_optional
      ? null
      : {
          code: 'step_not_skippable',
          from_state: current.state,
          event,
          guard,
          message: 'integration step is required and cannot be skipped',
        };
  }

  if (guard === 'blocker_is_resolved') {
    return context.blocker_is_resolved
      ? null
      : {
          code: 'blocker_unresolved',
          from_state: current.state,
          event,
          guard,
          message: 'blocked state remediation check did not pass',
        };
  }

  if (guard === 'resume_target_present') {
    const resumeTarget = resolveResumeTargetState(current, context);
    return resumeTarget
      ? null
      : {
          code: 'resume_target_missing',
          from_state: current.state,
          event,
          guard,
          message: 'blocked state does not have a resumable target state',
        };
  }

  if (guard === 'readiness_checks_passed') {
    return context.readiness_checks_passed
      ? null
      : {
          code: 'readiness_checks_failed',
          from_state: current.state,
          event,
          guard,
          message: 'required readiness checks are still failing',
        };
  }

  if (guard === 'activation_not_already_completed') {
    return context.activation_not_already_completed
      ? null
      : {
          code: 'activation_already_completed',
          from_state: current.state,
          event,
          guard,
          message: 'activation was already completed in persistent state',
        };
  }

  if (guard === 'failure_is_non_retryable') {
    return context.failure_is_non_retryable
      ? null
      : {
          code: 'failure_retryable',
          from_state: current.state,
          event,
          guard,
          message: 'block_transition is only valid for non-retryable failures',
        };
  }

  return {
    code: 'invalid_transition',
    from_state: current.state,
    event,
    guard,
    message: `unknown guard '${guard}'`,
  };
}

function classifyInvalidTransition(
  fromState: OnboardingState,
  event: OnboardingEvent,
  context: OnboardingGuardContext,
): Omit<OnboardingTransitionError, 'category'> {
  if (fromState === 'not_started') {
    return {
      code: 'invalid_transition',
      from_state: fromState,
      event,
      message: `event '${event}' is invalid before onboarding is started`,
    };
  }

  if (
    event === 'activation_succeeded' &&
    fromState === 'readiness_pending' &&
    context.readiness_checks_passed === false
  ) {
    return {
      code: 'readiness_checks_failed',
      from_state: fromState,
      event,
      guard: 'readiness_checks_passed',
      message: 'required readiness checks are still failing',
    };
  }

  const requiredState = STEP_EVENT_REQUIRED_STATE[event];
  if (requiredState) {
    const currentRank = STATE_SEQUENCE_RANK[fromState];
    const requiredRank = STATE_SEQUENCE_RANK[requiredState];
    if (
      typeof currentRank === 'number' &&
      typeof requiredRank === 'number' &&
      currentRank < requiredRank
    ) {
      return {
        code: 'prerequisite_not_met',
        from_state: fromState,
        event,
        message: `event '${event}' requires onboarding state '${requiredState}'`,
      };
    }
  }

  return {
    code: 'invalid_transition',
    from_state: fromState,
    event,
    message: `event '${event}' is not valid from state '${fromState}'`,
  };
}

function transitionFailure(
  error: Omit<OnboardingTransitionError, 'category'>,
): OnboardingTransitionFailure {
  return {
    ok: false,
    error: {
      ...error,
      category: ONBOARDING_ERROR_CATEGORY_BY_CODE[error.code],
    },
  };
}

function resolveTargetState(
  target: OnboardingTransitionTarget,
  current: OnboardingStateSnapshot,
  context: OnboardingGuardContext,
): OnboardingState | null {
  if (target !== 'resume_target_state') {
    return target;
  }

  const resumeTarget = resolveResumeTargetState(current, context);
  return resumeTarget ?? null;
}

function resolveResumeTargetState(
  current: OnboardingStateSnapshot,
  context: OnboardingGuardContext,
): OnboardingResumableState | null {
  const resumeTarget = context.resume_target_state ?? current.resume_target_state;
  return isOnboardingResumableState(resumeTarget) ? resumeTarget : null;
}

function normalizeStateSnapshot(state: OnboardingStateInput): OnboardingStateSnapshot {
  if (typeof state === 'string') {
    return {
      contract_version: ONBOARDING_CONTRACT_VERSION_V1,
      state,
      resume_target_state: null,
    };
  }

  return {
    contract_version: ONBOARDING_CONTRACT_VERSION_V1,
    state: state.state,
    resume_target_state: state.resume_target_state ?? null,
  };
}

function isOnboardingResumableState(state: string | null | undefined): state is OnboardingResumableState {
  return (
    state === 'auth_pending' ||
    state === 'profile_pending' ||
    state === 'integration_pending' ||
    state === 'readiness_pending' ||
    state === 'ready_to_activate'
  );
}

function toTransitionKey(fromState: OnboardingState, event: OnboardingEvent): string {
  return `${fromState}:${event}`;
}
