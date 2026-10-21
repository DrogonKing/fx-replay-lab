#!/usr/bin/env bash
# Reach the stub bridge exactly the way the app does: Node's fetch, to loopback, on a real port.
set -u
cd "$(dirname "$0")/.."
PORT="${1:-18780}"

python3 scripts/fake-bridge.py --port "$PORT" > /tmp/sb.log 2>&1 &
BPID=$!
trap 'kill $BPID 2>/dev/null' EXIT
for _ in $(seq 1 30); do
  curl -s "http://127.0.0.1:$PORT/health" | grep -q connected && break
  sleep 0.3
done

echo "--- curl says the bridge is up ---"
curl -s -o /dev/null -w "  health: HTTP %{http_code}\n" "http://127.0.0.1:$PORT/health"

echo "--- node fetch to the SAME url ---"
node -e "
const url = 'http://127.0.0.1:$PORT/health';
fetch(url)
  .then(r => { console.log('  OK', r.status); return r.text(); })
  .then(t => console.log('  body:', t.slice(0, 80)))
  .catch(e => {
    console.log('  ERR:', e.message);
    console.log('  cause:', e.cause && (e.cause.code || e.cause.message));
    console.log('  cause.errno:', e.cause && e.cause.errno);
    console.log('  cause.syscall:', e.cause && e.cause.syscall);
  });
"

echo "--- node POST to /login ---"
node -e "
fetch('http://127.0.0.1:$PORT/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ login: '10000001', password: 'p', server: 'Stub-Demo' }),
  signal: AbortSignal.timeout(5000),
})
  .then(r => r.text())
  .then(t => console.log('  OK:', t.slice(0, 120)))
  .catch(e => {
    console.log('  ERR:', e.message);
    console.log('  cause:', e.cause && (e.cause.code || e.cause.message));
  });
"
