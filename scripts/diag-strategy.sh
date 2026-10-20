#!/usr/bin/env bash
# Diagnose the strategy panel inside the real app: report the series length the
# panel received, the message text, and any errors it rendered.
set -u
cd /root/fx-replay-lab
LOG=/tmp/fxdiag.log
: > "$LOG"

timeout 120 xvfb-run -a --server-args="-screen 0 1600x1000x24" \
  npx electron . --no-sandbox --remote-debugging-port=9226 >> "$LOG" 2>&1 &
APP_PID=$!

for i in $(seq 1 40); do
  curl -s --max-time 1 http://127.0.0.1:9226/json/version >/dev/null 2>&1 && break
  sleep 1
done

node --input-type=module <<'JS'
const list = await (await fetch("http://127.0.0.1:9226/json/list")).json();
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
  if (r.result?.exceptionDetails) return { EXC: r.result.exceptionDetails.text,
    detail: r.result.exceptionDetails.exception?.description?.slice(0, 400) };
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(2500);

// First load LIVE data so the strategy runs against real bars, not the sample.
console.log("LIVE:", await evalJs(`(async () => {
  const cb = document.querySelector('.switch-row input[type=checkbox]');
  cb.click();
  await new Promise(r=>setTimeout(r,200));
  const btn = [...document.querySelectorAll('.data-panel button')].find(b=>b.textContent.includes('Reload'));
  btn.click();
  for (let i=0;i<60;i++){
    await new Promise(r=>setTimeout(r,500));
    const s = document.querySelector('.status')?.textContent || '';
    if (s.includes('Live') || s.includes('error') || s.includes('failed')) return s;
  }
  return 'timeout';
})()`));

// go to strategy tab and report what the panel has
console.log("TAB:", await evalJs(`(async () => {
  [...document.querySelectorAll('.rail-tab')].find(t => t.textContent.toLowerCase()==='strategy').click();
  await new Promise(r=>setTimeout(r,600));
  const ta = document.querySelector('.strategy-panel .code');
  return JSON.stringify({
    codeLen: ta ? ta.value.length : -1,
    codeHead: ta ? ta.value.slice(0, 60) : null,
  });
})()`));

// run and then dump msg + errors + stats
console.log("RUN:", await evalJs(`(async () => {
  const run = [...document.querySelectorAll('.strategy-panel button')].find(b => b.textContent.includes('Run'));
  run.click();
  await new Promise(r=>setTimeout(r,2500));
  const msg = document.querySelector('.strategy-panel .row .msg')?.textContent;
  const errs = [...document.querySelectorAll('.strategy-panel .errors li')].map(e=>e.textContent);
  const stats = [...document.querySelectorAll('.stats .kv')].map(kv=>kv.textContent);
  return JSON.stringify({ msg, errs, statsHead: stats.slice(0,4), statCount: stats.length });
})()`));

// probe: what does the panel actually receive? read the legend + replay numbers
console.log("STATE:", await evalJs(`JSON.stringify({
  badge: document.querySelector('.badge')?.textContent,
  kv: [...document.querySelectorAll('.kv')].map(k=>k.textContent).slice(0,8),
})`));

ws.close();
JS

kill "$APP_PID" 2>/dev/null; wait "$APP_PID" 2>/dev/null
