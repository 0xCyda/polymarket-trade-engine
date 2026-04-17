#!/bin/bash
# Paper trading launcher for Polymarket late-entry engine
# Usage: start-paper.sh [BTC|SOL|XRP|ETH]
# Requires WALLET_BALANCE env var (default $500)

set -e
BASE="/home/brandon/.openclaw/workspace/polymarket/polymarket-trade-engine"
SYMBOL="${1:-BTC}"
SYMBOL="${SYMBOL^^}"

LOCK="/tmp/late-entry-${SYMBOL,,}.lock"
rm -f "$LOCK"

export WALLET_BALANCE="${WALLET_BALANCE:-500}"
export MARKET_SYMBOL="$SYMBOL"
export NODE_OPTIONS="-r dotenv/config"

cd "$BASE"
exec ./node_modules/.bin/tsx index.ts --paper --symbol "$SYMBOL"