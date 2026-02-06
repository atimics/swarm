import { randomUUID } from 'crypto';
import type { OnboardingErrorEnvelope, OnboardingErrorDetails } from './errors.js';
import {
  hashOnboardingResumeToken,
  type OnboardingResumeTokenClaims,
} from './resume-token.js';
import type {
  OnboardingErrorCode,
  OnboardingErrorType,
  OnboardingRetryStrategy,
} from './error-types.js';

export const DEFAULT_ONBOARDING_FAILURE_HISTORY_LIMIT = 100;

export type OnboardingFailureResolution =
  | 'retry_succeeded'
  | 'restart_onboarding'
  | 'cancel_onboarding'
  | 'manual_remediation';

export interface OnboardingFailureRecord {
  failureId: string;
  runId: string;
  avatarId: string;
  state: string;
  step: string;
  event: string;
  occurredAt: string;
  attempt: number;
  maxAttempts: number;
  errorType: OnboardingErrorType;
  errorCode: OnboardingErrorCode;
  retryable: boolean;
  retryStrategy: OnboardingRetryStrategy;
  retryAfterMs?: number;
  correlationId: string;
  requestId?: string;
  idempotencyKey?: string;
  resumeTokenHash: string;
  details?: OnboardingErrorDetails;
  resolvedAt?: string;
  resolution?: OnboardingFailureResolution;
}

export interface OnboardingFailureSummary {
  failureId: string;
  occurredAt: string;
  errorType: OnboardingErrorType;
  errorCode: OnboardingErrorCode;
  retryable: boolean;
  retryStrategy: OnboardingRetryStrategy;
  correlationId: string;
}

export interface OnboardingStepRetryState {
  step: string;
  attempt: number;
  maxAttempts: number;
  exhausted: boolean;
  retryable: boolean;
  retryStrategy: OnboardingRetryStrategy;
  lastErrorCode: OnboardingErrorCode;
  lastFailureId: string;
  lastAttemptAt: string;
  retryAfterMs?: number;
}

export interface OnboardingResumeTokenMetadata {
  tokenHash: string;
  issuedAt: number;
  expiresAt: number;
  failureSeq: number;
  nonce: string;
}

export interface OnboardingRunPersistenceRecord {
  runId: string;
  avatarId: string;
  state: string;
  step: string;
  failureSeq: number;
  lastFailure?: OnboardingFailureSummary;
  failureHistory: OnboardingFailureRecord[];
  retryByStep: Record<string, OnboardingStepRetryState>;
  latestResumeToken?: OnboardingResumeTokenMetadata;
}

export interface CreateOnboardingRunPersistenceParams {
  runId: string;
  avatarId: string;
  state: string;
  step: string;
}

export interface AppendOnboardingFailureParams {
  state: string;
  step: string;
  event: string;
  attempt: number;
  maxAttempts: number;
  error: OnboardingErrorEnvelope;
  requestId?: string;
  idempotencyKey?: string;
  resumeToken?: string;
  occurredAt?: string;
  failureId?: string;
}

export function createOnboardingRunPersistenceRecord(
  params: CreateOnboardingRunPersistenceParams
): OnboardingRunPersistenceRecord {
  return {
    runId: params.runId,
    avatarId: params.avatarId,
    state: params.state,
    step: params.step,
    failureSeq: 0,
    failureHistory: [],
    retryByStep: {},
  };
}

function toFailureSummary(record: OnboardingFailureRecord): OnboardingFailureSummary {
  return {
    failureId: record.failureId,
    occurredAt: record.occurredAt,
    errorType: record.errorType,
    errorCode: record.errorCode,
    retryable: record.retryable,
    retryStrategy: record.retryStrategy,
    correlationId: record.correlationId,
  };
}

function buildResumeTokenHash(resumeToken?: string): string {
  if (!resumeToken) {
    return 'none';
  }
  return hashOnboardingResumeToken(resumeToken);
}

function normalizeAttemptCount(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

function trimFailureHistory(
  history: OnboardingFailureRecord[],
  maxHistory = DEFAULT_ONBOARDING_FAILURE_HISTORY_LIMIT
): OnboardingFailureRecord[] {
  if (maxHistory <= 0) {
    return [];
  }

  if (history.length <= maxHistory) {
    return history;
  }

  return history.slice(history.length - maxHistory);
}

export function appendOnboardingFailureRecord(
  run: OnboardingRunPersistenceRecord,
  params: AppendOnboardingFailureParams,
  options: { maxHistory?: number } = {}
): {
  run: OnboardingRunPersistenceRecord;
  failure: OnboardingFailureRecord;
} {
  const failureId = params.failureId ?? randomUUID();
  const occurredAt = params.occurredAt ?? new Date().toISOString();
  const failureSeq = run.failureSeq + 1;

  const attempt = normalizeAttemptCount(params.attempt);
  const maxAttempts = normalizeAttemptCount(params.maxAttempts);
  const exhausted = maxAttempts > 0 && attempt >= maxAttempts;

  const failure: OnboardingFailureRecord = {
    failureId,
    runId: run.runId,
    avatarId: run.avatarId,
    state: params.state,
    step: params.step,
    event: params.event,
    occurredAt,
    attempt,
    maxAttempts,
    errorType: params.error.errorType,
    errorCode: params.error.errorCode,
    retryable: params.error.retryable,
    retryStrategy: params.error.retryStrategy,
    ...(typeof params.error.retryAfterMs === 'number' ? { retryAfterMs: params.error.retryAfterMs } : {}),
    correlationId: params.error.correlationId,
    ...(params.requestId ? { requestId: params.requestId } : {}),
    ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
    resumeTokenHash: buildResumeTokenHash(params.resumeToken ?? params.error.resumeToken),
    ...(params.error.details ? { details: params.error.details } : {}),
  };

  const updatedHistory = trimFailureHistory(
    [...run.failureHistory, failure],
    options.maxHistory
  );

  const stepRetryState: OnboardingStepRetryState = {
    step: params.step,
    attempt,
    maxAttempts,
    exhausted,
    retryable: params.error.retryable && !exhausted,
    retryStrategy: params.error.retryStrategy,
    lastErrorCode: params.error.errorCode,
    lastFailureId: failureId,
    lastAttemptAt: occurredAt,
    ...(typeof params.error.retryAfterMs === 'number' ? { retryAfterMs: params.error.retryAfterMs } : {}),
  };

  return {
    failure,
    run: {
      ...run,
      state: params.state,
      step: params.step,
      failureSeq,
      lastFailure: toFailureSummary(failure),
      failureHistory: updatedHistory,
      retryByStep: {
        ...run.retryByStep,
        [params.step]: stepRetryState,
      },
    },
  };
}

export function setLatestOnboardingResumeTokenMetadata(
  run: OnboardingRunPersistenceRecord,
  token: string,
  claims: Pick<OnboardingResumeTokenClaims, 'iat' | 'exp' | 'failureSeq' | 'nonce'>
): OnboardingRunPersistenceRecord {
  return {
    ...run,
    latestResumeToken: {
      tokenHash: hashOnboardingResumeToken(token),
      issuedAt: claims.iat,
      expiresAt: claims.exp,
      failureSeq: claims.failureSeq,
      nonce: claims.nonce,
    },
  };
}

export function resolveOnboardingFailureRecord(
  run: OnboardingRunPersistenceRecord,
  failureId: string,
  resolution: OnboardingFailureResolution,
  resolvedAt = new Date().toISOString()
): OnboardingRunPersistenceRecord {
  let lastFailureResolved = false;

  const failureHistory = run.failureHistory.map((failure) => {
    if (failure.failureId !== failureId) {
      return failure;
    }

    if (run.lastFailure?.failureId === failureId) {
      lastFailureResolved = true;
    }

    return {
      ...failure,
      resolvedAt,
      resolution,
    };
  });

  return {
    ...run,
    failureHistory,
    ...(lastFailureResolved && run.lastFailure
      ? {
          lastFailure: {
            ...run.lastFailure,
          },
        }
      : {}),
  };
}

export function getOnboardingStepRetryState(
  run: Pick<OnboardingRunPersistenceRecord, 'retryByStep'>,
  step: string
): OnboardingStepRetryState | undefined {
  return run.retryByStep[step];
}

export function shouldRetryOnboardingStep(
  run: Pick<OnboardingRunPersistenceRecord, 'retryByStep'>,
  step: string
): boolean {
  const retryState = getOnboardingStepRetryState(run, step);
  if (!retryState) {
    return false;
  }

  return retryState.retryable && !retryState.exhausted;
}
