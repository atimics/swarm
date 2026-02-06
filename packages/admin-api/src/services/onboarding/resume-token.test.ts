import { describe, expect, it } from 'bun:test';
import {
  signOnboardingResumeToken,
  verifyOnboardingResumeToken,
} from './resume-token.js';

const SECRET = 'onboarding_resume_secret_for_tests_12345';

describe('onboarding resume token', () => {
  it('signs and verifies token payload', () => {
    const signed = signOnboardingResumeToken(
      {
        avatarId: 'avatar-1',
        runId: 'run-1',
        state: 'integration_pending',
        step: 'connect_telegram',
        failureSeq: 2,
      },
      { secret: SECRET }
    );

    const verified = verifyOnboardingResumeToken(signed.token, {
      secret: SECRET,
      expectedAvatarId: 'avatar-1',
      expectedRunId: 'run-1',
    });

    expect(verified.valid).toBe(true);
    if (verified.valid) {
      expect(verified.claims.failureSeq).toBe(2);
      expect(verified.claims.v).toBe('onboarding_contract_v1');
    }
  });

  it('rejects expired tokens', () => {
    const signed = signOnboardingResumeToken(
      {
        avatarId: 'avatar-2',
        runId: 'run-2',
        state: 'auth_pending',
        step: 'connect_wallet',
        failureSeq: 0,
        ttlMs: 1,
      },
      {
        secret: SECRET,
        now: () => 1_000,
      }
    );

    const verified = verifyOnboardingResumeToken(signed.token, {
      secret: SECRET,
      now: () => 2_000,
    });

    expect(verified.valid).toBe(false);
    if (!verified.valid) {
      expect(verified.error.errorCode).toBe('resume_token_expired');
    }
  });

  it('rejects replayed tokens with stale failure sequence', () => {
    const signed = signOnboardingResumeToken(
      {
        avatarId: 'avatar-3',
        runId: 'run-3',
        state: 'blocked',
        step: 'connect_telegram',
        failureSeq: 1,
      },
      { secret: SECRET }
    );

    const verified = verifyOnboardingResumeToken(signed.token, {
      secret: SECRET,
      minFailureSeq: 2,
    });

    expect(verified.valid).toBe(false);
    if (!verified.valid) {
      expect(verified.error.errorCode).toBe('resume_token_replayed');
    }
  });
});
