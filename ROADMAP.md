# AWS Swarm Roadmap

This roadmap focuses on product and platform milestones.

**Last reviewed:** 2026-02-07

## Current focus (early Feb 2026)
- **M1 is nearing completion.** Auth/onboarding, entitlements, energy unification, Orb-holder auto-boost, ascension→Pro, memory delete/export/TTL, deploy audit logging, and correlation IDs all shipped.
- Remaining M1 work: CloudWatch dashboards/DLQ alarms, staging Telegram canary, operational runbook.
- See [docs/BILLING-STRATEGY.md](docs/BILLING-STRATEGY.md) for the unified web3+web2 billing model.

For the execution-level, MVP-focused plan (2-week slices and P0→P3 sequencing), see:
- [docs/ROADMAP-M1-PAID-TELEGRAM-MVP.md](docs/ROADMAP-M1-PAID-TELEGRAM-MVP.md)

## Near (0-3 months)
Milestone M1: Paid Telegram MVP
- ~~Billing and entitlements with runtime enforcement.~~ **Done.** Manual entitlements + atomic enforcement + Orb-holder auto-boost + energy as burst pool.
- ~~Memory opt-in with retention and management.~~ **Done.** Schema, gating, retention TTL, delete, and export endpoints shipped.
- ~~Deploy or activate from admin UI and API.~~ **Done.** Readiness gates + activation endpoints + audit logging shipped.
- ~~Authentication improvements (wallet + Crossmint).~~ **Done.** Full onboarding overhaul (SWARM-011 through SWARM-020).
- ~~Structured logging with correlation IDs.~~ **Done.** Correlation ID propagation across webhook→SQS→handler chain. CloudWatch dashboards remaining.
- End-to-end Telegram canary and operational runbook (not started).

## Medium (3-9 months)
Milestone M2: Multi-platform parity
- Discord and X adapters reach feature parity with Telegram.
- Unified tool registry shared across admin API and handlers.
- Usage metering surfaced in admin UI.
- SQS payload offload for large media and DLQ management.

## Far (9-18 months)
Milestone M3: Persistent swarm platform
- Multi-avatar coordination and cross-avatar policies.
- Durable memory tiers (ephemeral, durable, archival) with export and delete.
- Marketplace-ready templates and persona packs.
- SaaS reliability and cost optimization for scale.

## Legacy
Prior planning snapshots are intentionally not kept as separate files; use git history for older iterations.
