/**
 * Shared helpers for handling internal test key bypass logic.
 * Used by admin-api and runtime handlers to avoid auth drift.
 */

export function isProductionEnvironment(environment?: string, nodeEnv?: string): boolean {
  const value = (environment || nodeEnv || '').trim().toLowerCase();
  return value === 'prod' || value === 'production';
}

export function getHeaderValue(
  headers: Record<string, string | undefined> | undefined,
  name: string
): string | undefined {
  const exact = headers?.[name];
  if (exact) return exact;

  const target = name.toLowerCase();
  for (const [headerName, headerValue] of Object.entries(headers || {})) {
    if (headerName.toLowerCase() === target && headerValue) {
      return headerValue;
    }
  }

  return undefined;
}

export interface InternalTestKeyOptions {
  headers: Record<string, string | undefined> | undefined;
  internalTestKey?: string | null;
  environment?: string;
  nodeEnv?: string;
  headerName?: string;
}

/**
 * Returns true when:
 * - environment is NOT production, and
 * - internalTestKey is configured, and
 * - request contains a matching key in the configured header.
 */
export function hasValidInternalTestKey(options: InternalTestKeyOptions): boolean {
  if (
    isProductionEnvironment(options.environment, options.nodeEnv)
    || !options.internalTestKey
  ) {
    return false;
  }

  const headerName = options.headerName || 'x-internal-test-key';
  const provided = getHeaderValue(options.headers, headerName);
  return Boolean(provided && provided === options.internalTestKey);
}
