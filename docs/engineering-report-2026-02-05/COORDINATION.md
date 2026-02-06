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

- `main` is at `3223c53` and is **ahead of `origin/main` by 4 commits**.
- Branch split:
  - `feat/swarm-001` to `feat/swarm-004` remain at `223a963`
  - `feat/swarm-005` to `feat/swarm-010` are at `3223c53`
- SWARM-001/002/003/004 scope has already been committed directly to `main` (mainline-first closure path).
- Assigned worktree signals:
  - `feat/swarm-001`: untracked `packages/core/src/services/circuit-breaker.ts`
  - `feat/swarm-004`: untracked `.editorconfig`, `.prettierrc`
- Additional branch signal:
  - `feat/swarm-007`: untracked `packages/core/src/services/llm/index.test.ts`
- Remaining uncommitted activity in `main` is focused on runtime limits / entitlement / energy and one LLM test file.

## Worker Assignment Matrix

| Worker | Ticket | Branch | Worktree | Core Mission | Status (2026-02-06) | Notes |
|--------|--------|--------|----------|--------------|-----------------------|-------|
| `worker-001` | SWARM-001 | `feat/swarm-001` | `/Users/ratimics/develop/aws-swarm-swarm-001` | Add fail-fast LLM protection in `message-processor` using shared circuit breaker logic from `@swarm/core`. | Completed-by-commit | Implemented on `main` via `f18a552`; branch still at `223a963` |
| `worker-002` | SWARM-002 | `feat/swarm-002` | `/Users/ratimics/develop/aws-swarm-swarm-002` | Replace duplicated secret fetching with shared `loadAvatarSecrets()` utility in all targeted handlers. | Completed-by-commit | Implemented on `main` via `3223c53`; branch still at `223a963` |
| `worker-003` | SWARM-003 | `feat/swarm-003` | `/Users/ratimics/develop/aws-swarm-swarm-003` | Introduce canonical `DEFAULT_AVATAR_CONFIG` and remove divergent inline fallback objects. | Completed-by-commit | Implemented on `main` via `3223c53`; branch still at `223a963` |
| `worker-004` | SWARM-004 | `feat/swarm-004` | `/Users/ratimics/develop/aws-swarm-swarm-004` | Establish consistent formatting and coverage guardrails (`.editorconfig`, `.prettierrc`, lint-staged, vitest thresholds). | Completed-by-commit | Implemented on `main` via `edad325`; branch still at `223a963` |
| `worker-005` | SWARM-005 | `feat/swarm-005` | `/Users/ratimics/develop/aws-swarm-swarm-005` | Decompose oversized files into focused modules while preserving existing exports and behavior. | Assigned, not started | Branch is aligned to `3223c53`; clean worktree |
| `worker-006` | SWARM-006 | `feat/swarm-006` | `/Users/ratimics/develop/aws-swarm-swarm-006` | Wire all current CloudWatch alarms to actionable SNS notifications without replacements. | Assigned, not started | Branch is aligned to `3223c53`; clean worktree |
| `worker-007` | SWARM-007 | `feat/swarm-007` | `/Users/ratimics/develop/aws-swarm-swarm-007` | Add high-value tests for LLM services, avatars handler, Discord adapter, and worker critical paths. | In progress (branch-local) | Branch is aligned to `3223c53`; untracked `packages/core/src/services/llm/index.test.ts` in worktree |
| `worker-008` | SWARM-008 | `feat/swarm-008` | `/Users/ratimics/develop/aws-swarm-swarm-008` | Harden security posture with WAF, scoped Bedrock IAM, queue encryption, and workflow cleanup. | Assigned, not started | Branch is aligned to `3223c53`; clean worktree |
| `worker-009` | SWARM-009 | `feat/swarm-009` | `/Users/ratimics/develop/aws-swarm-swarm-009` | Remove legacy code paths and duplicate types after migration and compatibility verification. | Assigned, not started | Branch is aligned to `3223c53`; clean worktree |
| `worker-010` | SWARM-010 | `feat/swarm-010` | `/Users/ratimics/develop/aws-swarm-swarm-010` | Improve operational resilience with EventBridge DLQs, configurable LLM limits, and deploy/admin-api maintainability work. | Adjacent activity detected | Branch is aligned to `3223c53`; runtime-limit/entitlement changes are active in `main` |

## Ticket Closure Ledger (Mainline-First)

| Ticket | Closure | Evidence Commits | Residual Follow-Up |
|--------|---------|------------------|--------------------|
| SWARM-001 | Completed-by-commit | `f18a552` | Confirm acceptance checklist in ticket doc and close worker branch as superseded |
| SWARM-002 | Completed-by-commit | `3223c53` | Confirm message-processor side completed as intended and close worker branch as superseded |
| SWARM-003 | Completed-by-commit | `3223c53` | Confirm all fallback sites migrated and close worker branch as superseded |
| SWARM-004 | Completed-by-commit | `edad325` | Confirm lint/coverage gate behavior in CI and close worker branch as superseded |

## Engineering Change Watch (Docs-Only Monitoring)

Snapshot intent: monitor engineering activity without editing runtime code.

### Recent SWARM-Relevant Commits on `main`

| Commit | Message | Ticket Impact | Files |
|--------|---------|---------------|-------|
| `edad325` | `chore: add developer tooling configs (SWARM-004)` | SWARM-004 | `.editorconfig`, `.prettierrc`, `package.json`, `vitest.config.ts` |
| `f18a552` | `feat(core): add circuit breaker and wire into message processor (SWARM-001)` | SWARM-001 | `packages/core/src/services/circuit-breaker.ts`, `packages/core/src/services/index.ts`, `packages/admin-api/src/services/circuit-breaker.ts`, `packages/handlers/src/message-processor.ts` |
| `3223c53` | `refactor(handlers): extract DEFAULT_AVATAR_CONFIG and consolidate secrets (SWARM-002, SWARM-003)` | SWARM-002, SWARM-003 | `packages/core/src/constants.ts`, `packages/handlers/src/response-sender.ts` |

### Observed In-Main Activity (Uncommitted)

| Area | Files | Likely Ticket Impact | Confidence |
|------|-------|----------------------|------------|
| LLM service tests | `packages/core/src/services/llm/index.test.ts` | SWARM-007 | Medium |
| Runtime limits / entitlements / energy stream | `packages/admin-api/src/handlers/avatars.ts`, `packages/admin-api/src/handlers/wallet-auth.ts`, `packages/admin-api/src/services/runtime-limits.ts`, `packages/handlers/src/services/entitlement-enforcement.ts`, `packages/handlers/src/services/platform-mcp-adapter.ts`, `packages/handlers/src/media-processor.ts`, `packages/handlers/src/autonomous-tweet-poster.ts`, `packages/handlers/src/tweet-poster.ts`, `packages/core/src/services/media-queue.ts` | Outside current SWARM tickets (or adjacent to SWARM-010) | Medium |

### Branch Discipline Watch

- Risk: mixed governance if branch-only and mainline-first habits are both used simultaneously.
- Required coordinator action: for SWARM-001/002/003/004, mark `feat/swarm-00x` branches as superseded by commit evidence and avoid duplicate branch PRs.
- Current exceptions already visible in assigned worktrees:
  - `feat/swarm-001`: `packages/core/src/services/circuit-breaker.ts`
  - `feat/swarm-004`: `.editorconfig`, `.prettierrc`
  - `feat/swarm-007`: `packages/core/src/services/llm/index.test.ts`

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

1. Coordinator: mark SWARM-001/002/003/004 ticket branches as superseded using the closure ledger.
2. SWARM-007 agent: continue LLM test implementation in `feat/swarm-007` and report checkpoint with test command output.
3. Coordinator: classify current runtime-limits/entitlement stream as SWARM-010 extension or open a new ticket to prevent scope ambiguity.
