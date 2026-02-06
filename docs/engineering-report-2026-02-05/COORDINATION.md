# SWARM Coordination Snapshot - 2026-02-06

## Scope

This snapshot aligns SWARM tickets with actual git worktree and branch state so agents can coordinate without stepping on each other.

## Assignment Authority

- Swarm coordinator: `codex`
- Authority: the coordinator may assign or reassign workers, define core mission statements, and change execution order by updating this file plus the corresponding `SWARM-00x` ticket document.
- Assignment rule: ticket ownership is official only when worker, branch, and mission are all present in this file and the ticket document.

## Governance Mode

**Active mode (effective 2026-02-06):** `mainline-first`

In this mode:
- `main` commit history is the delivery source of truth.
- Ticket branches are coordination lanes and may be marked superseded if work lands directly on `main`.
- Ticket closure may be recorded as `completed-by-commit` when closure criteria are met.

### Closure Criteria (`completed-by-commit`)

A ticket may be closed without a ticket-branch PR when all are true:
1. At least one `main` commit explicitly maps to the ticket scope.
2. The changed files materially satisfy ticket acceptance intent.
3. Evidence commit SHA(s) are recorded in this document.
4. Residual risks or follow-up validation items are recorded.
5. Coordinator marks ticket status as `completed-by-commit`.

## Observed Repository State

Snapshot collected on **2026-02-06** from:
- `git worktree list`
- `git -C <worktree> status --short --branch`
- `git branch --list 'feat/swarm-*' -v`

### Current Findings

- `main` is at `33fdda5` and currently synced with `origin/main`.
- Local SWARM branches currently present: `feat/swarm-008`, `feat/swarm-009`, `feat/swarm-010` (all at `3223c53`).
- Local SWARM worktrees currently present: `swarm-008`, `swarm-009`, `swarm-010`.
- SWARM-001/002/003/004 were delivered via `main` commits and are tracked via closure ledger.
- SWARM-007 has mainline progress (`22b7ed6`) but is not yet marked complete.
- Current uncommitted activity in `main` is infra plus type/test additions; see Change Watch.

## Worker Assignment Matrix

| Worker | Ticket | Branch | Worktree | Core Mission | Status (2026-02-06) | Notes |
|--------|--------|--------|----------|--------------|-----------------------|-------|
| `worker-001` | SWARM-001 | `(deprovisioned locally)` | `(deprovisioned locally)` | Add fail-fast LLM protection in `message-processor` using shared circuit breaker logic from `@swarm/core`. | Completed-by-commit | Implemented on `main` via `f18a552` |
| `worker-002` | SWARM-002 | `(deprovisioned locally)` | `(deprovisioned locally)` | Replace duplicated secret fetching with shared `loadAvatarSecrets()` utility in all targeted handlers. | Completed-by-commit | Implemented on `main` via `3223c53` |
| `worker-003` | SWARM-003 | `(deprovisioned locally)` | `(deprovisioned locally)` | Introduce canonical `DEFAULT_AVATAR_CONFIG` and remove divergent inline fallback objects. | Completed-by-commit | Implemented on `main` via `3223c53` |
| `worker-004` | SWARM-004 | `(deprovisioned locally)` | `(deprovisioned locally)` | Establish consistent formatting and coverage guardrails (`.editorconfig`, `.prettierrc`, lint-staged, vitest thresholds). | Completed-by-commit | Implemented on `main` via `edad325` |
| `worker-005` | SWARM-005 | `(not present locally)` | `(not provisioned)` | Decompose oversized files into focused modules while preserving existing exports and behavior. | Planned / not active | Local branch/worktree not currently provisioned |
| `worker-006` | SWARM-006 | `(not present locally)` | `(not provisioned)` | Wire all current CloudWatch alarms to actionable SNS notifications without replacements. | Planned / not active | Local branch/worktree not currently provisioned |
| `worker-007` | SWARM-007 | `(not present locally)` | `(not provisioned)` | Add high-value tests for LLM services, avatars handler, Discord adapter, and worker critical paths. | In progress on mainline | Commit `22b7ed6` adds LLM tests; broader ticket still open |
| `worker-008` | SWARM-008 | `feat/swarm-008` | `/Users/ratimics/develop/aws-swarm-swarm-008` | Harden security posture with WAF, scoped Bedrock IAM, queue encryption, and workflow cleanup. | Blocked (dirty worktree) | Worktree has unexpected tracked deletions across repo root files |
| `worker-009` | SWARM-009 | `feat/swarm-009` | `/Users/ratimics/develop/aws-swarm-swarm-009` | Remove legacy code paths and duplicate types after migration and compatibility verification. | Assigned, not started | Branch/worktree present and clean at `3223c53` |
| `worker-010` | SWARM-010 | `feat/swarm-010` | `/Users/ratimics/develop/aws-swarm-swarm-010` | Improve operational resilience with EventBridge DLQs, configurable LLM limits, and deploy/admin-api maintainability work. | Assigned, not started | Branch/worktree present and clean at `3223c53` |

## Ticket Closure Ledger (Mainline-First)

| Ticket | Closure | Evidence Commits | Residual Follow-Up |
|--------|---------|------------------|--------------------|
| SWARM-001 | Completed-by-commit | `f18a552` | Confirm acceptance checklist in ticket doc and close worker branch as superseded |
| SWARM-002 | Completed-by-commit | `3223c53` | Confirm message-processor side completed as intended and close worker branch as superseded |
| SWARM-003 | Completed-by-commit | `3223c53` | Confirm all fallback sites migrated and close worker branch as superseded |
| SWARM-004 | Completed-by-commit | `edad325` | Confirm lint/coverage gate behavior in CI and close worker branch as superseded |

## Planned Story Set - Onboarding Overhaul (SWARM-011 to SWARM-020)

Status: planned backlog, not yet provisioned as local worktrees/branches.

| Worker | Ticket | Proposed Branch | Worktree | Status | Notes |
|--------|--------|-----------------|----------|--------|-------|
| `worker-011` | SWARM-011 | `feat/swarm-011` | `/Users/ratimics/develop/aws-swarm-swarm-011` | Planned | Baseline metrics and funnel instrumentation kickoff |
| `worker-012` | SWARM-012 | `feat/swarm-012` | `/Users/ratimics/develop/aws-swarm-swarm-012` | Planned | State machine contract and transition guards |
| `worker-013` | SWARM-013 | `feat/swarm-013` | `/Users/ratimics/develop/aws-swarm-swarm-013` | Planned | Onboarding orchestrator API and idempotent step execution |
| `worker-014` | SWARM-014 | `feat/swarm-014` | `/Users/ratimics/develop/aws-swarm-swarm-014` | Planned | Auth/account handshake hardening for onboarding |
| `worker-015` | SWARM-015 | `feat/swarm-015` | `/Users/ratimics/develop/aws-swarm-swarm-015` | Planned | Unified wizard UI |
| `worker-016` | SWARM-016 | `feat/swarm-016` | `/Users/ratimics/develop/aws-swarm-swarm-016` | Planned | Telegram verified step with diagnostics/repair |
| `worker-017` | SWARM-017 | `feat/swarm-017` | `/Users/ratimics/develop/aws-swarm-swarm-017` | Planned | Activation readiness gate enforcement |
| `worker-018` | SWARM-018 | `feat/swarm-018` | `/Users/ratimics/develop/aws-swarm-swarm-018` | Planned | Typed error model plus retry/resume |
| `worker-019` | SWARM-019 | `feat/swarm-019` | `/Users/ratimics/develop/aws-swarm-swarm-019` | Planned | End-to-end and resilience test suite |
| `worker-020` | SWARM-020 | `feat/swarm-020` | `/Users/ratimics/develop/aws-swarm-swarm-020` | Planned | Rollout controls, migration, and runbooks |

## Engineering Change Watch (Docs-Only Monitoring)

Snapshot intent: monitor engineering activity without editing runtime code.

### Recent SWARM-Relevant Commits on `main`

| Commit | Message | Ticket Impact | Files |
|--------|---------|---------------|-------|
| `33fdda5` | `docs: update coordination snapshot and engineering report` | Coordination metadata | `docs/engineering-report-2026-02-05/*` |
| `22b7ed6` | `test(core): add LLM service tests (SWARM-007)` | SWARM-007 (partial) | `packages/core/src/services/llm/index.test.ts` |
| `3a008cf` | `feat(admin-api): sync runtime contract with burn/energy augmentations` | Adjacent SWARM-010 | `packages/admin-api/src/handlers/avatars.ts`, `packages/admin-api/src/handlers/wallet-auth.ts`, `packages/admin-api/src/services/runtime-limits.ts` |
| `64c21e4` | `feat(handlers): wire entitlement-based media usage gating` | Adjacent SWARM-010 | `packages/handlers/src/media-processor.ts`, `packages/handlers/src/tweet-poster.ts`, `packages/handlers/src/autonomous-tweet-poster.ts`, `packages/handlers/src/services/platform-mcp-adapter.ts` |
| `4a123a0` | `feat(handlers): introduce RuntimeContract and refactor entitlement enforcement` | Adjacent SWARM-010 / SWARM-005 | `packages/handlers/src/services/entitlement-enforcement.ts` and related runtime contract paths |
| `edad325` | `chore: add developer tooling configs (SWARM-004)` | SWARM-004 | `.editorconfig`, `.prettierrc`, `package.json`, `vitest.config.ts` |
| `f18a552` | `feat(core): add circuit breaker and wire into message processor (SWARM-001)` | SWARM-001 | `packages/core/src/services/circuit-breaker.ts`, `packages/core/src/services/index.ts`, `packages/admin-api/src/services/circuit-breaker.ts`, `packages/handlers/src/message-processor.ts` |
| `3223c53` | `refactor(handlers): extract DEFAULT_AVATAR_CONFIG and consolidate secrets (SWARM-002, SWARM-003)` | SWARM-002, SWARM-003 | `packages/core/src/constants.ts`, `packages/handlers/src/response-sender.ts` |

### Observed In-Main Activity (Uncommitted)

| Area | Files | Likely Ticket Impact | Confidence |
|------|-------|----------------------|------------|
| Infra alarm/notification/security changes | `packages/infra/src/constructs/avatar.ts`, `packages/infra/src/constructs/shared.ts`, `packages/infra/src/stacks/avatars-stack.ts`, `packages/infra/src/stacks/shared-infra-stack.ts` | SWARM-006 / SWARM-008 / SWARM-010 overlap | Medium |
| Admin API test addition | `packages/admin-api/src/handlers/avatars.test.ts` | SWARM-007 | Medium |
| Core type decomposition additions | `packages/core/src/types/envelope.ts`, `packages/core/src/types/helpers.ts`, `packages/core/src/types/platform.ts`, `packages/core/src/types/queue.ts`, `packages/core/src/types/response.ts`, `packages/core/src/types/service.ts`, `packages/core/src/types/state.ts` | SWARM-005 | High |

### Branch Discipline Watch

- Risk: active branch/worktree inventory no longer matches historical worker mapping.
- Required coordinator action: refresh branch/worktree provisioning plan before starting new ticket execution.
- Current blocker:
  - `feat/swarm-008` worktree has widespread tracked deletions and should be normalized before development continues.

## Coordinator Runbook

### Daily Startup Checks

Run these before assigning new work or approving merges:

```bash
git worktree list
for wt in /Users/ratimics/develop/aws-swarm*; do
  [ -d "$wt/.git" ] || continue
  echo "### $wt"
  git -C "$wt" status --short --branch
done
```

Then update this document if any status changed.

### Control Loop Cadence

Use a simple repeating loop:

1. **Intake:** collect progress updates from each worker.
2. **Validate:** confirm branch/worktree/commit with git commands.
3. **Record:** update matrix status, notes, latest SHA, and PR.
4. **Unblock:** resolve conflicts and reassign if needed.
5. **Gate:** approve merge only when definition-of-done checks pass.

Target cadence:
- Every 2-4 hours during active delivery windows.
- Immediately after any worker opens a PR.
- Immediately after any merge to `main`.

### Worker Checkpoint Template

Require every worker to submit this exact block:

```md
### CHECKPOINT
ticket: SWARM-00X
worker: worker-00X
branch: feat/swarm-00X
worktree: /Users/ratimics/develop/aws-swarm-swarm-00X
status: in_progress | review | blocked | merged
latest_commit: <sha>
pr: <url-or-none>
changes: <1-3 lines>
tests_run: <commands and result>
blockers: <none or concrete blocker>
next_step: <single next action>
```

### Coordinator Matrix Update Template

When a worker reports progress, append this under the relevant ticket notes:

```md
[2026-02-06T00:00Z] status=<status> sha=<sha> pr=<url-or-none> blocker=<none|summary>
```

Keep only the last 5 checkpoint lines per ticket to avoid bloat.

### Execution Waves and Merge Order

Use this order to reduce conflicts in shared files:

1. **Wave 1 (P0 core risk):** SWARM-001, SWARM-004
2. **Wave 2 (P0 shared runtime):** SWARM-002, SWARM-003
3. **Wave 3 (P1 reliability/testing):** SWARM-006, SWARM-007
4. **Wave 4 (P1/P2 refactor and cleanup):** SWARM-005, SWARM-009
5. **Wave 5 (P2 infra and operational):** SWARM-008, SWARM-010
6. **Wave 6 (Onboarding foundation):** SWARM-011, SWARM-012, SWARM-013, SWARM-014
7. **Wave 7 (Onboarding UX and resiliency):** SWARM-015, SWARM-016, SWARM-017, SWARM-018
8. **Wave 8 (Onboarding validation and rollout):** SWARM-019, SWARM-020

### Conflict Hotspots

Expect merge conflicts in these areas:
- `packages/handlers/src/message-processor.ts` (SWARM-001, SWARM-002, SWARM-003, SWARM-005)
- `packages/core/src/*` runtime constants/types (SWARM-001, SWARM-003, SWARM-005, SWARM-010)
- Root config/workflow files (SWARM-004, SWARM-008, SWARM-010)

Resolution rule:
1. Lower wave number has merge priority.
2. Higher wave branch rebases onto latest `main`.
3. If behavior-level conflict remains, coordinator decides and records rationale in notes.

### Definition of Done for Merge Approval

A ticket is merge-ready only when all are true:

1. Acceptance criteria in `SWARM-00x` doc are checked off.
2. Tests for impacted packages run and results are posted in checkpoint.
3. `git -C <worktree> status --short --branch` shows only intended changes.
4. PR includes scope summary, risks, and rollback note.
5. Coordination matrix status is set to `review` before merge, then `merged` after merge.

### Blocker Escalation Rules

Escalate immediately to coordinator when:
- Worktree has unrelated dirty files.
- A worker needs to change another ticket's branch.
- Infra change implies replacement/destructive diff.
- Acceptance criteria are ambiguous or contradictory.

Coordinator options:
1. Re-scope ticket.
2. Split follow-up ticket.
3. Reassign worker.
4. Pause wave and publish decision note in this file.

## Coordination Rules for Agents

1. Under `mainline-first`, prefer committing to `main` unless coordinator explicitly requests branch-isolated execution for a ticket.
2. Do not open duplicate PRs for tickets marked `completed-by-commit`; use closure ledger evidence instead.
3. Keep ticket scope isolated: one SWARM ticket per branch/PR.
4. Update this file after each meaningful checkpoint:
   - latest commit SHA
   - PR link
   - status (`not started`, `in progress`, `review`, `merged`)
   - blockers/risks
5. Before handoff or review, re-run:
   - `git -C <worktree> status --short --branch`
   - `git -C <worktree> log --oneline --max-count=5`

## Suggested Next Agent Actions

1. Coordinator: resolve the `feat/swarm-008` dirty worktree state before assigning new work to that lane.
2. Coordinator: decide whether to re-provision SWARM-005/006/007 branches locally or continue those tickets directly in `mainline-first` mode.
3. Coordinator: classify current uncommitted infra/type/test changes into SWARM-005/006/007/008/010 ownership before merge.
4. Coordinator: provision worktrees for SWARM-011 through SWARM-020 before onboarding overhaul kickoff.
5. Kickoff order for onboarding overhaul: SWARM-011 -> SWARM-012 -> SWARM-013 -> SWARM-014.
