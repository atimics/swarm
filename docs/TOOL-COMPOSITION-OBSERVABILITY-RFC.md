# Tool Composition + Queryable Observability RFC

Status: Draft  
Author: Internal  
Date: 2026-01-25

## Summary

This RFC proposes two related improvements:

1) **Tool composition primitives**: a workflow-style tool that can execute multiple tool calls in one LLM turn, reducing the need for iterative tool loops in the model.
2) **Queryable observability**: system-level and per-avatar endpoints/tools that expose recent errors, rate limits, queue depth, and activity timelines (plus LLM token/latency metrics).

Together, these changes aim to reduce token waste, improve operator visibility, and make runtime behavior easier to diagnose.

## Problem Statement

### Tool composition

Today, the agent must perform multi-step actions via an iterative tool loop (max 10 iterations) where each tool call is serialized. This increases latency and token usage, and makes intent expression noisy in prompts (example: generate image → create sticker → post).

### Observability

We already store logs and auto-issues, but they are fragmented:

- CloudWatch logs are queryable per avatar via `/avatars/{id}/logs`.
- Fast DynamoDB logs exist, but only behind `fast=true`.
- Auto-issues are deduplicated server-side but not surfaced in a unified status view.
- There is no single “system status” or “my activity” endpoint that aggregates: errors, rate limits, queue depth, and recent actions.
- LLM token/latency metrics are not consistently surfaced for decisioning (verbose vs terse).

## Goals

- Provide a **single workflow tool** that can execute multiple tools in one call.
- Provide **system-level status** for errors, rate limits, queue depth, and tool credits.
- Provide **per-avatar activity** and “what happened recently” APIs/tools.
- Record **token/latency metrics** for LLM calls as structured logs.
- Improve agent continuity and context across sessions, platforms, and async tasks.

## Non-Goals

- Replacing the existing tool loop entirely.
- Introducing a full workflow engine or scheduler.
- Implementing a full observability stack (Grafana, etc.) in this phase.

## Scope and Acceptance Criteria

### P0 (Must-have for initial rollout)

- **System status endpoint + tool**
  - `GET /system/status` returns: error counts, open auto-issues by severity, tool credits/energy, rate-limit state, queue depth (or an explicit `unavailable` flag).
  - `system_status` MCP tool returns the same payload.
  - Access control enforced (admin-only).

- **My activity endpoint + tool**
  - `GET /avatars/{id}/activity?since=...` returns a timeline of recent actions and errors.
  - `my_activity` MCP tool returns a summarized view with key highlights.
  - Access control enforced (admin or avatar owner).

- **LLM token/latency metrics**
  - LLM calls log structured metrics (tokens, latency, model, tool calls).
  - Metrics are queryable via `/avatars/{id}/logs`.

### P1 (Should-have after P0)

- **Tool composition primitive**
  - `run_workflow` tool executes 2–8 tool calls with dependencies.
  - Safe toolset allowlist and recursion guard in place.
  - Optional parallel mode for independent steps.

- **Agent experience improvements (first wave)**
  - Mode hints injected into system prompt (admin vs public vs test).
  - Rate limit awareness: prompt guidance to call `get_tool_credits`, `get_energy_status`, and `check_post_rate_limit` pre-flight.
  - Tool failure visibility: error payloads include `errorCode`, `errorType`, and `retryable` fields.

### P2 (Nice-to-have)

- **Continuity summary**
  - ~~Relationship summary persisted and injected (refresh every N turns).~~
  - **Superseded by [DYNAMIC-CONTEXT-RFC.md](./DYNAMIC-CONTEXT-RFC.md)**: Pinned memories + channel context provide continuity.

- **Async follow-up**
  - `watch_job` tool and/or webhook/SSE notification for completed jobs.

- **Cross-platform context**
  - ~~Presence + channel summaries wired into tools and system prompt.~~
  - **Superseded by [DYNAMIC-CONTEXT-RFC.md](./DYNAMIC-CONTEXT-RFC.md)**: Channel Summary Service provides this.

- **Richer media pipeline**
  - Preview → refine → publish flow with gallery search by tags/content.

## Current Architecture (as of 2026-01-25)

- Tool loop exists in `packages/core/src/processors/message-processor.ts` with max iterations.
- Admin fallback loop exists in `packages/admin-api/src/handlers/chat.ts`.
- Tool definitions are centralized in `packages/mcp-server` and registered via `ToolRegistry`.
- Logs API (CloudWatch + fast DynamoDB) via `GET /avatars/{id}/logs` in `packages/admin-api/src/handlers/avatars.ts`.
- Auto-issues (fingerprinting + dedupe) in `packages/admin-api/src/services/auto-issues.ts`.
- Events (issues/feedback) stored in DynamoDB via `packages/admin-api/src/services/avatar-events.ts`.

## Proposed Design

### 1) Tool Composition Primitive: `run_workflow`

Add a new MCP tool that executes a declarative list of tool calls:

**Tool name:** `run_workflow`  
**Input:**
```json
{
  "steps": [
    {
      "id": "step-1",
      "tool": "generate_image",
      "args": { "prompt": "..." },
      "dependsOn": []
    },
    {
      "id": "step-2",
      "tool": "generate_sticker",
      "args": { "imageUrl": "{{step-1.result.url}}" },
      "dependsOn": ["step-1"]
    }
  ],
  "mode": "sequential"
}
```

**Output:**
```json
{
  "workflowId": "wf-...",
  "results": [
    { "id": "step-1", "success": true, "data": { ... } },
    { "id": "step-2", "success": false, "error": "..." }
  ]
}
```

**Implementation notes:**
- Implement as a new tool in `packages/mcp-server/src/tools/`.
- Use `ToolRegistry.execute()` internally for each step.
- Allow only safe toolsets (e.g., forbid `run_workflow` calling itself).
- Add an optional `parallel` mode for steps that do not depend on each other.
- Limit maximum steps (e.g., 8) and max total tool executions to prevent abuse.

**Prompt guidance:**
- In system prompt guidance, recommend `run_workflow` when 2+ tool calls are known upfront.

### 2) System Status Endpoint + Tool

Add an admin-only endpoint:

**Endpoint:** `GET /system/status`

**Response includes:**
- recent error counts (from `avatar-logs` or CloudWatch)
- open auto-issues by severity (from `auto-issues`)
- queue depth (SQS or job tables)
- tool credit status and energy (from `credits.getToolStatusStructured`)
- presence and rate limit (if `presence` services are wired)

Add an MCP tool `system_status` to expose this to the model.

### 3) My Activity Endpoint + Tool

Add an endpoint:

**Endpoint:** `GET /avatars/{id}/activity?since=...`

**Response includes:**
- recent messages, tool calls, job starts/completions
- recent errors (level WARN/ERROR)
- links to relevant logs/events for drilldown

Add MCP tool `my_activity` to return summarized activity within the last N hours.

### 4) LLM Token + Latency Metrics

Instrument LLM calls in:
- `packages/core/src/processors/message-processor.ts`
- `packages/admin-api/src/handlers/chat.ts`

**Log event example:**
```json
{
  "level": "INFO",
  "subsystem": "llm",
  "event": "llm_call_completed",
  "avatarId": "...",
  "model": "...",
  "promptTokens": 1234,
  "completionTokens": 321,
  "totalTokens": 1555,
  "latencyMs": 1870,
  "toolCalls": 2
}
```

These logs should be queryable via the existing `/avatars/{id}/logs` endpoints.

### 5) Agent Experience Improvements

These map directly to tools or APIs and can be layered on top of the above:

- **Continuity between sessions**  
  Add a compact "relationship summary" in the system prompt, sourced from memory (existing memory service + optional new summary table). Refresh on session end or every N turns.

- **Better async handling**  
  Add `watch_job` or `poll_job_until_complete` tool and allow server-driven callbacks (webhook or SSE) to notify completion. Pair with `get_pending_jobs` for proactive follow-up.

- **Cross-platform context**  
  Expose presence and channel summaries to the model (wire `presence` services) so it can reference recent activity across Twitter/Telegram/Discord.

- **Tool failure visibility**  
  Standardize error payloads with `errorCode`, `errorType`, and retry hints; surface these in tool results and logs.

- **Richer media pipeline**  
  Add "preview → refine → publish" flow and a gallery search tool by tags/content (or basic semantic labels) to reuse prior assets.

- **Conversation mode hints**  
  Include explicit `mode` in system prompt (admin-ui vs public chat vs test) to reduce tone/behavior mismatches.

- **Rate limit awareness**  
  Expose `get_tool_credits`, `get_energy_status`, and `check_post_rate_limit` as recommended pre-flight tools in the prompt.

## Security and Access Control

- `system/status` should be admin-only.
- `my_activity` should require admin or avatar owner access.
- Workflow tool should honor existing tool permissions and toolset gates.

## Rollout Plan

1) Implement `run_workflow` tool in MCP server.
2) Add status + activity endpoints in admin-api.
3) Wire MCP tools to admin-api services.
4) Add prompt guidance to prefer workflow tool when applicable.
5) Add LLM metrics logging.

## Open Questions

- Should workflow results allow variable substitution (e.g., `{{step-1.result.url}}`)?
- Do we need a separate "dry run" mode?
- Should the workflow tool be available on all platforms or only admin-ui + API?
- Where should queue depth be sourced (SQS or internal job tables)?
