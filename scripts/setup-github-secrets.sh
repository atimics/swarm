#!/usr/bin/env bash
#
# GitHub Secrets Setup Script
# Check status and interactively set/reset GitHub repository secrets
#
# Usage: ./scripts/setup-github-secrets.sh
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Secret definitions (parallel arrays for bash 3 compatibility)
SECRET_NAMES=(
    "AWS_ACCESS_KEY_ID"
    "AWS_SECRET_ACCESS_KEY"
    "CLOUDFLARE_API_TOKEN"
    "CLOUDFLARE_ZONE_ID"
    "VITE_PRIVY_APP_ID"
)

SECRET_DESCRIPTIONS=(
    "AWS access key for CDK deployments"
    "AWS secret key for CDK deployments"
    "Cloudflare API token for DNS/CDN management"
    "Cloudflare zone ID for rati.chat domain"
    "Privy App ID (frontend build-time config)"
)

SECRET_URLS=(
    "https://console.aws.amazon.com/iam/home#/security_credentials"
    "https://console.aws.amazon.com/iam/home#/security_credentials"
    "https://dash.cloudflare.com/profile/api-tokens"
    "https://dash.cloudflare.com (Overview > Zone ID)"
    "https://dashboard.privy.io"
)

# Mark required secrets (0=required, 1=optional)
SECRET_OPTIONAL=(0 0 1 1 1)

# Helper to get index of a secret by name
get_secret_index() {
    local name="$1"
    for i in "${!SECRET_NAMES[@]}"; do
        if [ "${SECRET_NAMES[$i]}" = "$name" ]; then
            echo "$i"
            return
        fi
    done
    echo "-1"
}

echo -e "${BLUE}"
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║              GitHub Secrets Manager for Swarm                  ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Check gh CLI is installed and authenticated
if ! command -v gh &>/dev/null; then
    echo -e "${RED}Error: GitHub CLI (gh) is not installed${NC}"
    echo "Install it from: https://cli.github.com/"
    exit 1
fi

if ! gh auth status &>/dev/null; then
    echo -e "${RED}Error: GitHub CLI not authenticated${NC}"
    echo "Run: gh auth login"
    exit 1
fi

# Get repo info
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo "")
if [ -z "$REPO" ]; then
    echo -e "${RED}Error: Not in a GitHub repository${NC}"
    exit 1
fi

echo -e "${GREEN}Repository: ${REPO}${NC}"
echo ""

# Function to check if a secret exists
check_secret() {
    local name="$1"
    gh secret list --json name -q ".[].name" 2>/dev/null | grep -q "^${name}$"
}

# Function to display secret status
display_status() {
    echo -e "${BLUE}═══════════════════════════════════════════════════════════════════${NC}"
    echo -e "${CYAN}                        SECRET STATUS                              ${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════════════${NC}"
    echo ""

    local missing_required=0
    local missing_optional=0

    echo -e "${YELLOW}Required Secrets:${NC}"
    for i in "${!SECRET_NAMES[@]}"; do
        if [ "${SECRET_OPTIONAL[$i]}" -eq 0 ]; then
            if check_secret "${SECRET_NAMES[$i]}"; then
                echo -e "  ${GREEN}✓${NC} ${SECRET_NAMES[$i]}"
            else
                echo -e "  ${RED}✗${NC} ${SECRET_NAMES[$i]} ${RED}(MISSING)${NC}"
                ((missing_required++)) || true
            fi
        fi
    done
    echo ""

    echo -e "${YELLOW}Optional Secrets:${NC}"
    for i in "${!SECRET_NAMES[@]}"; do
        if [ "${SECRET_OPTIONAL[$i]}" -eq 1 ]; then
            if check_secret "${SECRET_NAMES[$i]}"; then
                echo -e "  ${GREEN}✓${NC} ${SECRET_NAMES[$i]}"
            else
                echo -e "  ${YELLOW}○${NC} ${SECRET_NAMES[$i]} (not set)"
                ((missing_optional++)) || true
            fi
        fi
    done
    echo ""

    if [ $missing_required -gt 0 ]; then
        echo -e "${RED}⚠ $missing_required required secret(s) missing!${NC}"
    else
        echo -e "${GREEN}✓ All required secrets are configured${NC}"
    fi

    if [ $missing_optional -gt 0 ]; then
        echo -e "${YELLOW}○ $missing_optional optional secret(s) not set${NC}"
    fi
    echo ""
}

# Function to set a secret
set_secret() {
    local name="$1"
    local idx=$(get_secret_index "$name")
    local desc="${SECRET_DESCRIPTIONS[$idx]}"
    local url="${SECRET_URLS[$idx]}"

    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}Secret: ${name}${NC}"
    echo -e "Description: ${desc}"
    if [ -n "$url" ]; then
        echo -e "Get it from: ${CYAN}${url}${NC}"
    fi
    echo ""

    if check_secret "$name"; then
        echo -e "${GREEN}Current status: Set${NC}"
    else
        echo -e "${YELLOW}Current status: Not set${NC}"
    fi

    echo ""
    read -sp "Enter value (or press Enter to skip): " value
    echo ""

    if [ -z "$value" ]; then
        echo -e "${YELLOW}Skipped${NC}"
        return
    fi

    echo "$value" | gh secret set "$name"
    echo -e "${GREEN}✓ Secret '${name}' set successfully${NC}"
    echo ""
}

# Function to delete a secret
delete_secret() {
    local name="$1"

    if ! check_secret "$name"; then
        echo -e "${YELLOW}Secret '${name}' is not set${NC}"
        return
    fi

    read -p "Are you sure you want to delete '${name}'? [y/N]: " confirm
    if [[ "$confirm" =~ ^[yY] ]]; then
        gh secret delete "$name"
        echo -e "${GREEN}✓ Secret '${name}' deleted${NC}"
    else
        echo -e "${YELLOW}Cancelled${NC}"
    fi
}

# Main menu
main_menu() {
    while true; do
        echo ""
        echo -e "${BLUE}═══════════════════════════════════════════════════════════════════${NC}"
        echo -e "${CYAN}                          MAIN MENU                                ${NC}"
        echo -e "${BLUE}═══════════════════════════════════════════════════════════════════${NC}"
        echo ""
        echo "  1) View secret status"
        echo "  2) Set/update a specific secret"
        echo "  3) Set all missing secrets"
        echo "  4) Delete a secret"
        echo "  5) Set up all required secrets"
        echo "  6) Set up all optional secrets"
        echo ""
        echo "  q) Quit"
        echo ""
        read -p "Select option: " choice

        case "$choice" in
            1)
                display_status
                ;;
            2)
                echo ""
                echo "Available secrets:"
                for i in "${!SECRET_NAMES[@]}"; do
                    printf "  %2d) %s\n" "$((i+1))" "${SECRET_NAMES[$i]}"
                done
                echo ""
                read -p "Select secret number: " num
                if [[ "$num" =~ ^[0-9]+$ ]] && [ "$num" -ge 1 ] && [ "$num" -le "${#SECRET_NAMES[@]}" ]; then
                    set_secret "${SECRET_NAMES[$((num-1))]}"
                else
                    echo -e "${RED}Invalid selection${NC}"
                fi
                ;;
            3)
                echo ""
                echo -e "${BLUE}Setting missing secrets...${NC}"
                for name in "${SECRET_NAMES[@]}"; do
                    if ! check_secret "$name"; then
                        set_secret "$name"
                    fi
                done
                echo -e "${GREEN}Done!${NC}"
                ;;
            4)
                echo ""
                echo "Configured secrets:"
                local configured=()
                for name in "${SECRET_NAMES[@]}"; do
                    if check_secret "$name"; then
                        configured+=("$name")
                    fi
                done

                if [ ${#configured[@]} -eq 0 ]; then
                    echo -e "${YELLOW}No secrets are currently set${NC}"
                    continue
                fi

                for i in "${!configured[@]}"; do
                    printf "  %2d) %s\n" "$((i+1))" "${configured[$i]}"
                done
                echo ""
                read -p "Select secret number to delete: " num
                if [[ "$num" =~ ^[0-9]+$ ]] && [ "$num" -ge 1 ] && [ "$num" -le "${#configured[@]}" ]; then
                    delete_secret "${configured[$((num-1))]}"
                else
                    echo -e "${RED}Invalid selection${NC}"
                fi
                ;;
            5)
                echo ""
                echo -e "${BLUE}Setting up required secrets...${NC}"
                for i in "${!SECRET_NAMES[@]}"; do
                    if [ "${SECRET_OPTIONAL[$i]}" -eq 0 ]; then
                        set_secret "${SECRET_NAMES[$i]}"
                    fi
                done
                echo -e "${GREEN}Done!${NC}"
                ;;
            6)
                echo ""
                echo -e "${BLUE}Setting up optional secrets...${NC}"
                for i in "${!SECRET_NAMES[@]}"; do
                    if [ "${SECRET_OPTIONAL[$i]}" -eq 1 ]; then
                        set_secret "${SECRET_NAMES[$i]}"
                    fi
                done
                echo -e "${GREEN}Done!${NC}"
                ;;
            q|Q)
                echo ""
                echo -e "${GREEN}Goodbye!${NC}"
                exit 0
                ;;
            *)
                echo -e "${RED}Invalid option${NC}"
                ;;
        esac
    done
}

# Show initial status and start menu
display_status
main_menu
