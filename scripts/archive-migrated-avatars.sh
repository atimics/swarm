#!/bin/bash
# Archive avatars from staging that have been migrated to production
# This copies all records for each avatar to the archive table, then deletes from staging

set -e

SOURCE_TABLE="SwarmAdmin-staging"
ARCHIVE_TABLE="SwarmAdmin-staging-archive"
PROFILE="staging"

# Avatars that exist in both staging and prod
MIGRATED_AVATARS=(
  "agent-1-0ieo"
  "agent-1-55e3"
  "agent-1-6yan"
  "agent-1-wflt"
  "agent-11-oqd2"
  "agent-12-1pzv"
  "agent-13-955e"
  "agent-15-uyoe"
  "agent-16-9uzw"
  "agent-17-3p6j"
  "agent-18-sp9g"
  "agent-24-eses"
  "agent-3-qkwg"
  "agent-4-3aah"
  "agent-5-vpnx"
  "agent-6-1cc5"
  "agent-8-5ypy"
  "agent-9-4u0m"
  "avatar-1-9qhu"
)

ARCHIVED=0
DELETED=0
ERRORS=0

for AVATAR_ID in "${MIGRATED_AVATARS[@]}"; do
  echo "=========================================="
  echo "Processing: $AVATAR_ID"
  echo "=========================================="
  
  # Get all records for this avatar
  RECORDS=$(AWS_PROFILE=$PROFILE aws dynamodb query \
    --table-name $SOURCE_TABLE \
    --key-condition-expression "pk = :pk" \
    --expression-attribute-values "{\":pk\":{\"S\":\"AVATAR#${AVATAR_ID}\"}}" \
    --output json 2>&1)
  
  COUNT=$(echo "$RECORDS" | jq '.Items | length')
  echo "Found $COUNT records for $AVATAR_ID"
  
  if [ "$COUNT" -eq 0 ]; then
    echo "⚠️  No records found, skipping"
    continue
  fi
  
  # Archive each record
  echo "$RECORDS" | jq -c '.Items[]' | while read -r item; do
    sk=$(echo "$item" | jq -r '.sk.S')
    
    # Add archive metadata
    ARCHIVED_ITEM=$(echo "$item" | jq --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      '. + {"archivedAt": {"S": $ts}, "archivedFrom": {"S": "SwarmAdmin-staging"}}')
    
    # Write to archive table
    AWS_PROFILE=$PROFILE aws dynamodb put-item \
      --table-name $ARCHIVE_TABLE \
      --item "$ARCHIVED_ITEM" 2>&1 > /dev/null
    
    if [ $? -eq 0 ]; then
      echo "  ✅ Archived: $sk"
      ((ARCHIVED++)) || true
    else
      echo "  ❌ Failed to archive: $sk"
      ((ERRORS++)) || true
    fi
  done
  
  # Verify records were archived
  ARCHIVED_COUNT=$(AWS_PROFILE=$PROFILE aws dynamodb query \
    --table-name $ARCHIVE_TABLE \
    --key-condition-expression "pk = :pk" \
    --expression-attribute-values "{\":pk\":{\"S\":\"AVATAR#${AVATAR_ID}\"}}" \
    --select COUNT \
    --output json 2>&1 | jq '.Count')
  
  if [ "$ARCHIVED_COUNT" -eq "$COUNT" ]; then
    echo "✅ Verified $ARCHIVED_COUNT records archived"
    
    # Delete from source table
    echo "Deleting from source table..."
    echo "$RECORDS" | jq -c '.Items[]' | while read -r item; do
      pk=$(echo "$item" | jq -r '.pk.S')
      sk=$(echo "$item" | jq -r '.sk.S')
      
      AWS_PROFILE=$PROFILE aws dynamodb delete-item \
        --table-name $SOURCE_TABLE \
        --key "{\"pk\":{\"S\":\"$pk\"},\"sk\":{\"S\":\"$sk\"}}" 2>&1 > /dev/null
      
      if [ $? -eq 0 ]; then
        echo "  🗑️  Deleted: $sk"
        ((DELETED++)) || true
      else
        echo "  ❌ Failed to delete: $sk"
        ((ERRORS++)) || true
      fi
    done
  else
    echo "❌ Archive count mismatch ($ARCHIVED_COUNT vs $COUNT), skipping deletion"
    ((ERRORS++)) || true
  fi
  
  echo ""
done

echo "=========================================="
echo "Archive Summary"
echo "=========================================="
echo "Avatars processed: ${#MIGRATED_AVATARS[@]}"
echo "Archive table: $ARCHIVE_TABLE"
echo "=========================================="
