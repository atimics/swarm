import { describe, expect, it } from 'bun:test';
import {
  buildOnboardingErrorEnvelope,
  resolveOnboardingErrorCode,
  toOnboardingErrorEnvelope,
} from './errors.js';

describe('onboarding errors', () => {
  it('builds envelope with policy metadata', () => {
    const envelope = buildOnboardingErrorEnvelope({
      errorCode: 'step_dependency_timeout',
      runId: 'run-1',
      state: 'integration_pending',
      step: 'connect_telegram',
      attempt: 1,
      maxAttempts: 3,
    });

    expect(envelope.errorType).toBe('transient');
    expect(envelope.retryable).toBe(true);
    expect(envelope.retryStrategy).toBe('exponential_backoff');
    expect(envelope.errorCode).toBe('step_dependency_timeout');
    expect(envelope.onboardingContractVersion).toBe('onboarding_contract_v1');
  });

  it('maps retryable failures to attempt-limit code', () => {
    const code = resolveOnboardingErrorCode('step_dependency_timeout', 3, 3);
    expect(code).toBe('retry_attempt_limit_reached');
  });

  it('infers timeout-like unknown errors', () => {
    const envelope = toOnboardingErrorEnvelope(
      new Error('Upstream request timed out'),
      {
        runId: 'run-2',
        state: 'integration_pending',
        step: 'connect_telegram',
      }
    );

    expect(envelope.errorCode).toBe('step_dependency_timeout');
    expect(envelope.retryStrategy).toBe('exponential_backoff');
  });
});
