#!/usr/bin/env bash
set -euo pipefail

# Cutover staging to split stacks and (optionally) delete the legacy monolithic stack.
#
# This script is intentionally conservative:
# - It writes logs to audit/staging/ instead of spamming the console.
# - It will NOT delete the legacy stack unless CONFIRM_DELETE_LEGACY=YES is set.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AUDIT_DIR="$ROOT_DIR/audit/staging"
mkdir -p "$AUDIT_DIR"

log() {
  # Minimal console output, detailed logs in files.
  printf '%s\n' "$1"
}

run_logged() {
  local name="$1"; shift
  local logfile="$AUDIT_DIR/${name}.log"
  # shellcheck disable=SC2124
  local cmd="$@"
  log "Running: $name (logging to $logfile)"
  (cd "$ROOT_DIR" && eval "$cmd") >"$logfile" 2>&1
}

# 1) Build infra (ensures CDK app reflects current code)
run_logged infra_build "pnpm -C packages/infra build"

# 2) Deploy split stacks (staging migration mode)
# NOTE: We keep useExistingSharedResources=true to avoid re-creating shared tables/buckets.
SPLIT_CTX="-c environment=staging -c splitStacks=true -c useExistingSharedResources=true -c enableSharedHandlers=true"
run_logged deploy_split_api "pnpm -C packages/infra cdk deploy SwarmApi-staging $SPLIT_CTX --require-approval never"
run_logged deploy_split_ui "pnpm -C packages/infra cdk deploy SwarmUi-staging $SPLIT_CTX --require-approval never"

# Optional: avatars stack can be deployed separately if you’re changing avatar configs.
# run_logged deploy_split_avatars "pnpm -C packages/infra cdk deploy SwarmAvatars-staging $SPLIT_CTX --require-approval never"

log "Next: use the Admin UI to run ‘Repair Telegram webhook’ for affected avatars (or run your existing repair script)."

# 3) Update legacy stack once to apply staging RETAIN policies (prevents data loss on delete)
run_logged deploy_legacy_retention "pnpm -C packages/infra cdk deploy SwarmStack-staging -c environment=staging --require-approval never"

# 4) Optional: delete legacy monolithic stack
if [[ "${CONFIRM_DELETE_LEGACY:-}" != "YES" ]]; then
  log "Skipping legacy deletion. To delete, re-run with CONFIRM_DELETE_LEGACY=YES."
  exit 0
fi

run_logged delete_legacy "aws cloudformation delete-stack --stack-name SwarmStack-staging"
run_logged wait_delete_legacy "aws cloudformation wait stack-delete-complete --stack-name SwarmStack-staging"

log "Legacy stack deleted (data resources should be retained per updated policies)."
