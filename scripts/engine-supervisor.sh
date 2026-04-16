#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOG_FILE="${ENGINE_DIR}/../logs/engine-supervisor.log"
MAX_RESTARTS=10
RESTART_WINDOW=3600

mkdir -p "$(dirname "$LOG_FILE")"

log() {
  echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*" | tee -a "$LOG_FILE"
}

kill_engine() {
  if [ -f "$ENGINE_DIR/.engine-pid" ]; then
    while read pid; do
      kill "$pid" 2>/dev/null || true
    done < "$ENGINE_DIR/.engine-pid"
    rm -f "$ENGINE_DIR/.engine-pid"
  fi
  pkill -f "tsx -r dotenv/config index.ts --prod" 2>/dev/null || true
  rm -f /tmp/early-bird*.lock
}

start_engine() {
  cd "$ENGINE_DIR"
  rm -f /tmp/early-bird*.lock
  nohup npm run start:prod >> "$ENGINE_DIR/../logs/engine.log" 2>&1 &
  local pid=$!
  echo "$pid" > "$ENGINE_DIR/.engine-pid"
  log "engine started, PID=$pid"
}

restart_count=0
last_restarts=()

while true; do
  now=$(date +%s)

  # Trim restarts older than 1 hour
  last_restarts=($(for ts in "${last_restarts[@]}"; do (( now - ts < RESTART_WINDOW )) && echo $ts; done))

  if [ ${#last_restarts[@]} -ge $MAX_RESTARTS ]; then
    log "FATAL: $MAX_RESTARTS restarts in $RESTART_WINDOW seconds. Exiting."
    exit 1
  fi

  log "Starting trade engine (restart #$((restart_count+1)))"
  last_restarts+=($now)
  ((restart_count++))

  kill_engine
  sleep 2
  start_engine

  sleep 8

  # Check if engine is alive
  if [ -f "$ENGINE_DIR/.engine-pid" ]; then
    local pid
    pid=$(cat "$ENGINE_DIR/.engine-pid")
    if kill -0 "$pid" 2>/dev/null; then
      log "Engine stable, PID=$pid"
    else
      log "Engine died immediately. Restarting in 5s..."
      kill_engine
      sleep 5
      continue
    fi
  fi

  # Monitor loop
  while true; do
    sleep 10
    if [ -f "$ENGINE_DIR/.engine-pid" ]; then
      local pid
      pid=$(cat "$ENGINE_DIR/.engine-pid")
      if ! kill -0 "$pid" 2>/dev/null; then
        log "Engine PID $pid is dead. Restarting..."
        break
      fi
    else
      log "No PID file. Restarting..."
      break
    fi
  done
done