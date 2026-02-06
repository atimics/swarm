# SWARM-020: Onboarding Rollout, Migration, and Runbooks

**Priority:** P1 - Next Sprint
**Package:** Docs, `@swarm/admin-api`, `@swarm/admin-ui`, Ops
**Risk:** Medium - rollout quality determines user impact

## Worker Assignment

- **Assigned Worker:** `worker-020` (planned)
- **Branch:** `feat/swarm-020`
- **Worktree:** `/Users/ratimics/develop/aws-swarm-swarm-020` (provision on kickoff)
- **Core Mission:** Ship onboarding overhaul safely with staged rollout controls, support playbooks, and clear rollback paths.

## Problem

Even a strong onboarding redesign can cause incidents if rollout, migration, and support handling are not explicitly engineered.

## Solution

1. Add feature flags and staged rollout plan by cohort.
2. Publish runbooks for support and incident triage.
3. Define rollback criteria and fallback behavior to prior onboarding path.

## Dependencies

- SWARM-011 through SWARM-019 completion at review level.

## Acceptance Criteria

- [ ] Feature-flagged rollout supports cohort-based enablement
- [ ] Operational runbook exists for onboarding incidents
- [ ] Rollback procedure is tested in staging
- [ ] Success SLOs and alert thresholds are defined
- [ ] Post-rollout report compares baseline vs new funnel metrics
