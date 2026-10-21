#!/usr/bin/env bash
# Exercise the login path with no bridge, then with a stub bridge that answers /login.
set -uo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-18341}"
BRIDGE_PORT="${BRIDGE_PORT:-18780}"
LOG=/tmp/plogin.log
CACHE=/tmp/pl-cache-$$
mkdir -p "$CACHE"
pkill -f "remote-debugging-port=$PORT" 2>/dev/null
cleanup() {
  pkill -f "remote-debugging-port=$PORT" 2>/dev/null
  [[ -n "${BPID:-}" ]] && kill "$BPID" 2>/dev/null
  rm -rf "$CACHE"
}
trap cleanup EXIT

export NODE_OPTIONS=--max-old-space-size=1600
FXLAB_DATA_DIR="$CACHE" \
  xvfb-run -a --server-args="-screen 0 1700x1050x24" \
  npx electron dist/main/main.js --remote-debugging-port="$PORT" --no-sandbox \
  > "$LOG" 2>&1 &
for _ in $(seq 1 60); do
  curl -s "http://127.0.0.1:$PORT/json/list" | grep -q webSocketDebuggerUrl && break
  sleep 0.5
done

echo "=== no bridge running: does the UI say anything useful? ==="
node scripts/probe-login.mjs "$PORT" 2>&1 | grep -vE '^\s*$' | head -20
pkill -f "remote-debugging-port=$PORT" 2>/dev/null
sleep 1

echo
echo "=== now with a stub bridge on :$BRIDGE_PORT ==="
python3 scripts/fake-bridge.py --port "$BRIDGE_PORT" > /tmp/stubbridge.log 2>&1 &
BPID=$!
for _ in $(seq 1 30); do
  curl -s "http://127.0.0.1:$BRIDGE_PORT/health" | grep -q connected && break
  sleep 0.3
done
echo "stub /login reply:"
curl -s -X POST "http://127.0.0.1:$BRIDGE_PORT/login" \
  -H 'Content-Type: application/json' \
  -d '{"login":"10000001","password":"stub-password","server":"Stub-Demo"}' | head -c 200
echo

FXLAB_DATA_DIR="$CACHE" \
  xvfb-run -a --server-args="-screen 0 1700x1050x24" \
  npx electron dist/main/main.js --remote-debugging-port="$PORT" --no-sandbox \
  > /tmp/plogin2.log 2>&1 &
for _ in $(seq 1 60); do
  curl -s "http://127.0.0.1:$PORT/json/list" | grep -q webSocketDebuggerUrl && break
  sleep 0.5
done
node scripts/probe-login.mjs "$PORT" "http://127.0.0.1:$BRIDGE_PORT" 2>&1 | grep -vE '^\s*$' | head -22
pkill -f "remote-debugging-port=$PORT" 2>/dev/null
