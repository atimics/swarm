/**
 * Correlation ID utilities for distributed tracing across webhook -> SQS -> handlers.
 *
 * A correlationId ties together all log entries for a single inbound request
 * as it flows from the webhook handler, through SQS, and into downstream
 * processors (message-processor, response-sender, continuation-processor).
 */
import { randomUUID } from 'crypto';

/**
 * SQS message attribute name used to propagate the correlation ID.
 */
export const CORRELATION_ID_ATTR = 'correlationId';

/**
 * Generate a new correlation ID.
 * Uses the API Gateway requestId when available (preserving the original
 * request identity), otherwise falls back to a new UUID.
 */
export function generateCorrelationId(requestId?: string): string {
  return requestId || randomUUID();
}

/**
 * Extract a correlation ID from an API Gateway v2 event.
 * Checks:
 *   1. `x-correlation-id` header (in case an upstream proxy injected one)
 *   2. `requestContext.requestId` (API Gateway's own request ID)
 *   3. Falls back to generating a new UUID
 */
export function extractCorrelationIdFromApiEvent(event: {
  headers?: Record<string, string | undefined>;
  requestContext?: { requestId?: string };
}): string {
  const headers = event.headers || {};

  // Normalise header lookup to lowercase
  const lowerHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined) {
      lowerHeaders[k.toLowerCase()] = v;
    }
  }

  return (
    lowerHeaders['x-correlation-id'] ||
    event.requestContext?.requestId ||
    randomUUID()
  );
}

/**
 * Extract a correlation ID from an SQS record's message attributes.
 * Falls back to generating a new UUID if not present.
 */
export function extractCorrelationIdFromSqsRecord(record: {
  messageAttributes?: Record<string, { stringValue?: string }>;
}): string {
  return (
    record.messageAttributes?.[CORRELATION_ID_ATTR]?.stringValue ||
    randomUUID()
  );
}
