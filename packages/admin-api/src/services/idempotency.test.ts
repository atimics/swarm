import { describe, it, expect } from 'bun:test';
import { createIdempotencyStore } from './idempotency.js';

describe('idempotency store', () => {
  it('returns cached value within ttl', () => {
    let now = 1000;
    const store = createIdempotencyStore<string>({ now: () => now, ttlMs: 100 });

    store.set('key', 'value');
    expect(store.get('key')).toBe('value');

    now += 50;
    expect(store.get('key')).toBe('value');
  });

  it('expires values after ttl', () => {
    let now = 1000;
    const store = createIdempotencyStore<string>({ now: () => now, ttlMs: 100 });

    store.set('key', 'value');
    now += 200;

    expect(store.get('key')).toBe(null);
  });
});
