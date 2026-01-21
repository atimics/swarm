# AWS Swarm Roadmap

This roadmap focuses on product and platform milestones.

For the execution-level, MVP-focused plan (2-week slices and P0→P3 sequencing), see:
- [docs/ROADMAP-M1-PAID-TELEGRAM-MVP.md](docs/ROADMAP-M1-PAID-TELEGRAM-MVP.md)

## Near (0-3 months)
Milestone M1: Paid Telegram MVP
- Billing and entitlements with runtime enforcement.
- Memory opt-in and retention defaults (stateless free tier).
- Deploy or activate from admin UI and API.
- Authentication improvements (wallet + Crossmint): cookie/session consistency, backend-session bootstrap, explicit identity linking (Account + Identity), and account-level gating.
- Structured logging with correlation IDs and basic dashboards.
- End-to-end Telegram canary and operational runbook.

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
