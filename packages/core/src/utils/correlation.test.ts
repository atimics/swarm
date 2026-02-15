import { describe, it, expect } from 'vitest';
import {
  CORRELATION_ID_ATTR,
  generateCorrelationId,
  extractCorrelationIdFromApiEvent,
  extractCorrelationIdFromSqsRecord,
} from './correlation.js';

describe('correlation', () => {
  describe('CORRELATION_ID_ATTR', () => {
    it('should export the correlation ID attribute name', () => {
      expect(CORRELATION_ID_ATTR).toBe('correlationId');
    });
  });

  describe('generateCorrelationId', () => {
    it('should use requestId when provided', () => {
      const requestId = 'test-request-123';
      expect(generateCorrelationId(requestId)).toBe(requestId);
    });

    it('should generate a new UUID when requestId is not provided', () => {
      const id = generateCorrelationId();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });

    it('should generate a new UUID when requestId is undefined', () => {
      const id = generateCorrelationId(undefined);
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });

    it('should generate different UUIDs on consecutive calls', () => {
      const id1 = generateCorrelationId();
      const id2 = generateCorrelationId();
      expect(id1).not.toBe(id2);
    });
  });

  describe('extractCorrelationIdFromApiEvent', () => {
    it('should extract from x-correlation-id header', () => {
      const event = {
        headers: { 'x-correlation-id': 'header-correlation-123' },
        requestContext: { requestId: 'request-456' },
      };
      expect(extractCorrelationIdFromApiEvent(event)).toBe('header-correlation-123');
    });

    it('should handle case-insensitive header names', () => {
      const event = {
        headers: { 'X-Correlation-ID': 'header-correlation-123' },
        requestContext: { requestId: 'request-456' },
      };
      expect(extractCorrelationIdFromApiEvent(event)).toBe('header-correlation-123');
    });

    it('should fall back to requestContext.requestId when header is not present', () => {
      const event = {
        headers: {},
        requestContext: { requestId: 'request-789' },
      };
      expect(extractCorrelationIdFromApiEvent(event)).toBe('request-789');
    });

    it('should fall back to requestContext.requestId when headers is undefined', () => {
      const event = {
        requestContext: { requestId: 'request-abc' },
      };
      expect(extractCorrelationIdFromApiEvent(event)).toBe('request-abc');
    });

    it('should generate a new UUID when neither header nor requestId are present', () => {
      const event = {
        headers: {},
        requestContext: {},
      };
      const id = extractCorrelationIdFromApiEvent(event);
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });

    it('should generate a new UUID when event is empty', () => {
      const event = {};
      const id = extractCorrelationIdFromApiEvent(event);
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });

    it('should handle headers with undefined values', () => {
      const event = {
        headers: { 'some-header': undefined, 'x-correlation-id': 'test-123' },
      };
      expect(extractCorrelationIdFromApiEvent(event)).toBe('test-123');
    });

    it('should prioritize header over requestId', () => {
      const event = {
        headers: { 'x-correlation-id': 'from-header' },
        requestContext: { requestId: 'from-request-context' },
      };
      expect(extractCorrelationIdFromApiEvent(event)).toBe('from-header');
    });
  });

  describe('extractCorrelationIdFromSqsRecord', () => {
    it('should extract from message attributes', () => {
      const record = {
        messageAttributes: {
          correlationId: { stringValue: 'sqs-correlation-123' },
        },
      };
      expect(extractCorrelationIdFromSqsRecord(record)).toBe('sqs-correlation-123');
    });

    it('should generate a new UUID when messageAttributes is undefined', () => {
      const record = {};
      const id = extractCorrelationIdFromSqsRecord(record);
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });

    it('should generate a new UUID when messageAttributes is empty', () => {
      const record = {
        messageAttributes: {},
      };
      const id = extractCorrelationIdFromSqsRecord(record);
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });

    it('should generate a new UUID when correlationId attribute is missing', () => {
      const record = {
        messageAttributes: {
          otherAttribute: { stringValue: 'other-value' },
        },
      };
      const id = extractCorrelationIdFromSqsRecord(record);
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });

    it('should generate a new UUID when stringValue is undefined', () => {
      const record = {
        messageAttributes: {
          correlationId: {},
        },
      };
      const id = extractCorrelationIdFromSqsRecord(record);
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });
  });
});
