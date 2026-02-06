# SWARM-012: Onboarding State Machine Contract

**Priority:** P0 - Do Now
**Package:** `@swarm/admin-api`, `@swarm/core`
**Risk:** Medium - contract changes affect UI and API integration

## Worker Assignment

- **Assigned Worker:** `worker-012` (planned)
- **Branch:** `feat/swarm-012`
- **Worktree:** `/Users/ratimics/develop/aws-swarm-swarm-012` (provision on kickoff)
- **Core Mission:** Replace implicit onboarding flow with an explicit, validated state machine that is deterministic and resumable.

## Problem

Current onboarding logic is spread across handlers and UI prompts. Step validity and ordering are implicit, making edge cases and retries brittle.

## Solution

1. Define onboarding states, transitions, guards, and terminal states.
2. Define machine-readable step metadata for UI rendering.
3. Add strict transition validation in backend orchestration layer.

## Dependencies

- SWARM-011 baseline metrics for transition/failure prioritization.

## Acceptance Criteria

- [ ] State machine schema exists (states, events, guards, retry policy)
- [ ] Invalid transitions are rejected with typed errors
- [ ] State machine supports resume after interruption
- [ ] Contract is versioned (`onboarding_contract_v1`)
- [ ] Contract tests validate all valid/invalid transitions
