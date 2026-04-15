#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
GUARD_DIR="${NONCE_GUARD_BOT_DIR:-${ENGINE_DIR}/../nonce-guard-bot}"
FEED_PATH="${NONCE_GUARD_FILL_FEED_PATH:-${GUARD_DIR}/state/live-fills.jsonl}"

if [[ ! -d "${GUARD_DIR}" ]]; then
  echo "[run] nonce-guard-bot directory not found: ${GUARD_DIR}" >&2
  exit 1
fi

echo "[run] using fill feed: ${FEED_PATH}"
echo "[run] starting nonce-guard-bot in ${GUARD_DIR}"
(
  cd "${GUARD_DIR}"
  FILL_FEED_PATH="${FEED_PATH}" npm run start
) &
GUARD_PID=$!

cleanup() {
  if kill -0 "${GUARD_PID}" >/dev/null 2>&1; then
    kill "${GUARD_PID}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

echo "[run] starting trade engine in production mode"
cd "${ENGINE_DIR}"
NONCE_GUARD_FILL_FEED_PATH="${FEED_PATH}" npm run start -- --prod "$@"

