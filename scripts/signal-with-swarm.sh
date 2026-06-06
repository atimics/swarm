#!/bin/bash
# signal-with-swarm.sh — Launch Signal with an aws-swarm avatar identity.
#
# Starts aws-swarm, waits for it to be ready, fetches the avatar's
# Ed25519 keypair, and launches Signal with the keypair injected so
# the player's station uses their avatar's cryptographic identity.
#
# Usage: ./scripts/signal-with-swarm.sh [swarm-port] [signal-path]

SWARM_PORT="${1:-3090}"
SIGNAL_BIN="${2:-$HOME/develop/signal/build/signal}"
SWARM_URL="http://localhost:${SWARM_PORT}"
SWARM_DB="/tmp/swarm-signal-$$.db"
SWARM_BLOBS="/tmp/swarm-signal-blobs-$$"

cleanup() {
    kill $SWARM_PID 2>/dev/null
    rm -rf "$SWARM_DB" "$SWARM_BLOBS" 2>/dev/null
}
trap cleanup EXIT

echo "=== Starting aws-swarm on port $SWARM_PORT ==="
mkdir -p "$SWARM_BLOBS"
cd "$HOME/develop/aws-swarm"
SWARM_DB_PATH="$SWARM_DB" SWARM_BLOB_DIR="$SWARM_BLOBS" \
  PORT="$SWARM_PORT" bun run packages/local/src/app.ts --password=swarm1234 &
SWARM_PID=$!

# Wait for swarm to be ready
for i in $(seq 1 30); do
    if curl -s "$SWARM_URL/health" > /dev/null 2>&1; then
        echo "=== Swarm is ready ==="
        break
    fi
    sleep 1
done

# Create an avatar if none exists
AVATARS=$(curl -s "$SWARM_URL/api/avatars")
if echo "$AVATARS" | grep -q '"avatarId"'; then
    echo "=== Found existing avatar ==="
else
    echo "=== Creating avatar ==="
    curl -s -X POST "$SWARM_URL/api/avatars" \
        -H 'Content-Type: application/json' \
        -d '{"name":"SignalMiner","description":"A mining avatar"}' > /dev/null
fi

# Fetch the keypair
KEYPAIR=$(curl -s "$SWARM_URL/api/signal/keypair")
PUBKEY=$(echo "$KEYPAIR" | grep -o '"pubkey":"[^"]*"' | cut -d'"' -f4)
SEED_B64=$(echo "$KEYPAIR" | grep -o '"seedBase64":"[^"]*"' | cut -d'"' -f4)

if [ -z "$SEED_B64" ]; then
    echo "ERROR: Could not fetch avatar keypair"
    exit 1
fi

echo "=== Avatar identity ==="
echo "  Pubkey: $PUBKEY"

# Convert base64 seed to hex for Signal env var
SEED_HEX=$(echo "$SEED_B64" | base64 -d 2>/dev/null | xxd -p | tr -d '\n')
NACL_SECRET_HEX="${SEED_HEX}$(echo "$PUBKEY" | base58 -d 2>/dev/null | xxd -p | tr -d '\n')"

echo "  Keypair loaded ($(echo "$NACL_SECRET_HEX" | wc -c) hex chars)"

# Launch Signal
echo "=== Launching Signal ==="
SIGNAL_AVATAR_KEYPAIR_B64="$SEED_B64" \
SIGNAL_AVATAR_PUBKEY="$PUBKEY" \
    exec "$SIGNAL_BIN"
