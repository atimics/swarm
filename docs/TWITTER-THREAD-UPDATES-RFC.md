# Twitter Thread Updates RFC

Status: Draft

Author: Internal

Date: 2026-01-25

## Summary

This RFC proposes a cleanup and streamlining of the Twitter/X integration so that:

- Twitter ingestion is treated as **thread updates** (a “channel” in Swarm terms), not as “reply to an individual mention”.
- The bot **participates in threads** consistently across the system.
- Duplicate replies are prevented via robust idempotency and cursoring.
- Twitter becomes a **first-class agent tool** in the agentic loop, aligned with the avatar’s persona and platform guidelines.

## Problem Statement

### Symptoms

- The bot often does not reply to mentions.
- The bot sometimes replies multiple times to the same post.
- Twitter feels “bolted on” vs Telegram/Discord: it is not fully available as an in-loop tool, and platform behavior is not consistently represented in prompts.

### Root Causes (Observed)

1) **Ingestion semantics mismatch**

Telegram/Discord ingestion behaves like “thread updates”:

- Idempotency is checked at ingest.
- Messages are added to channel state.
- Then the event is enqueued.

Twitter mention polling currently does not mirror that model. It also contains “should we reply?” filtering in the poller, which belongs in decisioning.

2) **Two pollers can be deployed**

There are both:

- per-avatar pollers (in each avatar stack)
- a shared multi-tenant poller

If both run, duplicates become likely (especially outside SQS FIFO’s dedupe window).

3) **Cursor updates compare tweet IDs lexicographically**

Tweet IDs are numeric snowflakes; comparing them as strings can prevent cursor advancement and cause reprocessing.

4) **Twitter MCP tools are not available in the Lambda agent loop**

The platform handler tool registry only registers Twitter tools when a `twitter` service is provided. The platform MCP adapter currently does not provide a Twitter service, so the agent cannot fetch thread context or reply using a Twitter tool in-loop.

## Goals

- **Thread-first behavior:** treat Twitter events as updates to a thread/channel.
- **Admission vs response:** mentions/replies-to-bot should “add the bot to the thread” (mark it active), but the bot responds at the thread level with consistent state machine behavior.
- **Single ingestion path:** deploy one canonical Twitter poller architecture.
- **Strong idempotency:** prevent duplicate enqueues and duplicate outbound sends.
- **Stable thread identity:** consistent `conversationId` for Twitter threads.
- **Twitter as a first-class tool:** enable in-loop tools for reading tweet/thread context and posting replies/quotes, with persona + platform guidelines.
- **Operational clarity:** structured logs/metrics for cursors, dedupe, and replies.

## Non-Goals

- Implementing Twitter Account Activity API webhooks (CRC/webhook verification).
- Supporting Twitter DMs (unless explicitly added later).
- Perfect “full thread reconstruction” for every case (we’ll define bounded context fetching).

## Current Architecture (as of 2026-01-25)

### Inbound

- Twitter mention pollers (two forms)
  - Per-avatar scheduled poller
  - Shared multi-tenant scheduled poller
- Pollers call `TwitterAdapter.getMentions()` and enqueue a `SwarmEnvelope` into the message queue.

### Processing

- `message-processor` updates channel state and decides whether to respond.
- If responding, it generates actions via LLM + MCP tool loop.

### Outbound

- `response-sender` executes `ResponseAction`s using platform adapters.
- Some idempotency exists in `response-sender` keyed by `conversationId` and an “anchor” value.

### Tooling

- Twitter MCP tools exist (`twitter_status`, `twitter_post`, `twitter_reply`, etc.).
- The platform handler runtime does not wire `services.twitter`, so these tools are not available in the Lambda agent loop.

## Proposed Design

### 1) Unify Twitter Ingestion: One Poller

Adopt a single canonical deployment path:

- Prefer **shared multi-tenant poller** as the only production poller.
- Disable/remove per-avatar pollers to avoid dual ingestion.

Rationale:

- Centralized budget management and rate limiting.
- One place to implement cursoring, idempotency, and filtering.

### 2) Twitter Ingestion Should Only Produce “Thread Update” Events

The poller should not decide “should reply”. Its responsibilities:

- Fetch new tweets relevant to the bot (mentions timeline + replies-to-bot).
- Normalize each tweet into a `SwarmEnvelope` with stable thread identity.
- Perform ingest idempotency.
- Add the message to channel/thread state (or at minimum enqueue it to be added).
- Enqueue a message queue item.

Decisioning (whether and when to reply) remains in the channel state + processor pipeline.

### 3) Stable Thread Identity

Define:

- `threadId` = `conversation_id` from Twitter API when present.
- If missing, fallback to `tweet.id` and optionally do a bounded lookup to retrieve `conversation_id`.

Swarm mapping:

- `envelope.conversationId` MUST represent the thread identity.

### 4) Admission Criteria: “Added to Thread”

A thread becomes eligible for bot participation when:

- The tweet is a direct mention of the bot, OR
- The tweet is a reply to the bot, OR
- The thread is already ACTIVE (the bot is already participating), and a new thread update arrives.

This is not “mentions trigger an immediate response”; it’s “mentions allow the thread to enter bot’s channel state machine”.

### 5) Channel State Semantics for Twitter

For Twitter threads, treat them as channels:

- Add messages to channel state under `conversationId = threadId`.
- Use the existing Kyro-style state machine (IDLE → ACTIVE → COOLDOWN).

Key change required:

- Response targeting should be derived from **thread state** rather than “the current message”.

### 6) Reply Targeting: Reply to Thread, Not the Current Message

Twitter requires `in_reply_to_tweet_id`. To reply to a thread:

- Pick a target tweet ID from channel state:
  - default: latest eligible tweet in the thread
  - or: most recent direct-engagement tweet (mention/reply-to-bot)

The `message-processor` should compute `replyToMessageId` from channel state target selection (e.g., `getResponseTarget(state)`), and set `response.replyToMessageId` accordingly.

This aligns “respond to thread” with Twitter’s reply mechanics.

### 7) Strong Idempotency

Implement idempotency at two layers:

- **Ingest idempotency:** `twitter:<avatarId>:<tweetId>` checked at poller ingest.
- **Outbound idempotency:** keep outbound dedupe but key it on stable thread ID + target tweet ID.

Additionally:

- Fix cursor progression using numeric comparison for tweet IDs.
- Ensure cursor updates occur even when a tweet is “non-actionable” to prevent re-poll loops.

### 8) Twitter as a First-Class Agent Tool in the Loop

Wire Twitter MCP services into the platform handler runtime so the agent can:

- fetch tweet by ID
- fetch recent thread context (bounded window)
- draft a reply consistent with persona
- post reply/quote/like as explicit actions

Tooling constraints:

- Preserve “confirm before irreversible side effects” behavior.
- Apply platform-specific guidelines (character limits, style constraints).

### 9) Persona + Platform Guidelines Integration

Upgrade the platform prompt section for Twitter:

- Incorporate the richer platform guidance from `prompts/platforms/twitter.md` into prompt generation.
- Make thread reply style explicit (tone, brevity, mention etiquette, no double-posting).

## Implementation Plan (Phased)

### Phase 0: Observability Baseline

- Add structured log fields to Twitter poller + outbound sender:
  - `avatarId`, `threadId`, `tweetId`, `cursorBefore`, `cursorAfter`, `dedupeHit`, `queued`, `replied`

### Phase 1: Unify Poller Deployment

- Choose shared poller as canonical.
- Disable per-avatar poller deployment.

### Phase 2: Cursor + Ingest Idempotency

- Fix cursor numeric comparisons.
- Add ingest idempotency checks.

### Phase 3: Thread Reply Targeting

- Change reply targeting to be derived from thread/channel state.

### Phase 4: Twitter MCP Services in Platform Runtime

- Implement `services.twitter` in the platform MCP adapter.
- Ensure Twitter tools are registered in the tool registry.

### Phase 5: Prompt Integration

- Replace/extend hardcoded Twitter prompt guidance with `prompts/platforms/twitter.md` content.

## Risks

- API tier limitations: fetching thread context may require additional endpoints/expansions.
- Increased API usage if naive thread reconstruction is attempted. Must remain budget-aware.
- Migration issues if `conversationId` values change for in-flight threads.

## Alternatives Considered

- Use Account Activity API webhooks.
  - Pros: near real-time.
  - Cons: higher integration complexity and operational overhead.

- Keep per-avatar pollers.
  - Pros: isolated failure domains.
  - Cons: duplicates and operational complexity; harder budget management.

## Open Questions

- Do we want to treat quote-tweets that mention the bot as “thread admission”?
- Should we add a “thread subscription TTL” so threads go cold automatically?
- What bounded thread context window is acceptable (e.g., last 5 tweets in thread) under budget constraints?

---

Appendix: Relevant code touchpoints

- Twitter pollers:
  - `packages/handlers/src/twitter-mention-poller.ts`
  - `packages/handlers/src/twitter-mention-poller-shared.ts`
- Twitter adapter:
  - `packages/core/src/platforms/twitter.ts`
- Processing:
  - `packages/handlers/src/message-processor.ts`
- Outbound:
  - `packages/handlers/src/response-sender.ts`
- MCP tooling:
  - `packages/mcp-server/src/tools/twitter.ts`
  - `packages/handlers/src/services/platform-mcp-adapter.ts`
- Twitter prompt guidance:
  - `prompts/platforms/twitter.md`
