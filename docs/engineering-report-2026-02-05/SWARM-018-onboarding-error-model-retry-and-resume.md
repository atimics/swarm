# SWARM-018: Onboarding Error Model, Retry, and Resume

**Priority:** P1 - Next Sprint
**Package:** `@swarm/admin-api`, `@swarm/admin-ui`, `@swarm/core`
**Risk:** Medium - error semantics are cross-cutting

## Worker Assignment

- **Assigned Worker:** `worker-018` (planned)
- **Branch:** `feat/swarm-018`
- **Worktree:** `/Users/ratimics/develop/aws-swarm-swarm-018` (provision on kickoff)
- **Core Mission:** Make onboarding failures predictable and recoverable with typed errors, retry policy, and resumable execution.

## Problem

Users currently see mixed failure messaging and inconsistent retry behavior across setup steps.

## Solution

1. Define onboarding error taxonomy (`validation`, `transient`, `dependency`, `auth`, `configuration`).
2. Add per-step retry policy and backoff hints.
3. Persist step failure history and resume tokens for support/debugging.

## Dependencies

- SWARM-012 contract.
- SWARM-013 orchestrator API.

## Acceptance Criteria

- [ ] Every onboarding step failure maps to a typed error class
- [ ] Retryability is explicit in API responses
- [ ] Resume after refresh/session recovery preserves progress safely
- [ ] UI uses typed errors for deterministic remediation guidance
- [ ] Logs include correlation IDs for each onboarding attempt
