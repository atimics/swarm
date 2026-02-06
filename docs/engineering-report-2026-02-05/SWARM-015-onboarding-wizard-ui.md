# SWARM-015: Onboarding Wizard UI

**Priority:** P1 - Next Sprint
**Package:** `@swarm/admin-ui`
**Risk:** Medium - major UX surface change

## Worker Assignment

- **Assigned Worker:** `worker-015` (planned)
- **Branch:** `feat/swarm-015`
- **Worktree:** `/Users/ratimics/develop/aws-swarm-swarm-015` (provision on kickoff)
- **Core Mission:** Replace fragmented setup prompts with one guided onboarding wizard driven by backend step state.

## Problem

Setup actions are currently distributed across modal flows and integration panels. Users can miss required actions or complete steps out of order.

## Solution

1. Create a dedicated onboarding route/surface with stepper state.
2. Render only valid next actions from orchestrator step metadata.
3. Keep advanced configuration outside the default onboarding path.

## Dependencies

- SWARM-012 contract.
- SWARM-013 orchestrator API.
- SWARM-014 auth handshake stabilization.

## Acceptance Criteria

- [ ] Single onboarding UI flow for new avatar setup
- [ ] Step actions are driven by backend-provided step metadata
- [ ] Required vs optional steps are clearly separated
- [ ] Users can leave and resume without losing progress
- [ ] Funnel events emitted for each step completion/failure
