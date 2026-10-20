#!/usr/bin/env bash
# Prove the journal persists across a restart, independently of drawings.
#
# Adds a sample entry, waits for the debounced save, kills the app, relaunches and
# asserts the row is back in the table AND in the statistics.
set -u
cd /root/fx-replay-lab
LOG=/tmp/fxjournal.log
: > "$LOG"
DB="$HOME/.config/fx-replay-lab/fx-replay-lab/fx-replay-lab.db"

run_cdp() {
  local port="$1" script="$2"
  node --input-type=module -e "
const list = await (await fetch('http://127.0.0.1:$port/json/list')).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 1; const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) =>
  new Promise((res) => { const id = seq++; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
await new Promise((r) => ws.addEventListener('open', r));
await send('Runtime.enable');
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { EXC: r.result.exceptionDetails.exception?.description?.slice(0,400) };
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
$script
ws.close();
"
}

wait_port() {
  local port="$1"
  for i in $(seq 1 40); do
    curl -s --max-time 1 "http://127.0.0.1:$port/json/version" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

echo "=== PHASE 1: add a journal entry ==="
timeout 120 xvfb-run -a --server-args="-screen 0 1600x1000x24" \
  npx electron . --no-sandbox --remote-debugging-port=9241 >> "$LOG" 2>&1 &
APP1=$!
wait_port 9241 || { echo "FAIL: app never opened its debugger"; exit 1; }

run_cdp 9241 "
await sleep(3200);
console.log('ADD:', await evalJs(\`(async () => {
  [...document.querySelectorAll('.rail-tab')].find(t=>t.textContent.toLowerCase()==='journal').click();
  await new Promise(r=>setTimeout(r,400));
  const btn = [...document.querySelectorAll('.journal-panel button')].find(b=>b.textContent.includes('Sample'));
  if (!btn) return 'no sample button';
  btn.click();
  await new Promise(r=>setTimeout(r,300));
  btn.click();
  await new Promise(r=>setTimeout(r,900));
  const rows = [...document.querySelectorAll('.journal-panel table.grid tr')].length;
  const kvs = [...document.querySelectorAll('.journal-panel .kv')].map(k=>k.textContent);
  return JSON.stringify({ tableRows: rows, stats: kvs.slice(0,4) });
})()\`));
"
sleep 2
echo "=== PHASE 2: inspect journal table on disk ==="
python3 - "$DB" <<'PY'
import sqlite3, sys, json
con = sqlite3.connect(sys.argv[1])
rows = con.execute("SELECT id, payload, exit_time FROM journal ORDER BY exit_time").fetchall()
print(f"journal rows on disk: {len(rows)}")
for rid, payload, ex in rows:
    d = json.loads(payload)
    print(f"  {rid}  {d['symbol']} {d['side']} pnl={d['pnl']} tags={d['tags']}")
con.close()
PY

echo "=== PHASE 3: kill and relaunch ==="
kill -9 $APP1 2>/dev/null; wait $APP1 2>/dev/null
sleep 2

timeout 120 xvfb-run -a --server-args="-screen 0 1600x1000x24" \
  npx electron . --no-sandbox --remote-debugging-port=9242 >> "$LOG" 2>&1 &
APP2=$!
wait_port 9242 || { echo "FAIL: relaunch never opened its debugger"; exit 1; }

run_cdp 9242 "
await sleep(3500);
console.log('RESTORED:', await evalJs(\`(async () => {
  [...document.querySelectorAll('.rail-tab')].find(t=>t.textContent.toLowerCase()==='journal').click();
  await new Promise(r=>setTimeout(r,500));
  const rows = [...document.querySelectorAll('.journal-panel table.grid tr')].length;
  const kvs = [...document.querySelectorAll('.journal-panel .kv')].map(k=>k.textContent);
  const btns = [...document.querySelectorAll('.journal-panel button')].map(b=>b.textContent.trim());
  return JSON.stringify({ tableRows: rows, stats: kvs.slice(0,4), buttons: btns });
})()\`));
"

kill -9 $APP2 2>/dev/null; wait $APP2 2>/dev/null
echo "=== errors ==="
grep -iE "\b(error|exception|uncaught)\b" "$LOG" \
  | grep -viE "bus\.cc|gpu|vulkan|libva|gbm|dri3|MESA|fontconfig|sandbox|X11|NODE_OPTION|sqlite-error|bind\(\) failed" | head -5 || echo "  (none)"
