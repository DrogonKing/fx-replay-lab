#!/usr/bin/env bash
# Prove the CSV column mapping and quality report work in the running app, on a file that
# the automatic importer cannot read.
set -u
cd /root/fx-replay-lab
LOG=/tmp/fxcsv.log
: > "$LOG"
export NODE_OPTIONS="--max-old-space-size=1600"

pkill -9 -f "fx-replay-lab/node_modules/electron" 2>/dev/null
sleep 1
PORT=$(( 9700 + RANDOM % 300 ))

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
const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { EXC: r.result.exceptionDetails.exception?.description?.slice(0, 400) };
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(3600);

console.log("1. AUTO-DETECT REJECTS THE MESSY FILE:", await evalJs(`(async () => {
  const csv = [
    'Instrument;DateTime;Qty;Low;High;Open;Last',
    'XAUUSD;2024.01.02 10:00;120;1999.50;2002.00;2000.50;2001.00',
    'XAUUSD;2024.01.02 10:05;140;2001.00;2004.25;2001.00;2004.00',
    'XAUUSD;2024.01.02 10:10;95;2003.75;2005.00;2004.00;2004.50',
    'XAUUSD;2024.01.02 10:15;200;2004.25;2007.50;2004.50;2007.00',
    'XAUUSD;2024.01.02 10:20;80;2006.50;2008.00;2007.00;2006.75',
  ].join('\\n');

  // drive the panel the way the file input does
  const file = new File([csv], 'broker-messy.csv', { type: 'text/csv' });
  const input = document.querySelector('.data-panel input[type="file"]');
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 1600));

  const map = document.querySelector('[data-panel="colmap"]');
  const note = document.querySelector('.data-panel .status')?.textContent ?? '';
  return JSON.stringify({
    mappingShown: !!map,
    mentionsRejected: /rejected/i.test(note),
    note: note.slice(0, 90),
  });
})()`));

console.log("2. HEADERS MAP AUTOMATICALLY:", await evalJs(`(async () => {
  const val = (f) => document.querySelector('[data-field="map-' + f + '"]')?.value;
  return JSON.stringify({
    time: val('time'), open: val('open'), high: val('high'),
    low: val('low'), close: val('close'), volume: val('volume'),
    timeOfDay: val('timeOfDay'),
  });
})()`));

console.log("3. APPLY MAPPING IMPORTS THE BARS:", await evalJs(`(async () => {
  document.querySelector('[data-action="apply-map"]')?.click();
  await new Promise(r => setTimeout(r, 1800));
  const kv = (s) => document.querySelector('[data-kv="' + s + '"]')?.textContent?.replace(/\\s+/g,' ').trim();
  const note = document.querySelector('.data-panel .status')?.textContent ?? '';
  return JSON.stringify({
    bars: kv('q-bars'),
    spacing: kv('q-spacing'),
    range: kv('q-range'),
    note: note.slice(0, 80),
  });
})()`));

console.log("4. QUALITY REPORT IS HONEST:", await evalJs(`(async () => {
  const panel = document.querySelector('[data-panel="quality"]');
  const note = document.querySelector('[data-note="quality"]')?.textContent?.trim();
  return JSON.stringify({
    shown: !!panel,
    headline: note?.slice(0, 80),
  });
})()`));

console.log("5. A WRONG MAP IS REFUSED, NOT APPLIED SILENTLY:", await evalJs(`(async () => {
  const sel = document.querySelector('[data-field="map-close"]');
  const set = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
  set.call(sel, '-1');
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 600));
  const missing = document.querySelector('[data-note="mapmissing"]')?.textContent?.trim();
  document.querySelector('[data-action="apply-map"]')?.click();
  await new Promise(r => setTimeout(r, 900));
  const note = document.querySelector('.data-panel .status')?.textContent ?? '';
  return JSON.stringify({
    missingShown: missing?.slice(0, 50),
    refused: /cannot import/i.test(note),
    note: note.slice(0, 80),
  });
})()`));

const shot = await send("Page.captureScreenshot", { format: "png" });
if (shot.result?.data) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync("/tmp/fx-csv.png", Buffer.from(shot.result.data, "base64"));
  console.log("screenshot /tmp/fx-csv.png");
}
ws.close();
JS

echo "=== errors ==="
grep -iE "\b(error|exception|uncaught)\b" "$LOG" \
  | grep -viE "bus\.cc|gpu|vulkan|libva|gbm|dri3|MESA|fontconfig|sandbox|X11|NODE_OPTION|sqlite-error" | head -5 || echo "  (none)"

kill -9 $APP 2>/dev/null; wait $APP 2>/dev/null
