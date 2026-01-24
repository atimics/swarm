#!/bin/bash
#
# Fast deploy Lambda handlers directly (bypasses CDK/CloudFormation)
# Usage: ./scripts/fast-deploy.sh [staging|prod] [function-name]
#
# Examples:
#   ./scripts/fast-deploy.sh staging                    # Deploy all to staging
#   ./scripts/fast-deploy.sh staging message-processor  # Deploy one function
#   ./scripts/fast-deploy.sh prod telegram-webhook-shared
#
set -e

ENV="${1:-staging}"
FUNCTION="${2:-all}"

# Validate environment
if [[ "$ENV" != "staging" && "$ENV" != "prod" ]]; then
  echo "❌ Invalid environment: $ENV (use 'staging' or 'prod')"
  exit 1
fi

# Function mappings
declare -A FUNCTION_MAP=(
  ["message-processor"]="swarm-${ENV}-message-processor"
  ["telegram-webhook-shared"]="swarm-${ENV}-telegram-webhook"
  ["response-sender"]="swarm-${ENV}-response-sender"
  ["media-processor"]="swarm-${ENV}-media-processor"
  ["twitter-mention-poller"]="swarm-${ENV}-twitter-mention-poller"
  ["autonomous-tweet-poster"]="swarm-${ENV}-autonomous-tweet-poster"
)

# Build dependencies first
echo "🔨 Building packages..."
pnpm --filter @swarm/core --filter @swarm/mcp-server --filter @swarm/handlers build

cd packages/handlers

# Determine functions to deploy
if [ "$FUNCTION" = "all" ]; then
  FUNCTIONS="${!FUNCTION_MAP[@]}"
else
  FUNCTIONS="$FUNCTION"
fi

TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

for handler in $FUNCTIONS; do
  LAMBDA_NAME="${FUNCTION_MAP[$handler]}"
  if [ -z "$LAMBDA_NAME" ]; then
    echo "⚠️  Unknown handler: $handler"
    continue
  fi
  
  ENTRY="src/${handler}.ts"
  if [ ! -f "$ENTRY" ]; then
    echo "⚠️  Entry not found: $ENTRY"
    continue
  fi
  
  echo "📦 Bundling ${handler}..."
  
  mkdir -p "$TMPDIR/$handler"
  
  npx esbuild "$ENTRY" \
    --bundle \
    --platform=node \
    --target=node20 \
    --format=esm \
    --outfile="$TMPDIR/$handler/index.mjs" \
    --external:@aws-sdk/* \
    --external:sharp \
    --sourcemap \
    --minify 2>/dev/null
  
  cd "$TMPDIR/$handler"
  zip -q "${handler}.zip" index.mjs index.mjs.map
  
  echo "⬆️  Updating ${LAMBDA_NAME}..."
  
  aws lambda update-function-code \
    --function-name "$LAMBDA_NAME" \
    --zip-file "fileb://${handler}.zip" \
    --no-cli-pager > /dev/null
  
  echo "✅ ${LAMBDA_NAME} updated"
  cd - > /dev/null
done

echo ""
echo "🎉 Fast deploy complete!"
