/**
 * Core Constants
 * Centralized configuration values used across the swarm
 */

/**
 * Default LLM model for new avatars and fallback scenarios.
 * Each avatar stores their own model in llmConfig.model - this is just the default.
 */
export const DEFAULT_LLM_MODEL = 'google/gemini-3-flash-preview';

/**
 * Default LLM provider
 */
export const DEFAULT_LLM_PROVIDER = 'openrouter';

/**
 * Default LLM temperature
 */
export const DEFAULT_LLM_TEMPERATURE = 0.8;

/**
 * Default max tokens
 */
export const DEFAULT_LLM_MAX_TOKENS = 1024;

// =============================================================================
// RATI BURN TIER SYSTEM
// =============================================================================

/**
 * RATI token mint address on Solana
 */
export const RATI_MINT = 'Ci6Y1UX8bY4jxn6YiogJmdCxFEu2jmZhCcG65PStpump';

/**
 * Burn tier definition
 */
export interface BurnTier {
  tier: number;
  name: string;
  emoji: string;
  minBurned: number;
  maxEnergy: number;
  regenPerHour: number;
  features: readonly string[];
}

/**
 * RATI burn tiers - burn more RATI to unlock higher tiers
 * Each tier provides increased max energy, faster regen, and new features
 */
export const BURN_TIERS: readonly BurnTier[] = [
  {
    tier: 0,
    name: 'Spark',
    emoji: '✨',
    minBurned: 0,
    maxEnergy: 5,
    regenPerHour: 0.5,
    features: ['chat'],
  },
  {
    tier: 1,
    name: 'Ember',
    emoji: '🔸',
    minBurned: 100_000,        // 100K RATI
    maxEnergy: 10,
    regenPerHour: 1.0,
    features: ['chat', 'image'],
  },
  {
    tier: 2,
    name: 'Flame',
    emoji: '🔥',
    minBurned: 500_000,        // 500K RATI
    maxEnergy: 15,
    regenPerHour: 1.5,
    features: ['chat', 'image', 'voice'],
  },
  {
    tier: 3,
    name: 'Inferno',
    emoji: '🔥🔥',
    minBurned: 1_000_000,      // 1M RATI
    maxEnergy: 20,
    regenPerHour: 2.0,
    features: ['chat', 'image', 'voice', 'video', 'launch'],
  },
  {
    tier: 4,
    name: 'Supernova',
    emoji: '💥',
    minBurned: 5_000_000,      // 5M RATI
    maxEnergy: 30,
    regenPerHour: 3.0,
    features: ['chat', 'image', 'voice', 'video', 'launch', 'priority'],
  },
  {
    tier: 5,
    name: 'Ascended',
    emoji: '👑',
    minBurned: 10_000_000,     // 10M RATI
    maxEnergy: 50,
    regenPerHour: 5.0,
    features: ['chat', 'image', 'voice', 'video', 'launch', 'priority', 'unlimited'],
  },
] as const;

/**
 * Get the tier for a given burn amount
 */
export function getTierForBurnAmount(totalBurned: number): BurnTier {
  // Find the highest tier the user qualifies for
  for (let i = BURN_TIERS.length - 1; i >= 0; i--) {
    if (totalBurned >= BURN_TIERS[i].minBurned) {
      return BURN_TIERS[i];
    }
  }
  return BURN_TIERS[0];
}

/**
 * Get the next tier (for progress display)
 */
export function getNextTier(currentTier: number): BurnTier | null {
  const nextIndex = currentTier + 1;
  if (nextIndex >= BURN_TIERS.length) {
    return null; // Already at max tier
  }
  return BURN_TIERS[nextIndex];
}

/**
 * Calculate progress to next tier (0-100)
 */
export function getProgressToNextTier(totalBurned: number): number {
  const currentTier = getTierForBurnAmount(totalBurned);
  const nextTier = getNextTier(currentTier.tier);

  if (!nextTier) {
    return 100; // Already at max tier
  }

  const currentMin = currentTier.minBurned;
  const nextMin = nextTier.minBurned;
  const progress = ((totalBurned - currentMin) / (nextMin - currentMin)) * 100;

  return Math.min(100, Math.max(0, progress));
}
