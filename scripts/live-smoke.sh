#!/usr/bin/env bash
# Drive the running app through CDP: click the LIVE toggle, load real Yahoo data,
# run a backtest from the UI, and screenshot the result.
#
# This is the only test that proves the online path end-to-end: it goes through
# the real renderer, the real IPC bridge, the real CSP, and the real network.
set -u
cd /root/fx-replay-lab
OUT="${1:-/tmp/fx-live.png}"
LOG=/tmp/fxlive.log
: > "$LOG"
export NODE_OPTIONS="--max-old-space-size=1600"

timeout 120 xvfb-run -a --server-args="-screen 0 1600x1000x24" \
  npx electron . --no-sandbox --remote-debugging-port=9225 \
  >> "$LOG" 2>&1 &
APP_PID=$!

for i in $(seq 1 40); do
  curl -s --max-time 1 http://127.0.0.1:9225/json/version >/dev/null 2>&1 && break
  kill -0 "$APP_PID" 2>/dev/null || { echo "app died"; tail -25 "$LOG"; exit 1; }
  sleep 1
done

node --input-type=module - "$OUT" <<'JS'
import { writeFileSync } from "node:fs";
const out = process.argv[2];
const list = await (await fetch("http://127.0.0.1:9225/json/list")).json();
const page = list.find((t) => t.type === "page");
if (!page) { console.error("no page target"); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 1;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) =>
  new Promise((res) => { const id = seq++; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });

await new Promise((r) => ws.addEventListener("open", r));
await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });

const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.text };
  return r.result?.result?.value;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(2500);

// 1. Confirm the bridge exists and the live toggle is present.
const before = await evalJs(`JSON.stringify({
  bridge: typeof window.fxlab?.fetchJson === "function",
  badge: document.querySelector(".badge")?.textContent,
  tabs: [...document.querySelectorAll(".rail-tab")].map(b => b.textContent),
})`);
console.log("BEFORE:", before);

// 2. Turn LIVE on and load real data through the real IPC + network.
const liveResult = await evalJs(`(async () => {
  const cb = document.querySelector('.switch-row input[type=checkbox]');
  if (!cb) return "no toggle";
  cb.click();
  await new Promise(r => setTimeout(r, 200));
  const btn = [...document.querySelectorAll('.data-panel button')].find(b => b.textContent.includes('Reload'));
  if (!btn) return "no reload button";
  btn.click();
  // the fetch is real: wait for it
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    const badge = document.querySelector('.badge')?.textContent || '';
    const note = document.querySelector('.status-note')?.textContent || '';
    const status = document.querySelector('.status')?.textContent || '';
    if (status && !status.includes('turning')) return JSON.stringify({ badge, note, status });
  }
  const note = document.querySelector('.status-note')?.textContent || '';
  const status = document.querySelector('.status')?.textContent || '';
  return JSON.stringify({ timeout: true, note, status });
})()`);
console.log("LIVE:", liveResult);

await sleep(1500);

// 3. Go to the strategy tab and run a backtest from the UI.
// Wait until the replay counter reflects the loaded series: clicking Run before
// React commits the new series makes the panel backtest stale data and report
// "0 trades", which looks like an engine bug but is a race in the test.
const bt = await evalJs(`(async () => {
  const tabs = [...document.querySelectorAll('.rail-tab')];
  const strat = tabs.find(t => t.textContent.toLowerCase() === 'strategy');
  if (!strat) return "no strategy tab";
  strat.click();
  await new Promise(r => setTimeout(r, 600));

  // wait for the panel to receive the full series
  for (let i = 0; i < 40; i++) {
    const kvs = [...document.querySelectorAll('.kv')].map(k => k.textContent);
    const base = kvs.find(k => k.startsWith('base bars'));
    if (base && !base.includes('30,000')) break;
    await new Promise(r => setTimeout(r, 250));
  }
  await new Promise(r => setTimeout(r, 400));
  const run = [...document.querySelectorAll('.strategy-panel button')].find(b => b.textContent.includes('Run'));
  if (!run) return "no run button";
  run.click();
  await new Promise(r => setTimeout(r, 3000));
  const pairs = [...document.querySelectorAll('.stats .kv')].map(kv => kv.textContent);
  return JSON.stringify({
    rows: pairs.length,
    pairs: pairs.slice(0, 6),
    msg: document.querySelector('.strategy-panel .row .msg')?.textContent,
    errs: [...document.querySelectorAll('.strategy-panel .errors li')].map(e => e.textContent),
    baseBars: [...document.querySelectorAll('.kv')].map(k => k.textContent).find(k => k.startsWith('base bars')),
    revealed: [...document.querySelectorAll('.kv')].map(k => k.textContent).find(k => k.startsWith('revealed')),
  });
})()`);
console.log("BACKTEST:", bt);

await sleep(800);

// 4. Screenshot whatever state it ended in.
const shot = await send("Page.captureScreenshot", { format: "png" });
if (shot.result?.data) {
  writeFileSync(out, Buffer.from(shot.result.data, "base64"));
  console.log("saved", out);
}
ws.close();
JS

RC=$?
echo "=== app errors ==="
grep -iE "error|exception|failed|refused|CSP" "$LOG" \
  | grep -viE "bus\.cc|gpu|vulkan|libva|gbm|dri3|MESA|fontconfig|sandbox" | head -12 || echo "  (none)"
kill "$APP_PID" 2>/dev/null
wait "$APP_PID" 2>/dev/null
exit $RC
