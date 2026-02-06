/**
 * Circuit Breaker — prevents cascading failures when downstream services are unhealthy.
 *
 * State machine:
 *   closed  → (failure threshold reached) → open
 *   open    → (cooldown elapsed)          → half-open
 *   half-open → (success)                 → closed
 *   half-open → (failure)                 → open
 *
 * Usage:
 *   const breaker = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 30_000 });
 *   if (!breaker.canExecute()) throw new Error('Circuit open');
 *   try { await callService(); breaker.recordSuccess(); }
 *   catch (e) { breaker.recordFailure(); throw e; }
 */

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreaker {
  state: () => CircuitState;
  canExecute: () => boolean;
  recordSuccess: () => void;
  recordFailure: () => void;
  reset: () => void;
}

export function createCircuitBreaker(params?: {
  failureThreshold?: number;
  cooldownMs?: number;
  now?: () => number;
}): CircuitBreaker {
  const failureThreshold = params?.failureThreshold ?? 5;
  const cooldownMs = params?.cooldownMs ?? 30_000;
  const now = params?.now ?? (() => Date.now());

  let failures = 0;
  let openedAt: number | null = null;
  let state: CircuitState = 'closed';

  const transitionTo = (next: CircuitState) => {
    state = next;
    if (next === 'closed') {
      failures = 0;
      openedAt = null;
    }
  };

  const canExecute = () => {
    if (state === 'closed') return true;
    if (state === 'half-open') return true;
    if (state === 'open') {
      if (openedAt !== null && now() - openedAt >= cooldownMs) {
        state = 'half-open';
        return true;
      }
      return false;
    }
    return false;
  };

  const recordSuccess = () => {
    transitionTo('closed');
  };

  const recordFailure = () => {
    failures += 1;
    if (failures >= failureThreshold) {
      state = 'open';
      openedAt = now();
    }
  };

  const reset = () => {
    transitionTo('closed');
  };

  return {
    state: () => state,
    canExecute,
    recordSuccess,
    recordFailure,
    reset,
  };
}
