import { describe, expect, it } from 'bun:test';
import { parseJsonBody } from './request-body.js';
import { isRequestValidationError } from '../middleware/validate.js';

describe('parseJsonBody', () => {
  it('parses valid JSON', () => {
    const result = parseJsonBody<{ foo: string }>({ body: '{"foo":"bar"}' });
    expect(result.foo).toBe('bar');
  });

  it('returns empty object for missing body by default', () => {
    const result = parseJsonBody<Record<string, unknown>>({ body: undefined });
    expect(result).toEqual({});
  });

  it('throws RequestValidationError on malformed JSON', () => {
    try {
      parseJsonBody({ body: '{"foo":' });
      throw new Error('expected parseJsonBody to throw');
    } catch (error) {
      expect(isRequestValidationError(error)).toBe(true);
      if (isRequestValidationError(error)) {
        expect(error.statusCode).toBe(400);
        expect(error.message).toBe('Invalid JSON body');
      }
    }
  });

  it('throws when body is required but missing', () => {
    try {
      parseJsonBody({ body: '' }, { requireBody: true });
      throw new Error('expected parseJsonBody to throw');
    } catch (error) {
      expect(isRequestValidationError(error)).toBe(true);
      if (isRequestValidationError(error)) {
        expect(error.statusCode).toBe(400);
        expect(error.message).toBe('Request body required');
      }
    }
  });
});
