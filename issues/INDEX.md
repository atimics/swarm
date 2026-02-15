# Issue Index

This directory contains structured issue files for bugs, features, technical debt, and documentation improvements identified through repository analysis.

## Issue Organization

This index groups issues into logical categories, but all issue JSON files are stored under `issues/staging/` as described in `issues/README.md`.

- **Staging** - High-priority issues ready for immediate work (M2 focus)
- **Bugs** category - Bug fixes and technical issues
- **Features** category - New feature requests (M2 and M3)
- **Tech debt** category - Technical debt cleanup items
- **Docs** category - Documentation improvements
## Issue Summary by Priority

### P0 (Critical - M2 Blockers)
- **ISSUE-001** - Wire semantic search into memory retrieval (2 days)
- **ISSUE-002** - Implement Discord adapter integration tests (3 days)
- **FEATURE-003** - X/Twitter adapter feature parity with Telegram (5 days)

### P1 (High Priority - M2 Goals)
- **ISSUE-003** - Add SQS DLQ recovery runbook and CLI tools (1 day)
- **ISSUE-004** - Optimize DynamoDB query pattern in auto-issues service (4 hours)
- **ISSUE-005** - Complete authentication signup test suite (2 days)
- **ISSUE-006** - Complete priority test suite (1 day)
- **FEATURE-001** - Add usage metering to admin UI (3 days)
- **FEATURE-002** - Implement SQS payload offload for large media (2 days)
- **FEATURE-006** - Implement durable memory tiers (4 days)
- **DOC-001** - Document Discord gateway architecture and deployment (1 day)
- **DOC-003** - Create monitoring and alerting operator guide (1 day)
- **DOC-004** - Expand SQS DLQ troubleshooting procedures (4 hours)

### P2 (Medium Priority)
- **BUG-013** - Address @ts-ignore suppressions in platform-mcp-adapter (4 hours)
- **BUG-014** - Audit console.log/error statements for sensitive data exposure (1 day)
- **BUG-015** - Add cleanup for setInterval/setTimeout in React components (4 hours)
- **FEATURE-004** - Implement RPG-style avatar stats and leveling (5 days)
- **FEATURE-005** - Implement multi-avatar coordination system (10 days)
- **FEATURE-007** - Implement marketplace templates and persona packs (7 days)
- **DOC-002** - Complete semantic memory design documentation (1 day)

### P3 (Low Priority - Cleanup)
- **DEBT-001** - Clean up TODO comments in message-processor-bundle (1 day)
- **DEBT-002** - Create deprecation migration script and timeline (1 day)
- **DEBT-003** - Extract common patterns to shared-patterns package (2 days)

## Total Issue Count

- **Staging Issues**: 6
- **Feature Requests**: 7
- **Bugs**: 3
- **Technical Debt**: 3
- **Documentation**: 4
- **Total**: 23 issues

## Milestone Breakdown

### M2 (Multi-platform Parity) - 17 issues
High-priority work focusing on:
- Discord and X/Twitter platform parity
- Testing and reliability
- Operational readiness
- Performance optimization

### M3 (Persistent Swarm Platform) - 4 issues
Future work focusing on:
- Multi-avatar coordination
- Memory tiers
- Marketplace features
- Gamification

### Ongoing - 2 issues
Continuous improvement items

## Quick Start

1. Review issues in `staging/` for immediate work
2. Check milestone alignment in ROADMAP.md
3. Assign issues to agents using the ownership guidance in `AGENTS.md`
4. Track progress in issue status field

## Issue File Format

Each issue is a JSON file with:
- `id` - Unique identifier
- `title` - Short description
- `status` - Current state (open/in-progress/closed)
- `priority` - P0/P1/P2/P3
- `milestone` - M2/M3/etc
- `tags` - Categorization tags
- `summary` - Detailed description
- `acceptance` - Acceptance criteria
- `effort` - Time estimate
- `impact` - Business impact assessment
- `references` - Related code/docs
- `notes` - Additional context
