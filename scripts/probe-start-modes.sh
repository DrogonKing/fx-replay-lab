#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."
PORT=18331
CACHE=/tmp/sm2-cache-$$
mkdir -p "$CACHE"
pkill -f "remote-debugging-port=$PORT" 2>/dev/null
export NODE_OPTIONS=--max-old-space-size=1600
FXLAB_DATA_DIR="$CACHE" \
  xvfb-run -a --server-args="-screen 0 1600x1000x24" \
  npx electron dist/main/main.js --remote-debugging-port="$PORT" --no-sandbox \
  > /tmp/sm2.log 2>&1 &
for _ in $(seq 1 60); do
  curl -s "http://127.0.0.1:$PORT/json/list" | grep -q webSocketDebuggerUrl && break
  sleep 0.5
done
node scripts/probe-start-modes.mjs "$PORT" 2>&1 | tail -6
pkill -f "remote-debugging-port=$PORT" 2>/dev/null
rm -rf "$CACHE"
