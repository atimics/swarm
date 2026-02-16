#!/usr/bin/env bash
# Create a GitHub issue and optionally assign to Copilot.
#
# Usage:
#   scripts/gh-create-issue.sh --title "fix(core): ..." --body "..." [--labels "type:bug,priority:high"] [--copilot]
#
# Options:
#   --title     Issue title (required)
#   --body      Issue body in markdown (required; use - to read from stdin)
#   --labels    Comma-separated labels (default: none)
#   --copilot   Assign to Copilot coding agent after creation
#
# Examples:
#   # Create and assign to Copilot
#   scripts/gh-create-issue.sh \
#     --title "fix(core): broken test mocks in CI" \
#     --body "Tests fail due to vitest compat issues" \
#     --labels "type:bug,priority:high,package:core" \
#     --copilot
#
#   # Create from a file
#   scripts/gh-create-issue.sh --title "feat: new thing" --body - < issue-body.md

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TITLE=""
BODY=""
LABELS=""
ASSIGN_COPILOT=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --title)  TITLE="$2"; shift 2 ;;
    --body)   BODY="$2"; shift 2 ;;
    --labels) LABELS="$2"; shift 2 ;;
    --copilot) ASSIGN_COPILOT=true; shift ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: $0 --title TITLE --body BODY [--labels LABELS] [--copilot]" >&2
      exit 1
      ;;
  esac
done

if [ -z "$TITLE" ]; then
  echo "Error: --title is required" >&2
  exit 1
fi

if [ -z "$BODY" ]; then
  echo "Error: --body is required (use - for stdin)" >&2
  exit 1
fi

# Read body from stdin if -
if [ "$BODY" = "-" ]; then
  BODY="$(cat)"
fi

# Build gh issue create args
ARGS=(--title "$TITLE" --body "$BODY")
if [ -n "$LABELS" ]; then
  ARGS+=(--label "$LABELS")
fi

# Create the issue
ISSUE_URL=$(gh issue create "${ARGS[@]}")
ISSUE_NUMBER=$(echo "$ISSUE_URL" | grep -oE '[0-9]+$')

echo "Created: $ISSUE_URL"

# Optionally assign to Copilot
if $ASSIGN_COPILOT; then
  "$SCRIPT_DIR/gh-assign-copilot.sh" "$ISSUE_NUMBER"
fi
