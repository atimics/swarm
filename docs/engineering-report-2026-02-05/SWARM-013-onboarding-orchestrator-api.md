# SWARM-013: Onboarding Orchestrator API

**Priority:** P0 - Do Now
**Package:** `@swarm/admin-api`
**Risk:** Medium - introduces new API path and orchestration layer

## Worker Assignment

- **Assigned Worker:** `worker-013` (planned)
- **Branch:** `feat/swarm-013`
- **Worktree:** `/Users/ratimics/develop/aws-swarm-swarm-013` (provision on kickoff)
- **Core Mission:** Expose a single backend onboarding interface that executes and tracks steps idempotently.

## Problem

Onboarding requires clients to call multiple endpoint families directly, increasing coupling and handling complexity.

## Solution

1. Add onboarding orchestration endpoints (status, execute-step, restart, skip-optional).
2. Persist onboarding progress server-side.
3. Enforce idempotency and retry safety per step execution.

## Dependencies

- SWARM-012 state machine contract.

## Acceptance Criteria

- [ ] `GET /onboarding/{avatarId}` returns canonical onboarding state
- [ ] `POST /onboarding/{avatarId}/steps/{step}/execute` is idempotent
- [ ] Step errors return typed, user-safe codes/messages
- [ ] Retryable vs non-retryable failures are explicit
- [ ] API integration tests cover success, retry, timeout, and invalid-state cases
