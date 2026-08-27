#!/usr/bin/env bash
# Boots the API against a throwaway database, runs a scripted check, then stops
# it. Used in development to prove the auth flow and API surface really work.
#
#   scripts/smoke-test.sh <check-script.mjs> [port]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECK="${1:?usage: smoke-test.sh <check-script.mjs> [port]}"
PORT="${2:-8791}"
WORKDIR="$(mktemp -d)"
SERVER_PID=""

cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

export DATA_DIR="$WORKDIR/data"
export PORT
export HOST=127.0.0.1
export PUBLIC_ORIGIN="http://127.0.0.1:$PORT"
export MOUNTS="nvme:NVMe:$WORKDIR/nvme:nvme,hdd:HDD:$WORKDIR/hdd:hdd,storagebox:StorageBox:$WORKDIR/remote:remote"
export LOG_LEVEL="${LOG_LEVEL:-warn}"
export SERVE_WEB="${SERVE_WEB:-false}"
export WEB_ROOT="${WEB_ROOT:-$ROOT/apps/web/dist}"
mkdir -p "$WORKDIR/nvme" "$WORKDIR/hdd" "$WORKDIR/remote"

node "$ROOT/apps/api/dist/index.js" > "$WORKDIR/server.log" 2>&1 &
SERVER_PID=$!

# Wait for the health endpoint rather than guessing at a start-up delay.
for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$PORT/api/health" > /dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "server exited during start-up:" >&2
    cat "$WORKDIR/server.log" >&2
    exit 1
  fi
  perl -e 'select(undef,undef,undef,0.25)'
done

if ! curl -sf "http://127.0.0.1:$PORT/api/health" > /dev/null 2>&1; then
  echo "server never became healthy:" >&2
  cat "$WORKDIR/server.log" >&2
  exit 1
fi

set +e
API_BASE="http://127.0.0.1:$PORT" node "$CHECK"
STATUS=$?
set -e

if [ "$STATUS" -ne 0 ]; then
  echo "--- server log ---" >&2
  cat "$WORKDIR/server.log" >&2
fi
exit "$STATUS"
