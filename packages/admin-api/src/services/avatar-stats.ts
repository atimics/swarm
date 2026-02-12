/**
 * D&D-Style Avatar Stats Generation
 *
 * Generates deterministic ability scores from avatar creation timestamp.
 * Uses SHA256 hashing to simulate 4d6 drop lowest for each stat.
 */
import { createHash } from 'crypto';

/**
 * D&D ability scores with computed modifiers
 */
export interface AvatarStats {
  STR: number; // Strength - reserved for future use
  DEX: number; // Dexterity - Initiative modifier
  CON: number; // Constitution - reserved for future use
  INT: number; // Intelligence - reserved for future use
  WIS: number; // Wisdom - Interest check (reflective contexts)
  CHA: number; // Charisma - Interest check (social contexts)
  modifiers: {
    STR: number;
    DEX: number;
    CON: number;
    INT: number;
    WIS: number;
    CHA: number;
  };
}

const ABILITIES = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'] as const;
type AbilityName = (typeof ABILITIES)[number];

/**
 * Generate D&D ability scores from avatar createdAt timestamp.
 *
 * Method: 4d6 drop lowest simulation using deterministic hash bytes.
 * Score range: 3-18 (standard D&D range)
 * Modifier: (score - 10) / 2, rounded down (range: -4 to +4)
 *
 * @param createdAt - Avatar creation timestamp (milliseconds)
 * @param avatarId - Avatar ID for additional entropy
 * @returns AvatarStats with all 6 ability scores and modifiers
 */
export function generateAvatarStats(
  createdAt: number,
  avatarId: string
): AvatarStats {
  // Create deterministic seed from createdAt + avatarId
  const seed = `${createdAt}:${avatarId}:dnd-stats-v1`;
  const hash = createHash('sha256').update(seed).digest();

  const stats: Record<AbilityName, number> = {} as Record<AbilityName, number>;
  const modifiers: Record<AbilityName, number> = {} as Record<
    AbilityName,
    number
  >;

  ABILITIES.forEach((ability, index) => {
    // Use 4 bytes per ability to simulate 4d6 drop lowest
    const offset = index * 4;
    const dice = [
      (hash[offset] % 6) + 1,
      (hash[offset + 1] % 6) + 1,
      (hash[offset + 2] % 6) + 1,
      (hash[offset + 3] % 6) + 1,
    ];

    // Sort descending and sum top 3 (drop lowest)
    dice.sort((a, b) => b - a);
    const score = dice[0] + dice[1] + dice[2];

    stats[ability] = score;
    // D&D modifier formula: (score - 10) / 2, rounded down
    modifiers[ability] = Math.floor((score - 10) / 2);
  });

  return {
    STR: stats.STR,
    DEX: stats.DEX,
    CON: stats.CON,
    INT: stats.INT,
    WIS: stats.WIS,
    CHA: stats.CHA,
    modifiers,
  };
}

/**
 * Roll a d20 using crypto-safe random bytes
 * @returns Number between 1 and 20 inclusive
 */
export function rollD20(): number {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  const value = new DataView(bytes.buffer).getUint32(0, true);
  return (value % 20) + 1;
}

/**
 * Roll initiative: 1d20 + DEX modifier
 * @param stats - Avatar's ability scores
 * @returns Total initiative roll
 */
export function rollInitiative(stats: AvatarStats): {
  roll: number;
  modifier: number;
  total: number;
} {
  const roll = rollD20();
  const modifier = stats.modifiers.DEX;
  return {
    roll,
    modifier,
    total: roll + modifier,
  };
}

/**
 * Format stats for display/logging
 */
export function formatStats(stats: AvatarStats): string {
  return ABILITIES.map(
    (a) =>
      `${a}: ${stats[a]} (${stats.modifiers[a] >= 0 ? '+' : ''}${stats.modifiers[a]})`
  ).join(', ');
}
