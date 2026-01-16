#!/bin/bash
#
# AWS Secrets Manager Setup Script
# Interactively creates/updates secrets needed for Swarm deployment
#
# Usage: ./scripts/setup-secrets.sh [environment]
# Example: ./scripts/setup-secrets.sh staging
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default environment
ENV="${1:-staging}"
PREFIX="swarm"

echo -e "${BLUE}"
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║           AWS Secrets Manager Setup for Swarm                  ║"
echo "║                  Environment: ${ENV}                              ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Check AWS CLI is configured
if ! aws sts get-caller-identity &>/dev/null; then
    echo -e "${RED}Error: AWS CLI not configured or no valid credentials${NC}"
    echo "Please run 'aws configure' or set AWS_PROFILE"
    exit 1
fi

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=$(aws configure get region || echo "us-east-1")

echo -e "${GREEN}AWS Account: ${ACCOUNT_ID}${NC}"
echo -e "${GREEN}Region: ${REGION}${NC}"
echo ""

# Function to create or update a secret
create_secret() {
    local name="$1"
    local description="$2"
    local help_url="$3"
    local is_json="${4:-false}"

    local full_name="${PREFIX}/${ENV}/${name}"

    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}Secret: ${full_name}${NC}"
    echo -e "Description: ${description}"
    if [ -n "$help_url" ]; then
        echo -e "Get it from: ${help_url}"
    fi
    echo ""

    # Check if secret exists
    if aws secretsmanager describe-secret --secret-id "$full_name" &>/dev/null; then
        echo -e "${GREEN}✓ Secret exists${NC}"
        read -p "Update this secret? [y/N/skip]: " choice
    else
        echo -e "${YELLOW}○ Secret does not exist${NC}"
        read -p "Create this secret? [y/N/skip]: " choice
    fi

    case "$choice" in
        [yY]|[yY][eE][sS])
            if [ "$is_json" = "true" ]; then
                echo "Enter JSON value (paste and press Enter, then Ctrl+D):"
                value=$(cat)
            else
                read -sp "Enter secret value: " value
                echo ""
            fi

            if [ -z "$value" ]; then
                echo -e "${YELLOW}Skipped (empty value)${NC}"
                return
            fi

            # Create or update
            if aws secretsmanager describe-secret --secret-id "$full_name" &>/dev/null; then
                aws secretsmanager put-secret-value \
                    --secret-id "$full_name" \
                    --secret-string "$value" \
                    --output text > /dev/null
                echo -e "${GREEN}✓ Secret updated${NC}"
            else
                aws secretsmanager create-secret \
                    --name "$full_name" \
                    --description "$description" \
                    --secret-string "$value" \
                    --output text > /dev/null
                echo -e "${GREEN}✓ Secret created${NC}"
            fi
            ;;
        [sS]|[sS][kK][iI][pP])
            echo -e "${YELLOW}Skipped${NC}"
            ;;
        *)
            echo -e "${YELLOW}Skipped${NC}"
            ;;
    esac
    echo ""
}

# Function for global secrets (not environment-specific)
create_global_secret() {
    local name="$1"
    local description="$2"
    local help_url="$3"
    local is_json="${4:-false}"

    local full_name="${PREFIX}/global/${name}"

    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}Secret: ${full_name} (GLOBAL)${NC}"
    echo -e "Description: ${description}"
    if [ -n "$help_url" ]; then
        echo -e "Get it from: ${help_url}"
    fi
    echo ""

    # Check if secret exists
    if aws secretsmanager describe-secret --secret-id "$full_name" &>/dev/null; then
        echo -e "${GREEN}✓ Secret exists${NC}"
        read -p "Update this secret? [y/N/skip]: " choice
    else
        echo -e "${YELLOW}○ Secret does not exist${NC}"
        read -p "Create this secret? [y/N/skip]: " choice
    fi

    case "$choice" in
        [yY]|[yY][eE][sS])
            if [ "$is_json" = "true" ]; then
                echo "Enter JSON value (paste and press Enter, then Ctrl+D):"
                value=$(cat)
            else
                read -sp "Enter secret value: " value
                echo ""
            fi

            if [ -z "$value" ]; then
                echo -e "${YELLOW}Skipped (empty value)${NC}"
                return
            fi

            # Create or update
            if aws secretsmanager describe-secret --secret-id "$full_name" &>/dev/null; then
                aws secretsmanager put-secret-value \
                    --secret-id "$full_name" \
                    --secret-string "$value" \
                    --output text > /dev/null
                echo -e "${GREEN}✓ Secret updated${NC}"
            else
                aws secretsmanager create-secret \
                    --name "$full_name" \
                    --description "$description" \
                    --secret-string "$value" \
                    --output text > /dev/null
                echo -e "${GREEN}✓ Secret created${NC}"
            fi
            ;;
        *)
            echo -e "${YELLOW}Skipped${NC}"
            ;;
    esac
    echo ""
}

echo -e "${BLUE}=== Required Secrets ===${NC}"
echo ""

# OpenRouter API Key (Required)
create_secret \
    "openrouter-api-key" \
    "OpenRouter API key for LLM access (Claude, GPT, etc.)" \
    "https://openrouter.ai/keys"

# Helius API Key (Required for NFT gating)
create_secret \
    "helius-api-key" \
    "Helius API key for Solana RPC and NFT queries" \
    "https://dev.helius.xyz/dashboard/app"

echo -e "${BLUE}=== Optional Secrets ===${NC}"
echo ""

# Replicate API Key (Optional - for image generation)
create_secret \
    "replicate-api-key" \
    "Replicate API key for AI image/video generation" \
    "https://replicate.com/account/api-tokens"

# Web Search API Key (Optional)
create_secret \
    "web-search-api-key" \
    "SerpAPI key for web search functionality" \
    "https://serpapi.com/manage-api-key"

# Crossmint API Key (Optional - for server-side JWT verification)
create_secret \
    "crossmint-api-key" \
    "Crossmint server API key for JWT verification" \
    "https://console.crossmint.com"

echo -e "${BLUE}=== Global Secrets (shared across environments) ===${NC}"
echo ""

# Twitter App Credentials (Global - JSON format)
echo -e "${YELLOW}Twitter App Credentials require JSON format:${NC}"
echo '{"consumer_key": "...", "consumer_secret": "..."}'
echo ""
create_global_secret \
    "twitter-app-credentials" \
    "Twitter/X OAuth app credentials (JSON)" \
    "https://developer.twitter.com/en/portal/dashboard" \
    "true"

echo -e "${BLUE}"
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║                    Setup Complete!                             ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

echo "Secret ARNs for CDK configuration:"
echo ""

# List created secrets
echo -e "${GREEN}Environment secrets (${ENV}):${NC}"
for secret in openrouter-api-key helius-api-key replicate-api-key web-search-api-key crossmint-api-key; do
    full_name="${PREFIX}/${ENV}/${secret}"
    if aws secretsmanager describe-secret --secret-id "$full_name" &>/dev/null 2>&1; then
        arn=$(aws secretsmanager describe-secret --secret-id "$full_name" --query ARN --output text)
        echo "  $secret:"
        echo "    $arn"
    fi
done

echo ""
echo -e "${GREEN}Global secrets:${NC}"
for secret in twitter-app-credentials; do
    full_name="${PREFIX}/global/${secret}"
    if aws secretsmanager describe-secret --secret-id "$full_name" &>/dev/null 2>&1; then
        arn=$(aws secretsmanager describe-secret --secret-id "$full_name" --query ARN --output text)
        echo "  $secret:"
        echo "    $arn"
    fi
done

echo ""
echo -e "${BLUE}=== Updating CDK Configuration ===${NC}"
echo ""

# Path to cdk.json
CDK_JSON="packages/infra/cdk.json"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CDK_JSON_PATH="${SCRIPT_DIR}/../${CDK_JSON}"

if [ -f "$CDK_JSON_PATH" ]; then
    # Get ARNs for each secret
    OPENROUTER_ARN=""
    HELIUS_ARN=""
    REPLICATE_ARN=""
    WEBSEARCH_ARN=""
    CROSSMINT_ARN=""
    TWITTER_ARN=""

    for secret in openrouter-api-key helius-api-key replicate-api-key web-search-api-key crossmint-api-key; do
        full_name="${PREFIX}/${ENV}/${secret}"
        if aws secretsmanager describe-secret --secret-id "$full_name" &>/dev/null 2>&1; then
            arn=$(aws secretsmanager describe-secret --secret-id "$full_name" --query ARN --output text)
            case "$secret" in
                openrouter-api-key) OPENROUTER_ARN="$arn" ;;
                helius-api-key) HELIUS_ARN="$arn" ;;
                replicate-api-key) REPLICATE_ARN="$arn" ;;
                web-search-api-key) WEBSEARCH_ARN="$arn" ;;
                crossmint-api-key) CROSSMINT_ARN="$arn" ;;
            esac
        fi
    done

    # Get global Twitter credentials ARN
    full_name="${PREFIX}/global/twitter-app-credentials"
    if aws secretsmanager describe-secret --secret-id "$full_name" &>/dev/null 2>&1; then
        TWITTER_ARN=$(aws secretsmanager describe-secret --secret-id "$full_name" --query ARN --output text)
    fi

    # Update cdk.json using jq if available, otherwise use node
    if command -v jq &>/dev/null; then
        # Build jq update expression
        JQ_EXPR=".context.environments.${ENV}"
        [ -n "$OPENROUTER_ARN" ] && JQ_EXPR="${JQ_EXPR} | .openRouterApiKeyArn = \"${OPENROUTER_ARN}\""
        [ -n "$HELIUS_ARN" ] && JQ_EXPR="${JQ_EXPR} | .heliusApiKeyArn = \"${HELIUS_ARN}\""
        [ -n "$REPLICATE_ARN" ] && JQ_EXPR="${JQ_EXPR} | .replicateApiKeyArn = \"${REPLICATE_ARN}\""
        [ -n "$WEBSEARCH_ARN" ] && JQ_EXPR="${JQ_EXPR} | .webSearchApiKeyArn = \"${WEBSEARCH_ARN}\""
        [ -n "$CROSSMINT_ARN" ] && JQ_EXPR="${JQ_EXPR} | .crossmintApiKeyArn = \"${CROSSMINT_ARN}\""

        # Apply updates
        jq "(.context.environments.${ENV}) |= (${JQ_EXPR} | .)" "$CDK_JSON_PATH" > "${CDK_JSON_PATH}.tmp" && mv "${CDK_JSON_PATH}.tmp" "$CDK_JSON_PATH"
        echo -e "${GREEN}✓ Updated ${CDK_JSON} with secret ARNs for ${ENV}${NC}"
    else
        # Use node/tsx as fallback
        node -e "
const fs = require('fs');
const path = '${CDK_JSON_PATH}';
const config = JSON.parse(fs.readFileSync(path, 'utf8'));
const env = '${ENV}';

if (!config.context.environments[env]) {
    config.context.environments[env] = {};
}

const updates = {
    openRouterApiKeyArn: '${OPENROUTER_ARN}' || undefined,
    heliusApiKeyArn: '${HELIUS_ARN}' || undefined,
    replicateApiKeyArn: '${REPLICATE_ARN}' || undefined,
    webSearchApiKeyArn: '${WEBSEARCH_ARN}' || undefined,
    crossmintApiKeyArn: '${CROSSMINT_ARN}' || undefined,
};

Object.entries(updates).forEach(([key, value]) => {
    if (value) config.context.environments[env][key] = value;
});

fs.writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
console.log('Updated ${CDK_JSON} with secret ARNs for ${ENV}');
"
        echo -e "${GREEN}✓ Updated ${CDK_JSON} with secret ARNs for ${ENV}${NC}"
    fi
else
    echo -e "${YELLOW}Warning: ${CDK_JSON} not found, skipping automatic update${NC}"
    echo "Please manually copy the ARNs above to your CDK configuration"
fi

echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo "1. Run 'pnpm -r build' to rebuild"
echo "2. Deploy with 'cd packages/infra && npx cdk deploy'"
echo ""
