/**
 * Shared fetch-with-retry utility for external API calls.
 * Provides exponential backoff with jitter for transient failures.
 */

export interface FetchRetryOptions {
  /** Maximum number of retry attempts (default: 2) */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff (default: 500) */
  baseDelayMs?: number;
  /** Maximum delay in ms (default: 5000) */
  maxDelayMs?: number;
  /** Timeout per request in ms (default: 20000) */
  timeoutMs?: number;
  /** HTTP status codes that should trigger a retry (default: [429, 500, 502, 503, 504]) */
  retryableStatuses?: number[];
}

const DEFAULT_RETRYABLE_STATUSES = [429, 500, 502, 503, 504];

/**
 * Fetch with automatic retry on transient errors.
 * Retries on network errors (ECONNRESET, ETIMEDOUT, AbortError) and configurable HTTP status codes.
 */
export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  options?: FetchRetryOptions
): Promise<Response> {
  const maxRetries = options?.maxRetries ?? 2;
  const baseDelayMs = options?.baseDelayMs ?? 500;
  const maxDelayMs = options?.maxDelayMs ?? 5000;
  const timeoutMs = options?.timeoutMs ?? 20_000;
  const retryableStatuses = options?.retryableStatuses ?? DEFAULT_RETRYABLE_STATUSES;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    // Merge caller's signal with our timeout
    const callerSignal = init?.signal;
    if (callerSignal?.aborted) {
      clearTimeout(timeoutId);
      throw new DOMException('The operation was aborted.', 'AbortError');
    }

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });

      // Don't retry client errors (4xx) except 429
      if (response.ok || !retryableStatuses.includes(response.status)) {
        return response;
      }

      // Retryable HTTP status
      lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);

      // Respect Retry-After header if present
      const retryAfter = response.headers.get('Retry-After');
      if (retryAfter && attempt < maxRetries) {
        const retryMs = Number(retryAfter) * 1000;
        if (!isNaN(retryMs) && retryMs > 0 && retryMs <= maxDelayMs) {
          await sleep(retryMs);
          continue;
        }
      }
    } catch (error) {
      lastError = error;

      // Don't retry if caller explicitly aborted
      if (callerSignal?.aborted) {
        throw error;
      }

      // Only retry on network/timeout errors
      const isRetryable =
        error instanceof Error &&
        (error.name === 'AbortError' ||
          error.message.includes('ECONNRESET') ||
          error.message.includes('ETIMEDOUT') ||
          error.message.includes('ENOTFOUND') ||
          error.message.includes('fetch failed'));

      if (!isRetryable) {
        throw error;
      }
    } finally {
      clearTimeout(timeoutId);
    }

    // Exponential backoff with jitter before retrying
    if (attempt < maxRetries) {
      const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
      const jitter = delay * 0.3 * Math.random();
      await sleep(delay + jitter);
    }
  }

  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
