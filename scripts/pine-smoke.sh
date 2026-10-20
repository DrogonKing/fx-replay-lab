#!/usr/bin/env bash
# Verify the Pine tab runs inside the real app (parse + evaluate over IPC).
set -u
cd /root/fx-replay-lab
LOG=/tmp/fxpine.log
: > "$LOG"

timeout 120 xvfb-run -a --server-args="-screen 0 1600x1000x24" \
  npx electron . --no-sandbox --remote-debugging-port=9227 >> "$LOG" 2>&1 &
APP_PID=$!
for i in $(seq 1 40); do
  curl -s --max-time 1 http://127.0.0.1:9227/json/version >/dev/null 2>&1 && break
  sleep 1
done

node --input-type=module <<'JS'
const list = await (await fetch("http://127.0.0.1:9227/json/list")).json();
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
await sleep(2500);

console.log("PINE:", await evalJs(`(async () => {
  [...document.querySelectorAll('.rail-tab')].find(t=>t.textContent.toLowerCase()==='strategy').click();
  await new Promise(r=>setTimeout(r,500));
  const pineTab = [...document.querySelectorAll('.strategy-panel .tab')].find(t=>t.textContent.trim()==='pine');
  if (!pineTab) return 'no pine tab';
  pineTab.click();
  await new Promise(r=>setTimeout(r,400));
  const run = [...document.querySelectorAll('.strategy-panel button')].find(b=>b.textContent.includes('Compile'));
  run.click();
  await new Promise(r=>setTimeout(r,3000));
  return JSON.stringify({
    msg: document.querySelector('.strategy-panel .row .msg')?.textContent,
    errs: [...document.querySelectorAll('.strategy-panel .errors li')].map(e=>e.textContent).slice(0,3),
  });
})()`));

// also verify a Pine script that is deliberately wrong reports a precise error
console.log("BAD_PINE:", await evalJs(`(async () => {
  const ta = document.querySelector('.strategy-panel .code');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, '//@version=5\\nindicator("bad")\\nx = ta.notReal(close, 14)\\nplot(x)');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r=>setTimeout(r,300));
  const run = [...document.querySelectorAll('.strategy-panel button')].find(b=>b.textContent.includes('Compile'));
  run.click();
  await new Promise(r=>setTimeout(r,2500));
  return JSON.stringify({
    msg: document.querySelector('.strategy-panel .row .msg')?.textContent,
    errs: [...document.querySelectorAll('.strategy-panel .errors li')].map(e=>e.textContent).slice(0,2),
  });
})()`));

ws.close();
JS

kill "$APP_PID" 2>/dev/null; wait "$APP_PID" 2>/dev/null
