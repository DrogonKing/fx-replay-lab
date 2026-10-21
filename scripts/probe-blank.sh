#!/usr/bin/env bash
set -u
cd /root/fx-replay-lab
LOG=/tmp/fxblank.log
: > "$LOG"
export NODE_OPTIONS="--max-old-space-size=1600"
pkill -9 -f "fx-replay-lab/node_modules/electron" 2>/dev/null
sleep 1
PORT=$(( 9700 + RANDOM % 90 ))
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
let seq = 1; const pending = new Map(); const logs = [];
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === "Runtime.consoleAPICalled") {
    logs.push("CONSOLE " + m.params.type + ": " + m.params.args.map(a => a.value ?? a.description ?? "").join(" ").slice(0, 300));
  }
  if (m.method === "Runtime.exceptionThrown") {
    logs.push("EXCEPTION: " + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).slice(0, 500));
  }
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
await sleep(4000);

console.log("BEFORE:", await evalJs(`JSON.stringify({
  root: document.getElementById('root')?.children.length,
  start: !!document.querySelector('[data-panel="start"]'),
})`));

console.log("CLICK LIVE:", await evalJs(`(async () => {
  document.querySelector('[data-mode="live"]')?.click();
  await new Promise(r => setTimeout(r, 300));
  document.querySelector('[data-action="start-go"]')?.click();
  return 'clicked';
})()`));

await sleep(9000);
console.log("AFTER 9s:", await evalJs(`JSON.stringify({
  root: document.getElementById('root')?.children.length,
  start: !!document.querySelector('[data-panel="start"]'),
  app: !!document.querySelector('.app'),
  html: document.getElementById('root')?.innerHTML.slice(0, 200),
})`));

console.log("--- console/exceptions ---");
for (const l of logs.slice(-25)) console.log(l);
ws.close();
JS
kill -9 $APP 2>/dev/null; wait $APP 2>/dev/null
