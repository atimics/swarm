#!/bin/bash
#
# Stripe Setup Verification
#
# Validates that all expected products and prices exist and are active.
# Exits 0 if all good, 1 if any issues.
#
# Usage:
#   ./stripe/scripts/verify-setup.sh          # Test mode (default)
#   ./stripe/scripts/verify-setup.sh --live    # Live mode
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
echo "║           Stripe Setup Verification                           ║"
echo "║                     Mode: ${MODE}                                 ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

if [[ ! -f "$IDS_FILE" ]]; then
  echo -e "${RED}Error: ${IDS_FILE} not found. Run setup-products.sh first.${NC}"
  exit 1
fi

PASS=0
FAIL=0

# Helper: check a Stripe resource
check_resource() {
  local type="$1"  # "products" or "prices"
  local id="$2"
  local label="$3"

  if [[ -z "$id" || "$id" == "null" ]]; then
    echo -e "  ${RED}FAIL${NC}  $label — ID not set"
    FAIL=$((FAIL + 1))
    return
  fi

  local active
  active=$(stripe "$type" retrieve "$id" $STRIPE_FLAGS 2>/dev/null | jq -r '.active // false') || active="error"

  if [[ "$active" == "true" ]]; then
    echo -e "  ${GREEN}PASS${NC}  $label ($id)"
    PASS=$((PASS + 1))
  elif [[ "$active" == "false" ]]; then
    echo -e "  ${YELLOW}WARN${NC}  $label ($id) — archived/inactive"
    FAIL=$((FAIL + 1))
  else
    echo -e "  ${RED}FAIL${NC}  $label ($id) — not found or API error"
    FAIL=$((FAIL + 1))
  fi
}

echo -e "${BLUE}Products:${NC}"
for plan in free pro enterprise; do
  product_id=$(jq -r --arg p "$plan" '.products[$p].product_id // empty' "$IDS_FILE")
  check_resource "products" "$product_id" "$plan product"
done
echo ""

echo -e "${BLUE}Monthly Prices:${NC}"
for plan in free pro enterprise; do
  price_id=$(jq -r --arg p "$plan" '.products[$p].price_id // empty' "$IDS_FILE")
  check_resource "prices" "$price_id" "$plan price"
done
echo ""

echo -e "${BLUE}Metered Overage Prices (Pro):${NC}"
for key in media_overage voice_overage video_overage; do
  price_id=$(jq -r --arg k "$key" '.metered_prices[$k].price_id // empty' "$IDS_FILE")
  check_resource "prices" "$price_id" "$key"
done
echo ""

echo -e "${BLUE}Metered Overage Prices (Enterprise):${NC}"
for key in media_overage voice_overage video_overage; do
  price_id=$(jq -r --arg k "$key" '.metered_prices[$k].enterprise_price_id // empty' "$IDS_FILE")
  check_resource "prices" "$price_id" "$key (enterprise)"
done
echo ""

# Summary
TOTAL=$((PASS + FAIL))
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [[ $FAIL -eq 0 ]]; then
  echo -e "${GREEN}All ${TOTAL} resources verified.${NC}"
  exit 0
else
  echo -e "${RED}${FAIL}/${TOTAL} resources failed verification.${NC}"
  exit 1
fi
