/**
 * Twitter ID (Snowflake) comparison utilities
 *
 * Twitter IDs are 64-bit integers represented as strings.
 * String comparison works for same-length IDs but fails when
 * ID lengths differ. Use BigInt for reliable comparison.
 */

/**
 * Compare two Twitter snowflake IDs numerically
 * @returns -1 if a < b, 0 if a === b, 1 if a > b
 */
export function compareTwitterIds(a: string, b: string): number {
  const bigA = BigInt(a);
  const bigB = BigInt(b);
  if (bigA < bigB) return -1;
  if (bigA > bigB) return 1;
  return 0;
}

/**
 * Check if ID a is greater than ID b (numerically)
 */
export function isTwitterIdGreater(a: string, b: string): boolean {
  return BigInt(a) > BigInt(b);
}

/**
 * Get the maximum of two Twitter IDs (numerically)
 * Returns b if a is null/undefined
 */
export function maxTwitterId(a: string | null | undefined, b: string): string {
  if (!a) return b;
  return isTwitterIdGreater(a, b) ? a : b;
}
