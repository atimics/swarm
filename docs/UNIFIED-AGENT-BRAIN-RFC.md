# Unified Agent Brain RFC (Fixing Cross-Platform “Two Brain”)

Status: Draft  
Author: Internal  
Date: 2026-02-14

## Summary

This RFC defines how AWS Swarm moves from platform-specific cognition paths to a unified per-avatar “brain” model.

Today, Telegram/runtime and web/admin paths use different memory/history systems. Users perceive this as a split personality: the same avatar remembers different things depending on channel.

This proposal introduces:
1. A **single canonical memory system** per avatar (semantic + tiered memory graph)
2. A **shared brain service interface** used by all platforms
3. A **no-downtime migration** via dual-write, dual-read, backfill, and controlled cutover
4. **metacognitive loops** (consolidation, salience, self-model updates) operating on one substrate

## Problem Statement

### Observed symptom

Users report that avatar memory differs across Telegram vs web.

### Root cause

The architecture currently has multiple cognition/data paths:

- Runtime social path: Telegram/Twitter/Discord via handlers pipeline
  - `packages/handlers/src/telegram-webhook-shared.ts`
  - `packages/handlers/src/message-processor.ts`
  - `packages/handlers/src/services/platform-mcp-adapter.ts`
- Admin web chat path:
  - `packages/admin-api/src/handlers/chat.ts`
  - `packages/admin-api/src/services/memory.ts`
  - `packages/admin-api/src/services/chat-history-store.ts`
- Shared web chat path (already more unified):
  - `packages/admin-api/src/handlers/shared-chat.ts`
  - `packages/admin-api/src/services/processor-adapter.ts`

### Concrete split points

1. **Memory store split**
   - Runtime memory tools write/read `FACT#...` through state service in `STATE_TABLE`:
     - `packages/core/src/services/state/fact-store.ts`
     - invoked by `packages/handlers/src/services/platform-mcp-adapter.ts`
   - Admin/web uses tiered semantic memory in `ADMIN_TABLE` (`MEMORY#{avatarId}`):
     - `packages/admin-api/src/services/memory.ts`

2. **History model split**
   - Runtime uses channel state buffers per conversation/platform:
     - `packages/core/src/services/state/channel-state.ts`
   - Admin chat history is keyed by user email + avatar (`CHAT#{email}`, `AVATAR#{avatarId}`):
     - `packages/admin-api/src/services/chat-history-store.ts`

3. **Processor split**
   - A unified processor exists in core and is used by shared-chat adapter.
   - Telegram/runtime still uses a custom handler loop in `packages/handlers/src/message-processor.ts`.

Result: memory writes from one path are not guaranteed to be visible to the other.

## Goals

- One persistent “brain” memory substrate per avatar, independent of channel.
- One brain API contract used by all platforms/tools.
- Keep channel state as short-term working memory, not long-term truth.
- Add metacognitive primitives (salience, consolidation, identity drift control) over unified memory.
- Deliver with no production downtime and reversible rollout.

## Non-Goals

- Replacing channel-level state machine behavior (IDLE/ACTIVE/COOLDOWN).
- Replacing all existing tables in one step.
- Building a full external graph DB in this milestone.

## Target Architecture

## 1) Canonical Brain Layers

For each avatar:

1. **Working Memory (ephemeral, channel-scoped)**
   - Existing channel buffers/state in `STATE_TABLE`
   - Used for turn-taking, trigger logic, immediate context

2. **Episodic + Semantic Memory (durable, avatar-scoped)**
   - Canonical memory graph in `ADMIN_TABLE` (`MEMORY#{avatarId}` namespace)
   - Tiered + embeddings + relationships from `packages/admin-api/src/services/memory.ts`

3. **Self-Model / Metacognition**
   - Dreams, consolidation, reinforcement, identity snapshots
   - Existing components remain but consume same canonical memory substrate

## 2) Unified Brain Service Interface

Add a shared interface in core (new module), e.g.:

- `remember(avatarId, fact, about?, actorRef?, contextRef?)`
- `recall(avatarId, query, filters?)`
- `getMemoryContextForQuery(avatarId, query, options?)`
- `recordEpisode(avatarId, event)`
- `consolidate(avatarId, options?)`

All platform adapters call this interface instead of directly writing `FACT#` rows.

## 3) Canonical Identity + Context Keys

Normalize source identity/context across platforms:

- `actorRef`: `<platform>:<platformUserId>` (stable)
- `conversationRef`: `<platform>:<conversationId>`
- Optional `sessionRef` for admin-ui/web threads

These become first-class metadata in durable memory records.

## Data Model Plan

### Canonical (keep and extend)

Use existing semantic memory schema in `packages/admin-api/src/services/memory.ts` as source of truth:

- `pk = MEMORY#{avatarId}`
- `sk = {tier}#{timestamp}#{id}`
- content, about, userId, themes, strength, embedding, metadata, ttl

### Transitional legacy (to retire)

Legacy facts in `STATE_TABLE`:

- `pk = AVATAR#{avatarId}`
- `sk = FACT#{about}#{hash}`

These become compatibility-only during migration and are removed from write path after cutover.

## Migration Strategy (No Downtime)

### Phase 0 — Observability Baseline

Add metrics + logs before behavior change:

- memory read source (`canonical|legacy|hybrid`)
- memory write mode (`legacy_only|dual_write|canonical_only`)
- recall hit-rate by platform
- cross-platform recall parity checks

### Phase 1 — Dual Write

Update runtime memory writes to write both stores:

- In `packages/handlers/src/services/platform-mcp-adapter.ts`:
  - `memory.remember` writes canonical via new brain service
  - still writes legacy `stateService.saveFact` for safety

### Phase 2 — Dual Read (Canonical First)

Update runtime recall/context retrieval:

- read canonical memory first
- fallback to legacy facts if canonical empty/error
- log fallback usage

### Phase 3 — Backfill Historical Legacy Facts

Add one-time backfill script:

- scan legacy `FACT#` entries
- transform to canonical memory items (tier=`immediate` or `recent`)
- preserve timestamp/about/userId where available
- idempotent by source hash marker in metadata

### Phase 4 — Cutover

- stop legacy writes
- run parity monitor for N days
- remove legacy read fallback
- remove legacy fact APIs from runtime adapters

### Phase 5 — Cleanup

- remove `FACT#` write/read codepaths from state service and adapters
- keep optional read-only compatibility helper behind feature flag for one release window

## Feature Flags

Use explicit env flags for safe rollout:

- `BRAIN_WRITE_MODE=legacy|dual|canonical`
- `BRAIN_READ_MODE=legacy|hybrid|canonical`
- `BRAIN_BACKFILL_ENABLED=true|false`

Recommended rollout:

1. `legacy/legacy` (baseline)
2. `dual/hybrid` (staging)
3. `dual/hybrid` (prod canary avatars)
4. `canonical/hybrid`
5. `canonical/canonical`

## Metacognitive Architecture Improvements

Once unified memory is in place, implement these high-value upgrades:

1. **Salience scoring at ingest**
   - prioritize memories by novelty, user affinity, and emotional weight

2. **Contextual recall policy**
   - use `getMemoryContextForQuery` (semantic) by default
   - avoid static full-context dumps

3. **Consolidation cadence**
   - periodic promotion (immediate → recent → core)
   - edge pruning and strength decay

4. **Self-model guards**
   - separate identity memories from transient events
   - bound identity drift with explicit confidence/recency constraints

5. **Cross-platform episode stitching**
   - stitch related events by `actorRef` and temporal proximity
   - expose “ongoing thread” summaries to prompts

## Implementation Work Items

### A) Core brain interface

- Add shared Brain service contract in `packages/core`.
- Provide adapter implementation backed by `admin-api` memory service (or extracted shared module).

### B) Runtime adapter migration

- Refactor `packages/handlers/src/services/platform-mcp-adapter.ts` memory section to use Brain service.
- Keep compatibility writes/reads during migration phases.

### C) Admin chat alignment

- Update `packages/admin-api/src/handlers/chat.ts` to prefer query-aware memory injection:
  - `getMemoryContextForQuery` where possible
- Keep history persistence behavior separate from long-term memory.

### D) Processor alignment

- Gradually move Telegram/runtime from custom loop in `packages/handlers/src/message-processor.ts` toward shared core processor model.
- Minimize duplicate LLM/tool orchestration logic.

### E) Backfill + tooling

- Add script in `scripts/` for FACT→MEMORY backfill with dry-run and progress output.
- Add integrity checks for counts and sampling parity.

## Validation and Success Metrics

Primary acceptance criteria:

- Cross-platform recall parity ≥ 95% on sampled prompts per avatar.
- Legacy fallback read rate < 1% for 7 consecutive days before fallback removal.
- No increase in p95 response latency > 10% after canonical read enablement.
- User-reported “forgot in channel X” incidents trend to near-zero.

Suggested dashboards:

- `brain_recall_hit_rate{platform}`
- `brain_fallback_reads{platform}`
- `brain_write_mode_count`
- `memory_consolidation_duration_ms`
- `memory_context_tokens`

## Risks and Mitigations

1. **Latency increase from semantic recall**
   - mitigation: cache hot recall contexts; cap query limits; async prefetch

2. **Data drift during dual-write**
   - mitigation: idempotent write IDs; parity audit jobs

3. **Backfill quality issues**
   - mitigation: dry-run mode, sample verification, reversible flags

4. **Behavior regressions in Telegram runtime**
   - mitigation: canary avatars + staged flag rollout

## Open Questions

1. Should canonical memory remain in `ADMIN_TABLE`, or be moved to a dedicated `BRAIN_TABLE` post-M1?
2. Should we store raw episodic events in addition to consolidated memory objects?
3. Do we want hard quotas per memory tier by entitlement plan?
4. Should actor identity resolution include wallet/account linkage metadata by default?

## First Implementation Slice (recommended this sprint)

1. Add Brain interface + runtime adapter shim.
2. Implement dual-write in runtime `remember` path.
3. Implement hybrid read in runtime `recall` path.
4. Add rollout flags + structured logs.
5. Ship to staging canary avatars and measure fallback/read parity.
