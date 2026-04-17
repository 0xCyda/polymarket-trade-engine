#!/bin/bash
# Launch Polymarket late-entry engine in paper mode (BTC only)
set -e

BASE="/home/brandon/.openclaw/workspace/polymarket/polymarket-trade-engine"
export WALLET_BALANCE="${WALLET_BALANCE:-500}"

for sym in BTC; do
  rm -f "/tmp/late-entry-${sym,,}.lock"
  nohup "$BASE/start-paper.sh" "$sym" > "/tmp/paper-${sym,,}.log" 2>&1 &
  echo "Paper bot launched: $sym"
done

echo "All paper bots launched."
