#!/usr/bin/env bash
# Prove the optimizer heatmap and the journal R calendar work in the running app.
set -u
cd /root/fx-replay-lab
LOG=/tmp/fxheat.log
: > "$LOG"
export NODE_OPTIONS="--max-old-space-size=1600"

pkill -9 -f "fx-replay-lab/node_modules/electron" 2>/dev/null
sleep 1
PORT=$(( 9900 + RANDOM % 90 ))

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
  if (r.result?.exceptionDetails) return { EXC: r.result.exceptionDetails.exception?.description?.slice(0, 500) };
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(3600);

console.log("1. OPTIMIZER HEATMAP RENDERS:", await evalJs(`(async () => {
  document.querySelector('.rail-tab[data-tab="strategy"]')?.click();
  await new Promise(r => setTimeout(r, 700));
  // the optimize tab, then the "⚙ Optimize" button (not "Run" — that one backtests)
  const tabs = [...document.querySelectorAll('button')].filter(b => /optimiz/i.test(b.textContent || ''));
  tabs[0]?.click();
  await new Promise(r => setTimeout(r, 400));
  const run = [...document.querySelectorAll('button')].find(b => /Optimize/.test(b.textContent || '') && !/tab/i.test(b.className));
  if (!run) return JSON.stringify({ error: 'no Optimize button', buttons: [...document.querySelectorAll('button')].map(b => (b.textContent||'').trim()).filter(Boolean).slice(0, 20) });
  run.click();
  await new Promise(r => setTimeout(r, 12000));

  const grid = document.querySelector('[data-grid="heatmap"]');
  const cells = [...document.querySelectorAll('[data-cell]')];
  const filled = cells.filter(c => c.textContent?.trim() !== '·').length;
  return JSON.stringify({
    gridShown: !!grid,
    cells: cells.length,
    filled,
    summary: document.querySelector('[data-note="heat-summary"]')?.textContent?.slice(0, 80),
    roughness: document.querySelector('[data-kv="roughness"]')?.textContent?.replace(/\\s+/g,' ').trim().slice(0, 90),
    best: document.querySelector('[data-kv="heat-best"]')?.textContent?.replace(/\\s+/g,' ').trim().slice(0, 60),
  });
})()`));

console.log("2. CHANGING THE METRIC REDRAWS:", await evalJs(`(async () => {
  const sel = document.querySelector('[data-field="heat-metric"]');
  if (!sel) return 'no metric selector';
  const set = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
  set.call(sel, 'maxDrawdown');
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 900));
  const colours = [...document.querySelectorAll('[data-cell]')]
    .map(c => c.style.background).filter(Boolean);
  return JSON.stringify({
    metric: sel.value,
    distinctColours: new Set(colours).size,
    summary: document.querySelector('[data-note="heat-summary"]')?.textContent?.slice(0, 60),
  });
})()`));

console.log("3. APPLY BEST PARAMS FILLS THE FIELDS:", await evalJs(`(async () => {
  const btn = document.querySelector('[data-action="apply-best"]');
  if (!btn) return 'no apply button';
  btn.click();
  await new Promise(r => setTimeout(r, 900));
  // the panel message names the applied set
  const msg = [...document.querySelectorAll('.status, .msg')]
    .map(e => e.textContent || '').find(t => t.includes('applied'));
  return JSON.stringify({ applied: !!msg, msg: (msg || '').slice(0, 70) });
})()`));

console.log("4. JOURNAL CALENDAR RENDERS:", await evalJs(`(async () => {
  // close a few trades on different days so the calendar has data
  const S = window.__fxlab.session;
  S.setRiskLimit(0);
  const days = [1704193200, 1704279600, 1704366000, 1704452400];
  const pnls = [1, -1, 1, 1];
  for (let i = 0; i < days.length; i++) {
    S.setPrice(2000, days[i]);
    S.open('buy', 0.1, 30, 60);
    S.setPrice(pnls[i] > 0 ? 2010 : 1990, days[i] + 3600);
    S.closeAll();
  }
  document.querySelector('.rail-tab[data-tab="journal"]')?.click();
  await new Promise(r => setTimeout(r, 1400));

  const cal = document.querySelector('[data-panel="calendar"]');
  const days_ = [...document.querySelectorAll('[data-day]')];
  const buckets = {};
  for (const d of days_) {
    const b = d.getAttribute('data-bucket');
    buckets[b] = (buckets[b] || 0) + 1;
  }
  return JSON.stringify({
    calendarShown: !!cal,
    dayCells: days_.length,
    buckets,
    month: document.querySelector('[data-kv="cal-month"]')?.textContent,
    total: document.querySelector('[data-kv="cal-total"]')?.textContent,
    worst: document.querySelector('[data-kv="cal-worst"]')?.textContent?.replace(/\\s+/g,' ').trim().slice(0, 40),
    streak: document.querySelector('[data-kv="cal-streak"]')?.textContent?.replace(/\\s+/g,' ').trim(),
  });
})()`));

console.log("5. MONTH NAVIGATION AND REPORT:", await evalJs(`(async () => {
  const next = document.querySelector('[data-action="cal-next"]');
  const prev = document.querySelector('[data-action="cal-prev"]');
  const copy = document.querySelector('[data-action="copy-report"]');
  const before = document.querySelector('[data-kv="cal-month"]')?.textContent;
  // with one month, next should be disabled
  const nextDisabled = next?.disabled;
  copy?.click();
  await new Promise(r => setTimeout(r, 700));
  const note = document.querySelector('[data-note="cal-copied"]')?.textContent?.trim();
  return JSON.stringify({
    month: before,
    nextDisabledSingleMonth: nextDisabled,
    prevDisabled: prev?.disabled,
    copyReportNote: note?.slice(0, 50),
  });
})()`));

const shot = await send("Page.captureScreenshot", { format: "png" });
if (shot.result?.data) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync("/tmp/fx-heat.png", Buffer.from(shot.result.data, "base64"));
  console.log("screenshot /tmp/fx-heat.png");
}
ws.close();
JS

echo "=== errors ==="
grep -iE "\b(error|exception|uncaught)\b" "$LOG" \
  | grep -viE "bus\.cc|gpu|vulkan|libva|gbm|dri3|MESA|fontconfig|sandbox|X11|NODE_OPTION|sqlite-error" | head -5 || echo "  (none)"

kill -9 $APP 2>/dev/null; wait $APP 2>/dev/null
