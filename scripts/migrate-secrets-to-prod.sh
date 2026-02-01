#!/bin/bash
# Migrate secret ARN references from staging to prod account in DynamoDB
# This updates secretArn fields that point to the staging account (022118847419)
# to point to the equivalent secrets in the prod account (332730082708)

set -e

STAGING_ACCOUNT="022118847419"
PROD_ACCOUNT="332730082708"
TABLE="SwarmAdmin-prod"

echo "Fetching secrets pointing to staging account..."

# Get all secret records pointing to staging
STAGING_SECRETS=$(AWS_PROFILE=prod aws dynamodb scan \
  --table-name $TABLE \
  --filter-expression "contains(secretArn, :staging)" \
  --expression-attribute-values "{\":staging\":{\"S\":\"$STAGING_ACCOUNT\"}}" \
  --output json)

COUNT=$(echo "$STAGING_SECRETS" | jq '.Items | length')
echo "Found $COUNT secrets pointing to staging account"

# Process each one
echo "$STAGING_SECRETS" | jq -c '.Items[]' | while read -r item; do
  pk=$(echo "$item" | jq -r '.pk.S')
  sk=$(echo "$item" | jq -r '.sk.S')
  old_arn=$(echo "$item" | jq -r '.secretArn.S')
  
  # Extract the secret name from the ARN (everything after ":secret:")
  secret_name=$(echo "$old_arn" | sed 's/.*:secret://')
  # Remove the trailing random suffix (e.g., -YSb9zU)
  secret_base_name=$(echo "$secret_name" | sed 's/-[A-Za-z0-9]\{6\}$//')
  
  echo "Processing: $pk | $sk"
  echo "  Old ARN: $old_arn"
  
  # Check if the secret exists in prod with the same base name
  PROD_SECRET=$(AWS_PROFILE=prod aws secretsmanager list-secrets \
    --filter Key=name,Values="$secret_base_name" \
    --output json 2>/dev/null | jq -r '.SecretList[0].ARN // empty')
  
  if [ -n "$PROD_SECRET" ]; then
    echo "  Found in prod: $PROD_SECRET"
    
    # Update DynamoDB
    AWS_PROFILE=prod aws dynamodb update-item \
      --table-name $TABLE \
      --key "{\"pk\":{\"S\":\"$pk\"},\"sk\":{\"S\":\"$sk\"}}" \
      --update-expression "SET secretArn = :arn, updatedAt = :now" \
      --expression-attribute-values "{\":arn\":{\"S\":\"$PROD_SECRET\"},\":now\":{\"N\":\"$(date +%s)000\"}}" \
      --return-values NONE
    
    echo "  ✅ Updated to prod ARN"
  else
    echo "  ⚠️  Secret not found in prod: $secret_base_name"
  fi
  
  echo ""
done

echo "Migration complete!"
