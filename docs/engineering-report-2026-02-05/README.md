# Engineering Report — 2026-02-05

## Deep Codebase Analysis & Prioritized Recommendations

**Scope:** Full analysis of all 10 packages (~50K+ LOC), 90 test files, 5 CI/CD workflows, 34 scripts, and CDK infrastructure.

### Executive Summary

AWS Swarm is a **well-architected, production-grade multi-platform AI avatar framework** running on AWS serverless. The architecture is sound — queue-based async processing, multi-tenant shared handlers, and a unified MCP tool registry — but there are clear areas where technical debt, testing gaps, and structural issues need attention.

## Coordination Snapshot (2026-02-06)

- Coordination source of truth: [`COORDINATION.md`](./COORDINATION.md) (includes assignment authority, worker roster, and coordinator runbook)
- Current execution state: `main` is at `3223c53` and ahead of `origin/main` by 4 commits; SWARM branches are split (`001-004` at `223a963`, `005-010` at `3223c53`).
- Governance mode is `mainline-first`; SWARM-001/002/003/004 are tracked as `completed-by-commit` in the coordination closure ledger.
- Live activity is being tracked in `COORDINATION.md` under **Engineering Change Watch** (including branch/worktree drift and likely ticket mapping).

### Repository Metrics

| Metric | Value |
|--------|-------|
| Packages | 10 (core, handlers, admin-api, admin-ui, infra, mcp-server, layer, claude-code-worker, profile-page, plan-tests) |
| Source files | ~350+ |
| Test files | 90 |
| LOC (TypeScript) | ~50,000+ |
| CI/CD workflows | 5 |
| AWS resources | 30+ (Lambda, DynamoDB, SQS, S3, CloudFront, API GW, ECS, EventBridge) |

---

## Key Findings

### 1. Mega-File Problem

Several critical files have grown far beyond maintainability limits:

| File | Lines | Concern |
|------|-------|---------|
| `admin-api/handlers/chat.ts` | 2,516 | Monolithic chat handler |
| `admin-api/handlers/avatars.ts` | 1,789 | 40+ routes, zero tests |
| `admin-api/types.ts` | 1,676 | All types in one file |
| `handlers/telegram-webhook-shared.ts` | 1,554 | Auth + channel + activation + admin |
| `handlers/message-processor.ts` | 1,483 | Core brain, hard to test |
| `core/types/index.ts` | 1,368 | Every type definition |

### 2. Code Duplication

| Pattern | Locations | Impact |
|---------|-----------|--------|
| Secret-fetching logic | message-processor.ts, response-sender.ts, continuation-processor.ts, telegram-webhook-shared.ts | Same `fetchAvatarSecrets` reimplemented 3x with raw `secretsClient.send()`, while `load-avatar-secrets.ts` utility exists |
| Default avatar config | message-processor.ts, response-sender.ts | Identical inline 20-line fallback objects |
| Fetch-retry | core/services/llm (inline), core/utils/fetch-retry.ts | Two implementations with different semantics |
| System prompt building | response-generator.ts (legacy), prompt-builder.ts (unified) | Two divergent strategies |

### 3. Testing Gaps

| Untested Area | Risk | Package |
|---------------|------|---------|
| LLM service (Bedrock/OpenRouter/Anthropic/Retry) | 🔴 Critical | core |
| `avatars.ts` handler (1,789 LOC, 40+ routes) | 🔴 Critical | admin-api |
| Discord adapter (778 LOC) | 🟡 High | core |
| claude-code-worker (entire package) | 🟡 High | claude-code-worker |
| 23/27 MCP tool files | 🟡 High | mcp-server |
| Prompt builder | 🟡 Medium | core |
| LLM circuit breaker in message processor | 🔴 Critical | handlers |

### 4. Security Gaps

- **No WAF** on CloudFront or API Gateway (relies solely on Cloudflare Access)
- **Wildcard Bedrock IAM** — `bedrock:InvokeModel` on `Resource: *`
- **Per-avatar SQS unencrypted** — shared queues use SQS_MANAGED, per-avatar don't
- **Disabled dangerous code** in deploy workflow (S3 bucket deletion)

### 5. Operational Gaps

- **CloudWatch alarms fire silently** — no `alarmActions` configured on any alarm
- **No circuit breaker on message processor LLM calls** — 90s timeout exhausts concurrency
- **No DLQ on EventBridge rules** — failed invocations lost silently
- **LLM timeouts hardcoded** — not configurable per avatar

### 6. Developer Experience Gaps

- No `.prettierrc` config file (Prettier installed but unconfigured)
- No `.editorconfig`
- No `CODEOWNERS`
- `lint-staged` runs ESLint only, not Prettier
- No coverage thresholds enforced
- 1,247-line deploy workflow needs decomposition

---

## Tickets

See individual ticket files in this directory:

| Priority | Ticket | Branch | Description |
|----------|--------|--------|-------------|
| P0 | [SWARM-001](./SWARM-001-circuit-breaker-message-processor.md) | `feat/swarm-001` | Add circuit breaker to message processor LLM calls |
| P0 | [SWARM-002](./SWARM-002-consolidate-secret-loading.md) | `feat/swarm-002` | Consolidate duplicated secret-loading into shared utility |
| P0 | [SWARM-003](./SWARM-003-extract-default-avatar-config.md) | `feat/swarm-003` | Extract default avatar config to shared constant |
| P0 | [SWARM-004](./SWARM-004-developer-tooling.md) | `feat/swarm-004` | Add .prettierrc, .editorconfig, coverage thresholds |
| P1 | [SWARM-005](./SWARM-005-decompose-mega-files.md) | `feat/swarm-005` | Decompose mega-files into focused modules |
| P1 | [SWARM-006](./SWARM-006-wire-alarm-actions.md) | `feat/swarm-006` | Wire CloudWatch alarm actions to SNS |
| P1 | [SWARM-007](./SWARM-007-test-critical-paths.md) | `feat/swarm-007` | Add tests for LLM service, avatars handler, Discord adapter |
| P2 | [SWARM-008](./SWARM-008-security-hardening.md) | `feat/swarm-008` | WAF, scoped IAM, SQS encryption |
| P2 | [SWARM-009](./SWARM-009-deprecate-legacy.md) | `feat/swarm-009` | Deprecate legacy stack, processors, dead code |
| P2 | [SWARM-010](./SWARM-010-operational-improvements.md) | `feat/swarm-010` | EventBridge DLQs, configurable timeouts |
