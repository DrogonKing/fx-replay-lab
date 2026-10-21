#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."
PORT=18351
BPORT=18790
CACHE=/tmp/pli-cache-$$
mkdir -p "$CACHE"
pkill -f "remote-debugging-port=$PORT" 2>/dev/null

python3 scripts/fake-bridge.py --port "$BPORT" > /tmp/sb3.log 2>&1 &
BPID=$!
trap 'kill $BPID 2>/dev/null; pkill -f "remote-debugging-port=$PORT" 2>/dev/null; rm -rf "$CACHE"' EXIT
for _ in $(seq 1 30); do
  curl -s "http://127.0.0.1:$BPORT/health" | grep -q connected && break
  sleep 0.3
done
echo "bridge health: $(curl -s "http://127.0.0.1:$BPORT/health")"

export NODE_OPTIONS=--max-old-space-size=1600
FXLAB_DATA_DIR="$CACHE" \
  xvfb-run -a --server-args="-screen 0 1600x1000x24" \
  npx electron dist/main/main.js --remote-debugging-port="$PORT" --no-sandbox \
  > /tmp/pli.log 2>&1 &
for _ in $(seq 1 60); do
  curl -s "http://127.0.0.1:$PORT/json/list" | grep -q webSocketDebuggerUrl && break
  sleep 0.5
done
node scripts/probe-login-ipc.mjs "$PORT" "http://127.0.0.1:$BPORT" 2>&1 | tail -8
