#!/bin/bash
#
# Stripe Metered Price Setup (Overages)
#
# Creates metered prices for media/voice/video overages on Pro and Enterprise products.
# Must run AFTER setup-products.sh (reads product IDs from stripe-ids config).
#
# Usage:
#   ./stripe/scripts/setup-metered-prices.sh          # Test mode (default)
#   ./stripe/scripts/setup-metered-prices.sh --live    # Live mode
#
# Prerequisites:
#   - stripe CLI installed and authenticated
#   - jq installed
#   - setup-products.sh has been run (stripe-ids.{mode}.json exists)
#

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="${SCRIPT_DIR}/../config"

# Parse mode
MODE="test"
STRIPE_FLAGS=""
if [[ "${1:-}" == "--live" ]]; then
  MODE="live"
  STRIPE_FLAGS="--live"
fi

IDS_FILE="${CONFIG_DIR}/stripe-ids.${MODE}.json"

echo -e "${BLUE}"
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║           Stripe Metered Price Setup (Overages)               ║"
echo "║                       Mode: ${MODE}                               ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Check prerequisites
if ! command -v stripe &>/dev/null; then
  echo -e "${RED}Error: stripe CLI not found.${NC}"
  exit 1
fi

if ! command -v jq &>/dev/null; then
  echo -e "${RED}Error: jq not found.${NC}"
  exit 1
fi

if [[ ! -f "$IDS_FILE" ]]; then
  echo -e "${RED}Error: ${IDS_FILE} not found. Run setup-products.sh first.${NC}"
  exit 1
fi

# Read product IDs
PRO_PRODUCT_ID=$(jq -r '.products.pro.product_id' "$IDS_FILE")
ENT_PRODUCT_ID=$(jq -r '.products.enterprise.product_id' "$IDS_FILE")

if [[ "$PRO_PRODUCT_ID" == "null" || -z "$PRO_PRODUCT_ID" ]]; then
  echo -e "${RED}Error: Pro product ID not found in ${IDS_FILE}. Run setup-products.sh first.${NC}"
  exit 1
fi

if [[ "$ENT_PRODUCT_ID" == "null" || -z "$ENT_PRODUCT_ID" ]]; then
  echo -e "${RED}Error: Enterprise product ID not found in ${IDS_FILE}. Run setup-products.sh first.${NC}"
  exit 1
fi

# Live mode confirmation
if [[ "$MODE" == "live" ]]; then
  echo -e "${RED}WARNING: Creating metered prices in LIVE mode.${NC}"
  read -p "Type 'yes' to continue: " confirm
  if [[ "$confirm" != "yes" ]]; then
    echo "Aborted."
    exit 0
  fi
  echo ""
fi

echo -e "${BLUE}Pro product:${NC}        $PRO_PRODUCT_ID"
echo -e "${BLUE}Enterprise product:${NC} $ENT_PRODUCT_ID"
echo ""

# Overage definitions: name, unit_amount_cents, overage_type, unit
OVERAGES=(
  "media_overage|Media Generation Overage|5|media|credit"
  "voice_overage|Voice Generation Overage|10|voice|minute"
  "video_overage|Video Generation Overage|25|video|credit"
)

# Helper: create a metered price
create_metered_price() {
  local product_id="$1"
  local nickname="$2"
  local amount_cents="$3"
  local overage_type="$4"
  local unit="$5"
  local plan_type="$6"

  local result
  result=$(stripe prices create \
    --product "$product_id" \
    --currency usd \
    --unit-amount "$amount_cents" \
    --nickname "$nickname" \
    -d "recurring[interval]=month" \
    -d "recurring[usage_type]=metered" \
    -d "recurring[aggregate_usage]=sum" \
    --metadata overage_type="$overage_type" \
    --metadata unit="$unit" \
    --metadata plan_type="$plan_type" \
    $STRIPE_FLAGS 2>/dev/null)

  echo "$result" | jq -r '.id'
}

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${BLUE}Creating metered overage prices...${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

declare -A METERED_IDS
declare -A ENT_METERED_IDS

for overage in "${OVERAGES[@]}"; do
  IFS='|' read -r key nickname amount_cents overage_type unit <<< "$overage"

  echo -e "${BLUE}[${key}]${NC} $nickname (\$$(echo "scale=2; $amount_cents / 100" | bc)/$unit)"

  # Check if already set in config
  existing=$(jq -r --arg k "$key" '.metered_prices[$k].price_id // empty' "$IDS_FILE")
  if [[ -n "$existing" && "$existing" != "null" ]]; then
    echo -e "  ${YELLOW}Already configured: ${existing}${NC}"
    METERED_IDS[$key]="$existing"
    echo ""
    continue
  fi

  # Create on Pro product
  echo -e "  Creating on Pro product..."
  price_id=$(create_metered_price "$PRO_PRODUCT_ID" "$nickname (Pro)" "$amount_cents" "$overage_type" "$unit" "pro")
  echo -e "  ${GREEN}Pro price: ${price_id}${NC}"
  METERED_IDS[$key]="$price_id"

  # Also create on Enterprise product (for usage tracking/attribution)
  echo -e "  Creating on Enterprise product..."
  ent_price_id=$(create_metered_price "$ENT_PRODUCT_ID" "$nickname (Enterprise)" "$amount_cents" "$overage_type" "$unit" "enterprise")
  echo -e "  ${GREEN}Enterprise price: ${ent_price_id}${NC}"
  ENT_METERED_IDS[$key]="$ent_price_id"

  echo ""
done

# Update the IDs file with metered prices (using Pro price IDs as primary)
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${BLUE}Updating ${IDS_FILE}${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

UPDATED=$(jq \
  --arg mp "${METERED_IDS[media_overage]:-}" \
  --arg vp "${METERED_IDS[voice_overage]:-}" \
  --arg vidp "${METERED_IDS[video_overage]:-}" \
  --arg emp "${ENT_METERED_IDS[media_overage]:-}" \
  --arg evp "${ENT_METERED_IDS[voice_overage]:-}" \
  --arg evidp "${ENT_METERED_IDS[video_overage]:-}" \
  '.metered_prices.media_overage.price_id = $mp |
   .metered_prices.voice_overage.price_id = $vp |
   .metered_prices.video_overage.price_id = $vidp |
   .metered_prices.media_overage.enterprise_price_id = $emp |
   .metered_prices.voice_overage.enterprise_price_id = $evp |
   .metered_prices.video_overage.enterprise_price_id = $evidp' \
  "$IDS_FILE")

echo "$UPDATED" | jq '.' > "$IDS_FILE"

echo ""
echo -e "${GREEN}Done! Metered overage prices created.${NC}"
echo ""
echo "  Media:  \$0.05/credit  ${METERED_IDS[media_overage]:-}"
echo "  Voice:  \$0.10/minute  ${METERED_IDS[voice_overage]:-}"
echo "  Video:  \$0.25/credit  ${METERED_IDS[video_overage]:-}"
echo ""
echo -e "Config updated: ${BLUE}${IDS_FILE}${NC}"
