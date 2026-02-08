#!/bin/bash
#
# Stripe Test Mode Teardown
#
# Archives (deactivates) all test-mode products and prices created by setup scripts.
# SAFETY: Refuses to run in live mode.
#
# Usage:
#   ./stripe/scripts/teardown-test.sh
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
IDS_FILE="${CONFIG_DIR}/stripe-ids.test.json"

# Block live mode
if [[ "${1:-}" == "--live" ]]; then
  echo -e "${RED}ERROR: Teardown is only supported in test mode.${NC}"
  echo "To archive live products, do so manually in the Stripe Dashboard."
  exit 1
fi

echo -e "${BLUE}"
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║           Stripe Test Mode Teardown                           ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

if [[ ! -f "$IDS_FILE" ]]; then
  echo -e "${RED}Error: ${IDS_FILE} not found. Nothing to tear down.${NC}"
  exit 1
fi

echo -e "${YELLOW}This will archive all test-mode products and prices.${NC}"
echo ""
cat "$IDS_FILE" | jq '.products, .metered_prices'
echo ""
read -p "Continue? [y/N] " confirm
if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
  echo "Aborted."
  exit 0
fi
echo ""

ERRORS=0

# Archive metered prices first (Pro + Enterprise)
echo -e "${BLUE}Archiving metered prices...${NC}"
for key in media_overage voice_overage video_overage; do
  for id_field in price_id enterprise_price_id; do
    price_id=$(jq -r --arg k "$key" --arg f "$id_field" '.metered_prices[$k][$f] // empty' "$IDS_FILE")
    if [[ -n "$price_id" && "$price_id" != "null" ]]; then
      echo -n "  $key/$id_field ($price_id)... "
      if stripe prices update "$price_id" --active false 2>/dev/null; then
        echo -e "${GREEN}archived${NC}"
      else
        echo -e "${RED}failed${NC}"
        ERRORS=$((ERRORS + 1))
      fi
    fi
  done
done
echo ""

# Archive product prices, then products
echo -e "${BLUE}Archiving products and prices...${NC}"
for plan in free pro enterprise; do
  price_id=$(jq -r --arg p "$plan" '.products[$p].price_id // empty' "$IDS_FILE")
  product_id=$(jq -r --arg p "$plan" '.products[$p].product_id // empty' "$IDS_FILE")

  if [[ -n "$price_id" && "$price_id" != "null" ]]; then
    echo -n "  ${plan} price ($price_id)... "
    if stripe prices update "$price_id" --active false 2>/dev/null; then
      echo -e "${GREEN}archived${NC}"
    else
      echo -e "${RED}failed${NC}"
      ERRORS=$((ERRORS + 1))
    fi
  fi

  if [[ -n "$product_id" && "$product_id" != "null" ]]; then
    echo -n "  ${plan} product ($product_id)... "
    if stripe products update "$product_id" --active false 2>/dev/null; then
      echo -e "${GREEN}archived${NC}"
    else
      echo -e "${RED}failed${NC}"
      ERRORS=$((ERRORS + 1))
    fi
  fi
done
echo ""

# Backup config
BACKUP="${IDS_FILE}.bak"
cp "$IDS_FILE" "$BACKUP"
echo -e "Config backed up to: ${BLUE}${BACKUP}${NC}"

if [[ $ERRORS -gt 0 ]]; then
  echo -e "${YELLOW}Completed with ${ERRORS} error(s). Some resources may still be active.${NC}"
  exit 1
else
  echo -e "${GREEN}All test products and prices archived.${NC}"
  echo -e "Run ${BLUE}setup-products.sh${NC} to recreate them."
fi
