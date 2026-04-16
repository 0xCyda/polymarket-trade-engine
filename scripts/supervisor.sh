#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
GUARD_DIR="${ENGINE_DIR}/../nonce-guard-bot"
FEED_PATH="${NONCE_GUARD_FILL_FEED_PATH:-${GUARD_DIR}/state/live-fills.jsonl}"
LOG_FILE="${ENGINE_DIR}/../logs/supervisor.log"
MAX_RESTARTS=10
RESTART_WINDOW=3600  # per hour

mkdir -p "$(dirname "$LOG_FILE")"

log() {
  echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] [supervisor] $*" | tee -a "$LOG_FILE"
}

start_guard() {
  (
    cd "$GUARD_DIR"
    FILL_FEED_PATH="$FEED_PATH" npm run start >> "$ENGINE_DIR/../logs/guard.log" 2>&1
  ) &
  GUARD_PID=$!
  echo $GUARD_PID > "$ENGINE_DIR/../.guard-pid"
}

start_engine() {
  (
    cd "$ENGINE_DIR"
    npm run start:prod:guard >> "$ENGINE_DIR/../logs/engine.log" 2>&1
  ) &
  ENGINE_PID=$!
  echo $ENGINE_PID > "$ENGINE_DIR/../.engine-pid"
}

kill_all() {
  if [ -f "$ENGINE_DIR/../.guard-pid" ]; then
    kill $(cat "$ENGINE_DIR/../.guard-pid") 2>/dev/null || true
    rm -f "$ENGINE_DIR/../.guard-pid"
  fi
  if [ -f "$ENGINE_DIR/../.engine-pid" ]; then
    kill $(cat "$ENGINE_DIR/../.engine-pid") 2>/dev/null || true
    rm -f "$ENGINE_DIR/../.engine-pid"
  fi
  # Kill any orphaned tsx processes
  pkill -f "nonce-guard-bot.*src/index.ts" 2>/dev/null || true
  pkill -f "tsx -r dotenv/config index.ts --prod" 2>/dev/null || true
  rm -f /tmp/early-bird*.lock
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
  
  log "Starting guard + engine (restart #$((restart_count+1)))"
  last_restarts+=($now)
  ((restart_count++))
  
  start_guard
  sleep 2
  start_engine
  
  # Monitor both processes
  guard_dead=true
  engine_dead=true
  
  while $guard_dead || $engine_dead; do
    sleep 5
    
    # Check guard
    if [ -f "$ENGINE_DIR/../.guard-pid" ]; then
      if kill -0 $(cat "$ENGINE_DIR/../.guard-pid") 2>/dev/null; then
        guard_dead=false
      fi
    fi
    
    # Check engine (look for any tsx process running the engine)
    engine_pid=$(pgrep -f "tsx -r dotenv/config index.ts --prod" | head -1 || true)
    if [ -n "$engine_pid" ]; then
      if kill -0 $engine_pid 2>/dev/null; then
        engine_dead=false
      fi
    fi
    
    if $guard_dead || $engine_dead; then
      log "One or more processes died. Guard=$guard_dead Engine=$engine_dead. Restarting in 3s..."
      kill_all
      sleep 3
      break
    fi
  done
  
  if ! $guard_dead && ! $engine_dead; then
    log "All processes stable. Monitoring..."
  fi
done
