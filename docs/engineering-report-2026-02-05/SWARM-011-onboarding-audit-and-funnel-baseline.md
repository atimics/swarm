# SWARM-011: Onboarding Audit and Funnel Baseline

**Priority:** P0 - Do Now
**Package:** `@swarm/admin-api`, `@swarm/admin-ui`, Docs
**Risk:** Low - additive observability and analysis

## Worker Assignment

- **Assigned Worker:** `worker-011` (planned)
- **Branch:** `feat/swarm-011`
- **Worktree:** `/Users/ratimics/develop/aws-swarm-swarm-011` (provision on kickoff)
- **Core Mission:** Establish a trusted baseline for onboarding drop-off, error classes, and time-to-activate before behavior changes.

## Problem

Onboarding failures are visible anecdotally but not measured consistently end-to-end. Without a baseline, an overhaul risks moving problems instead of removing them.

## Solution

1. Define canonical onboarding funnel stages and event names.
2. Add structured events and counters for each stage transition/failure.
3. Publish a baseline report covering completion rate, median setup time, and top failure reasons.

## Dependencies

- None (starting point for SWARM-012 through SWARM-020).

## Acceptance Criteria

- [ ] Funnel stages are documented and versioned (`onboarding_funnel_v1`)
- [ ] Admin API emits structured stage transition events
- [ ] Admin UI emits stage-entry/exit events (no PII leakage)
- [ ] Baseline report produced from staging/prod sample window
- [ ] Top 5 failure classes are identified with concrete counts
