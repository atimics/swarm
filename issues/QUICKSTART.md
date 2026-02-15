# Quick Reference: Priority Issues

This is a quick-start guide for the most important issues to tackle first.

## 🔥 P0 - Start Here (M2 Blockers)

### 1. Semantic Search Integration (2 days)
**File**: `issues/staging/ISSUE-001-semantic-search-integration.json`
**Why**: Infrastructure complete, just needs wiring. High impact on memory quality.
**Where**: `packages/admin-api/src/services/memory.ts`

### 2. Discord Adapter Tests (3 days)
**File**: `issues/staging/ISSUE-002-discord-adapter-tests.json`
**Why**: M2 requires multi-platform parity. Tests block production deployment.
**Where**: `packages/core/src/platforms/discord.ts`

### 3. Twitter Adapter Parity (5 days)
**File**: `issues/features/FEATURE-003-twitter-adapter-parity.json`
**Why**: M2 core requirement. Placeholder exists, needs full implementation.
**Where**: `packages/core/src/platforms/twitter.ts`

## ⚡ P1 - High Value Quick Wins

### 4. DLQ Recovery Tools (1 day)
**File**: `issues/staging/ISSUE-003-sqs-dlq-recovery-runbook.json`
**Why**: Operational readiness. Improves incident response.
**Where**: `docs/RUNBOOK.md`, new CLI tools

### 5. React Timer Cleanup (4 hours)
**File**: `issues/bugs/BUG-015-react-timer-cleanup.json`
**Why**: Memory leak prevention. Easy fix with high value.
**Where**: `packages/admin-ui/src/components/`

### 6. Authentication Tests (2 days)
**File**: `issues/staging/ISSUE-005-authentication-tests.json`
**Why**: Critical flows need coverage. Tests already outlined.
**Where**: `packages/plan-tests/authentication-signup.todo.test.ts`

## 📋 Ready to Assign

All issues in `issues/staging/` are ready for immediate work:
- Well-defined acceptance criteria
- Effort estimates provided
- Code references included
- Clear business value

## 🎯 M2 Success Criteria

Complete these 6 issues to unblock M2:
1. ✅ ISSUE-001 (Semantic search)
2. ✅ ISSUE-002 (Discord tests)
3. ✅ ISSUE-003 (DLQ tools)
4. ✅ ISSUE-005 (Auth tests)
5. ✅ FEATURE-003 (Twitter parity)
6. ✅ DOC-001 (Discord docs)

## 📊 Effort vs Impact Matrix

```
High Impact, Low Effort (DO FIRST):
- BUG-015: React timer cleanup (4h)
- ISSUE-004: DynamoDB optimization (4h)
- BUG-013: TypeScript suppressions (4h)

High Impact, Medium Effort (PRIORITIZE):
- ISSUE-001: Semantic search (2d)
- ISSUE-003: DLQ tools (1d)
- ISSUE-005: Auth tests (2d)
- FEATURE-001: Usage metering (3d)

High Impact, High Effort (PLAN CAREFULLY):
- ISSUE-002: Discord tests (3d)
- FEATURE-003: Twitter parity (5d)
- FEATURE-006: Memory tiers (4d)

Low Impact (BACKLOG):
- DEBT-001: TODO cleanup (1d)
- DEBT-002: Deprecations (1d)
```

## 🚀 Suggested Sprint Plan

### Sprint 1 (2 weeks)
- Day 1-2: ISSUE-001 (Semantic search)
- Day 3: BUG-015 (React cleanup) + ISSUE-004 (DynamoDB)
- Day 4-5: ISSUE-003 (DLQ tools)
- Day 6-10: ISSUE-005 (Auth tests)

### Sprint 2 (2 weeks)
- Day 1-3: ISSUE-002 (Discord tests)
- Day 4-5: DOC-001 (Discord docs)
- Day 6-10: FEATURE-003 (Twitter, partial)

### Sprint 3 (2 weeks)
- Day 1-5: FEATURE-003 (Twitter, complete)
- Day 6-8: FEATURE-001 (Usage metering)
- Day 9-10: BUG-013, BUG-014 (cleanup)

## 📞 Need Help?

- Architecture questions → see `ARCHITECTURE.md`
- Deployment questions → see `ROADMAP.md`, `PLAN.md`
- Debugging help → see `AGENTS.md`
- Code standards → see `CLAUDE.md`

## 🔗 Related Documents

- Full issue catalog: `issues/INDEX.md`
- Analysis summary: `ANALYSIS.md`
- Avatar registry: `issues/avatars.json`
