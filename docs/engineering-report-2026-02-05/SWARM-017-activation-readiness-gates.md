# SWARM-017: Activation Readiness Gates

**Priority:** P1 - Next Sprint
**Package:** `@swarm/admin-api`, `@swarm/admin-ui`
**Risk:** Medium - changes activation control logic

## Worker Assignment

- **Assigned Worker:** `worker-017` (planned)
- **Branch:** `feat/swarm-017`
- **Worktree:** `/Users/ratimics/develop/aws-swarm-swarm-017` (provision on kickoff)
- **Core Mission:** Block premature activation and enforce explicit readiness checks before production enablement.

## Problem

Users can attempt activation while setup is partially complete, which causes unstable runtime behavior and confusing first-run failures.

## Solution

1. Build a readiness report contract consumed by both API and UI.
2. Gate activation on required checks (auth/account, platform config, secrets, webhook health).
3. Show clear fix actions for each failing readiness check.

## Dependencies

- SWARM-013 orchestrator API.
- SWARM-015 onboarding wizard.
- SWARM-016 Telegram step reliability.

## Acceptance Criteria

- [ ] Activation endpoint rejects if required readiness checks fail
- [ ] UI shows readiness checklist with explicit pass/fail states
- [ ] Each failed check includes remediation guidance
- [ ] Successful activation is only possible from verified onboarding state
- [ ] Regression tests cover blocked and successful activation paths
