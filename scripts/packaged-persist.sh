#!/usr/bin/env bash
# Persistence in the PACKAGED app.
#
# The dev tree writing to SQLite proves nothing about the bundle: better-sqlite3 has
# to be unpacked from asar, the userData path differs, and the preload bridge is a
# different file. This draws in the real AppImage, kills it, relaunches it, and
# checks both.
set -u
cd /root/fx-replay-lab
LOG=/tmp/fxpackersist.log
: > "$LOG"

APPIMAGE=$(ls release/*.AppImage 2>/dev/null | head -1)
if [ -z "$APPIMAGE" ]; then echo "FAIL: no AppImage"; exit 1; fi
echo "testing: $APPIMAGE"

# The packaged app writes to the same userData dir but a different db file name is
# NOT used, so clear it to make the test unambiguous.
DB="$HOME/.config/FX Replay Lab/fx-replay-lab/fx-replay-lab.db"
DB2="$HOME/.config/fx-replay-lab/fx-replay-lab/fx-replay-lab.db"
rm -f "$DB"* "$DB2"* 2>/dev/null

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
  for i in $(seq 1 45); do
    curl -s --max-time 1 "http://127.0.0.1:$1/json/version" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

echo "=== PHASE 1: draw in the packaged app ==="
timeout 140 xvfb-run -a --server-args="-screen 0 1600x1000x24" \
  "$APPIMAGE" --appimage-extract-and-run --no-sandbox \
  --remote-debugging-port=9251 >> "$LOG" 2>&1 &
APP1=$!
wait_port 9251 || { echo "FAIL: packaged app never opened its debugger"; tail -20 "$LOG"; exit 1; }

run_cdp 9251 "
await sleep(3500);
console.log('DRAW:', await evalJs(\`(async () => {
  const pick = async (gi, label) => {
    const g = document.querySelectorAll('.draw-rail .tool-group')[gi];
    g.querySelector('.tool-btn').click();
    await new Promise(r=>setTimeout(r,250));
    const it = [...document.querySelectorAll('.draw-tool-flyout .flyout-item, .tool-flyout .flyout-item')]
      .find(b=>b.textContent.includes(label));
    if (!it) return false;
    it.click(); await new Promise(r=>setTimeout(r,250)); return true;
  };
  const c = document.querySelector('.draw-canvas');
  const rect = c.getBoundingClientRect();
  const ev = (t,x,y,b) => c.dispatchEvent(new PointerEvent(t, {bubbles:true, clientX:rect.left+x, clientY:rect.top+y, pointerId:1, button:0, buttons:b}));
  if (!await pick(0, 'Horizontal Line')) return 'no hline';
  ev('pointerdown', 400, 320, 1); ev('pointerup', 400, 320, 0);
  await new Promise(r=>setTimeout(r,250));
  if (!await pick(2, 'Rectangle')) return 'no rect';
  ev('pointerdown', 480, 560, 1); ev('pointermove', 880, 700, 1); ev('pointerup', 880, 700, 0);
  await new Promise(r=>setTimeout(r,400));
  return JSON.stringify({ count: document.querySelector('.rail-count')?.textContent });
})()\`));
await sleep(1800);
"

sleep 2
echo "=== PHASE 2: find the database the packaged app wrote ==="
FOUND=""
for cand in "$DB" "$DB2"; do
  [ -f "$cand" ] && FOUND="$cand"
done
if [ -z "$FOUND" ]; then
  echo "searching for any db under ~/.config:"
  find "$HOME/.config" -name 'fx-replay-lab.db' 2>/dev/null
  FOUND=$(find "$HOME/.config" -name 'fx-replay-lab.db' 2>/dev/null | head -1)
fi
[ -z "$FOUND" ] && { echo "FAIL: no database created"; exit 1; }
echo "db: $FOUND"
python3 - "$FOUND" <<'PY'
import sqlite3, sys, json
con = sqlite3.connect(sys.argv[1])
rows = con.execute("SELECT workspace, payload FROM drawing_sets").fetchall()
print(f"drawing_sets rows: {len(rows)}")
for ws, payload in rows:
    d = json.loads(payload)
    print(f"  {ws}: {len(d.get('drawings', []))} shapes "
          f"{[x.get('kind') for x in d.get('drawings', [])]}")
con.close()
PY

echo "=== PHASE 3: kill -9 and relaunch the packaged app ==="
kill -9 $APP1 2>/dev/null; wait $APP1 2>/dev/null
sleep 3

: > "$LOG"
timeout 140 xvfb-run -a --server-args="-screen 0 1600x1000x24" \
  "$APPIMAGE" --appimage-extract-and-run --no-sandbox \
  --remote-debugging-port=9252 >> "$LOG" 2>&1 &
APP2=$!
wait_port 9252 || { echo "FAIL: relaunch never opened its debugger"; tail -20 "$LOG"; exit 1; }

run_cdp 9252 "
await sleep(4000);
console.log('RESTORED:', await evalJs(\`(async () => {
  const c = document.querySelector('.draw-canvas');
  const ctx = c.getContext('2d');
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let opaque = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 8) opaque++;
  return JSON.stringify({
    railCount: document.querySelector('.rail-count')?.textContent,
    paintedPixels: opaque,
  });
})()\`));
const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync('/tmp/fx-packaged-restored.png', Buffer.from(shot.result.data, 'base64'));
  console.log('screenshot /tmp/fx-packaged-restored.png');
}
"

kill -9 $APP2 2>/dev/null; wait $APP2 2>/dev/null
echo "=== errors ==="
grep -iE "\b(error|exception|uncaught)\b" "$LOG" \
  | grep -viE "bus\.cc|gpu|vulkan|libva|gbm|dri3|MESA|fontconfig|sandbox|X11|NODE_OPTION|sqlite-error|bind\(\) failed" | head -5 || echo "  (none)"
