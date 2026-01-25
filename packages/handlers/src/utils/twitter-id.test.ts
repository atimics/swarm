import { describe, it, expect } from 'bun:test';
import { compareTwitterIds, isTwitterIdGreater, maxTwitterId } from './twitter-id.js';

describe('Twitter ID comparison utilities', () => {
  describe('compareTwitterIds', () => {
    it('returns -1 when a < b', () => {
      expect(compareTwitterIds('123', '456')).toBe(-1);
      expect(compareTwitterIds('1234567890123456788', '1234567890123456789')).toBe(-1);
    });

    it('returns 1 when a > b', () => {
      expect(compareTwitterIds('456', '123')).toBe(1);
      expect(compareTwitterIds('1234567890123456789', '1234567890123456788')).toBe(1);
    });

    it('returns 0 when a === b', () => {
      expect(compareTwitterIds('123', '123')).toBe(0);
      expect(compareTwitterIds('1234567890123456789', '1234567890123456789')).toBe(0);
    });

    it('handles different length IDs correctly (where string comparison fails)', () => {
      // String comparison would fail here: '1' < '9' lexicographically
      // but 10000000000000000000 > 9999999999999999999 numerically
      expect(compareTwitterIds('10000000000000000000', '9999999999999999999')).toBe(1);
      expect(compareTwitterIds('9999999999999999999', '10000000000000000000')).toBe(-1);
    });
  });

  describe('isTwitterIdGreater', () => {
    it('returns true when a > b', () => {
      expect(isTwitterIdGreater('1234567890123456789', '1234567890123456788')).toBe(true);
    });

    it('returns false when a < b', () => {
      expect(isTwitterIdGreater('1234567890123456788', '1234567890123456789')).toBe(false);
    });

    it('returns false when a === b', () => {
      expect(isTwitterIdGreater('123', '123')).toBe(false);
    });

    it('handles different length IDs correctly', () => {
      // This is where string comparison would fail
      expect(isTwitterIdGreater('10000000000000000000', '9999999999999999999')).toBe(true);
      // Demonstrate the bug with string comparison
      expect('10000000000000000000' > '9999999999999999999').toBe(false); // String comparison is WRONG
    });
  });

  describe('maxTwitterId', () => {
    it('returns b when a is null', () => {
      expect(maxTwitterId(null, '123')).toBe('123');
    });

    it('returns b when a is undefined', () => {
      expect(maxTwitterId(undefined, '456')).toBe('456');
    });

    it('returns the larger ID numerically', () => {
      expect(maxTwitterId('123', '456')).toBe('456');
      expect(maxTwitterId('456', '123')).toBe('456');
    });

    it('handles equal IDs', () => {
      expect(maxTwitterId('123', '123')).toBe('123');
    });

    it('handles different length IDs correctly', () => {
      expect(maxTwitterId('9999999999999999999', '10000000000000000000')).toBe('10000000000000000000');
      expect(maxTwitterId('10000000000000000000', '9999999999999999999')).toBe('10000000000000000000');
    });
  });
});
