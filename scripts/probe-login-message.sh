#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."
PORT=18371
CACHE=/tmp/plm-cache-$$
mkdir -p "$CACHE"
pkill -f "remote-debugging-port=$PORT" 2>/dev/null
pkill -f "fake-bridge.py --port 8765" 2>/dev/null
trap 'pkill -f "remote-debugging-port=$PORT" 2>/dev/null; rm -rf "$CACHE"' EXIT

export NODE_OPTIONS=--max-old-space-size=1600
npx vite build > /tmp/vb-plm.log 2>&1 || { echo "vite FAILED"; tail -4 /tmp/vb-plm.log; exit 1; }
npx tsc -p tsconfig.main.json > /tmp/tsc-plm.log 2>&1 || { echo "tsc FAILED"; tail -4 /tmp/tsc-plm.log; exit 1; }
node scripts/postbuild-main.mjs > /dev/null 2>&1

# deliberately NO bridge: this is the state a new user is in
FXLAB_DATA_DIR="$CACHE" \
  xvfb-run -a --server-args="-screen 0 1600x1000x24" \
  npx electron dist/main/main.js --remote-debugging-port="$PORT" --no-sandbox \
  > /tmp/plm.log 2>&1 &
for _ in $(seq 1 60); do
  curl -s "http://127.0.0.1:$PORT/json/list" | grep -q webSocketDebuggerUrl && break
  sleep 0.5
done
node scripts/probe-login-message.mjs "$PORT" 2>&1 | tail -6
