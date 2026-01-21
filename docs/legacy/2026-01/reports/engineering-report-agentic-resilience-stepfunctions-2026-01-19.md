# Engineering Report: Resilient, Scalable Agentic Runtime (Serverless + Step Functions)

**Status:** Deferred (not on the M1 critical path)

Sequencing reference:
- [docs/ROADMAP-M1-PAID-TELEGRAM-MVP.md](../../../ROADMAP-M1-PAID-TELEGRAM-MVP.md)

**Date:** 2026-01-18
**Audience:** Engineering
**Scope:** Admin UI + Admin API + MCP tools + Infra (CDK)
**Constraints:** Serverless-first; orchestrate with AWS Step Functions; preserve current MCP tool ecosystem.

**Status:** Deferred — patch existing bugs and harden current flows first.
**Decision:** No need for AgentCore yet; revisit after P0/P1 stability work.

---

## 0) Timing: Why We’re Deferring This

This report describes a target architecture we **intend to return to**, but we should not start implementing it until we’ve patched the current high-impact bugs and reduced churn risk.

**Prerequisites (recommended before starting any Step Functions refactor):**
- Close the P0 UX blockers and ship diagnostics (notably Telegram verification/diagnosis)
- Add regression tests for access-mode transitions and avatar switching
- Reduce risk in the chat orchestration surface area (targeted refactors/tests around `processChat`)

These items are tracked in the consolidated platform status report: [docs/engineering-report-platform-status-2026-01-18.md](docs/engineering-report-platform-status-2026-01-18.md)

## 1) Context and Goal

This repo already has the core ingredients of an agentic system:
- **UI** that supports interactive “pause-for-input” tool prompts and renders artifacts (images/audio).
- **API** that orchestrates LLM + tool calls, with **idempotency** and an **LLM circuit breaker**.
- **Tools** implemented via an MCP registry and adapters.
- **Async work** via queues/jobs for media generation.

The goal of this proposal is to evolve the system into a **resilient and scalable agent runtime** with:
- Durable execution (multi-step runs that can pause/resume and survive retries)
- Clear separation of responsibilities (planner vs narrator; orchestration vs execution)
- Idempotent, observable, and cost-controlled operations
- A migration plan that doesn’t require a “big rewrite”

---

## 2) Current Architecture (What We Have)

### 1.1 Key components

- Admin API chat orchestration: [packages/admin-api/src/handlers/chat.ts](packages/admin-api/src/handlers/chat.ts)
  - Has request idempotency (header `Idempotency-Key`)
  - Has LLM circuit breaker
  - Executes MCP tools and returns `pendingToolCall` for UI input

- Tooling: MCP server + adapter layer
  - Tool schemas and execution sit behind the MCP boundary (good)

- UI chat and tool prompts
  - Chat panel and message rendering already handle:
    - tool prompts
    - async job polling
    - artifact rendering

### 1.2 Observed systemic gaps

- Orchestration is still “request-scoped” (durability across pauses and retries is partially bolted-on).
- “Pause-for-input” is not fully declarative; UI and orchestration rely on conventions.
- Async job updates are polling-based.
- `processChat` complexity makes it hard to evolve safely.

---

## 3) Target State: A First-Class Agent Runtime

### 2.1 The core abstraction: `AgentRun`

Introduce a persistent, auditable representation of an agent run:

**AgentRun**
- `runId`, `avatarId`, `userId`, `channel`, `createdAt`, `updatedAt`
- `status`: `running | waiting_for_input | completed | failed | cancelled`
- `input`: user message + attachments + request metadata
- `modelRouting`: selected content model + pinned tool model
- `policy`: budgets, safety flags, allowed tools/categories

**AgentStep**
- `stepId`, `runId`, `type`:
  - `plan` (LLM tool-planner)
  - `tool` (tool invocation)
  - `interrupt` (pause-for-input)
  - `render` (final response generation)
  - `emit` (write messages/artifacts to history)
- `attempt`, `startedAt`, `endedAt`, `result`, `error`

**Artifact**
- `type`: `image | audio | video | sticker | file`
- `url`, `metadata` (prompt, jobId, durationMs, etc.)

These structures should be stored in DynamoDB for durability and queried for debugging.

### 2.2 Step Functions as the durable orchestrator

Define a Step Functions state machine that drives each `AgentRun`.

Two variants are useful:
- **Express (sync)** for low-latency interactive chat turns (return response within API Gateway timeout).
- **Standard (async)** for long-running workflows, backfills, batch jobs, or agent “missions”.

**Core state machine outline**

1. **InitializeRun** (Lambda)
   - Validate authz (avatar access)
   - Create `AgentRun` record
   - Normalize input (attachments, history)

2. **PlanWithTools** (Lambda)
   - Tool-capable model produces either:
     - tool calls (structured)
     - or “no tools needed”
     - or “needs user input” as an interrupt request

3. **ExecuteTools (Map)** (Lambda per tool)
   - Fan out tool calls that are safe to parallelize
   - Enforce budgets and tool allowlist
   - Write ToolResult + Artifacts into run state

4. **NeedsUserInput?**
   - If yes: **WaitForCallback (Task Token)**
     - Persist the task token + prompt metadata
     - Return prompt to UI

5. **RenderResponse** (Lambda)
   - Tool-free content model generates the final response text
   - Attach artifacts

6. **PersistAndEmit** (Lambda)
   - Write to chat history
   - Update run status
   - Return final response

7. **Catch/Retry paths**
   - Standardized error taxonomy and retry/backoff strategy
   - DLQ and issue creation hooks for repeated failures

---

## 4) Resilience Design

### 3.1 Idempotency everywhere

We already support chat idempotency at the HTTP edge; extend this to workflow steps.

**Principle:** every state machine task is retriable; every effect must be idempotent.

Recommended:
- Create a DynamoDB table (or extend existing state store) keyed by:
  - `pk = IDEMPOTENCY#<scope>`
  - `sk = <idempotencyKey>`
  - store `status`, `resultDigest`, `createdAt`, TTL

Scopes:
- `CHAT_TURN` (request-level)
- `TOOL_CALL` (tool call id)
- `MEDIA_JOB` (job id)
- `PLATFORM_EVENT` (telegram/discord message id)

### 3.2 Retry strategy and failure taxonomy

Standardize errors:
- `RetryableExternalError` (timeouts, 5xx)
- `RetryableThrottlingError` (429)
- `NonRetryableValidationError`
- `NonRetryablePolicyError`
- `NonRetryableAuthzError`

Step Functions per-task policy:
- short exponential backoff, jitter
- hard timeouts
- max attempts per category

### 3.3 Circuit breakers and bulkheads

We already have an LLM circuit breaker. Expand the concept:
- separate circuit breakers for:
  - LLM provider
  - Replicate/media provider
  - Telegram API
  - Twitter/X API

Bulkheads:
- Per-avatar concurrency limits (avoid one avatar stampeding)
- Per-tool concurrency limits (avoid a single tool consuming all concurrency)
- Reserved concurrency on key Lambdas

### 3.4 Pause/resume durability (Task Token)

Use Step Functions callback pattern for “pause-for-input” tools:
- When planner requests input, persist `pendingInput` in `AgentRun`:
  - `toolCallId`, `uiSchema`, `taskToken`, `expiresAt`
- UI submits tool result to Admin API
- Admin API calls `SendTaskSuccess` with the task token

Benefits:
- No ad-hoc polling loops for “waiting for user”
- Durable for hours/days
- Clear audit trail

### 3.5 Backpressure

Where backpressure belongs:
- At ingress: rate-limit by user/avatar
- In workflow: per-avatar concurrency gate
- On external APIs: adaptive retries + circuit breaker open state

---

## 5) Scalability Design

### 4.1 Throughput and concurrency

Key levers:
- **Step Functions Express** for chat turns to keep latency and cost predictable
- Use **SQS + Lambda** for heavy tool executions (media, browsing, scraping) if needed
- DynamoDB partitioning by `avatarId` (and/or `runId`) to avoid hot keys

### 4.2 Parallel execution (when safe)

Use Step Functions `Map` state for tool fan-out, but only if tool calls are independent.

Add tool metadata:
- `execution: { parallelSafe: boolean }`
- `sideEffects: { writesState: boolean, externalCalls: string[] }`

### 4.3 Async media jobs

Recommended shape:
- Planner emits “start media job” tool
- Tool returns `jobId` + placeholder artifact
- A dedicated job workflow updates artifacts when complete
- UI gets updates via:
  - DynamoDB stream → WebSocket/SSE (optional)
  - or polling as fallback

---

## 6) Observability and Debuggability

### 5.1 Correlation IDs

Propagate:
- `requestId` (API Gateway)
- `runId` (AgentRun)
- `stepId` (AgentStep)
- `toolCallId`

### 5.2 Structured logs

Standard fields:
- `level`, `subsystem`, `event`, `avatarId`, `runId`, `stepId`, `toolName`, `durationMs`, `attempt`

### 5.3 Metrics

Emit CloudWatch metrics for:
- p50/p95/p99 latency per phase (plan/tools/render)
- tool failure rates
- circuit breaker open time
- cost proxies: tokens in/out, tool call counts

### 5.4 Run inspector

Add an admin endpoint:
- `GET /avatars/{avatarId}/runs/{runId}` returns run timeline + artifacts

---

## 7) Security and Governance

### 6.1 Authorization (avatar access)

Make avatar access checks consistent across:
- chat turns
- tool result submissions
- run resume callbacks

### 6.2 Secrets

- Never expose secrets to the LLM.
- Tools read secrets server-side.
- Tools declare required secret types (for UI guidance), but the secret values never leave the backend.

### 6.3 Policy engine (lightweight)

Before executing tools, check policy:
- allowed tool categories
- max tool calls per run
- max external calls
- “confirm required” for risky actions

---

## 8) How Bedrock AgentCore Fits (Now with Source Content)

You provided content from the AgentCore Developer Guide quickstart. Key takeaways relevant to this repo:

- AgentCore provides modular building blocks:
  - **AgentCore Runtime**: host an agent or tools
  - **AgentCore Memory**: add memory
  - **AgentCore Gateway**: securely connect to tools/resources
  - **AgentCore Identity**: identity management
  - **AgentCore Observability**: observe agents/resources
  - **AgentCore Policy**: control agent-to-tool interactions
  - **AgentCore Evaluations**: evaluate agent performance
  - **AgentCore MCP Server**: “vibe coding” with a coding assistant

- There is a CLI starter toolkit (`pip install bedrock-agentcore-starter-toolkit`) that can:
  - scaffold a simple agent using one of several frameworks (Strands Agents, LangGraph, OpenAI Agents SDK, Google ADK)
  - pick a model provider (Bedrock, OpenAI, Gemini, Anthropic Claude, Nova, Llama, Mistral)
  - generate either a Python project or IaC-ready code (Terraform or CDK)
  - auto-create Gateway, Memory, enable Observability
  - deploy a zip bundle to AgentCore Runtime and enable CloudWatch logging

### 8.1 Recommendation: keep Step Functions as system-of-record orchestration

Even if we adopt AgentCore, we should keep **Step Functions** as the durable orchestrator for `AgentRun` lifecycle because it gives us:
- explicit, auditable run timelines
- first-class callback waits (Task Tokens) for pause/resume
- stable orchestration independent of agent framework choice

AgentCore can still be very valuable, but as an **execution substrate** (runtime, gateway, identity, policy, observability) rather than the run state machine.

### 8.2 Mapping AgentCore modules to this repo’s target state

- **AgentCore Runtime** → alternative host for a tool-execution microservice or agent executor.
  - Fits best as a dedicated “executor” that we invoke from Step Functions for:
    - planner step (tool-calling model)
    - narrator step (final text)
    - tool execution when it makes sense to centralize in the runtime

- **AgentCore Gateway** → strongly overlaps with our MCP tool boundary.
  - Ideal outcome: keep MCP as the logical tool API, but use Gateway for:
    - network egress control
    - auth to internal AWS resources
    - standardized connectors and auditing

- **AgentCore Memory** → optional enhancement.
  - Our system should still persist `AgentRun`/`AgentStep` in DynamoDB.
  - AgentCore memory can add higher-level “agent memory” (semantic notes, user prefs) without replacing the run log.

- **AgentCore Identity** → complements our current auth model.
  - Use it to formalize identities for agent applications and tool access.
  - Still enforce avatar-level authz at the Admin API edge.

- **AgentCore Policy** → maps to the “policy engine” described above.
  - Use it to restrict tool execution (allowlists, confirmations, budgets).
  - Keep a local enforcement layer too so Step Functions retries remain safe.

- **AgentCore Observability** → maps to our structured logs + run inspector.
  - Adopt if it provides better cross-component traces; but do not depend on it to reconstruct run history.

- **AgentCore Evaluations** → fits as an offline/async workflow.
  - Evaluate tool selection correctness, latency, costs, and safety.
  - Implement as a Standard workflow that replays stored runs.

- **AgentCore MCP Server** → developer experience tool.
  - Not runtime-critical, but useful for integrating coding assistants and tool authoring.

### 8.3 How to adopt AgentCore without lock-in

Treat AgentCore as replaceable by preserving these invariants:
- **Run state is ours**: `AgentRun`/`AgentStep`/`Artifact` persist in DynamoDB.
- **Tool API is ours**: MCP tool definitions remain the source of truth.
- **Orchestration is ours**: Step Functions controls retries, pauses, and budgets.

If we adopt AgentCore Runtime, we do so behind a small interface:
- `executePlanner(input, policy) -> plan`
- `executeTools(plan) -> toolResults`
- `renderResponse(input, toolResults) -> message`

This keeps an “exit hatch” where we can swap AgentCore-hosted executors back to Lambda or ECS/Fargate if needed.

---

## 9) “Strands Agents” / Mastra: Should We Adopt?

### 8.1 Recommendation

Implement a **strands-like internal model** (Run/Step/Artifact/Interrupt) regardless of framework.

Then, evaluate external frameworks only if they:
- compile down cleanly to our Step Functions + MCP execution substrate
- don’t force a long-lived runtime model incompatible with serverless constraints

### 8.2 Practical stance

- If a framework helps author workflows/graphs quickly, we can use it as a **planner authoring tool**.
- The system of record should remain:
  - DynamoDB run state
  - Step Functions execution history
  - MCP tool registry

---

## 10) Migration Plan (Low-Risk Phases)

### Phase 0 — Formalize the runtime contract (no infra change)

- Add `AgentRun`/`AgentStep` schema and write them alongside existing chat handling.
- Add run/step IDs to logs.

### Phase 1 — Step Functions Express for chat turns

- Admin API starts a sync Express execution for each user message.
- Keep the external API contract identical.

### Phase 2 — Callback tokens for pause-for-input

- Replace ad-hoc “pending tool call” handling with Task Token waits.
- UI submission resumes the run.

### Phase 3 — Async job unification

- Media jobs become sub-workflows that update the run state.
- Add optional push updates (SSE/WebSocket) later.

### Phase 4 — Planner/narrator split

- Planner model is pinned (tool-capable).
- Narrator model is user-selectable.

---

## 11) Acceptance Criteria

- A run survives retries and resumes correctly after UI input.
- Tool execution is idempotent under retries.
- Per-avatar concurrency limits prevent stampedes.
- A “run inspector” can explain what happened without CloudWatch spelunking.
- Cost controls (token and step budgets) are enforceable.
