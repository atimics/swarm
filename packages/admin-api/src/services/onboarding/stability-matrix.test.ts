import { describe, expect, it } from 'vitest';
import {
  ONBOARDING_CONTRACT_VERSION_V1,
  applyOnboardingEvent,
  createInitialOnboardingState,
  type OnboardingGuardContext,
  type OnboardingStateSnapshot,
} from './contract-v1.js';

function allowContext(overrides: Partial<OnboardingGuardContext> = {}): OnboardingGuardContext {
  return {
    actor_authorized: true,
    idempotency_key_consistent: true,
    required_prerequisites_complete: true,
    step_is_optional: true,
    blocker_is_resolved: true,
    readiness_checks_passed: true,
    activation_not_already_completed: true,
    failure_is_non_retryable: true,
    ...overrides,
  };
}

function nextStateOrThrow(
  state: OnboardingStateSnapshot | string,
  event: Parameters<typeof applyOnboardingEvent>[1],
  context: OnboardingGuardContext
): OnboardingStateSnapshot {
  const result = applyOnboardingEvent(state as OnboardingStateSnapshot, event, context);
  if (!result.ok) {
    throw new Error(`${event} failed: ${result.error.code}`);
  }
  return result.next;
}

describe('onboarding stability matrix', () => {
  it('A1 canonical contract version is stable', () => {
    const initial = createInitialOnboardingState();
    expect(initial.contract_version).toBe(ONBOARDING_CONTRACT_VERSION_V1);
  });

  it('WF-01 happy path converges to completed (A2, A5)', () => {
    let state = createInitialOnboardingState();
    state = nextStateOrThrow(state, 'start_onboarding', allowContext());
    state = nextStateOrThrow(state, 'auth_verified', allowContext());
    state = nextStateOrThrow(state, 'profile_saved', allowContext());
    state = nextStateOrThrow(state, 'integration_verified', allowContext());
    state = nextStateOrThrow(state, 'readiness_verified', allowContext());
    state = nextStateOrThrow(state, 'activation_succeeded', allowContext());
    expect(state.state).toBe('completed');
  });

  it('WF-02 optional integration skip is deterministic (A4)', () => {
    const state: OnboardingStateSnapshot = {
      contract_version: ONBOARDING_CONTRACT_VERSION_V1,
      state: 'integration_pending',
      resume_target_state: null,
    };

    const skipped = applyOnboardingEvent(state, 'skip_optional_integration', allowContext({
      step_is_optional: true,
    }));
    expect(skipped.ok).toBe(true);
    if (skipped.ok) {
      expect(skipped.next.state).toBe('readiness_pending');
    }

    const blockedSkip = applyOnboardingEvent(state, 'skip_optional_integration', allowContext({
      step_is_optional: false,
    }));
    expect(blockedSkip.ok).toBe(false);
    if (!blockedSkip.ok) {
      expect(blockedSkip.error.code).toBe('step_not_skippable');
    }
  });

  it('EF-04 auth/session interruption blocks until re-auth, then resumes (A7, A8, A10)', () => {
    const state: OnboardingStateSnapshot = {
      contract_version: ONBOARDING_CONTRACT_VERSION_V1,
      state: 'profile_pending',
      resume_target_state: null,
    };

    const unauthorized = applyOnboardingEvent(state, 'profile_saved', allowContext({
      actor_authorized: false,
    }));
    expect(unauthorized.ok).toBe(false);
    if (!unauthorized.ok) {
      expect(unauthorized.error.code).toBe('actor_not_authorized');
    }

    const resumed = applyOnboardingEvent(state, 'profile_saved', allowContext({
      actor_authorized: true,
    }));
    expect(resumed.ok).toBe(true);
    if (resumed.ok) {
      expect(resumed.next.state).toBe('integration_pending');
    }
  });

  it('FR-01 retryable transient conflict converges after retry (A8, A9)', () => {
    const state: OnboardingStateSnapshot = {
      contract_version: ONBOARDING_CONTRACT_VERSION_V1,
      state: 'auth_pending',
      resume_target_state: null,
    };

    const conflict = applyOnboardingEvent(state, 'auth_verified', allowContext({
      required_prerequisites_complete: false,
    }));
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.error.code).toBe('prerequisite_not_met');
    }

    const retry = applyOnboardingEvent(state, 'auth_verified', allowContext({
      required_prerequisites_complete: true,
    }));
    expect(retry.ok).toBe(true);
    if (retry.ok) {
      expect(retry.next.state).toBe('profile_pending');
    }
  });

  it('FR-08 restart deterministically resets to auth_pending (A2)', () => {
    const state: OnboardingStateSnapshot = {
      contract_version: ONBOARDING_CONTRACT_VERSION_V1,
      state: 'ready_to_activate',
      resume_target_state: null,
    };

    const restarted = applyOnboardingEvent(state, 'restart_onboarding', allowContext());
    expect(restarted.ok).toBe(true);
    if (restarted.ok) {
      expect(restarted.next.state).toBe('auth_pending');
      expect(restarted.next.resume_target_state).toBe(null);
    }
  });
});

