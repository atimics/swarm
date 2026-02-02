import { describe, expect, it } from 'vitest';

import { getEffectiveLimitsForAvatar } from './runtime-limits.js';

describe('runtime-limits.getEffectiveLimitsForAvatar', () => {
  it('treats trial entitlement as entitled', () => {
    const result = getEffectiveLimitsForAvatar('a1', {
      pk: 'ENTITLEMENT#acc1',
      sk: 'AVATAR#a1',
      accountId: 'acc1',
      avatarId: 'a1',
      plan: 'pro',
      status: 'trial',
      limits: {
        memoryEnabled: true,
        memoryRetentionDays: 7,
        maxMemoriesPerTier: 500,
        dailyMessageLimit: 123,
        dailyMediaCredits: 10,
        dailyVoiceMinutes: 5,
        maxToolCallsPerMessage: 8,
        maxPlatforms: 2,
        maxChannels: 10,
        autonomousPostsEnabled: true,
        customModelEnabled: false,
        priorityProcessing: true,
      },
      createdAt: 1,
      createdBy: 'actor',
      updatedAt: 1,
      updatedBy: 'actor',
      gsi1pk: 'AVATAR#a1',
      gsi1sk: 'ENTITLEMENT',
    });

    expect(result.source).toBe('entitlement');
    expect(result.plan).toBe('pro');
    expect(result.limits.dailyMessageLimit).toBe(123);
    expect(result.entitlementStatus).toBe('trial');
  });

  it('treats suspended entitlement as default/free', () => {
    const result = getEffectiveLimitsForAvatar('a1', {
      pk: 'ENTITLEMENT#acc1',
      sk: 'AVATAR#a1',
      accountId: 'acc1',
      avatarId: 'a1',
      plan: 'pro',
      status: 'suspended',
      limits: {
        memoryEnabled: true,
        memoryRetentionDays: 7,
        maxMemoriesPerTier: 500,
        dailyMessageLimit: 123,
        dailyMediaCredits: 10,
        dailyVoiceMinutes: 5,
        maxToolCallsPerMessage: 8,
        maxPlatforms: 2,
        maxChannels: 10,
        autonomousPostsEnabled: true,
        customModelEnabled: false,
        priorityProcessing: true,
      },
      createdAt: 1,
      createdBy: 'actor',
      updatedAt: 1,
      updatedBy: 'actor',
      gsi1pk: 'AVATAR#a1',
      gsi1sk: 'ENTITLEMENT',
    });

    expect(result.source).toBe('default');
    expect(result.plan).toBe('free');
    expect(result.entitlementStatus).toBe('suspended');
  });
});
