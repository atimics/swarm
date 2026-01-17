#!/bin/bash
set -euo pipefail

ENV="${1:-staging}"
ACTION="${2:-}"

if [ -z "$ACTION" ] || { [ "$ACTION" != "pull" ] && [ "$ACTION" != "push" ]; }; then
  echo "Usage: $0 <staging|prod|...> <pull|push>"
  echo ""
  echo "Requires:"
  echo "  SWARM_CDK_CONTEXT_BUCKET   S3 bucket name"
  echo "Optional:"
  echo "  SWARM_CDK_CONTEXT_PREFIX   S3 key prefix (default: swarm/cdk-context)"
  exit 2
fi

if [ -z "${SWARM_CDK_CONTEXT_BUCKET:-}" ]; then
  echo "Error: SWARM_CDK_CONTEXT_BUCKET is required (S3 bucket name)." >&2
  exit 1
fi

PREFIX="${SWARM_CDK_CONTEXT_PREFIX:-swarm/cdk-context}"
LOCAL_PATH="packages/infra/cdk.context.json"
S3_URI="s3://${SWARM_CDK_CONTEXT_BUCKET}/${PREFIX}/${ENV}/cdk.context.json"

mkdir -p "$(dirname "$LOCAL_PATH")"

case "$ACTION" in
  pull)
    echo "Downloading $S3_URI -> $LOCAL_PATH"
    aws s3 cp "$S3_URI" "$LOCAL_PATH" --only-show-errors
    echo "OK"
    ;;
  push)
    if [ ! -f "$LOCAL_PATH" ]; then
      echo "Error: $LOCAL_PATH not found. Run secrets setup or create it first." >&2
      exit 1
    fi
    echo "Uploading $LOCAL_PATH -> $S3_URI"
    aws s3 cp "$LOCAL_PATH" "$S3_URI" --only-show-errors --sse AES256
    echo "OK"
    ;;
esac
