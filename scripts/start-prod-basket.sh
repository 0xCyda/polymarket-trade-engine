#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p state

ASSETS=(BTC SOL XRP ETH)
for asset in "${ASSETS[@]}"; do
  # Skip if already running
  if pgrep -f "index.ts --prod --symbol ${asset}" >/dev/null 2>&1; then
    echo "${asset} already running"
    continue
  fi

  rm -f "/tmp/late-entry-${asset,,}.lock" 2>/dev/null || true
  nohup npm run start:prod -- --symbol "$asset" > "/tmp/trade-engine-${asset,,}.log" 2>&1 &
  echo "$asset started"
done
