# AWS Swarm: Architecture

**Last reviewed:** 2026-01-25

This document describes the technical architecture of AWS Swarm (control plane, runtime plane, and shared services).

For product direction and principles, see:
- `VISION.md`

For what we are shipping next (milestones and sequencing), see:
- `ROADMAP.md`
- `docs/ROADMAP-M1-PAID-TELEGRAM-MVP.md`

For runbook-style operational notes (logs endpoint, common issues), see:
- `AGENTS.md`

## Architecture Summary

- **Control plane:** Admin UI + Admin API for identity/session, avatar config, secrets, and operator tooling.
- **Runtime plane:** queue-based message processing (ingest → process → respond) using serverless handlers.
- **Shared services:** DynamoDB-backed state/memory, S3 media storage, Secrets Manager, and CloudWatch observability.

## Technical Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        CONTROL PLANE                            │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │  Admin UI   │  │  Admin API  │  │  Chat Configuration     │  │
│  │  (React)    │  │  (Lambda)   │  │  (LLM + Tools)          │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        RUNTIME PLANE                            │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐  │
│  │ Telegram │    │ Twitter  │    │ Discord  │    │   Web    │  │
│  │ Webhook  │    │ Poller   │    │ Gateway  │    │  Chat    │  │
│  └────┬─────┘    └────┬─────┘    └────┬─────┘    └────┬─────┘  │
│       │               │               │               │         │
│       └───────────────┴───────────────┴───────────────┘         │
│                              │                                   │
│                              ▼                                   │
│                    ┌─────────────────┐                          │
│                    │   Message SQS   │                          │
│                    └────────┬────────┘                          │
│                             │                                    │
│                             ▼                                    │
│                    ┌─────────────────┐                          │
│                    │ Message Handler │                          │
│                    │ (LLM + Tools)   │                          │
│                    └────────┬────────┘                          │
│                             │                                    │
│                             ▼                                    │
│                    ┌─────────────────┐                          │
│                    │  Response SQS   │                          │
│                    └────────┬────────┘                          │
│                             │                                    │
│                             ▼                                    │
│                    ┌─────────────────┐                          │
│                    │ Response Sender │                          │
│                    └─────────────────┘                          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     SHARED SERVICES                             │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌──────────────┐  │
│  │ Memory │ │ Media  │ │Credits │ │Wallets │ │ Observability│  │
│  │DynamoDB│ │S3+Repl.│ │DynamoDB│ │Secrets │ │ CloudWatch   │  │
│  └────────┘ └────────┘ └────────┘ └────────┘ └──────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## Operational Properties

- **Idempotency:** handlers should be safe to retry (API Gateway retries, SQS redelivery, etc.).
- **Async by default:** slow work (LLM calls, media jobs) should not block ingestion when possible.
- **Correlation:** logs should propagate `requestId`/`avatarId` consistently across webhook → SQS → handlers.
- **Least-privilege secrets:** tokens/keys live in AWS Secrets Manager; operators and avatars should not be able to read secrets back out.

## Notes on Scope

- Telegram is the primary production channel today; X/Twitter/Discord/Web are supported to varying degrees and are targeted for parity post-M1.
- Entitlements, deploy/activate flows, and memory retention controls are M1 work and are tracked in the roadmap docs linked above.

## References

- `README.md` (component map + request flows)
- `VISION.md` (mission/principles/success criteria)
- `ROADMAP.md` and `docs/ROADMAP-M1-PAID-TELEGRAM-MVP.md` (what’s next)
- `AGENTS.md` (logs endpoint + debugging)
