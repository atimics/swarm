# AWS Swarm Plan: Next Milestone (M1 Paid Telegram MVP)

Goal: deliver a self-serve paid Telegram avatar with enforced entitlements, opt-in
memory, and a deploy or activate flow.

## Milestone definition
- Create avatar in admin UI, connect Telegram, purchase plan or apply entitlement,
  deploy or activate, verify via logs.
- Free tier is stateless beyond request handling.
- Paid tier enables durable memory within a retention policy.
- Runtime enforces tool and usage limits per plan.

## Task list
### Billing and entitlements
- [ ] Decide billing provider and plan model (Stripe or manual entitlements) and
      document it in `ROADMAP.md` and `README.md`.
- [ ] Define an entitlement schema (plan, limits, memory flags) shared by admin API
      and runtime packages.
- [ ] Store entitlements in DynamoDB and expose them via admin API.
- [ ] Enforce entitlements in runtime handlers (message processor, media tools,
      voice tools).

### Memory opt-in and retention
- [ ] Add memory configuration fields (enabled, retentionDays) to avatar config.
- [ ] Default free tier to no durable memory writes.
- [ ] Implement deletion and export endpoints for paid memory.
- [ ] Enforce retention policy via TTL or scheduled cleanup.

### Deploy and activate flow
- [ ] Add admin API endpoint to trigger deploy or activation.
- [ ] Add admin UI control to call deploy and show status.
- [ ] Record deploy events in the audit log.

### Observability and reliability
- [ ] Add shared logger helper with correlation IDs.
- [ ] Propagate requestId and avatarId across webhook, SQS, and handlers.
- [ ] Add basic CloudWatch dashboard and DLQ alarms.

### End-to-end validation
- [ ] Add a staging Telegram canary avatar and test script.
- [ ] Write a smoke test for message processor and response sender using mocks.
- [ ] Document runbook for Telegram webhook failures and DLQ recovery.

## Out of scope for M1
- Discord gateway and full multi-platform parity.
- Marketplace templates and NFT gating.
- Protocol specification work.

## Legacy
Prior planning snapshots are archived in `docs/legacy/PLAN-2026-01-13.md` and
`docs/legacy/PLAN2-empty.md`.
