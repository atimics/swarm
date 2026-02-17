import { API_BASE } from './apiBase';

export const SUPPORTED_ONBOARDING_CONTRACT_VERSION = 'onboarding_contract_v1' as const;
export const ONBOARDING_FUNNEL_VERSION = 'onboarding_funnel_v1' as const;

export type OnboardingActionType =
  | 'execute'
  | 'retry'
  | 'continue'
  | 'skip_optional'
  | 'restart'
  | string;

export interface OnboardingAction {
  type: OnboardingActionType;
  label?: string;
  description?: string;
  disabled?: boolean;
  reason?: string;
  style?: 'primary' | 'secondary' | 'danger' | string;
  [key: string]: unknown;
}

export interface OnboardingStepError {
  class?: string;
  code?: string;
  message?: string;
  retryable?: boolean;
  [key: string]: unknown;
}

export interface OnboardingStep {
  id: string;
  title: string;
  requirement: 'required' | 'optional' | string;
  status: string;
  description?: string;
  validNextActions: OnboardingAction[];
  blockingReasons?: string[];
  lastError?: OnboardingStepError;
  [key: string]: unknown;
}

export interface OnboardingStatus {
  contractVersion: string;
  funnelVersion?: string;
  avatarId: string;
  attemptId?: string;
  state?: string;
  currentStepId?: string;
  steps: OnboardingStep[];
  globalActions?: OnboardingAction[];
  [key: string]: unknown;
}

export class OnboardingApiError extends Error {
  readonly status: number;
  readonly errorClass?: string;
  readonly errorCode?: string;

  constructor(
    message: string,
    options: {
      status: number;
      errorClass?: string;
      errorCode?: string;
    }
  ) {
    super(message);
    this.name = 'OnboardingApiError';
    this.status = options.status;
    this.errorClass = options.errorClass;
    this.errorCode = options.errorCode;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isOnboardingStatus(value: unknown): value is OnboardingStatus {
  if (!isRecord(value)) return false;
  return typeof value.avatarId === 'string' && Array.isArray(value.steps);
}

function toAction(type: string): OnboardingAction {
  switch (type) {
    case 'execute_step':
      return { type: 'execute', label: 'Execute Step' };
    case 'skip_optional':
      return { type: 'skip_optional', label: 'Skip Optional Step' };
    case 'restart':
      return { type: 'restart', label: 'Restart Onboarding', style: 'danger' };
    default:
      return { type };
  }
}

function mapEnvelopeToStatus(payload: Record<string, unknown>): OnboardingStatus | null {
  const avatarId = typeof payload.avatarId === 'string' ? payload.avatarId : null;
  const contractVersion = typeof payload.contractVersion === 'string' ? payload.contractVersion : null;
  const onboarding = isRecord(payload.onboarding) ? payload.onboarding : null;
  if (!avatarId || !contractVersion || !onboarding) return null;

  const rawSteps = Array.isArray(onboarding.steps) ? onboarding.steps : null;
  if (!rawSteps) return null;

  const allowedActions = Array.isArray(onboarding.allowedActions)
    ? onboarding.allowedActions.filter((action): action is string => typeof action === 'string')
    : [];

  const currentStepId = typeof onboarding.currentStepId === 'string' ? onboarding.currentStepId : undefined;
  const steps: OnboardingStep[] = [];
  for (const rawStep of rawSteps) {
    if (!isRecord(rawStep) || typeof rawStep.stepId !== 'string') {
      continue;
    }

    const stepIsCurrent = currentStepId === rawStep.stepId;
    const optional = Boolean(rawStep.optional);
    const validNextActions: OnboardingAction[] = [];

    if (stepIsCurrent && allowedActions.includes('execute_step')) {
      validNextActions.push(toAction('execute_step'));
    }
    if (stepIsCurrent && optional && allowedActions.includes('skip_optional')) {
      validNextActions.push(toAction('skip_optional'));
    }

    const stepError = isRecord(rawStep.lastError) ? rawStep.lastError : undefined;
    const parsedError = stepError
      ? {
          ...(typeof stepError.category === 'string' ? { class: stepError.category } : {}),
          ...(typeof stepError.code === 'string' ? { code: stepError.code } : {}),
          ...(typeof stepError.message === 'string' ? { message: stepError.message } : {}),
          ...(typeof stepError.retryable === 'boolean' ? { retryable: stepError.retryable } : {}),
        }
      : undefined;
    const lastError: OnboardingStepError | undefined =
      parsedError && Object.keys(parsedError).length > 0 ? parsedError : undefined;

    steps.push({
      id: rawStep.stepId,
      title: rawStep.stepId,
      requirement: optional ? 'optional' : 'required',
      status: typeof rawStep.status === 'string' ? rawStep.status : 'pending',
      validNextActions,
      lastError,
    });
  }

  return {
    contractVersion,
    avatarId,
    attemptId: typeof payload.requestId === 'string' ? payload.requestId : undefined,
    state: typeof onboarding.state === 'string' ? onboarding.state : undefined,
    currentStepId,
    steps,
    globalActions: allowedActions
      .filter((action) => action === 'restart')
      .map((action) => toAction(action)),
  };
}

function extractOnboardingStatus(payload: unknown): OnboardingStatus | null {
  if (isOnboardingStatus(payload)) return payload;
  if (!isRecord(payload)) return null;

  const mapped = mapEnvelopeToStatus(payload);
  if (mapped) return mapped;

  const candidates = [payload.status, payload.onboarding, payload.data];
  for (const candidate of candidates) {
    if (isOnboardingStatus(candidate)) {
      return candidate;
    }
    if (isRecord(candidate)) {
      const mappedCandidate = mapEnvelopeToStatus(candidate);
      if (mappedCandidate) {
        return mappedCandidate;
      }
    }
  }

  return null;
}

function parseErrorPayload(payload: unknown, fallbackMessage: string): {
  message: string;
  errorClass?: string;
  errorCode?: string;
} {
  if (!isRecord(payload)) {
    return { message: fallbackMessage };
  }

  const topLevelMessage =
    typeof payload.error === 'string'
      ? payload.error
      : typeof payload.message === 'string'
      ? payload.message
      : undefined;

  const topLevelClass =
    typeof payload.errorClass === 'string'
      ? payload.errorClass
      : typeof payload.class === 'string'
      ? payload.class
      : undefined;

  const topLevelCode =
    typeof payload.errorCode === 'string'
      ? payload.errorCode
      : typeof payload.code === 'string'
      ? payload.code
      : undefined;

  if (isRecord(payload.error)) {
    const nestedMessage = typeof payload.error.message === 'string' ? payload.error.message : undefined;
    const nestedClass = typeof payload.error.class === 'string' ? payload.error.class : undefined;
    const nestedCode = typeof payload.error.code === 'string' ? payload.error.code : undefined;

    return {
      message: nestedMessage || topLevelMessage || fallbackMessage,
      errorClass: nestedClass || topLevelClass,
      errorCode: nestedCode || topLevelCode,
    };
  }

  return {
    message: topLevelMessage || fallbackMessage,
    errorClass: topLevelClass,
    errorCode: topLevelCode,
  };
}

async function readResponseBody(response: Response): Promise<unknown | undefined> {
  if (response.status === 204) return undefined;

  const bodyText = await response.text();
  if (!bodyText.trim()) return undefined;

  try {
    return JSON.parse(bodyText) as unknown;
  } catch {
    return { message: bodyText };
  }
}

async function requestOnboarding(path: string, init?: RequestInit): Promise<unknown | undefined> {
  const headers = new Headers(init?.headers);
  const method = (init?.method || 'GET').toUpperCase();
  if (init?.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (method !== 'GET' && method !== 'HEAD' && !headers.has('Idempotency-Key')) {
    headers.set('Idempotency-Key', crypto.randomUUID());
  }

  const response = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...init,
    headers,
  });

  const payload = await readResponseBody(response);

  if (!response.ok) {
    const parsed = parseErrorPayload(payload, `HTTP ${response.status}`);
    throw new OnboardingApiError(parsed.message, {
      status: response.status,
      errorClass: parsed.errorClass,
      errorCode: parsed.errorCode,
    });
  }

  return payload;
}

export async function getOnboardingStatus(avatarId: string): Promise<OnboardingStatus> {
  const payload = await requestOnboarding(`/onboarding/${encodeURIComponent(avatarId)}`, {
    method: 'GET',
  });

  const status = extractOnboardingStatus(payload);
  if (!status) {
    throw new Error('Invalid onboarding status response');
  }

  return status;
}

export async function executeOnboardingStep(
  avatarId: string,
  stepId: string
): Promise<OnboardingStatus | null> {
  const payload = await requestOnboarding(
    `/onboarding/${encodeURIComponent(avatarId)}/steps/${encodeURIComponent(stepId)}/execute`,
    {
      method: 'POST',
    }
  );

  return extractOnboardingStatus(payload);
}

export async function restartOnboarding(avatarId: string): Promise<OnboardingStatus | null> {
  const payload = await requestOnboarding(`/onboarding/${encodeURIComponent(avatarId)}/restart`, {
    method: 'POST',
  });

  return extractOnboardingStatus(payload);
}

export async function skipOptionalOnboardingStep(
  avatarId: string,
  stepId: string
): Promise<OnboardingStatus | null> {
  const payload = await requestOnboarding(
    `/onboarding/${encodeURIComponent(avatarId)}/steps/${encodeURIComponent(stepId)}/skip-optional`,
    {
      method: 'POST',
    }
  );

  return extractOnboardingStatus(payload);
}

export function isOnboardingEndpointUnavailable(error: unknown): boolean {
  return (
    error instanceof OnboardingApiError &&
    (error.status === 404 || error.status === 405 || error.status === 501)
  );
}
