/**
 * Vanity mint policy helpers.
 *
 * Base58 is case-sensitive, so "RATi" and "RATI" are different patterns.
 */

export type VanityMintMode = 'best_effort' | 'strict';
export type VanityMatchPosition = 'prefix' | 'suffix' | 'contains' | 'none';

export interface VanityMintConfig {
  /**
   * Base58 pattern to target. Defaults to "RATi".
   * Note: uppercase "I" is not valid base58.
   */
  pattern?: string;
  /**
   * strict:
   * - only prefix/suffix matches satisfy policy
   *
   * best_effort:
   * - any contains match is acceptable
   */
  mode?: VanityMintMode;
  /**
   * Planned for native engine key grinding.
   * Currently ignored by the external Bags-backed path.
   */
  maxSearchMs?: number;
  /**
   * Planned for native engine key grinding.
   * Currently ignored by the external Bags-backed path.
   */
  maxAttempts?: number;
}

export interface ResolvedVanityMintConfig {
  pattern: string;
  mode: VanityMintMode;
  maxSearchMs: number;
  maxAttempts: number;
}

export interface VanityMatchInfo {
  matched: boolean;
  position: VanityMatchPosition;
}

const BASE58_PATTERN = /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/;

const DEFAULT_PATTERN = 'RATi';
const DEFAULT_MODE: VanityMintMode = 'best_effort';
const DEFAULT_MAX_SEARCH_MS = 15_000;
const DEFAULT_MAX_ATTEMPTS = 11_316_496; // 58^4, expected trials for 4-char suffix

export function resolveVanityMintConfig(config?: VanityMintConfig): ResolvedVanityMintConfig | null {
  if (!config) return null;

  const pattern = (config.pattern || DEFAULT_PATTERN).trim();
  if (!pattern) {
    throw new Error('Vanity mint pattern cannot be empty');
  }
  if (!BASE58_PATTERN.test(pattern)) {
    throw new Error(
      'Vanity mint pattern must use base58 characters only (1-9, A-H, J-N, P-Z, a-k, m-z)'
    );
  }

  return {
    pattern,
    mode: config.mode || DEFAULT_MODE,
    maxSearchMs: config.maxSearchMs && config.maxSearchMs > 0 ? config.maxSearchMs : DEFAULT_MAX_SEARCH_MS,
    maxAttempts: config.maxAttempts && config.maxAttempts > 0 ? config.maxAttempts : DEFAULT_MAX_ATTEMPTS,
  };
}

export function getVanityMatchPosition(address: string, pattern: string): VanityMatchPosition {
  if (address.startsWith(pattern)) return 'prefix';
  if (address.endsWith(pattern)) return 'suffix';
  if (address.includes(pattern)) return 'contains';
  return 'none';
}

export function evaluateVanityMatch(address: string, config: ResolvedVanityMintConfig): VanityMatchInfo {
  const position = getVanityMatchPosition(address, config.pattern);
  if (config.mode === 'strict') {
    return { matched: position === 'prefix' || position === 'suffix', position };
  }
  return { matched: position !== 'none', position };
}
