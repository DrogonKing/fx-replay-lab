#!/usr/bin/env bash
# Timeframe behaviour, tested live.
#
# The claim being verified: no timeframe is picked before data exists, every frame above the
# loaded base is available, a custom frame works, and a frame FINER than the base is refused with
# a reason rather than silently rendering the wrong bars.
set -uo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-18141}"
LOG=/tmp/tftest.log
CACHE=/tmp/tf-cache-$$
mkdir -p "$CACHE"

cleanup() {
  pkill -f "remote-debugging-port=$PORT" 2>/dev/null
  rm -rf "$CACHE"
}
trap cleanup EXIT

echo "=== building ==="
export NODE_OPTIONS=--max-old-space-size=1600
npx vite build > /tmp/vb-tf.log 2>&1 || { echo "vite build FAILED"; tail -5 /tmp/vb-tf.log; exit 1; }
npx tsc -p tsconfig.main.json > /tmp/tsc-tf.log 2>&1 || { echo "tsc FAILED"; tail -5 /tmp/tsc-tf.log; exit 1; }
node scripts/postbuild-main.mjs >> /tmp/vb-tf.log 2>&1

FXLAB_DATA_DIR="$CACHE" \
  xvfb-run -a --server-args="-screen 0 1700x1050x24" \
  npx electron dist/main/main.js --remote-debugging-port="$PORT" --no-sandbox \
  > "$LOG" 2>&1 &

READY=0
for _ in $(seq 1 60); do
  if curl -s "http://127.0.0.1:$PORT/json/list" | grep -q webSocketDebuggerUrl; then
    READY=1; break
  fi
  sleep 0.5
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
  if (r.result?.exceptionDetails) return { EXC: r.result.exceptionDetails.exception?.description?.slice(0, 300) };
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(3200);

console.log("1. NO TIMEFRAME PICKER BEFORE DATA EXISTS:", await evalJs(`JSON.stringify({
  startShown: !!document.querySelector('[data-panel="start"]'),
  intervalButtons: document.querySelectorAll('[data-interval]').length,
  // the app states what it will load instead of asking
  statesResolution: !!document.querySelector('[data-resolution]'),
  resolution: document.querySelector('[data-resolution]')?.getAttribute('data-resolution'),
  explainsFrames: /custom|frame/i.test(document.querySelector('.start-card')?.textContent ?? ''),
})`));

console.log("2. AN OLD RANGE ADAPTS THE RESOLUTION INSTEAD OF REFUSING:", await evalJs(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  const setSel = (field, value) => {
    const el = document.querySelector('[data-field="' + field + '"]');
    if (!el) return false;
    const set = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    set.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };
  const nowYear = new Date().getUTCFullYear();
  const resNow = document.querySelector('[data-resolution]')?.getAttribute('data-resolution');

  setSel('start-year', String(nowYear - 12));
  await w(700);
  const resOld = document.querySelector('[data-resolution]')?.getAttribute('data-resolution');
  const verdict = document.querySelector('[data-note="start-availability"]')?.getAttribute('data-verdict');
  const usable = !document.querySelector('[data-action="start-go"]')?.disabled;

  setSel('start-year', String(nowYear));
  await w(700);
  const resBack = document.querySelector('[data-resolution]')?.getAttribute('data-resolution');

  return JSON.stringify({
    thisYear: resNow,
    twelveYearsBack: resOld,
    becameCoarser: Number(resOld) > Number(resNow),
    verdict,
    stillLoadable: usable,
    backToThisYear: resBack,
  });
})()`));

console.log("3. EVERY MAIN FRAME IS LISTED; THE UNBUILDABLE ONES ARE MARKED:", await evalJs(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  document.querySelector('[data-mode="live"]')?.click();
  await w(400);
  const go = document.querySelector('[data-action="start-go"]');
  if (go && !go.disabled) go.click();
  for (let i = 0; i < 60 && !document.querySelector('.chart-host'); i++) await w(400);

  const sel = document.querySelector('[data-field="toolbar-tf"]');
  const opts = sel ? [...sel.options] : [];
  const offered = opts.map(o => o.value);
  const usable = opts.filter(o => o.getAttribute('data-usable') === 'yes').map(o => o.value);
  const blocked = opts.filter(o => o.getAttribute('data-usable') === 'no').map(o => o.value);
  const current = document.querySelector('[data-frame]')?.getAttribute('data-frame');
  const baseBars = Number(document.querySelector('[data-base-bars]')?.getAttribute('data-base-bars') ?? 0);
  const ORDER = ['M1','M5','M15','M30','H1','H4','D1','W1'];
  const idx = ORDER.indexOf(current ?? '');
  const expectedUsable = idx >= 0 ? ORDER.slice(idx) : [];
  return JSON.stringify({
    hasChart: !!document.querySelector('.chart-host'),
    current,
    baseBars,
    // ALL main frames are listed, which is what "every timeframe is accessible" means
    listsAllMainFrames: ORDER.every(f => offered.includes(f)),
    usable,
    blocked,
    // every frame above the base is usable, every one below is marked blocked
    usableMatchesBase: expectedUsable.every(f => usable.includes(f)),
    blockedAreMarked: blocked.length === 0 || opts.every(o =>
      o.getAttribute('data-usable') === 'yes' || /needs finer/.test(o.textContent ?? '')),
  });
})()`));

console.log("4. A CUSTOM FRAME WORKS (90m) AND A TOO-FINE ONE IS REFUSED (3m):", await evalJs(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  const customEl = document.querySelector('[data-field="custom-tf"]');
  const setVal = (v) => {
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(customEl, v);
    customEl.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const pressEnter = () => customEl.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

  // data-frame is the frame actually being rendered, which is the only claim worth checking
  const rendered = () => document.querySelector('[data-frame]')?.getAttribute('data-frame');

  // 3m is finer than the loaded base, so it must be refused with a reason
  setVal('3'); await w(200); pressEnter(); await w(600);
  const refusedStatus = (document.querySelector('.status')?.textContent ?? '').slice(0, 120);
  const afterRefuse = rendered();

  // 90m is coarser, so it must be accepted and actually rendered
  setVal('90'); await w(200); pressEnter(); await w(1200);
  const afterAccept = rendered();
  const acceptStatus = (document.querySelector('.status')?.textContent ?? '').slice(0, 80);
  // and it must appear in the select, or the control disagrees with the chart
  const inSelect = [...document.querySelectorAll('[data-field="toolbar-tf"] option')]
    .map(o => o.value).includes('90m');

  return JSON.stringify({
    refused3m: /cannot be built|Invalid/i.test(refusedStatus),
    refusedMessage: refusedStatus,
    stayedOnBase: afterRefuse,
    renderedAfter90m: afterAccept,
    customInSelect: inSelect,
    acceptStatus,
    rendererAlive: (document.getElementById('root')?.children.length ?? 0) > 0,
  });
})()`));

console.log("5. SWITCHING TO A DERIVED FRAME REBUILDS THE CHART:", await evalJs(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  const sel = document.querySelector('[data-field="toolbar-tf"]');
  const pick = (v) => {
    const set = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    set.call(sel, v);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  };
  // data-bars is the VIEW length, so a coarser frame must show fewer bars
  const bars = () => Number(document.querySelector('[data-bars]')?.getAttribute('data-bars') ?? -1);
  // pick frames that are actually usable from the loaded base, rather than assuming 5m exists
  const usable = [...document.querySelectorAll('[data-field="toolbar-tf"] option')]
    .filter(o => o.getAttribute('data-usable') === 'yes')
    .map(o => o.value);
  // presets only: a custom frame like 90m sits between presets and is not a valid "coarsest"
  const PRESETS = ['M1','M5','M15','M30','H1','H4','D1','W1'];
  const presetUsable = usable.filter((f) => PRESETS.includes(f));
  const fine = presetUsable[0];
  const coarse = presetUsable[presetUsable.length - 1];

  const setSel = (v) => {
    const set = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    set.call(sel, v);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  };

  setSel(fine); await w(1000);
  const bFine = bars();
  setSel(coarse); await w(1000);
  const bCoarse = bars();
  setSel(fine); await w(1000);
  const bBack = bars();

  return JSON.stringify({
    fineFrame: fine, barsFine: bFine,
    coarseFrame: coarse, barsCoarse: bCoarse,
    barsAfterReturning: bBack,
    // a coarser frame must draw FEWER bars: each one covers more time
    coarserHasFewerBars: bCoarse > 0 && bFine > 0 && bCoarse < bFine,
    returningRestoresCount: bBack === bFine,
  });
})()`));

console.log("6. NO RENDERER CRASH:", await evalJs(`JSON.stringify({
  rendererAlive: (document.getElementById('root')?.children.length ?? 0) > 0,
  hasChart: !!document.querySelector('.chart-host'),
})`));

ws.close();
JS

echo
echo "=== renderer errors ==="
grep -iE 'error|cannot read|is not a function' "$LOG" \
  | grep -viE 'bus.cc|net::ERR|devtools|Autofill|GPU|gpu_|Missing X|dbus|favicon' | head -6
echo "(nothing above = clean)"
