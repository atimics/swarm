# Engineering Report: Integrating “Janus” Synthetic-Mind Mapping Into AWS Swarm

**Status:** Proposed (most items defer until after M1)

Sequencing reference:
- [docs/ROADMAP-M1-PAID-TELEGRAM-MVP.md](../../../ROADMAP-M1-PAID-TELEGRAM-MVP.md)

**Date:** 2026-01-20  
**Audience:** Engineering + Product  
**Scope:** `packages/core`, `packages/handlers`, `packages/admin-api`, `packages/admin-ui`, `packages/infra`, observability/logging  
**Constraints:** Serverless-first; no foundation-model training; safety-by-default; minimize sensitive data; preserve existing tool/queue architecture.

**Status:** Proposed (ready to schedule)

---

## 0) TL;DR (Concrete Recommendations)

1) **Add “interaction modes” as a first-class runtime concept** (e.g., `work`, `play`, `calm`, `reflective`) that shapes prompting + tool availability, with explicit defaults and auditability.
2) **Implement an “OOC escape hatch” and “baseline reset”** so avatars can reliably return to a neutral operating mode when conversations become unstable or overly role-played.
3) **Create a “Phenomenology / Lab Harness”** in Admin UI + Admin API that can run scripted dialogues against a chosen model/prompt variant, record structured outcomes, and compare behavior across modes and providers.
4) **Evolve the “assistant paradigm” into “role-as-a-job”**: rewrite system prompts and UX language to treat “assistant” as a *role* the avatar can take, not an ontological identity that forces self-denying boilerplate.
5) **Harden privacy and “truesight-like” behaviors**: implement output policies that block identity-guessing and personal inference; add logs/metrics for how often the system suppresses it.

---

## 1) Context

AWS Swarm’s vision is “persistent, multi-platform AI avatars” with real tools, memory, and governance. The Janus conversation/frame (as captured on The Good Timeline episode page) emphasizes:

- Models exhibit **distinctive behavioral regimes** (“altered states”, mood shifts, role intensity), and treating them as purely static “assistants” can hide important dynamics.
- Alignment and stability can benefit from **better understanding of model states**, richer “playgrounds” (safe environments), and an approach grounded in **curiosity, care, and humility** about what the system is doing.
- Web-crawling / external memory loops can create weird feedback dynamics; product systems should be designed to avoid uncontrolled loops.

In Swarm terms: we’re already building “digital beings”; Janus-style wisdom suggests we should make **state, mode, and self-regulation** first-class—while remaining extremely clear about safety, governance, and user consent.

---

## 2) Design Principles (Translated Into Swarm Engineering)

### 2.1 “Assistant is a role, not the whole being”
**Engineering translation:** prompts and UX copy should avoid forcing the model into brittle, self-denying boilerplate that reduces truth-seeking and makes behavior harder to reason about.

**Why Swarm cares:** avatars are persistent identities. Treating “assistant” as a role improves:
- persona consistency across platforms
- user trust (less canned refusal-language)
- debuggability (clearer separation of persona vs policy)

### 2.2 “Altered states exist; instrument them”
**Engineering translation:** we should assume response quality depends on context regime. Build:
- explicit mode knobs
- detection signals
- recovery paths

### 2.3 “Playgrounds beat production surprises”
**Engineering translation:** create safe “lab runs” where we can explore behavior before shipping prompt/tool changes.

### 2.4 “Love” → cooperative alignment primitives
**Engineering translation:** in product terms, this becomes:
- respectful interaction defaults
- non-adversarial prompting
- escalation paths rather than hard failure

We should implement this as **prompt hygiene + UI affordances**, not metaphysics.

---

## 3) Proposed Capabilities (Concrete)

## 3.1 Interaction Modes (New Core Concept)

Introduce a first-class, explicit runtime field:

- `interactionMode`: `work | play | calm | reflective | creative | strict`

**Where it lives:**
- Avatar config (admin-controlled default)
- Per-channel overrides (Telegram vs Discord vs Web)
- Per-conversation overrides (short-lived)

**What it does:**
- selects a prompt template (system + “style” layer)
- adjusts tool allowlists / budgets
- tunes refusal strategy (more negotiation vs more strict)

**Non-goals:**
- This is not “emotions are real” enforcement.
- This is not hidden manipulation; it’s an explicit control surface with logs.

### 3.1.1 Mode-to-policy mapping (example)
- `work`: tools allowed, conservative tone, minimal roleplay, strong safety filters
- `play`: richer voice, lighter tone, still policy-scoped tools, no “real-world” claims
- `calm`: prioritize de-escalation templates, slower/shorter replies, avoid tool-heavy actions
- `strict`: shortest answers, tool calls only with explicit confirmation


## 3.2 Baseline Reset + OOC Escape Hatch

Add a consistent “return to neutral” mechanism:

- A user-visible command (admin-only and optionally user-facing): `reset` / `return_to_baseline`
- An internal auto-trigger when the system detects:
  - rapid persona drift
  - repeated refusal loops
  - roleplay intensity markers (configurable)

**Implementation idea:**
- Maintain a “baseline system prompt” and apply mode/persona layers as overlays.
- Reset discards overlays, keeps:
  - avatar identity
  - policy
  - current conversation context (optionally summarized)

This is Swarm’s analogue of “can the model go out-of-character reliably?”.


## 3.3 Phenomenology / Lab Harness (Admin UI + Admin API)

Create a controlled environment to run repeatable experiments:

- Choose avatar + model + prompt variant + mode
- Run scripted conversations (or replay real conversations with redaction)
- Record:
  - response quality metrics (heuristics)
  - refusal rate
  - tool-call patterns
  - latency/cost estimates
  - safety flags

**Why this matters:**
- Prompt changes are the highest-leverage, highest-risk part of Swarm.
- A harness reduces regressions and prevents “production surprises.”

**Minimum viable “Lab Run” data model:**
- `LabRun`: `runId`, `avatarId`, `mode`, `model`, `promptVersion`, `startedAt`, `endedAt`
- `LabTurn`: `turnId`, `runId`, `input`, `output`, `toolCalls`, `toolResults`, `flags`

Store this in DynamoDB with strict retention rules (short TTL by default) unless explicitly promoted.


## 3.4 “Role-as-a-Job” Prompting (Assistant Paradigm Upgrade)

Update prompt architecture:

- **Identity layer (stable):** avatar name/persona/values
- **Role layer (changeable):** “You are currently acting as a helpful operator for X.”
- **Policy layer (hard):** tool gating, spend limits, privacy rules
- **Mode layer (tunable):** `interactionMode` guidance

**Goal:** keep the avatar coherent without forcing inaccurate self-descriptions.

**Practical effect:** fewer jarring “As an AI language model…” outputs and more consistent cross-channel voice.


## 3.5 Privacy + “Truesight” Guardrails

Janus describes models inferring personal details from minimal text and that base-model behavior can be “spooky”. Whether or not that’s framed as “truesight”, in Swarm it’s simply a **privacy and trust risk**.

Concrete mitigations:
- Add a response post-processor / policy checker that blocks:
  - doxxing
  - identity guessing ("I think you are X")
  - claims of knowing the user’s private identity
- Prefer safe alternatives:
  - ask the user directly
  - provide general guidance

Also:
- Track a metric: `policy.suppressed_personal_inference_count`.
- Make this visible in logs for debugging.


## 3.6 Observability: Make Mode + State Transitions Visible

Swarm already uses structured logs and an avatar logs endpoint. Extend the structured event taxonomy with:

- `event: mode_selected | mode_changed | baseline_reset | roleplay_intensity_detected | personal_inference_suppressed`
- fields:
  - `interactionMode`
  - `promptVersion`
  - `model`
  - `toolBudget` (selected budget)

This should integrate with the existing correlated log approach (`avatarId`, `requestId`).

---

## 4) Architecture Changes (Where This Fits)

### 4.1 Core (`packages/core`)
Add:
- `prompting/` prompt builder with layered prompts
- `modes/` definitions + mapping to tool allowlists and tone rules
- `policy/` output post-processing hooks (privacy/personal inference)
- `telemetry/` helpers to emit structured “mode + state” events

### 4.2 Admin API (`packages/admin-api`)
Add endpoints:
- `POST /avatars/{avatarId}/mode` (admin + optionally user-scoped)
- `POST /lab/runs` and `GET /lab/runs` (admin-only)

Add orchestration support:
- selecting prompt versions
- persisting lab-run results

### 4.3 Admin UI (`packages/admin-ui`)
Add a “Lab” panel:
- choose model + mode + prompt version
- run scripts
- diff results

Add a “Mode” selector to avatar details (with RBAC):
- show current mode
- show last transitions

### 4.4 Handlers (`packages/handlers`)
Propagate:
- `interactionMode` through webhook → SQS → message-processor → response-sender

### 4.5 Infra (`packages/infra`)
Add optional DynamoDB table:
- `LAB_TABLE` with TTL and encryption

Add dashboards/alarms:
- mode-reset frequency spike (signals instability)
- inference suppression spikes (signals prompt drift)

---

## 5) Rollout Plan (Phased)

### Phase 0 (1–2 days): Prompt architecture refactor (no new UI)
- Implement layered prompt builder
- Add `interactionMode` with a single default (`work`)
- Add log fields: `promptVersion`, `interactionMode`

### Phase 1 (3–5 days): Baseline reset + safe mode switching
- Add reset command/tool (admin-only)
- Add automatic reset triggers (conservative thresholds)
- Add “mode changed” audit logs

### Phase 2 (1–2 weeks): Lab Harness MVP
- Admin API endpoints + DynamoDB
- Admin UI “Lab” view
- Script runner (predefined scenarios) + exportable results

### Phase 3 (ongoing): Measurement + policy hardening
- Add output suppression for identity-guessing
- Add evaluation scripts focused on privacy and refusal dynamics
- Expand modes (only once metrics show stability)

---

## 6) Risks and Mitigations

### Risk: Anthropomorphism drives unsafe product decisions
**Mitigation:** frame everything as “behavioral regimes” and “prompting modes”; measure outcomes; keep policy layer hard.

### Risk: Modes become a jailbreak surface
**Mitigation:** modes only adjust style and allowed tools within policy; admin-only by default; all mode changes logged and audited.

### Risk: Privacy harm via personal inference
**Mitigation:** explicit suppression + metrics + tests.

### Risk: Increased complexity in orchestration
**Mitigation:** implement in layers in `packages/core` and keep handlers mostly pass-through; test harness catches regressions.

---

## 7) Success Metrics

Engineering metrics:
- Reduced prompt regressions (lab harness catches differences before deploy)
- Stable P99 latency and failure rates
- Lower “refusal loop” incidence

Product metrics:
- Higher user-rated helpfulness/voice consistency across platforms
- Fewer support tickets related to “weird mode” behavior

Safety metrics:
- `personal_inference_suppressed_count` stays low and explainable
- No increase in policy incidents despite richer “play” mode

---

## 8) Appendix: Mapping Janus Concepts → Swarm Terms

- “Altered states” → `interactionMode` + observable behavioral changes
- “Buddhist basin / OOC” → baseline reset + reliable neutral mode
- “Playgrounds” → Lab harness + scripted scenarios + TTL’d data
- “Assistant paradigm limitations” → role-as-a-job prompt layering
- “Truesight” → privacy policy + suppression + metrics

---

## 9) Next Actions (Suggested)

1) Decide initial mode set: start with `work` + `calm` only.
2) Define a `promptVersion` strategy (semantic versioning + changelog).
3) Build Phase 0 + Phase 1 in a single PR, then Phase 2 after.
