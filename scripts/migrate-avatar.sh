#!/bin/bash
# Avatar Migration Script
# Usage: ./scripts/migrate-avatar.sh <avatar-id> <source-env> <target-env>
# Example: ./scripts/migrate-avatar.sh agent-18-sp9g staging prod

set -euo pipefail

AVATAR_ID="${1:?Usage: $0 <avatar-id> <source-env> <target-env>}"
SOURCE_ENV="${2:-staging}"
TARGET_ENV="${3:-prod}"

MIGRATIONS_DIR="$(dirname "$0")/../migrations"
mkdir -p "$MIGRATIONS_DIR"

# Table names
SOURCE_ADMIN_TABLE="SwarmAdmin-${SOURCE_ENV}"
SOURCE_STATE_TABLE="swarm-state-${SOURCE_ENV}"
TARGET_ADMIN_TABLE="SwarmAdmin-${TARGET_ENV}"
TARGET_STATE_TABLE="swarm-state-${TARGET_ENV}"

echo "=== Migrating avatar: $AVATAR_ID ==="
echo "Source: $SOURCE_ENV -> Target: $TARGET_ENV"
echo ""

# Step 1: Export from source
echo "[1/4] Exporting admin data from $SOURCE_ADMIN_TABLE..."
AWS_PROFILE="$SOURCE_ENV" aws dynamodb query \
  --table-name "$SOURCE_ADMIN_TABLE" \
  --key-condition-expression "pk = :pk" \
  --expression-attribute-values "{\":pk\":{\"S\":\"AVATAR#${AVATAR_ID}\"}}" \
  > "$MIGRATIONS_DIR/${AVATAR_ID}-admin-${SOURCE_ENV}.json"

ADMIN_COUNT=$(jq '.Count' "$MIGRATIONS_DIR/${AVATAR_ID}-admin-${SOURCE_ENV}.json")
echo "   Exported $ADMIN_COUNT admin records"

echo "[2/4] Exporting state data from $SOURCE_STATE_TABLE..."
AWS_PROFILE="$SOURCE_ENV" aws dynamodb query \
  --table-name "$SOURCE_STATE_TABLE" \
  --key-condition-expression "pk = :pk" \
  --expression-attribute-values "{\":pk\":{\"S\":\"AVATAR#${AVATAR_ID}\"}}" \
  > "$MIGRATIONS_DIR/${AVATAR_ID}-state-${SOURCE_ENV}.json"

STATE_COUNT=$(jq '.Count' "$MIGRATIONS_DIR/${AVATAR_ID}-state-${SOURCE_ENV}.json")
echo "   Exported $STATE_COUNT state records"

# Step 2: Convert to batch-write format and import
echo "[3/4] Importing admin data to $TARGET_ADMIN_TABLE..."

# Convert Items array to batch-write format (25 items per batch)
jq -c '.Items[]' "$MIGRATIONS_DIR/${AVATAR_ID}-admin-${SOURCE_ENV}.json" | \
while IFS= read -r item; do
  echo "{\"PutRequest\":{\"Item\":$item}}"
done | jq -s "{\"$TARGET_ADMIN_TABLE\": .}" > "$MIGRATIONS_DIR/${AVATAR_ID}-admin-batch.json"

# Split into batches of 25 and write
BATCH_SIZE=25
TOTAL_ADMIN=$(jq ".[\"$TARGET_ADMIN_TABLE\"] | length" "$MIGRATIONS_DIR/${AVATAR_ID}-admin-batch.json")

if [ "$TOTAL_ADMIN" -gt 0 ]; then
  for ((i=0; i<TOTAL_ADMIN; i+=BATCH_SIZE)); do
    END=$((i + BATCH_SIZE))
    jq "{\"$TARGET_ADMIN_TABLE\": .[\"$TARGET_ADMIN_TABLE\"][$i:$END]}" "$MIGRATIONS_DIR/${AVATAR_ID}-admin-batch.json" \
      > "$MIGRATIONS_DIR/batch-temp.json"
    
    AWS_PROFILE="$TARGET_ENV" aws dynamodb batch-write-item \
      --request-items "file://$MIGRATIONS_DIR/batch-temp.json" > /dev/null
    
    echo "   Wrote admin batch $((i/BATCH_SIZE + 1)) (items $((i+1))-$((END < TOTAL_ADMIN ? END : TOTAL_ADMIN)))"
  done
fi

echo "[4/4] Importing state data to $TARGET_STATE_TABLE..."

jq -c '.Items[]' "$MIGRATIONS_DIR/${AVATAR_ID}-state-${SOURCE_ENV}.json" | \
while IFS= read -r item; do
  echo "{\"PutRequest\":{\"Item\":$item}}"
done | jq -s "{\"$TARGET_STATE_TABLE\": .}" > "$MIGRATIONS_DIR/${AVATAR_ID}-state-batch.json"

TOTAL_STATE=$(jq ".[\"$TARGET_STATE_TABLE\"] | length" "$MIGRATIONS_DIR/${AVATAR_ID}-state-batch.json")

if [ "$TOTAL_STATE" -gt 0 ]; then
  for ((i=0; i<TOTAL_STATE; i+=BATCH_SIZE)); do
    END=$((i + BATCH_SIZE))
    jq "{\"$TARGET_STATE_TABLE\": .[\"$TARGET_STATE_TABLE\"][$i:$END]}" "$MIGRATIONS_DIR/${AVATAR_ID}-state-batch.json" \
      > "$MIGRATIONS_DIR/batch-temp.json"
    
    AWS_PROFILE="$TARGET_ENV" aws dynamodb batch-write-item \
      --request-items "file://$MIGRATIONS_DIR/batch-temp.json" > /dev/null
    
    echo "   Wrote state batch $((i/BATCH_SIZE + 1)) (items $((i+1))-$((END < TOTAL_STATE ? END : TOTAL_STATE)))"
  done
fi

# Cleanup temp files
rm -f "$MIGRATIONS_DIR/batch-temp.json"

echo ""
echo "=== Migration complete ==="
echo "Admin records: $ADMIN_COUNT"
echo "State records: $STATE_COUNT"
echo ""
echo "NOTE: Secrets (Telegram tokens, API keys) need to be migrated separately!"
echo "Check SECRET# records in the export files for what needs manual migration."
