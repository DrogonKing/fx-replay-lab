#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."
PORT=18381
CACHE=/tmp/sl-cache-$$
mkdir -p "$CACHE"
pkill -f "remote-debugging-port=$PORT" 2>/dev/null
trap 'pkill -f "remote-debugging-port=$PORT" 2>/dev/null; rm -rf "$CACHE"' EXIT
export NODE_OPTIONS=--max-old-space-size=1600
FXLAB_DATA_DIR="$CACHE" \
  xvfb-run -a --server-args="-screen 0 1600x1100x24" \
  npx electron dist/main/main.js --remote-debugging-port="$PORT" --no-sandbox \
  > /tmp/sl.log 2>&1 &
for _ in $(seq 1 60); do
  curl -s "http://127.0.0.1:$PORT/json/list" | grep -q webSocketDebuggerUrl && break
  sleep 0.5
done
node scripts/shoot-login.mjs "$PORT" 2>&1 | tail -3
ls -la /tmp/fx-login-explained.png 2>/dev/null
