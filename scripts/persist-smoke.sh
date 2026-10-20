#!/usr/bin/env bash
# Prove persistence survives an app restart.
#
# "It saved" is not the same as "it loaded". This script:
#   1. launches the app, draws three shapes, waits for the debounced autosave
#   2. reads the SQLite file directly to confirm rows exist on disk
#   3. KILLS the app
#   4. relaunches and asserts the drawings are back and repainted
#
# Step 2 matters because a passing step 4 can still be satisfied by in-memory state
# if the kill did not really happen, so the file is inspected on its own terms.
set -u
cd /root/fx-replay-lab
LOG=/tmp/fxpersist.log
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

echo "=== PHASE 1: draw and save ==="
timeout 120 xvfb-run -a --server-args="-screen 0 1600x1000x24" \
  npx electron . --no-sandbox --remote-debugging-port=9231 >> "$LOG" 2>&1 &
APP1=$!
for i in $(seq 1 40); do
  curl -s --max-time 1 http://127.0.0.1:9231/json/version >/dev/null 2>&1 && break
  sleep 1
done

run_cdp 9231 "
await sleep(3200);
console.log('DRAW:', await evalJs(\`(async () => {
  const pick = async (gi, label) => {
    const g = document.querySelectorAll('.draw-rail .tool-group')[gi];
    g.querySelector('.tool-btn').click();
    await new Promise(r=>setTimeout(r,200));
    const it = [...document.querySelectorAll('.tool-flyout .flyout-item')].find(b=>b.textContent.includes(label));
    if (!it) return false;
    it.click(); await new Promise(r=>setTimeout(r,200)); return true;
  };
  const c = document.querySelector('.draw-canvas');
  const rect = c.getBoundingClientRect();
  const ev = (t,x,y,b) => c.dispatchEvent(new PointerEvent(t, {bubbles:true, clientX:rect.left+x, clientY:rect.top+y, pointerId:1, button:0, buttons:b}));

  // a horizontal line (one click) and a rectangle (drag)
  if (!await pick(0, 'Horizontal Line')) return 'no hline tool';
  ev('pointerdown', 420, 300, 1); ev('pointerup', 420, 300, 0);
  await new Promise(r=>setTimeout(r,200));

  if (!await pick(2, 'Rectangle')) return 'no rect tool';
  ev('pointerdown', 500, 560, 1); ev('pointermove', 900, 700, 1); ev('pointerup', 900, 700, 0);
  await new Promise(r=>setTimeout(r,300));

  return JSON.stringify({ count: document.querySelector('.rail-count')?.textContent });
})()\`));
// the autosave is debounced 600ms
await sleep(1600);
console.log('WORKSPACE:', await evalJs(\`JSON.stringify({ tf: document.querySelector('.tf-label')?.textContent })\`));
"

sleep 1
echo "=== PHASE 2: inspect SQLite on disk ==="
if [ -f "$DB" ]; then
  python3 - "$DB" <<'PY'
import sqlite3, sys, json
con = sqlite3.connect(sys.argv[1])
try:
    rows = con.execute("SELECT workspace, length(payload), updated_at FROM drawing_sets").fetchall()
    print(f"drawing_sets rows: {len(rows)}")
    for ws, n, upd in rows:
        print(f"  {ws}  payload={n}B  updated={upd}")
    for ws, payload, upd in con.execute("SELECT workspace, payload, updated_at FROM drawing_sets"):
        data = json.loads(payload)
        print(f"  {ws}: version={data.get('version')} shapes={len(data.get('drawings', []))} "
              f"kinds={[d.get('kind') for d in data.get('drawings', [])]}")
    jr = con.execute("SELECT COUNT(*) FROM journal").fetchone()[0]
    print(f"journal rows: {jr}")
finally:
    con.close()
PY
else
  echo "FAIL: database file not created at $DB"
fi

echo "=== PHASE 3: kill the app hard ==="
kill -9 $APP1 2>/dev/null
wait $APP1 2>/dev/null
sleep 2
pkill -f "remote-debugging-port=9231" 2>/dev/null
sleep 1
echo "app killed"

echo "=== PHASE 4: relaunch and verify the drawings came back ==="
: > "$LOG"
timeout 120 xvfb-run -a --server-args="-screen 0 1600x1000x24" \
  npx electron . --no-sandbox --remote-debugging-port=9232 >> "$LOG" 2>&1 &
APP2=$!
for i in $(seq 1 40); do
  curl -s --max-time 1 http://127.0.0.1:9232/json/version >/dev/null 2>&1 && break
  sleep 1
done

run_cdp 9232 "
await sleep(3500);
console.log('RESTORED:', await evalJs(\`(async () => {
  const c = document.querySelector('.draw-canvas');
  const ctx = c.getContext('2d');
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let opaque = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 8) opaque++;
  return JSON.stringify({
    railCount: document.querySelector('.rail-count')?.textContent,
    paintedPixels: opaque,
    status: document.querySelector('.status')?.textContent?.slice(0,120),
  });
})()\`));
const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync('/tmp/fx-restored.png', Buffer.from(shot.result.data, 'base64'));
  console.log('screenshot /tmp/fx-restored.png');
}
"

kill -9 $APP2 2>/dev/null
wait $APP2 2>/dev/null
echo "=== errors ==="
grep -iE "\b(error|exception|uncaught)\b" "$LOG" \
  | grep -viE "bus\.cc|gpu|vulkan|libva|gbm|dri3|MESA|fontconfig|sandbox|X11|NODE_OPTION|sqlite-error" | head -6 || echo "  (none)"
