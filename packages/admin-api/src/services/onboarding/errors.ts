import { randomUUID } from 'crypto';
import {
  ONBOARDING_CONTRACT_VERSION,
} from './types.js';
import {
  ONBOARDING_ERROR_DEFAULT_MESSAGE_BY_CODE,
  ONBOARDING_ERROR_POLICY_BY_CODE,
  type OnboardingContractVersion,
  type OnboardingErrorCode,
  type OnboardingErrorType,
  type OnboardingRetryStrategy,
} from './error-types.js';

export type OnboardingErrorDetailsValue = string | number | boolean;
export type OnboardingErrorDetails = Record<string, OnboardingErrorDetailsValue>;

export interface OnboardingErrorEnvelope {
  errorType: OnboardingErrorType;
  errorCode: OnboardingErrorCode;
  message: string;
  retryable: boolean;
  retryStrategy: OnboardingRetryStrategy;
  retryAfterMs?: number;
  maxAttempts?: number;
  attempt?: number;
  correlationId: string;
  onboardingContractVersion: OnboardingContractVersion;
  runId: string;
  state: string;
  step?: string;
  resumeToken?: string;
  details?: OnboardingErrorDetails;
}

export interface BuildOnboardingErrorEnvelopeParams {
  errorCode: OnboardingErrorCode;
  runId: string;
  state: string;
  message?: string;
  step?: string;
  resumeToken?: string;
  correlationId?: string;
  retryAfterMs?: number;
  maxAttempts?: number;
  attempt?: number;
  details?: OnboardingErrorDetails;
}

export interface OnboardingErrorInit {
  errorCode: OnboardingErrorCode;
  message?: string;
  retryAfterMs?: number;
  maxAttempts?: number;
  attempt?: number;
  details?: OnboardingErrorDetails;
}

export interface OnboardingErrorContext {
  runId: string;
  state: string;
  step?: string;
  resumeToken?: string;
  correlationId?: string;
  maxAttempts?: number;
  attempt?: number;
}

function normalizeMessage(errorCode: OnboardingErrorCode, message?: string): string {
  const trimmed = message?.trim();
  if (trimmed) {
    return trimmed;
  }
  return ONBOARDING_ERROR_DEFAULT_MESSAGE_BY_CODE[errorCode];
}

function normalizeRetryAfterMs(retryAfterMs?: number): number | undefined {
  if (typeof retryAfterMs !== 'number') {
    return undefined;
  }
  if (!Number.isFinite(retryAfterMs) || retryAfterMs <= 0) {
    return undefined;
  }
  return Math.floor(retryAfterMs);
}

export function resolveOnboardingErrorCode(
  errorCode: OnboardingErrorCode,
  attempt?: number,
  maxAttempts?: number
): OnboardingErrorCode {
  const policy = ONBOARDING_ERROR_POLICY_BY_CODE[errorCode];

  if (
    policy.retryable
    && typeof attempt === 'number'
    && typeof maxAttempts === 'number'
    && attempt >= maxAttempts
  ) {
    return 'retry_attempt_limit_reached';
  }

  return errorCode;
}

export function buildOnboardingErrorEnvelope(
  params: BuildOnboardingErrorEnvelopeParams
): OnboardingErrorEnvelope {
  const resolvedCode = resolveOnboardingErrorCode(
    params.errorCode,
    params.attempt,
    params.maxAttempts
  );
  const policy = ONBOARDING_ERROR_POLICY_BY_CODE[resolvedCode];
  const retryAfterMs = normalizeRetryAfterMs(params.retryAfterMs);

  return {
    errorType: policy.errorType,
    errorCode: resolvedCode,
    message: normalizeMessage(resolvedCode, params.message),
    retryable: policy.retryable,
    retryStrategy: policy.retryStrategy,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(typeof params.maxAttempts === 'number' ? { maxAttempts: params.maxAttempts } : {}),
    ...(typeof params.attempt === 'number' ? { attempt: params.attempt } : {}),
    correlationId: params.correlationId ?? randomUUID(),
    onboardingContractVersion: ONBOARDING_CONTRACT_VERSION,
    runId: params.runId,
    state: params.state,
    ...(params.step ? { step: params.step } : {}),
    ...(params.resumeToken ? { resumeToken: params.resumeToken } : {}),
    ...(params.details ? { details: params.details } : {}),
  };
}

export class OnboardingError extends Error {
  readonly errorType: OnboardingErrorType;
  readonly errorCode: OnboardingErrorCode;
  readonly retryable: boolean;
  readonly retryStrategy: OnboardingRetryStrategy;
  readonly retryAfterMs?: number;
  readonly maxAttempts?: number;
  readonly attempt?: number;
  readonly details?: OnboardingErrorDetails;

  constructor(params: OnboardingErrorInit) {
    const resolvedCode = resolveOnboardingErrorCode(
      params.errorCode,
      params.attempt,
      params.maxAttempts
    );
    const policy = ONBOARDING_ERROR_POLICY_BY_CODE[resolvedCode];
    const message = normalizeMessage(resolvedCode, params.message);

    super(message);

    this.name = 'OnboardingError';
    this.errorCode = resolvedCode;
    this.errorType = policy.errorType;
    this.retryable = policy.retryable;
    this.retryStrategy = policy.retryStrategy;
    this.retryAfterMs = normalizeRetryAfterMs(params.retryAfterMs);
    this.maxAttempts = params.maxAttempts;
    this.attempt = params.attempt;
    this.details = params.details;
  }
}

function assertErrorType(
  errorName: string,
  expectedType: OnboardingErrorType,
  code: OnboardingErrorCode
): void {
  const actualType = ONBOARDING_ERROR_POLICY_BY_CODE[code].errorType;
  if (actualType !== expectedType) {
    throw new TypeError(`${errorName} requires ${expectedType} codes. Received "${code}" (${actualType}).`);
  }
}

export class OnboardingValidationError extends OnboardingError {
  constructor(params: OnboardingErrorInit) {
    assertErrorType('OnboardingValidationError', 'validation', params.errorCode);
    super(params);
    this.name = 'OnboardingValidationError';
  }
}

export class OnboardingDependencyError extends OnboardingError {
  constructor(params: OnboardingErrorInit) {
    assertErrorType('OnboardingDependencyError', 'dependency', params.errorCode);
    super(params);
    this.name = 'OnboardingDependencyError';
  }
}

export class OnboardingAuthError extends OnboardingError {
  constructor(params: OnboardingErrorInit) {
    assertErrorType('OnboardingAuthError', 'auth', params.errorCode);
    super(params);
    this.name = 'OnboardingAuthError';
  }
}

export class OnboardingConfigurationError extends OnboardingError {
  constructor(params: OnboardingErrorInit) {
    assertErrorType('OnboardingConfigurationError', 'configuration', params.errorCode);
    super(params);
    this.name = 'OnboardingConfigurationError';
  }
}

export class OnboardingTransientError extends OnboardingError {
  constructor(params: OnboardingErrorInit) {
    assertErrorType('OnboardingTransientError', 'transient', params.errorCode);
    super(params);
    this.name = 'OnboardingTransientError';
  }
}

export type OnboardingResumeTokenErrorCode =
  | 'resume_token_expired'
  | 'resume_token_invalid'
  | 'resume_token_replayed';

function isResumeTokenCode(errorCode: OnboardingErrorCode): errorCode is OnboardingResumeTokenErrorCode {
  return (
    errorCode === 'resume_token_expired'
    || errorCode === 'resume_token_invalid'
    || errorCode === 'resume_token_replayed'
  );
}

export class OnboardingResumeTokenError extends OnboardingError {
  constructor(params: Omit<OnboardingErrorInit, 'errorCode'> & { errorCode: OnboardingResumeTokenErrorCode }) {
    super(params);
    this.name = 'OnboardingResumeTokenError';
  }
}

export function isOnboardingError(error: unknown): error is OnboardingError {
  return error instanceof OnboardingError;
}

function inferErrorCodeFromUnknown(error: unknown): OnboardingErrorCode {
  if (error instanceof OnboardingError) {
    return error.errorCode;
  }

  const message = error instanceof Error ? error.message : String(error ?? '');
  const lower = message.toLowerCase();

  if (lower.includes('resume token') && lower.includes('expired')) {
    return 'resume_token_expired';
  }
  if (lower.includes('resume token') && (lower.includes('replay') || lower.includes('stale'))) {
    return 'resume_token_replayed';
  }
  if (lower.includes('resume token')) {
    return 'resume_token_invalid';
  }
  if (lower.includes('timeout') || lower.includes('timed out')) {
    return 'step_dependency_timeout';
  }
  if (lower.includes('rate limit')) {
    return 'step_rate_limited';
  }
  if (lower.includes('unauthorized') || lower.includes('forbidden') || lower.includes('invalid signature')) {
    return 'actor_not_authorized';
  }
  if (lower.includes('idempotency') || lower.includes('already consumed')) {
    return 'idempotency_key_conflict';
  }
  if (lower.includes('conditionalcheckfailed') || lower.includes('write conflict')) {
    return 'transition_write_conflict';
  }
  if (lower.includes('missing') || lower.includes('not configured') || lower.includes('configuration')) {
    return 'configuration_missing';
  }
  if (lower.includes('invalid') || lower.includes('mismatch') || lower.includes('malformed')) {
    return 'step_payload_invalid';
  }

  return 'step_dependency_unavailable';
}

function inferDetails(error: unknown): OnboardingErrorDetails | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  const maybeDetails = (error as { details?: unknown }).details;
  if (!maybeDetails || typeof maybeDetails !== 'object') {
    return undefined;
  }

  const details = maybeDetails as Record<string, unknown>;
  const normalized: OnboardingErrorDetails = {};

  for (const [key, value] of Object.entries(details)) {
    if (
      typeof value === 'string'
      || typeof value === 'number'
      || typeof value === 'boolean'
    ) {
      normalized[key] = value;
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function toOnboardingErrorEnvelope(
  error: unknown,
  context: OnboardingErrorContext
): OnboardingErrorEnvelope {
  if (error instanceof OnboardingError) {
    return buildOnboardingErrorEnvelope({
      errorCode: error.errorCode,
      message: error.message,
      retryAfterMs: error.retryAfterMs,
      attempt: context.attempt ?? error.attempt,
      maxAttempts: context.maxAttempts ?? error.maxAttempts,
      details: error.details,
      ...context,
    });
  }

  const inferredCode = inferErrorCodeFromUnknown(error);
  const inferredMessage = error instanceof Error
    ? error.message
    : ONBOARDING_ERROR_DEFAULT_MESSAGE_BY_CODE[inferredCode];

  return buildOnboardingErrorEnvelope({
    errorCode: inferredCode,
    message: inferredMessage,
    details: inferDetails(error),
    ...context,
  });
}

export function asResumeTokenError(
  errorCode: OnboardingErrorCode,
  message?: string
): OnboardingResumeTokenError {
  if (!isResumeTokenCode(errorCode)) {
    throw new TypeError(`Expected resume token code, received "${errorCode}".`);
  }

  return new OnboardingResumeTokenError({
    errorCode,
    message,
  });
}
