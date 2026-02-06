import { ONBOARDING_CONTRACT_VERSION } from './types.js';

export type OnboardingContractVersion = typeof ONBOARDING_CONTRACT_VERSION;

export type OnboardingErrorType =
  | 'validation'
  | 'transient'
  | 'dependency'
  | 'auth'
  | 'configuration';

export type OnboardingRetryStrategy =
  | 'none'
  | 'immediate'
  | 'exponential_backoff'
  | 'after_remediation'
  | 'after_reauth';

export const ONBOARDING_ERROR_CODES = [
  // SWARM-012 transition codes
  'invalid_transition',
  'prerequisite_not_met',
  'step_not_skippable',
  'readiness_checks_failed',
  'blocker_unresolved',
  'terminal_state_transition_denied',
  'actor_not_authorized',
  'idempotency_key_conflict',
  'transition_write_conflict',
  // SWARM-018 execution/resume codes
  'step_payload_invalid',
  'step_dependency_unavailable',
  'step_dependency_timeout',
  'step_rate_limited',
  'configuration_missing',
  'resume_token_expired',
  'resume_token_invalid',
  'resume_token_replayed',
  'retry_attempt_limit_reached',
] as const;

export type OnboardingErrorCode = (typeof ONBOARDING_ERROR_CODES)[number];

export interface OnboardingErrorPolicy {
  errorType: OnboardingErrorType;
  retryable: boolean;
  retryStrategy: OnboardingRetryStrategy;
}

export const ONBOARDING_ERROR_POLICY_BY_CODE: Record<OnboardingErrorCode, OnboardingErrorPolicy> = {
  invalid_transition: {
    errorType: 'validation',
    retryable: false,
    retryStrategy: 'none',
  },
  prerequisite_not_met: {
    errorType: 'dependency',
    retryable: false,
    retryStrategy: 'none',
  },
  step_not_skippable: {
    errorType: 'validation',
    retryable: false,
    retryStrategy: 'none',
  },
  readiness_checks_failed: {
    errorType: 'configuration',
    retryable: false,
    retryStrategy: 'after_remediation',
  },
  blocker_unresolved: {
    errorType: 'configuration',
    retryable: false,
    retryStrategy: 'after_remediation',
  },
  terminal_state_transition_denied: {
    errorType: 'validation',
    retryable: false,
    retryStrategy: 'none',
  },
  actor_not_authorized: {
    errorType: 'auth',
    retryable: false,
    retryStrategy: 'after_reauth',
  },
  idempotency_key_conflict: {
    errorType: 'validation',
    retryable: false,
    retryStrategy: 'none',
  },
  transition_write_conflict: {
    errorType: 'transient',
    retryable: true,
    retryStrategy: 'exponential_backoff',
  },
  step_payload_invalid: {
    errorType: 'validation',
    retryable: false,
    retryStrategy: 'none',
  },
  step_dependency_unavailable: {
    errorType: 'dependency',
    retryable: true,
    retryStrategy: 'exponential_backoff',
  },
  step_dependency_timeout: {
    errorType: 'transient',
    retryable: true,
    retryStrategy: 'exponential_backoff',
  },
  step_rate_limited: {
    errorType: 'dependency',
    retryable: true,
    retryStrategy: 'exponential_backoff',
  },
  configuration_missing: {
    errorType: 'configuration',
    retryable: false,
    retryStrategy: 'after_remediation',
  },
  resume_token_expired: {
    errorType: 'validation',
    retryable: false,
    retryStrategy: 'none',
  },
  resume_token_invalid: {
    errorType: 'auth',
    retryable: false,
    retryStrategy: 'none',
  },
  resume_token_replayed: {
    errorType: 'validation',
    retryable: false,
    retryStrategy: 'none',
  },
  retry_attempt_limit_reached: {
    errorType: 'configuration',
    retryable: false,
    retryStrategy: 'after_remediation',
  },
};

export const ONBOARDING_ERROR_DEFAULT_MESSAGE_BY_CODE: Record<OnboardingErrorCode, string> = {
  invalid_transition: 'Requested action is invalid for the current onboarding state.',
  prerequisite_not_met: 'A prerequisite onboarding step is incomplete.',
  step_not_skippable: 'This onboarding step cannot be skipped.',
  readiness_checks_failed: 'Readiness checks failed. Resolve blockers before continuing.',
  blocker_unresolved: 'A required blocker is unresolved.',
  terminal_state_transition_denied: 'No further transitions are allowed for this onboarding run.',
  actor_not_authorized: 'You are not authorized to perform this onboarding action.',
  idempotency_key_conflict: 'Request conflicts with an existing idempotency key.',
  transition_write_conflict: 'A concurrent onboarding update was detected. Retry shortly.',
  step_payload_invalid: 'Step input is invalid.',
  step_dependency_unavailable: 'A required dependency is temporarily unavailable.',
  step_dependency_timeout: 'A dependency timed out while processing the step.',
  step_rate_limited: 'The onboarding step is rate limited. Retry after backoff.',
  configuration_missing: 'Required configuration is missing for this onboarding step.',
  resume_token_expired: 'The resume token has expired. Refresh onboarding state and try again.',
  resume_token_invalid: 'The resume token is invalid for this onboarding run.',
  resume_token_replayed: 'The resume token is stale and has already been superseded.',
  retry_attempt_limit_reached: 'Retry attempt limit reached for this onboarding step.',
};
