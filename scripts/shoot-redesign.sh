#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."
PORT=18401
OUT=/tmp/redesign-shots
CACHE=/tmp/rd-cache-$$
rm -rf "$OUT"; mkdir -p "$OUT" "$CACHE"
pkill -f "remote-debugging-port=$PORT" 2>/dev/null
trap 'pkill -f "remote-debugging-port=$PORT" 2>/dev/null; rm -rf "$CACHE"' EXIT

export NODE_OPTIONS=--max-old-space-size=1600
FXLAB_DATA_DIR="$CACHE" \
  xvfb-run -a --server-args="-screen 0 1700x1100x24" \
  npx electron dist/main/main.js --remote-debugging-port="$PORT" --no-sandbox \
  > /tmp/redesign.log 2>&1 &
for _ in $(seq 1 60); do
  curl -s "http://127.0.0.1:$PORT/json/list" | grep -q webSocketDebuggerUrl && break
  sleep 0.5
done
node scripts/shoot-redesign.mjs "$PORT" "$OUT" 2>&1 | tail -26

echo
echo "=== renderer errors ==="
grep -iE 'error|cannot read|is not a function|undefined is not' /tmp/redesign.log \
  | grep -viE 'bus.cc|net::ERR|devtools|Autofill|GPU|gpu_|Missing X|dbus|favicon|NODE_OPTION' | head -6
echo "(nothing above = clean)"
echo
ls -la "$OUT"
