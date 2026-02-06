# SWARM-019: Onboarding E2E and Stability Tests

**Priority:** P1 - Next Sprint
**Package:** `@swarm/admin-api`, `@swarm/admin-ui`
**Risk:** Low - additive test and validation coverage

## Worker Assignment

- **Assigned Worker:** `worker-019` (planned)
- **Branch:** `feat/swarm-019`
- **Worktree:** `/Users/ratimics/develop/aws-swarm-swarm-019` (provision on kickoff)
- **Core Mission:** Protect onboarding overhaul quality with deterministic integration and end-to-end stability coverage.

## Problem

Without high-confidence test coverage, onboarding improvements can regress quickly due to auth, platform, and UI interaction complexity.

## Solution

1. Add contract tests for onboarding state machine and orchestrator API.
2. Add end-to-end happy path and failure path tests.
3. Add resilience tests for retries/timeouts/interrupted sessions.

## Dependencies

- SWARM-012 through SWARM-018 core contracts and flows.

## Acceptance Criteria

- [ ] E2E tests cover wallet-first and email-first onboarding paths
- [ ] Failure-path tests cover Telegram setup errors and retry recovery
- [ ] Auth/session interruption tests verify resume behavior
- [ ] CI includes onboarding stability suite in required checks
- [ ] Test artifacts identify the step and root-cause on failure
