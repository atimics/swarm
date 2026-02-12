#!/bin/bash
# Migrate avatar secrets from staging to production
set -euo pipefail

AVATAR_ID="${1:-agent-18-sp9g}"
SOURCE_ENV="${2:-staging}"
TARGET_ENV="${3:-prod}"

# Secret types to migrate
SECRET_TYPES=(
  "telegram_webhook_secret"
  "twitter_access_token"
  "twitter_access_secret"
  "replicate_api_key"
)

echo "=== Migrating secrets for $AVATAR_ID ==="
echo "Source: $SOURCE_ENV -> Target: $TARGET_ENV"

for SECRET_TYPE in "${SECRET_TYPES[@]}"; do
  echo ""
  echo "--- $SECRET_TYPE ---"
  
  # Try to get secret from staging (may use swarm-split or swarm prefix)
  SECRET_VALUE=""
  for PREFIX in "swarm-split" "swarm"; do
    SECRET_VALUE=$(AWS_PROFILE="$SOURCE_ENV" aws secretsmanager get-secret-value \
      --secret-id "${PREFIX}/${AVATAR_ID}/${SECRET_TYPE}/default" \
      --query SecretString --output text 2>/dev/null) && break
  done
  
  if [ -z "$SECRET_VALUE" ]; then
    echo "  Not found in staging, skipping"
    continue
  fi
  
  echo "  Got from staging (length: ${#SECRET_VALUE})"
  
  # Create or update in prod
  NEW_ARN=$(AWS_PROFILE="$TARGET_ENV" aws secretsmanager create-secret \
    --name "swarm/${AVATAR_ID}/${SECRET_TYPE}/default" \
    --secret-string "$SECRET_VALUE" \
    --description "Migrated from ${SOURCE_ENV}" \
    --query ARN --output text 2>/dev/null) || \
  NEW_ARN=$(AWS_PROFILE="$TARGET_ENV" aws secretsmanager put-secret-value \
    --secret-id "swarm/${AVATAR_ID}/${SECRET_TYPE}/default" \
    --secret-string "$SECRET_VALUE" \
    --query ARN --output text)
  
  echo "  Created/Updated in prod: $NEW_ARN"
  
  # Update DynamoDB record to point to new ARN
  AWS_PROFILE="$TARGET_ENV" aws dynamodb update-item \
    --table-name "SwarmAdmin-${TARGET_ENV}" \
    --key "{\"pk\":{\"S\":\"AVATAR#${AVATAR_ID}\"},\"sk\":{\"S\":\"SECRET#${SECRET_TYPE}#default\"}}" \
    --update-expression "SET secretArn = :arn" \
    --expression-attribute-values "{\":arn\":{\"S\":\"$NEW_ARN\"}}"
  
  echo "  DynamoDB record updated"
done

echo ""
echo "=== Secrets migration complete ==="
