#!/usr/bin/env bash
set -euo pipefail

APP="${APP:-swarm-rati-pilot}"
REGION="${REGION:-sea}"
VOLUME_NAME="${VOLUME_NAME:-swarm_data}"
VOLUME_SIZE="${VOLUME_SIZE:-3}"
ORIGIN="https://${APP}.fly.dev"

usage() {
  cat <<EOF
Usage:
  APP=swarm-rati-pilot \\
  ADMIN_PASSWORD=\$(openssl rand -base64 32) \\
  LOCAL_TOKEN=\$(openssl rand -hex 32) \\
  OPENROUTER_API_KEY=sk-or-... \\
  $0

Optional env:
  REGION=$REGION
  VOLUME_NAME=$VOLUME_NAME
  VOLUME_SIZE=$VOLUME_SIZE
  SKIP_DEPLOY=1     create app/volume/secrets but do not deploy
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if ! command -v flyctl >/dev/null 2>&1; then
  echo "flyctl is required: https://fly.io/docs/flyctl/install/" >&2
  exit 1
fi

if [[ -z "${ADMIN_PASSWORD:-}" ]]; then
  echo "ADMIN_PASSWORD is required" >&2
  usage >&2
  exit 1
fi

if [[ -z "${LOCAL_TOKEN:-}" ]]; then
  echo "LOCAL_TOKEN is required" >&2
  usage >&2
  exit 1
fi

echo "[pilot] app=$APP region=$REGION volume=$VOLUME_NAME origin=$ORIGIN"

if ! flyctl apps list --json | grep -q "\"Name\":\"$APP\""; then
  echo "[pilot] creating Fly app $APP"
  flyctl apps create "$APP"
else
  echo "[pilot] Fly app exists"
fi

if ! flyctl volumes list --app "$APP" --json | grep -q "\"name\":\"$VOLUME_NAME\""; then
  echo "[pilot] creating volume $VOLUME_NAME"
  flyctl volumes create "$VOLUME_NAME" \
    --app "$APP" \
    --region "$REGION" \
    --size "$VOLUME_SIZE" \
    --yes
else
  echo "[pilot] volume exists"
fi

secret_args=(
  "SWARM_ADMIN_PASSWORD=$ADMIN_PASSWORD"
  "SWARM_LOCAL_API_TOKEN=$LOCAL_TOKEN"
  "SWARM_ALLOWED_ORIGINS=$ORIGIN"
)

if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
  secret_args+=("OPENROUTER_API_KEY=$OPENROUTER_API_KEY")
fi

echo "[pilot] setting secrets"
flyctl secrets set --app "$APP" "${secret_args[@]}"

if [[ "${SKIP_DEPLOY:-}" == "1" ]]; then
  echo "[pilot] SKIP_DEPLOY=1; not deploying"
else
  echo "[pilot] deploying"
  flyctl deploy --app "$APP"
fi

cat <<EOF

[pilot] first admin URL:
  $ORIGIN/?swarmLocalToken=$LOCAL_TOKEN

[pilot] health:
  $ORIGIN/health
EOF
