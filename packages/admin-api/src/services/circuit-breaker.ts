// Re-export from @swarm/core — canonical implementation lives there.
// This file kept for backwards compatibility with existing imports.
export { createCircuitBreaker, type CircuitBreaker, type CircuitState } from '@swarm/core';

import { createCircuitBreaker } from '@swarm/core';

export const llmCircuitBreaker = createCircuitBreaker();
