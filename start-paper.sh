#!/bin/bash
# Paper trading launcher for Polymarket late-entry engine
# Usage: start-paper.sh [BTC|SOL|XRP|ETH]
# Requires WALLET_BALANCE env var (default $500)

set -e
BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYMBOL="${1:-BTC}"
SYMBOL="${SYMBOL^^}"

LOCK="/tmp/late-entry-${SYMBOL,,}.lock"
rm -f "$LOCK"

export WALLET_BALANCE="${WALLET_BALANCE:-500}"
export MARKET_SYMBOL="$SYMBOL"
export NODE_OPTIONS="-r dotenv/config"
# Full-session testing: disable session-loss halt and strategy circuit
# breakers so the run is not cut short by consecutive losses or daily
# drawdown. Per-trade sizing (Kelly, MAX_RISK_PER_TRADE) still applies.
export DISABLE_LOSS_CAPS="${DISABLE_LOSS_CAPS:-true}"

cd "$BASE"
exec ./node_modules/.bin/tsx index.ts --paper --symbol "$SYMBOL"