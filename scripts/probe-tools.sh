#!/usr/bin/env bash
set -u
cd /root/fx-replay-lab
LOG=/tmp/fxprobe.log
: > "$LOG"
export NODE_OPTIONS="--max-old-space-size=1600"
pkill -9 -f "fx-replay-lab/node_modules/electron" 2>/dev/null
sleep 1
PORT=$(( 9800 + RANDOM % 90 ))
timeout 150 xvfb-run -a --server-args="-screen 0 1700x1050x24" \
  npx electron . --no-sandbox --remote-debugging-port=$PORT --fx-test >> "$LOG" 2>&1 &
APP=$!
for i in $(seq 1 45); do
  curl -s --max-time 1 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1 && break
  sleep 1
done
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
  if (r.result?.exceptionDetails) return { EXC: r.result.exceptionDetails.exception?.description?.slice(0, 300) };
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(4000);

console.log("A. before any click:", await evalJs(`JSON.stringify({
  groups: document.querySelectorAll('[data-group]').length,
  flyouts: document.querySelectorAll('.tool-flyout').length,
})`));

console.log("B. click Lines once:", await evalJs(`(async () => {
  const lines = [...document.querySelectorAll('[data-group]')].find(b => b.getAttribute('data-group') === 'Lines');
  lines.click();
  await new Promise(r => setTimeout(r, 600));
  return JSON.stringify({
    flyouts: document.querySelectorAll('.tool-flyout').length,
    items: document.querySelectorAll('[data-tool-item]').length,
    gears: document.querySelectorAll('.fi-gear').length,
    gearKinds: [...document.querySelectorAll('.fi-gear')].map(b => b.getAttribute('data-settings')).slice(0,5),
    firstItemKinds: [...document.querySelectorAll('[data-tool-item]')].map(b => b.getAttribute('data-tool-item')).slice(0,5),
  });
})()`));

console.log("C. click gear:", await evalJs(`(async () => {
  const g = document.querySelector('[data-settings="trendline"]');
  if (!g) return 'still no gear; html sample: ' + (document.querySelector('.tool-flyout')?.innerHTML ?? 'none').slice(0,300);
  g.click();
  await new Promise(r => setTimeout(r, 600));
  return JSON.stringify({
    panel: !!document.querySelector('[data-panel="tool-settings"]'),
    kind: document.querySelector('[data-panel="tool-settings"]')?.getAttribute('data-kind'),
  });
})()`));

ws.close();
JS
kill -9 $APP 2>/dev/null; wait $APP 2>/dev/null
