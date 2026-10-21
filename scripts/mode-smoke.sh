#!/usr/bin/env bash
# Prove the start screen, live polling and replay both work against the real provider.
set -u
cd /root/fx-replay-lab
LOG=/tmp/fxmode.log
: > "$LOG"
export NODE_OPTIONS="--max-old-space-size=1600"

pkill -9 -f "fx-replay-lab/node_modules/electron" 2>/dev/null
sleep 1
PORT=$(( 9600 + RANDOM % 150 ))

timeout 200 xvfb-run -a --server-args="-screen 0 1700x1050x24" \
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

console.log("1. START SCREEN SHOWS TWO MODES:", await evalJs(`JSON.stringify({
  shown: !!document.querySelector('[data-panel="start"]'),
  modes: [...document.querySelectorAll('[data-mode]')].map(b => b.getAttribute('data-mode')),
  intervals: [...document.querySelectorAll('[data-interval]')].map(b => b.getAttribute('data-interval')),
  foot: document.querySelector('.start-foot')?.textContent?.slice(0, 60),
})`));

console.log("2. YEAR LIST REFUSES WHAT THE PROVIDER CANNOT SERVE:", await evalJs(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  // 5m: 60 days only, so this year is the only option
  document.querySelector('[data-interval="5"]')?.click();
  await wait(400);
  const y5 = [...document.querySelectorAll('[data-field="start-year"] option')].map(o => o.value);
  const avail5 = document.querySelector('[data-note="start-availability"]')?.getAttribute('data-verdict');

  // 1D: decades
  document.querySelector('[data-interval="1440"]')?.click();
  await wait(400);
  const y1d = [...document.querySelectorAll('[data-field="start-year"] option')].map(o => o.value);

  // 1m: 7 days, so nothing meaningful to replay
  document.querySelector('[data-interval="1"]')?.click();
  await wait(400);
  const avail1 = document.querySelector('[data-note="start-availability"]')?.getAttribute('data-verdict');
  const goDisabled = document.querySelector('[data-action="start-go"]')?.disabled;

  return JSON.stringify({
    years5m: y5, avail5m: avail5,
    years1d_count: y1d.length, years1d_has2019: y1d.includes('2019'),
    avail1m: avail1, goDisabledOn1m: goDisabled,
  });
})()`));

console.log("3. PICKING AN OLD YEAR IS CLAMPED, NOT SILENTLY EMPTY:", await evalJs(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  document.querySelector('[data-interval="5"]')?.click();
  await wait(300);
  // force the year select to an old value the picker does not offer
  const sel = document.querySelector('[data-field="start-year"]');
  const set = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
  set.call(sel, '2019');
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(500);
  return JSON.stringify({
    note: document.querySelector('[data-note="start-availability"]')?.textContent?.slice(0, 110),
    verdict: document.querySelector('[data-note="start-availability"]')?.getAttribute('data-verdict'),
  });
})()`));

console.log("4. LIVE MODE LOADS REAL BARS:", await evalJs(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  document.querySelector('[data-mode="live"]')?.click();
  await wait(300);
  document.querySelector('[data-interval="5"]')?.click();
  await wait(200);
  document.querySelector('[data-action="start-go"]')?.click();
  await wait(11000);

  const start = document.querySelector('[data-panel="start"]');
  const status = document.querySelector('.status')?.textContent ?? '';
  const rootKids = document.getElementById('root')?.children.length ?? 0;
  return JSON.stringify({
    startGone: !start,
    // a crashed renderer empties #root; without this the test reads as "no chart" and the
    // real cause stays hidden
    rendererAlive: rootKids > 0,
    status: status.slice(0, 110),
    hasChart: !!document.querySelector('.chart-host'),
    liveBadge: [...document.querySelectorAll('.badge')].map(b => b.textContent).join(','),
  });
})()`));

console.log("5. POLL IS IDEMPOTENT AND DOES NOT DUPLICATE BARS:", await evalJs(`(async () => {
  // A 5-minute bar cannot close inside a 20-second test, so "did the legend change" proves
  // nothing. What matters is that repeated polls MERGE rather than append: a duplicate bar
  // would be processed twice, charging commission and swap twice.
  const barCount = () =>
    Number(document.querySelector('[data-bars]')?.getAttribute('data-bars') ?? -1);
  const before = barCount();

  // wait for at least two poll cycles (pollSeconds is 15 by default)
  await new Promise(r => setTimeout(r, 34000));
  const after = barCount();

  return JSON.stringify({
    barsBefore: before,
    barsAfter: after,
    // a duplicate bar from a repeated poll would show as a jump of more than one
    grewByAtMostOne: after - before <= 1,
    mode: document.querySelector('[data-mode]')?.getAttribute('data-mode'),
    rendererAlive: (document.getElementById('root')?.children.length ?? 0) > 0,
  });
})()`));

const shot = await send("Page.captureScreenshot", { format: "png" });
if (shot.result?.data) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync("/tmp/fx-live.png", Buffer.from(shot.result.data, "base64"));
  console.log("screenshot /tmp/fx-live.png");
}
ws.close();
JS

echo "=== errors ==="
grep -iE "\b(error|exception|uncaught)\b" "$LOG" \
  | grep -viE "bus\.cc|gpu|vulkan|libva|gbm|dri3|MESA|fontconfig|sandbox|X11|NODE_OPTION|sqlite-error" | head -6 || echo "  (none)"

kill -9 $APP 2>/dev/null; wait $APP 2>/dev/null
