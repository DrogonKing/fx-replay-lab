#!/usr/bin/env bash
# Prove trailing stop and partial close in the running app.
#
# The critical assertion is #3: a trail must NOT be hit by the bar that created it.
# That was a real bug that closed winning trades for a loss, and only a multi-bar
# sequence in the live loop can catch it.
set -u
cd /root/fx-replay-lab
LOG=/tmp/fxtrail.log
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
const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { EXC: r.result.exceptionDetails.exception?.description?.slice(0, 500) };
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(3600);

console.log("0. UI CONTROLS:", await evalJs(`(async () => {
  [...document.querySelectorAll('.rail-tab')].find(t=>t.textContent.trim()==='trade').click();
  await new Promise(r=>setTimeout(r,500));
  const trailSel = document.querySelector('.be-row select');
  const beInput = document.querySelector('.be-row input');
  return JSON.stringify({
    trailOptions: trailSel ? [...trailSel.options].map(o=>o.value) : 'none',
    hasBreakEven: !!beInput,
  });
})()`));

console.log("1. OPEN A POSITION:", await evalJs(`(async () => {
  const setv = (name, v) => {
    const lab = [...document.querySelectorAll('.order-form label')]
      .find(l => l.textContent.trim().toLowerCase().startsWith(name));
    const el = lab.querySelector('input,select');
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  setv('lots', '1.00'); setv('sl', '60'); setv('tp', '0');
  await new Promise(r=>setTimeout(r,300));
  [...document.querySelectorAll('.trade-panel button')].find(b=>b.textContent.includes('Buy')).click();
  await new Promise(r=>setTimeout(r,600));
  return JSON.stringify(window.__fxlab.state());
})()`));

console.log("2. ENABLE TRAILING (high/low, 8 pts):", await evalJs(`(async () => {
  const sel = document.querySelector('.be-row select');
  const val = document.querySelectorAll('.be-row input')[0];
  const setSel = (el, v) => {
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const setVal = (el, v) => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  setSel(sel, 'extreme');
  await new Promise(r=>setTimeout(r,300));
  setVal(val, '8');
  await new Promise(r=>setTimeout(r,400));

  const before = window.__fxlab.state().positions[0];
  return JSON.stringify({ mode: sel.value, value: val.value, slBefore: before?.sl });
})()`));

console.log("3. STEP AND WATCH THE TRAIL (the regression case):", await evalJs(`(async () => {
  const H = window.__fxlab;
  const step = [...document.querySelectorAll('header button')].find(b=>b.textContent.includes('Step'));
  const trace = [];
  for (let i = 0; i < 25; i++) {
    step.click();
    await new Promise(r=>setTimeout(r,45));
    const st = H.state();
    const p = st.positions[0];
    trace.push({ i, sl: p ? p.sl : null, open: !!p, trades: st.positions.length === 0 });
  }
  const last = trace[trace.length - 1];
  const first = trace[0];
  return JSON.stringify({
    firstSL: first.sl,
    lastSL: last.sl,
    tightened: last.sl !== null && first.sl !== null && last.sl > first.sl,
    closedEarly: trace.findIndex(t => t.open === false),
    stillOpen: last.open,
  });
})()`));

console.log("4. PARTIAL CLOSE (½):", await evalJs(`(async () => {
  const H = window.__fxlab;
  const before = H.state().positions[0];
  if (!before) return 'no position to reduce';
  const half = document.querySelector('.trade-panel .row-half');
  if (!half) return 'no half button';
  half.click();
  await new Promise(r=>setTimeout(r,700));
  const st = H.state();
  return JSON.stringify({
    lotsBefore: before.lots,
    lotsAfter: st.positions[0]?.lots ?? 'closed',
    stillOpen: st.positions.length > 0,
  });
})()`));

console.log("5. JOURNAL RECEIVED THE PARTIAL:", await evalJs(`(async () => {
  [...document.querySelectorAll('.rail-tab')].find(t=>t.textContent.trim()==='journal').click();
  await new Promise(r=>setTimeout(r,1200));
  const rows = [...document.querySelectorAll('.journal-panel table.grid tbody tr')]
    .map(tr => [...tr.querySelectorAll('td')].map(td=>td.textContent.trim()));
  const kvs = [...document.querySelectorAll('.journal-panel .kv')].map(k=>k.textContent);
  return JSON.stringify({ rowCount: rows.length, rows: rows.slice(0,3), kvs: kvs.slice(0,3) });
})()`));

const shot = await send("Page.captureScreenshot", { format: "png" });
if (shot.result?.data) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync("/tmp/fx-trail.png", Buffer.from(shot.result.data, "base64"));
  console.log("screenshot /tmp/fx-trail.png");
}
ws.close();
JS

echo "=== errors ==="
grep -iE "\b(error|exception|uncaught)\b" "$LOG" \
  | grep -viE "bus\.cc|gpu|vulkan|libva|gbm|dri3|MESA|fontconfig|sandbox|X11|NODE_OPTION|sqlite-error|bind\(\) failed" | head -6 || echo "  (none)"

kill -9 $APP 2>/dev/null; wait $APP 2>/dev/null
