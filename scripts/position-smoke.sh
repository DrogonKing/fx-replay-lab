#!/usr/bin/env bash
# Prove position management end to end:
#   1. entry/SL/TP lines are painted on the overlay
#   2. a REAL pointer drag on the SL line moves the stop in the engine
#   3. a drag across the entry is refused, with the reason shown
#   4. auto break-even moves the stop to the entry (+commission) once in profit
#
# Step 2/3 dispatch genuine PointerEvents at coordinates derived from
# chart.priceToCoordinate, so the whole path runs: pointer -> hitHandle -> setLevel.
set -u
cd /root/fx-replay-lab
LOG=/tmp/fxpos.log
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
  if (r.result?.exceptionDetails) return { EXC: r.result.exceptionDetails.exception?.description?.slice(0, 600) };
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(3600);

const hook = await evalJs(`JSON.stringify({
  present: typeof window.__fxlab === 'object',
  search: window.location.search,
})`);
console.log("HOOK:", hook);
if (typeof hook === "string" && hook.includes('"present":false')) {
  console.log("FAIL: test hook not installed — the engine cannot be asserted directly");
}

console.log("1. OPEN POSITION:", await evalJs(`(async () => {
  [...document.querySelectorAll('.rail-tab')].find(t=>t.textContent.trim()==='trade').click();
  await new Promise(r=>setTimeout(r,500));
  const setv = (name, v) => {
    const lab = [...document.querySelectorAll('.order-form label')]
      .find(l => l.textContent.trim().toLowerCase().startsWith(name));
    const el = lab.querySelector('input,select');
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  setv('lots', '0.10'); setv('sl', '20'); setv('tp', '40');
  await new Promise(r=>setTimeout(r,250));
  [...document.querySelectorAll('.trade-panel button')].find(b=>b.textContent.includes('Buy')).click();
  await new Promise(r=>setTimeout(r,600));
  return JSON.stringify(window.__fxlab.state());
})()`));

console.log("2. LINES PAINTED:", await evalJs(`(async () => {
  const c = document.querySelector('.draw-canvas');
  const ctx = c.getContext('2d');
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let red = 0, green = 0, total = 0;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i+3];
    if (a > 8) total++;
    if (a > 40 && d[i] > 180 && d[i+1] < 120) red++;
    if (a > 40 && d[i+1] > 140 && d[i] < 130) green++;
  }
  return JSON.stringify({ paintedPixels: total, stopLinePixels: red, targetLinePixels: green });
})()`));

console.log("3. REAL DRAG ON THE SL LINE:", await evalJs(`(async () => {
  const H = window.__fxlab;
  const st = H.state();
  const pos = st.positions[0];
  if (!pos) return 'no position';
  const c = document.querySelector('.draw-canvas');
  const rect = c.getBoundingClientRect();
  const ySL = H.priceToY(pos.sl);
  const yNew = H.priceToY(pos.sl - 5);      // drag 5 points lower
  if (ySL === null || yNew === null) return 'no coordinate mapping';

  const ev = (t, x, y, b) => c.dispatchEvent(new PointerEvent(t, {
    bubbles: true, clientX: rect.left + x, clientY: rect.top + y,
    pointerId: 1, button: 0, buttons: b,
  }));
  const x = rect.width * 0.5;
  ev('pointerdown', x, ySL, 1);
  ev('pointermove', x, ySL + (yNew - ySL) * 0.5, 1);
  ev('pointermove', x, yNew, 1);
  ev('pointerup', x, yNew, 0);
  await new Promise(r=>setTimeout(r,500));
  const after = H.state().positions[0];
  return JSON.stringify({
    before: pos.sl, after: after?.sl,
    moved: after?.sl !== pos.sl,
    lower: (after?.sl ?? 0) < pos.sl,
  });
})()`));

console.log("4. DRAG ACROSS THE ENTRY IS REFUSED:", await evalJs(`(async () => {
  const H = window.__fxlab;
  const pos = H.state().positions[0];
  const c = document.querySelector('.draw-canvas');
  const rect = c.getBoundingClientRect();
  const ySL = H.priceToY(pos.sl);
  const yAbove = H.priceToY(pos.entryPrice + 5);   // ABOVE the entry: illegal
  const ev = (t, x, y, b) => c.dispatchEvent(new PointerEvent(t, {
    bubbles: true, clientX: rect.left + x, clientY: rect.top + y,
    pointerId: 1, button: 0, buttons: b,
  }));
  const x = rect.width * 0.5;
  ev('pointerdown', x, ySL, 1);
  ev('pointermove', x, yAbove, 1);
  ev('pointerup', x, yAbove, 0);
  await new Promise(r=>setTimeout(r,500));

  const after = H.state().positions[0];
  const msg = document.querySelector('.status-warn')?.textContent ?? '';
  // also assert the API refusal directly
  const api = H.setLevel(pos.id, 'sl', pos.entryPrice + 5);
  return JSON.stringify({
    slBefore: pos.sl, slAfter: after?.sl,
    unchanged: after?.sl === pos.sl,
    apiRefused: api.ok === false,
    apiReason: api.message,
    uiMessage: msg.slice(0, 90),
  });
})()`));

console.log("5. AUTO BREAK-EVEN:", await evalJs(`(async () => {
  const H = window.__fxlab;
  const beRow = document.querySelector('.be-row');
  const beInput = beRow ? beRow.querySelector('input') : null;

  // Set the trigger through a real React input event so the UI path is exercised too.
  if (beInput) {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
      .set.call(beInput, '0.2');
    beInput.dispatchEvent(new Event('input', { bubbles: true }));
  }
  await new Promise(r=>setTimeout(r,500));

  const step = [...document.querySelectorAll('header button')].find(b=>b.textContent.includes('Step'));
  for (let i = 0; i < 90; i++) { step.click(); await new Promise(r=>setTimeout(r,35)); }
  await new Promise(r=>setTimeout(r,800));

  const st = H.state();
  const pos = st.positions[0];
  const movedFromOriginal = pos ? pos.sl !== 1966.91 : null;
  return JSON.stringify({
    beControlPresent: !!beInput,
    beInputValue: beInput?.value,
    stillOpen: !!pos,
    entry: pos?.entryPrice, sl: pos?.sl,
    slMovedTowardEntry: pos ? (pos.side === 'buy' ? pos.sl > 1966.91 : pos.sl < 1966.91) : null,
    slAtOrAboveEntry: pos ? (pos.side === 'buy' ? pos.sl >= pos.entryPrice : pos.sl <= pos.entryPrice) : null,
    tradesClosed: st.positions.length === 0,
  });
})()`));

const shot = await send("Page.captureScreenshot", { format: "png" });
if (shot.result?.data) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync("/tmp/fx-posmanage.png", Buffer.from(shot.result.data, "base64"));
  console.log("screenshot /tmp/fx-posmanage.png");
}
ws.close();
JS

echo "=== errors ==="
grep -iE "\b(error|exception|uncaught)\b" "$LOG" \
  | grep -viE "bus\.cc|gpu|vulkan|libva|gbm|dri3|MESA|fontconfig|sandbox|X11|NODE_OPTION|sqlite-error|bind\(\) failed" | head -6 || echo "  (none)"

kill -9 $APP 2>/dev/null; wait $APP 2>/dev/null
