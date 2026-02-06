# SWARM-016: Telegram Step Diagnostics and Repair

**Priority:** P1 - Next Sprint
**Package:** `@swarm/admin-api`, `@swarm/admin-ui`
**Risk:** Medium - touches user-facing integration setup flow

## Worker Assignment

- **Assigned Worker:** `worker-016` (planned)
- **Branch:** `feat/swarm-016`
- **Worktree:** `/Users/ratimics/develop/aws-swarm-swarm-016` (provision on kickoff)
- **Core Mission:** Convert Telegram onboarding from multi-action manual setup into one verified step with built-in diagnosis and auto-repair.

## Problem

Telegram setup still requires manual interpretation of multiple statuses and can leave users unsure if the integration is actually ready.

## Solution

1. Define a single Telegram onboarding step contract (`pending`, `verified`, `repairable`, `blocked`).
2. Auto-run diagnostics after token/setup actions.
3. Offer one-click repair and re-validation when repairable.

## Dependencies

- SWARM-012 contract.
- SWARM-013 orchestrator API.
- SWARM-015 onboarding wizard.

## Acceptance Criteria

- [ ] Telegram onboarding step returns deterministic readiness status
- [ ] Diagnostics result is normalized and consumable by wizard UI
- [ ] Repair action is idempotent and re-runs diagnostics automatically
- [ ] Final user state is binary: ready vs not ready (with actionable reason)
- [ ] Integration tests cover webhook mismatch, missing secret, and token invalid paths
