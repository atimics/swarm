import { describe, it, expect } from 'bun:test';
import { createCircuitBreaker } from './circuit-breaker.js';

describe('circuit breaker', () => {
  it('opens after failure threshold and recovers after cooldown', () => {
    let now = 0;
    const breaker = createCircuitBreaker({ failureThreshold: 2, cooldownMs: 1000, now: () => now });

    expect(breaker.state()).toBe('closed');
    breaker.recordFailure();
    expect(breaker.state()).toBe('closed');
    breaker.recordFailure();
    expect(breaker.state()).toBe('open');

    expect(breaker.canExecute()).toBe(false);

    now = 1500;
    expect(breaker.canExecute()).toBe(true);
    expect(breaker.state()).toBe('half-open');

    breaker.recordSuccess();
    expect(breaker.state()).toBe('closed');
  });
});
