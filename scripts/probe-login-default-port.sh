#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."
PORT=18361
CACHE=/tmp/pldp-cache-$$
mkdir -p "$CACHE"
pkill -f "remote-debugging-port=$PORT" 2>/dev/null
pkill -f "fake-bridge.py --port 8765" 2>/dev/null

python3 scripts/fake-bridge.py --port 8765 > /tmp/sb8765.log 2>&1 &
BPID=$!
trap 'kill $BPID 2>/dev/null; pkill -f "remote-debugging-port=$PORT" 2>/dev/null; rm -rf "$CACHE"' EXIT
for _ in $(seq 1 30); do
  curl -s "http://127.0.0.1:8765/health" | grep -q connected && break
  sleep 0.3
done
echo "bridge on the app's default port: $(curl -s http://127.0.0.1:8765/health)"

export NODE_OPTIONS=--max-old-space-size=1600
FXLAB_DATA_DIR="$CACHE" \
  xvfb-run -a --server-args="-screen 0 1600x1000x24" \
  npx electron dist/main/main.js --remote-debugging-port="$PORT" --no-sandbox \
  > /tmp/pldp.log 2>&1 &
for _ in $(seq 1 60); do
  curl -s "http://127.0.0.1:$PORT/json/list" | grep -q webSocketDebuggerUrl && break
  sleep 0.5
done
node scripts/probe-login-default-port.mjs "$PORT" 2>&1 | tail -8
