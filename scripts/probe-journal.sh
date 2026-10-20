#!/usr/bin/env bash
# Find where the closed trade is lost: engine -> pending buffer -> journal panel.
set -u
cd /root/fx-replay-lab
LOG=/tmp/fxprobe2.log
: > "$LOG"

timeout 140 xvfb-run -a --server-args="-screen 0 1600x1000x24" \
  npx electron . --no-sandbox --remote-debugging-port=9262 >> "$LOG" 2>&1 &
APP=$!
for i in $(seq 1 45); do
  curl -s --max-time 1 http://127.0.0.1:9262/json/version >/dev/null 2>&1 && break
  sleep 1
done

node --input-type=module <<'JS'
const list = await (await fetch("http://127.0.0.1:9262/json/list")).json();
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
await sleep(3400);

// React internals are not reachable, so instrument the observable path instead:
// watch for the journal panel's DOM and the sqlite bridge directly.

console.log("1. place a trade and step:");
console.log(await evalJs(`(async () => {
  [...document.querySelectorAll('.rail-tab')].find(t=>t.textContent.trim()==='trade').click();
  await new Promise(r=>setTimeout(r,400));
  const inputs = [...document.querySelectorAll('.order-form input')];
  const setVal = (el, v) => {
    const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  setVal(inputs[0], '0.10'); setVal(inputs[1], '1'); setVal(inputs[2], '50'); setVal(inputs[3], 'probe');
  await new Promise(r=>setTimeout(r,300));
  [...document.querySelectorAll('.trade-panel button')].find(b=>b.textContent.includes('Buy')).click();
  await new Promise(r=>setTimeout(r,300));
  const openRows = document.querySelectorAll('.trade-panel table.grid tbody tr').length;

  const step = [...document.querySelectorAll('header button')].find(b=>b.textContent.includes('Step'));
  for (let i = 0; i < 40; i++) { step.click(); await new Promise(r=>setTimeout(r,45)); }
  await new Promise(r=>setTimeout(r,600));

  const closedTables = [...document.querySelectorAll('.trade-panel h3')].map(h=>h.textContent);
  return JSON.stringify({ openRows, sections: closedTables });
})()`));

console.log("2. what does the DB bridge return for the journal right now?");
console.log(await evalJs(`window.fxlab.loadJournal().then(r => JSON.stringify({
  count: r.value.length, rejected: r.rejected
}))`));

console.log("3. open the journal tab, wait, check DOM + db again:");
console.log(await evalJs(`(async () => {
  [...document.querySelectorAll('.rail-tab')].find(t=>t.textContent.trim()==='journal').click();
  await new Promise(r=>setTimeout(r,2500));
  const rows = document.querySelectorAll('.journal-panel table.grid tbody tr').length;
  const bodyText = (document.querySelector('.journal-panel')?.innerText || '').slice(0, 200);
  const db = await window.fxlab.loadJournal();
  return JSON.stringify({ domRows: rows, dbCount: db.value.length, text: bodyText.replace(/\\n/g,' | ') });
})()`));

console.log("4. is the session holding pending entries we cannot see? check via a fresh save:");
console.log(await evalJs(`(async () => {
  // force the journal panel to re-drain by remounting it
  [...document.querySelectorAll('.rail-tab')].find(t=>t.textContent.trim()==='data').click();
  await new Promise(r=>setTimeout(r,300));
  [...document.querySelectorAll('.rail-tab')].find(t=>t.textContent.trim()==='journal').click();
  await new Promise(r=>setTimeout(r,2000));
  const rows = document.querySelectorAll('.journal-panel table.grid tbody tr').length;
  const db = await window.fxlab.loadJournal();
  return JSON.stringify({ domRowsAfterRemount: rows, dbCount: db.value.length });
})()`));

ws.close();
JS

kill -9 $APP 2>/dev/null; wait $APP 2>/dev/null
grep -iE "cannot|undefined|error|exception" "$LOG" | grep -viE "bus\.cc|gpu|vulkan|libva|gbm|dri3|MESA|fontconfig|sandbox|X11|NODE_OPTION|sqlite-error|bind\(\)" | head -6
