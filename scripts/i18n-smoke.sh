#!/usr/bin/env bash
# Prove Persian + RTL in the running app:
#   1. switching the language flips <html dir> and lang
#   2. the toolbar, tabs and every panel render Persian, not English
#   3. the layout actually mirrors (panel on the physical left, rail on the right)
#   4. numbers stay LATIN and LTR — a mirrored price is a bug, not a translation
#   5. the choice survives a reload
set -u
cd /root/fx-replay-lab
LOG=/tmp/fxi18n.log
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

const hasPersian = `(s) => /[\\u0600-\\u06FF]/.test(s)`;

console.log("1. DEFAULT + SWITCH TO PERSIAN:", await evalJs(`(async () => {
  const before = {
    dir: document.documentElement.dir,
    lang: document.documentElement.lang,
    brandTabs: [...document.querySelectorAll('.rail-tab')].map(b=>b.textContent.trim()),
  };

  // the language select is the one whose options include 'فارسی'
  const sel = [...document.querySelectorAll('header select')]
    .find(s => [...s.options].some(o => o.textContent.includes('فارسی')));
  if (!sel) return JSON.stringify({ error: 'no language select', before });

  Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(sel, 'fa');
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r=>setTimeout(r,700));

  return JSON.stringify({
    before,
    after: {
      dir: document.documentElement.dir,
      lang: document.documentElement.lang,
      brandTabs: [...document.querySelectorAll('.rail-tab')].map(b=>b.textContent.trim()),
      playButton: [...document.querySelectorAll('header button')].map(b=>b.textContent.trim()).slice(0,2),
    },
  });
})()`));

console.log("2. PANELS IN PERSIAN:", await evalJs(`(async () => {
  const isFa = ${hasPersian};
  const out = {};
  for (const tab of ['data','trade','news','journal']) {
    const btn = [...document.querySelectorAll('.rail-tab')].find(b=>b.dataset.tab===tab)
      || [...document.querySelectorAll('.rail-tab')][['data','trade','news','indicators','strategy','journal'].indexOf(tab)];
    btn?.click();
    await new Promise(r=>setTimeout(r,450));
    const panel = document.querySelector('.panel');
    const text = panel?.innerText ?? '';
    const latinWords = (text.match(/\\b(balance|equity|floating|margin|lots|trigger|events|trades|win rate)\\b/gi) ?? []);
    out[tab] = { hasPersian: isFa(text), latinLeftovers: latinWords.slice(0,4), head: text.slice(0, 60).replace(/\\n/g,' | ') };
  }
  return JSON.stringify(out);
})()`));

console.log("3. LAYOUT MIRRORED:", await evalJs(`(async () => {
  const app = document.querySelector('.app');
  const chart = document.querySelector('.chart-host') || document.querySelector('.draw-canvas')?.parentElement;
  const panel = document.querySelector('.panel');
  const rail = document.querySelector('.draw-rail') || document.querySelector('.tool-rail');
  const r = (el) => el ? Math.round(el.getBoundingClientRect().left) : null;
  return JSON.stringify({
    dir: document.documentElement.dir,
    columns: getComputedStyle(app).gridTemplateColumns,
    panelLeft: r(panel),
    chartLeft: r(chart),
    railLeft: r(rail),
    // in RTL the panel must start LEFT of the chart
    panelIsLeftOfChart: r(panel) !== null && r(chart) !== null ? r(panel) < r(chart) : null,
  });
})()`));

console.log("4. NUMBERS STAY LATIN AND LTR:", await evalJs(`(async () => {
  [...document.querySelectorAll('.rail-tab')][1]?.click();
  await new Promise(r=>setTimeout(r,500));
  const kv = [...document.querySelectorAll('.trade-panel .kv')].map(k=>k.textContent);
  const bid = kv.find(k => k.includes('قیمت') || k.includes(' bid')) ?? kv[0] ?? '';
  const b = [...document.querySelectorAll('.trade-panel .kv b')][0];
  return JSON.stringify({
    firstKv: bid,
    // the digits must be ASCII, not Persian-Indic
    asciiDigits: /[0-9]/.test(bid),
    persianDigits: /[\\u06F0-\\u06F9]/.test(bid),
    computedDirection: b ? getComputedStyle(b).direction : 'none',
  });
})()`));

console.log("5. PERSISTED ACROSS RELOAD:", await evalJs(`(async () => {
  const stored = window.localStorage.getItem('fxlab.lang');
  location.reload();
  return JSON.stringify({ storedBeforeReload: stored });
})()`));

await sleep(4200);
console.log("6. AFTER RELOAD:", await evalJs(`JSON.stringify({
  dir: document.documentElement.dir,
  lang: document.documentElement.lang,
  tabs: [...document.querySelectorAll('.rail-tab')].map(b=>b.textContent.trim()),
  stored: window.localStorage.getItem('fxlab.lang'),
})`));

const shot = await send("Page.captureScreenshot", { format: "png" });
if (shot.result?.data) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync("/tmp/fx-fa.png", Buffer.from(shot.result.data, "base64"));
  console.log("screenshot /tmp/fx-fa.png");
}
ws.close();
JS

echo "=== errors ==="
grep -iE "\b(error|exception|uncaught)\b" "$LOG" \
  | grep -viE "bus\.cc|gpu|vulkan|libva|gbm|dri3|MESA|fontconfig|sandbox|X11|NODE_OPTION|sqlite-error|bind\(\) failed" | head -6 || echo "  (none)"

kill -9 $APP 2>/dev/null; wait $APP 2>/dev/null
