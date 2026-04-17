#!/bin/bash
# Launch Polymarket late-entry engine in paper mode (BTC only)
set -e

BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export WALLET_BALANCE="${WALLET_BALANCE:-500}"
export DISABLE_LOSS_CAPS="${DISABLE_LOSS_CAPS:-true}"

for sym in BTC; do
  rm -f "/tmp/late-entry-${sym,,}.lock"
  nohup "$BASE/start-paper.sh" "$sym" > "/tmp/paper-${sym,,}.log" 2>&1 &
  echo "Paper bot launched: $sym"
done

echo "All paper bots launched."
