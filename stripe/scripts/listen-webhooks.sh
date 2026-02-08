#!/bin/bash
#
# Stripe Webhook Listener (Local Development)
#
# Forwards Stripe events to a local endpoint for testing webhook handling.
# The signing secret printed at startup should be set as STRIPE_WEBHOOK_SECRET.
#
# Usage:
#   ./stripe/scripts/listen-webhooks.sh                                    # Default: localhost:3000
#   ./stripe/scripts/listen-webhooks.sh http://localhost:4000/api/stripe/webhook
#

set -euo pipefail

# Colors
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

FORWARD_URL="${1:-http://localhost:3000/api/stripe/webhook}"

EVENTS="checkout.session.completed,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,invoice.paid,invoice.payment_failed"

echo -e "${BLUE}"
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║           Stripe Webhook Listener                             ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo -e "${NC}"
echo -e "  Forwarding to: ${BLUE}${FORWARD_URL}${NC}"
echo -e "  Events:        ${YELLOW}${EVENTS//,/, }${NC}"
echo ""
echo -e "${YELLOW}Copy the webhook signing secret (whsec_...) printed below into your .env or Secrets Manager.${NC}"
echo ""

stripe listen \
  --forward-to "$FORWARD_URL" \
  --events "$EVENTS"
