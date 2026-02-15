# Issues

This folder is the **source of truth** for tracked engineering issues. YAML files in `issues/open/` are automatically synced to GitHub Issues via the `issue-sync` workflow.

## How it works

```
issues/open/001-fix-build.yml   ──push to main──▶   GitHub Issue #N (created/updated)
issues/open/002-add-tests.yml   ──push to main──▶   GitHub Issue #M (created/updated)
(file deleted)                  ──push to main──▶   GitHub Issue #X (auto-closed)
```

1. **Create** — add a YAML file to `issues/open/`. On merge to main, the workflow creates a GitHub Issue.
2. **Update** — edit the YAML file. The workflow updates the matching GitHub Issue.
3. **Close** — delete the YAML file (or move it to `issues/closed/`). The workflow closes the GitHub Issue.
4. **Manual trigger** — run the workflow manually with `dry_run: true` to preview changes.

All synced issues are tagged with `managed:issue-sync` so they can be identified.

## Issue file format

```yaml
id: "001"
title: "fix(core): describe the problem"
priority: P0          # P0 (critical), P1 (high), P2 (medium), P3 (low)
type: bug             # bug, feature, security, docs, infra
labels:
  - type:bug
  - priority:high
  - package:core
assignees:
  - copilot-swe-agent[bot]
source: engineering-report-2026-02-15

body: |
  ## Problem
  Describe the problem here.

  ## Acceptance Criteria
  - [ ] Criterion 1
  - [ ] Criterion 2
```

### Fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique issue ID (matches filename) |
| `title` | Yes | GitHub issue title (use conventional commit format) |
| `priority` | Yes | P0-P3 |
| `type` | Yes | bug, feature, security, docs, infra |
| `labels` | Yes | GitHub labels (must exist or be in the label set) |
| `assignees` | No | GitHub usernames to assign |
| `source` | No | Where the issue was identified |
| `body` | Yes | Markdown body (use YAML block scalar `\|`) |

### Naming convention

```
NNN-short-description.yml
```

- `NNN` — zero-padded number matching the `id` field
- `short-description` — kebab-case summary

## Running the sync

The sync runs automatically on push to `main` when files in `issues/open/` change.

To run manually:
1. Go to **Actions > Issue Sync**
2. Click **Run workflow**
3. Optionally check **dry_run** to preview without creating issues

## Labels

The workflow auto-creates these labels if they don't exist:

| Label | Color | Description |
|-------|-------|-------------|
| `type:bug` | red | Bug report |
| `type:feature` | blue | New feature request |
| `type:security` | dark red | Security related |
| `priority:high` | orange | High priority |
| `priority:medium` | yellow | Medium priority |
| `priority:low` | green | Low priority |
| `package:core` | light blue | Affects core package |
| `package:admin` | light blue | Affects admin packages |
| `package:infra` | light blue | Affects infrastructure |
| `managed:issue-sync` | purple | Managed by this workflow |

## Legacy

The previous `issues/staging/` JSON format and avatar registry (`issues/avatars.json`) are superseded by this YAML-based workflow.
