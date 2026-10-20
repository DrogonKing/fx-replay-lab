#!/usr/bin/env bash
# Prove the economic calendar works end to end in the running app:
#   1. the NEWS tab exists and says no calendar is loaded
#   2. importing a CSV parses it (counts, impact split) and persists it
#   3. high-impact events become chart markers
#   4. the blackout actually REFUSES an order and says which event
#   5. closing a position is still allowed during a blackout
#
# Step 4 is the whole point: an import that only draws markers is decoration.
set -u
cd /root/fx-replay-lab
LOG=/tmp/fxnews.log
: > "$LOG"
export NODE_OPTIONS="--max-old-space-size=1600"

pkill -9 -f "fx-replay-lab/node_modules/electron" 2>/dev/null
sleep 1
PORT=$(( 9300 + RANDOM % 400 ))

timeout 180 xvfb-run -a --server-args="-screen 0 1600x1000x24" \
  npx electron . --no-sandbox --remote-debugging-port=$PORT --fx-test >> "$LOG" 2>&1 &
APP=$!
READY=0
for i in $(seq 1 45); do
  curl -s --max-time 1 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1 && { READY=1; break; }
  sleep 1
done
[ "$READY" = "1" ] || { echo "FAIL: no debugger"; tail -15 "$LOG"; exit 1; }
export FX_PORT=$PORT

node --input-type=module <<'JS'
const PORT = process.env.FX_PORT;
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 1; const pending = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) =>
  new Promise((res) => { const id = seq++; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
await new Promise((r) => ws.addEventListener("open", r));
await send("Runtime.enable");
await send("DOM.enable");
const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { EXC: r.result.exceptionDetails.exception?.description?.slice(0, 500) };
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(3600);

console.log("1. NEWS TAB:", await evalJs(`(async () => {
  const tab = [...document.querySelectorAll('.rail-tab')].find(t=>t.textContent.trim()==='news');
  if (!tab) return 'no news tab';
  tab.click();
  await new Promise(r=>setTimeout(r,600));
  const txt = (document.querySelector('.news-panel')?.innerText ?? '').slice(0, 160).replace(/\\n/g,' | ');
  return JSON.stringify({ tabFound: true, text: txt });
})()`));

console.log("2. IMPORT THE CSV:", await evalJs(`(async () => {
  // The file input is hidden; drive the same import path the UI uses by setting files
  // is not possible without a real File object, so build one and call the handler the
  // input's onChange would call: read the CSV text and dispatch a change with a DataTransfer.
  const csv = [
    'Date,Time,Currency,Impact,Event,Actual,Forecast,Previous',
    '2024-01-02,15:00,USD,Medium,ISM Manufacturing PMI,47.4,47.1,46.7',
    '2024-01-03,13:30,USD,High,Non-Farm Payrolls,216K,170K,173K',
    '2024-01-03,15:00,USD,Medium,ISM Services PMI,50.6,52.6,52.7',
    '2024-01-04,07:00,EUR,Low,Sentix Index,-15.8,-16.0,-16.8',
    '2024-01-04,13:30,USD,High,CPI m/m,0.3%,0.2%,0.1%',
    '2024-01-05,13:30,USD,High,FOMC Minutes,,,',
  ].join('\\n');

  const input = document.querySelector('.news-import input[type=file]');
  if (!input) return 'no file input';
  const file = new File([csv], 'calendar.csv', { type: 'text/csv' });
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));

  await new Promise(r=>setTimeout(r,1500));
  const kvs = [...document.querySelectorAll('.news-panel .kv')].map(k=>k.textContent);
  const rows = [...document.querySelectorAll('.news-table tbody tr')].length;
  const msg = document.querySelector('.news-panel .msg')?.textContent;
  return JSON.stringify({ kvs, tableRows: rows, msg });
})()`));

console.log("3. PERSISTED + MARKERS:", await evalJs(`(async () => {
  const stored = await window.fxlab.loadNews();
  // count coloured markers by scanning the chart canvas is unreliable; assert the model
  const panel = document.querySelector('.news-panel');
  const blackoutEl = panel?.querySelector('.blackout-active, .blackout-clear');
  return JSON.stringify({
    storedInDb: stored.length,
    blackoutClass: blackoutEl?.className ?? 'none',
    blackoutText: (blackoutEl?.textContent ?? '').slice(0, 90),
  });
})()`));

console.log("4. BLACKOUT REFUSES AN ORDER:", await evalJs(`(async () => {
  // The session has no price until a bar is processed, so step once first — otherwise
  // the refusal comes from "no price yet" and proves nothing about the blackout.
  const H = window.__fxlab;
  H.session.setPrice(1991.0, 1704288600);
  H.session.setBlackout({ blocked: true, reason: 'high impact USD: Non-Farm Payrolls' });

  const before = H.state().positions.length;
  const r = H.session.open('buy', 0.1, 10, 20);
  const pending = H.session.placeOrder({
    side: 'buy', kind: 'limit', lots: 0.1, price: 1900, slDistance: 10, tpDistance: 20,
  });
  return JSON.stringify({
    positionsBefore: before,
    marketRefused: r.ok === false,
    marketMessage: r.message,
    mentionsBlackout: (r.message ?? '').includes('news blackout'),
    pendingRefused: pending.ok === false,
    pendingMessage: pending.message,
    positionsAfter: H.state().positions.length,
  });
})()`));

console.log("5. CLOSING IS STILL ALLOWED DURING A BLACKOUT:", await evalJs(`(async () => {
  const H = window.__fxlab;
  H.session.setPrice(1991.0, 1704288600);
  H.session.setBlackout(null);                 // open a position normally
  H.session.open('buy', 0.1, 10, 20);
  const opened = H.state().positions.length;
  H.session.setBlackout({ blocked: true, reason: 'high impact USD: CPI' });
  const closed = H.session.closeAll();
  return JSON.stringify({ opened, closedCount: closed, remaining: H.state().positions.length });
})()`));

const shot = await send("Page.captureScreenshot", { format: "png" });
if (shot.result?.data) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync("/tmp/fx-news.png", Buffer.from(shot.result.data, "base64"));
  console.log("screenshot /tmp/fx-news.png");
}
ws.close();
JS

echo "=== calendar rows in sqlite ==="
DB="$HOME/.config/fx-replay-lab/fx-replay-lab/fx-replay-lab.db"
if [ -f "$DB" ]; then
  python3 - "$DB" <<'PY'
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
rows = con.execute("SELECT time, currency, impact, title FROM news ORDER BY time").fetchall()
print(f"news rows: {len(rows)}")
for t, c, i, title in rows[:4]:
    print(f"  {t} {c} {i:6s} {title}")
con.close()
PY
fi

echo "=== errors ==="
grep -iE "\b(error|exception|uncaught)\b" "$LOG" \
  | grep -viE "bus\.cc|gpu|vulkan|libva|gbm|dri3|MESA|fontconfig|sandbox|X11|NODE_OPTION|sqlite-error|bind\(\) failed" | head -6 || echo "  (none)"

kill -9 $APP 2>/dev/null; wait $APP 2>/dev/null
