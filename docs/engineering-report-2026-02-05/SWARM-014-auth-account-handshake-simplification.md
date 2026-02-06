# SWARM-014: Auth and Account Handshake Simplification

**Priority:** P0 - Do Now
**Package:** `@swarm/admin-api`, `@swarm/admin-ui`
**Risk:** High - auth/session behavior is user-critical

## Worker Assignment

- **Assigned Worker:** `worker-014` (planned)
- **Branch:** `feat/swarm-014`
- **Worktree:** `/Users/ratimics/develop/aws-swarm-swarm-014` (provision on kickoff)
- **Core Mission:** Make account identity and session truth deterministic so onboarding cannot enter split-brain auth states.

## Problem

Onboarding stability still depends on multiple auth surfaces and transition paths. Identity-link/switch behavior remains error-prone in edge cases.

## Solution

1. Consolidate onboarding auth checks around one canonical account/session resolver.
2. Make link-vs-switch flows explicit and enforceable across UI/API.
3. Standardize onboarding-specific auth error responses for deterministic UI handling.

## Dependencies

- SWARM-012 contract.
- SWARM-013 orchestrator endpoint shape.

## Acceptance Criteria

- [ ] Onboarding uses one backend session/account truth path
- [ ] Link-vs-switch user flow is explicit in both API and UI contract
- [ ] No implicit identity switching during onboarding
- [ ] Session-expired behavior is deterministic and recoverable
- [ ] Regression tests cover wallet + crossmint onboarding transitions
