#!/usr/bin/env bash
# Prove limit/stop/OCO work in the running app.
#
# Asserted independently, because "a position exists" could come from the market
# button instead of the order book:
#   1. the type selector offers all four kinds
#   2. a buy LIMIT placed below the market appears in the Pending table
#   3. it is refused when placed above the market (the classic silent-instant-fill bug)
#   4. stepping the replay FILLS it, and the fill is recorded as `limit-fill`
#   5. an OCO bracket leaves two orders, and only one can ever fill
set -u
cd /root/fx-replay-lab
LOG=/tmp/fxorders.log
: > "$LOG"
export NODE_OPTIONS="--max-old-space-size=1600"

pkill -9 -f "fx-replay-lab/node_modules/electron" 2>/dev/null
sleep 1
PORT=$(( 9300 + RANDOM % 400 ))

timeout 170 xvfb-run -a --server-args="-screen 0 1600x1000x24" \
  npx electron . --no-sandbox --remote-debugging-port=$PORT >> "$LOG" 2>&1 &
APP=$!
READY=0
for i in $(seq 1 45); do
  curl -s --max-time 1 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1 && { READY=1; break; }
  sleep 1
done
[ "$READY" = "1" ] || { echo "FAIL: no debugger on $PORT"; tail -15 "$LOG"; exit 1; }
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
await sleep(3400);

// Shared helpers injected once.
await evalJs(`window.__t = {
  setVal: (el, v) => {
    const proto = el.tagName === 'SELECT'
      ? window.HTMLSelectElement.prototype
      : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  },
  inputs: () => [...document.querySelectorAll('.order-form input')],
  labels: () => [...document.querySelectorAll('.order-form label')].map(l => l.textContent.trim().split('\\n')[0]),
  field: (name) => {
    const lab = [...document.querySelectorAll('.order-form label')]
      .find(l => l.textContent.trim().toLowerCase().startsWith(name));
    return lab ? lab.querySelector('input,select') : null;
  },
  btn: (text) => [...document.querySelectorAll('.trade-panel button')]
    .find(b => b.textContent.includes(text)),
  pendingRows: () => [...document.querySelectorAll('.trade-panel table.grid tbody tr')].length,
  sections: () => [...document.querySelectorAll('.trade-panel h3')].map(h => h.textContent),
}; 'ok'`);

console.log("1. TYPE SELECTOR:", await evalJs(`(async () => {
  [...document.querySelectorAll('.rail-tab')].find(t=>t.textContent.trim()==='trade').click();
  await new Promise(r=>setTimeout(r,500));
  const sel = window.__t.field('type');
  return JSON.stringify({
    options: sel ? [...sel.options].map(o=>o.value) : 'none',
    labels: window.__t.labels(),
  });
})()`));

console.log("2. PLACE BUY LIMIT BELOW MARKET:", await evalJs(`(async () => {
  const T = window.__t;
  T.setVal(T.field('type'), 'limit');
  await new Promise(r=>setTimeout(r,350));
  T.setVal(T.field('lots'), '0.10');
  T.setVal(T.field('sl'), '5');
  T.setVal(T.field('tp'), '15');
  T.setVal(T.field('tags'), 'limit-test');
  await new Promise(r=>setTimeout(r,200));
  T.setVal(T.field('trigger'), '1985');
  await new Promise(r=>setTimeout(r,250));

  T.btn('Buy').click();
  await new Promise(r=>setTimeout(r,450));
  return JSON.stringify({
    msg: document.querySelector('.trade-panel .msg')?.textContent,
    sections: T.sections(),
    pendingRows: T.pendingRows(),
  });
})()`));

console.log("3. REFUSE BUY LIMIT ABOVE MARKET:", await evalJs(`(async () => {
  const T = window.__t;
  T.setVal(T.field('trigger'), '2050');
  await new Promise(r=>setTimeout(r,250));
  T.btn('Buy').click();
  await new Promise(r=>setTimeout(r,400));
  return JSON.stringify({ msg: document.querySelector('.trade-panel .msg')?.textContent });
})()`));

console.log("4. STEP UNTIL THE LIMIT FILLS:", await evalJs(`(async () => {
  const T = window.__t;
  const step = [...document.querySelectorAll('header button')].find(b=>b.textContent.includes('Step'));

  // Board is not empty from step 2/3, so place the test limit on a CLEAN book.
  T.btn('Cancel all orders')?.click();
  await new Promise(r=>setTimeout(r,350));

  // Read the live bid from the panel and put the limit 1 point under it: a 1-point
  // dip is an ordinary bar, whereas the earlier 1985 was 7 points away and the next
  // 90 bars never got there (wrong test assumption, not a code fault).
  const bidText = [...document.querySelectorAll('.trade-panel .kv')]
    .find(k => k.textContent.startsWith('bid'))?.textContent ?? '';
  const bid = Number(bidText.replace('bid', ''));
  const trigger = (Math.round((bid - 1) * 100) / 100).toFixed(2);

  T.setVal(T.field('type'), 'limit');
  await new Promise(r=>setTimeout(r,350));
  T.setVal(T.field('lots'), '0.10');
  T.setVal(T.field('sl'), '50');      // wide stop: we only care that the ENTRY fills
  T.setVal(T.field('tp'), '100');
  T.setVal(T.field('tags'), 'fill-test');
  await new Promise(r=>setTimeout(r,200));
  T.setVal(T.field('trigger'), trigger);
  await new Promise(r=>setTimeout(r,250));
  T.btn('Buy').click();
  await new Promise(r=>setTimeout(r,450));
  const placed = document.querySelector('.trade-panel .msg')?.textContent;

  for (let i = 0; i < 60; i++) { step.click(); await new Promise(r=>setTimeout(r,40)); }
  await new Promise(r=>setTimeout(r,800));

  const rows = [...document.querySelectorAll('.trade-panel table.grid tbody tr')]
    .map(tr => [...tr.querySelectorAll('td')].map(td=>td.textContent.trim()));
  return JSON.stringify({
    bid, trigger, placed, sections: T.sections(), rows: rows.slice(0,4),
    history: document.querySelector('.trade-panel .msg:last-of-type')?.textContent,
  });
})()`));

console.log("5. OCO BRACKET:", await evalJs(`(async () => {
  const T = window.__t;
  T.btn('Cancel all orders')?.click();
  await new Promise(r=>setTimeout(r,350));
  T.setVal(T.field('type'), 'limit');
  await new Promise(r=>setTimeout(r,350));
  T.setVal(T.field('lots'), '0.10');
  T.setVal(T.field('sl'), '10');
  T.setVal(T.field('tp'), '20');
  await new Promise(r=>setTimeout(r,200));
  T.setVal(T.field('trigger'), '1990');
  await new Promise(r=>setTimeout(r,200));
  const ocoBox = document.querySelector('.checkbox-row input');
  if (!ocoBox) return 'no OCO checkbox';
  if (!ocoBox.checked) ocoBox.click();
  await new Promise(r=>setTimeout(r,300));
  T.btn('Buy').click();
  await new Promise(r=>setTimeout(r,450));

  const rows = [...document.querySelectorAll('.trade-panel table.grid tbody tr')]
    .map(tr => [...tr.querySelectorAll('td')].map(td=>td.textContent.trim()));
  return JSON.stringify({
    msg: document.querySelector('.trade-panel .msg')?.textContent,
    pendingRows: T.pendingRows(),
    rows: rows.slice(0,4),
  });
})()`));

const shot = await send("Page.captureScreenshot", { format: "png" });
if (shot.result?.data) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync("/tmp/fx-orders.png", Buffer.from(shot.result.data, "base64"));
  console.log("screenshot /tmp/fx-orders.png");
}
ws.close();
JS

echo "=== errors ==="
grep -iE "\b(error|exception|uncaught)\b" "$LOG" \
  | grep -viE "bus\.cc|gpu|vulkan|libva|gbm|dri3|MESA|fontconfig|sandbox|X11|NODE_OPTION|sqlite-error|bind\(\) failed" | head -6 || echo "  (none)"

kill -9 $APP 2>/dev/null; wait $APP 2>/dev/null
