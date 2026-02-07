# AWS Swarm Roadmap

This roadmap focuses on product and platform milestones.

**Last reviewed:** 2026-02-07

## Current focus (early Feb 2026)
- **M1 is the active milestone.** Auth/onboarding shipped. Entitlements schema + runtime enforcement shipped. Billing posture decided: manual entitlements + Orb-holder auto-boost for M1, Stripe deferred to M2.
- Next highest-leverage work: unify energy as burst pool within entitlements (eliminate double-gating), Orb-holder auto-boost, memory delete/export, deploy audit logging, observability baseline, E2E validation.
- See [docs/BILLING-STRATEGY.md](docs/BILLING-STRATEGY.md) for the unified web3+web2 billing model.

For the execution-level, MVP-focused plan (2-week slices and P0→P3 sequencing), see:
- [docs/ROADMAP-M1-PAID-TELEGRAM-MVP.md](docs/ROADMAP-M1-PAID-TELEGRAM-MVP.md)

## Near (0-3 months)
Milestone M1: Paid Telegram MVP
- ~~Billing and entitlements with runtime enforcement.~~ **Done.** Manual entitlements + atomic enforcement. Orb-holder auto-boost and energy unification remaining.
- Memory opt-in (schema + gating done); retention TTL and delete/export remaining.
- ~~Deploy or activate from admin UI and API.~~ **Done.** Readiness gates + activation endpoints shipped.
- ~~Authentication improvements (wallet + Crossmint).~~ **Done.** Full onboarding overhaul (SWARM-011 through SWARM-020).
- Structured logging with correlation IDs and basic dashboards (partial).
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
