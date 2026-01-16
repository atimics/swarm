# AWS Swarm Vision

## Mission
Build the most reliable AWS-native platform for persistent, multi-platform AI avatars.

## Product thesis
- A single avatar identity spans Telegram, X, Discord, and web.
- A clear split between control plane (configuration, secrets, policy) and runtime plane
  (message processing, tools, delivery).
- Avatars are safe by default: tool gating, spend limits, and explicit retention policies.

## Principles
1. Reliability first: queue-based processing, idempotent handlers, deterministic retries.
2. Safety and governance: policy checks, approvals for risky actions, auditability.
3. Cost control: usage metering, budgets, and graceful degradation.
4. Observability: structured logs, trace IDs, and runbooks.
5. Developer velocity: shared core, typed tools, and local test harnesses.

## What success looks like
- Self-serve onboarding from avatar creation to live Telegram avatar in under 10 minutes.
- Paid plans enforce entitlements for memory, tools, and limits.
- Multi-platform adapters share consistent behavior and tool access.
- Clear data retention defaults with opt-in durable memory.

## Non-goals (for now)
- Training or hosting new foundation models.
- Building a consumer social network.
- Forcing crypto for core product usage.

## Legacy
This document replaces the 2026 whitepaper. The archived copy lives at
`docs/legacy/VISION-2026-01.md`.
