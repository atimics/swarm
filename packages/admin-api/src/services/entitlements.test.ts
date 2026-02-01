/**
 * Entitlements Service Tests
 */
import { describe, it, expect } from 'vitest';
import {
  PLAN_DEFAULTS,
  type PlanType,
  type PlanLimits,
} from '../types.js';

// Re-implement computeEffectiveLimits for testing (avoid DynamoDB dependencies)
function testComputeEffectiveLimits(
  plan: PlanType,
  overrides?: Partial<PlanLimits>
): PlanLimits {
  const defaults = PLAN_DEFAULTS[plan];
  if (!overrides) return { ...defaults };
  return { ...defaults, ...overrides };
}

describe('Entitlements', () => {
  describe('PLAN_DEFAULTS', () => {
    it('should have free tier with memory disabled', () => {
      const free = PLAN_DEFAULTS.free;
      expect(free.memoryEnabled).toBe(false);
      expect(free.memoryRetentionDays).toBe(0);
      expect(free.dailyMessageLimit).toBe(50);
      expect(free.dailyMediaCredits).toBe(5);
    });

    it('should have pro tier with memory enabled', () => {
      const pro = PLAN_DEFAULTS.pro;
      expect(pro.memoryEnabled).toBe(true);
      expect(pro.memoryRetentionDays).toBe(30);
      expect(pro.dailyMessageLimit).toBe(500);
      expect(pro.dailyMediaCredits).toBe(50);
    });

    it('should have enterprise tier with unlimited resources', () => {
      const enterprise = PLAN_DEFAULTS.enterprise;
      expect(enterprise.memoryEnabled).toBe(true);
      expect(enterprise.memoryRetentionDays).toBe(365);
      expect(enterprise.dailyMessageLimit).toBe(-1); // Unlimited
      expect(enterprise.dailyMediaCredits).toBe(-1); // Unlimited
      expect(enterprise.priorityProcessing).toBe(true);
    });
  });

  describe('computeEffectiveLimits', () => {
    it('should return plan defaults when no overrides', () => {
      const limits = testComputeEffectiveLimits('free');
      expect(limits).toEqual(PLAN_DEFAULTS.free);
    });

    it('should merge overrides with plan defaults', () => {
      const limits = testComputeEffectiveLimits('free', {
        dailyMessageLimit: 100,
        dailyMediaCredits: 10,
      });

      expect(limits.dailyMessageLimit).toBe(100);
      expect(limits.dailyMediaCredits).toBe(10);
      // Other defaults should remain
      expect(limits.memoryEnabled).toBe(false);
      expect(limits.maxToolCallsPerMessage).toBe(3);
    });

    it('should allow enabling memory on free tier via override', () => {
      const limits = testComputeEffectiveLimits('free', {
        memoryEnabled: true,
        memoryRetentionDays: 7,
      });

      expect(limits.memoryEnabled).toBe(true);
      expect(limits.memoryRetentionDays).toBe(7);
    });

    it('should allow downgrading pro limits via override', () => {
      const limits = testComputeEffectiveLimits('pro', {
        dailyMessageLimit: 100, // Lower than default 500
      });

      expect(limits.dailyMessageLimit).toBe(100);
      expect(limits.memoryEnabled).toBe(true); // Still pro default
    });
  });

  describe('PlanLimits schema', () => {
    it('should have all required fields in free tier', () => {
      const free = PLAN_DEFAULTS.free;
      expect(typeof free.memoryEnabled).toBe('boolean');
      expect(typeof free.memoryRetentionDays).toBe('number');
      expect(typeof free.maxMemoriesPerTier).toBe('number');
      expect(typeof free.dailyMessageLimit).toBe('number');
      expect(typeof free.dailyMediaCredits).toBe('number');
      expect(typeof free.dailyVoiceMinutes).toBe('number');
      expect(typeof free.maxToolCallsPerMessage).toBe('number');
      expect(typeof free.maxPlatforms).toBe('number');
      expect(typeof free.maxChannels).toBe('number');
      expect(typeof free.autonomousPostsEnabled).toBe('boolean');
      expect(typeof free.customModelEnabled).toBe('boolean');
      expect(typeof free.priorityProcessing).toBe('boolean');
    });
  });
});

describe('MemoryConfig', () => {
  it('should derive memory config from free tier', () => {
    const limits = PLAN_DEFAULTS.free;
    const memoryConfig = {
      enabled: limits.memoryEnabled,
      retentionDays: limits.memoryRetentionDays,
      consolidationEnabled: limits.memoryEnabled,
      semanticSearchEnabled: limits.memoryEnabled,
    };

    expect(memoryConfig.enabled).toBe(false);
    expect(memoryConfig.retentionDays).toBe(0);
    expect(memoryConfig.consolidationEnabled).toBe(false);
    expect(memoryConfig.semanticSearchEnabled).toBe(false);
  });

  it('should derive memory config from pro tier', () => {
    const limits = PLAN_DEFAULTS.pro;
    const memoryConfig = {
      enabled: limits.memoryEnabled,
      retentionDays: limits.memoryRetentionDays,
      consolidationEnabled: limits.memoryEnabled,
      semanticSearchEnabled: limits.memoryEnabled,
    };

    expect(memoryConfig.enabled).toBe(true);
    expect(memoryConfig.retentionDays).toBe(30);
    expect(memoryConfig.consolidationEnabled).toBe(true);
    expect(memoryConfig.semanticSearchEnabled).toBe(true);
  });
});
