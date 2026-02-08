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

export interface VanitySearchCandidate<T> {
  value: T;
  address: string;
}

export interface VanitySearchSelection<T> {
  selected: VanitySearchCandidate<T>;
  match: VanityMatchInfo;
  /**
   * Whether the selected candidate satisfied the requested policy.
   * In best-effort mode this can be false (fallback candidate).
   */
  satisfied: boolean;
  /**
   * Candidate index from the original list (0-based).
   */
  index: number;
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

/**
 * Select candidate according to vanity mode.
 *
 * strict:
 * - return first policy-satisfying candidate
 * - return null if none satisfy policy
 *
 * best_effort:
 * - return most recent satisfying candidate (any contains)
 * - if none satisfy, return most recent candidate as fallback
 */
export function selectVanityCandidate<T>(
  candidates: VanitySearchCandidate<T>[],
  config: ResolvedVanityMintConfig
): VanitySearchSelection<T> | null {
  if (candidates.length === 0) return null;

  if (config.mode === 'strict') {
    for (let i = 0; i < candidates.length; i += 1) {
      const match = evaluateVanityMatch(candidates[i].address, config);
      if (match.matched) {
        return {
          selected: candidates[i],
          match,
          satisfied: true,
          index: i,
        };
      }
    }
    return null;
  }

  let latestMatch: VanitySearchSelection<T> | null = null;
  for (let i = 0; i < candidates.length; i += 1) {
    const match = evaluateVanityMatch(candidates[i].address, config);
    if (match.matched) {
      latestMatch = {
        selected: candidates[i],
        match,
        satisfied: true,
        index: i,
      };
    }
  }

  if (latestMatch) return latestMatch;

  const fallbackIndex = candidates.length - 1;
  const fallback = candidates[fallbackIndex];
  return {
    selected: fallback,
    match: evaluateVanityMatch(fallback.address, config),
    satisfied: false,
    index: fallbackIndex,
  };
}
