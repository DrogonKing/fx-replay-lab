#!/usr/bin/env bash
# The right-hand panel can be hidden, and the chart takes the freed width.
set -uo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-18251}"
LOG=/tmp/panel.log
CACHE=/tmp/panel-cache-$$
mkdir -p "$CACHE"
pkill -f "remote-debugging-port=$PORT" 2>/dev/null
cleanup() { pkill -f "remote-debugging-port=$PORT" 2>/dev/null; rm -rf "$CACHE"; }
trap cleanup EXIT

export NODE_OPTIONS=--max-old-space-size=1600
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  npx vite build > /tmp/vb-panel.log 2>&1 || { echo "vite FAILED"; tail -5 /tmp/vb-panel.log; exit 1; }
  npx tsc -p tsconfig.main.json > /tmp/tsc-panel.log 2>&1 || { echo "tsc FAILED"; tail -5 /tmp/tsc-panel.log; exit 1; }
  node scripts/postbuild-main.mjs >> /tmp/vb-panel.log 2>&1
fi

FXLAB_DATA_DIR="$CACHE" \
  xvfb-run -a --server-args="-screen 0 1700x1050x24" \
  npx electron dist/main/main.js --remote-debugging-port="$PORT" --no-sandbox \
  > "$LOG" 2>&1 &

for _ in $(seq 1 60); do
  curl -s "http://127.0.0.1:$PORT/json/list" | grep -q webSocketDebuggerUrl && break
  sleep 0.5
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
await sleep(3500);

// The preference persists by design, which means a previous run can leave the panel hidden and
// reverse every direction below. Reset it explicitly: a test that inherits state is testing the
// last run, not the feature.
await evalJs(`localStorage.setItem('fxlab.panelOpen', '1')`);
await send("Page.enable");
await send("Page.reload");
await sleep(4500);

await evalJs(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  document.querySelector('[data-mode="live"]')?.click();
  await w(400);
  const go = document.querySelector('[data-action="start-go"]');
  if (go && !go.disabled) go.click();
  for (let i = 0; i < 80 && !document.querySelector('.chart-host'); i++) await w(400);
})()`);
await sleep(1500);

console.log("P1. THE TOGGLE EXISTS AND THE PANEL STARTS OPEN:", await evalJs(`(() => {
  const btn = document.querySelector('[data-action="panel-toggle"]');
  const aside = document.querySelector('aside.panel');
  const chart = document.querySelector('.chart-host')?.getBoundingClientRect();
  return JSON.stringify({
    togglePresent: !!btn,
    toggleState: btn?.getAttribute('aria-pressed'),
    titleMentionsF2: /F2/.test(btn?.getAttribute('title') ?? ''),
    panelVisible: !!aside && getComputedStyle(aside).display !== 'none',
    panelWidth: aside ? Math.round(aside.getBoundingClientRect().width) : 0,
    chartWidth: chart ? Math.round(chart.width) : 0,
  });
})()`));

console.log("P2. CLICKING THE TOGGLE HIDES IT AND THE CHART GROWS:", await evalJs(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  const before = Math.round(document.querySelector('.chart-host')?.getBoundingClientRect().width ?? 0);
  document.querySelector('[data-action="panel-toggle"]')?.click();
  await w(600);
  const aside = document.querySelector('aside.panel');
  const after = Math.round(document.querySelector('.chart-host')?.getBoundingClientRect().width ?? 0);
  return JSON.stringify({
    panelDisplay: aside ? getComputedStyle(aside).display : "gone",
    panelHidden: !aside || getComputedStyle(aside).display === 'none',
    chartWidthBefore: before,
    chartWidthAfter: after,
    chartGrew: after > before,
    // the freed width should be about the panel's 280px
    gainedPx: after - before,
    toggleStateNow: document.querySelector('[data-action="panel-toggle"]')?.getAttribute('aria-pressed'),
  });
})()`));

console.log("P3. THE CHART STILL RENDERS WITH THE PANEL HIDDEN:", await evalJs(`(() => {
  // the chart host may hold a wrapper div before the canvas, so look anywhere inside it
  const host = document.querySelector('.chart-host');
  const canvas = host?.querySelector('canvas') ?? document.querySelector('canvas.draw-canvas');
  const r = canvas ? canvas.getBoundingClientRect() : null;
  return JSON.stringify({
    hasCanvas: !!canvas,
    canvasNonZero: !!(r && r.width > 100 && r.height > 100),
    canvasWidth: r ? Math.round(r.width) : 0,
    canvasHeight: r ? Math.round(r.height) : 0,
    drawingsRailStillThere: !!document.querySelector('[data-rail="draw"]'),
    // legend proves the chart got data, not just that a canvas element exists
    legendHasInstrument: /GC=F|XAU|EUR|GBP/.test(document.querySelector('.legend')?.textContent ?? ''),
    rendererAlive: (document.getElementById('root')?.children.length ?? 0) > 0,
  });
})()`));

console.log("P4. F2 REOPENS IT AFTER A CLICK CLOSED IT:", await evalJs(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  // deterministic: make sure it is closed, then use ONLY the keyboard to bring it back
  const btn = document.querySelector('[data-action="panel-toggle"]');
  if (btn?.getAttribute('aria-pressed') === 'true') { btn.click(); await w(500); }
  const closedNow = document.querySelector('aside.panel') === null ||
    getComputedStyle(document.querySelector('aside.panel')).display === 'none';
  document.body.focus();
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'F2', key: 'F2', bubbles: true }));
  await w(700);
  const aside = document.querySelector('aside.panel');
  return JSON.stringify({
    startedClosed: closedNow,
    panelBack: !!aside && getComputedStyle(aside).display !== 'none',
    panelWidth: aside ? Math.round(aside.getBoundingClientRect().width) : 0,
    toggleState: document.querySelector('[data-action="panel-toggle"]')?.getAttribute('aria-pressed'),
    // the keyboard path must be what reopened it
    reopenedByKeyboard: closedNow && !!aside && getComputedStyle(aside).display !== 'none',
  });
})()`));

console.log("P5. THE CHOICE IS REMEMBERED:", await evalJs(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  document.querySelector('[data-action="panel-toggle"]')?.click();
  await w(500);
  return JSON.stringify({
    stored: localStorage.getItem('fxlab.panelOpen'),
    // "0" means hidden, which must persist across a reload
    storedMeansHidden: localStorage.getItem('fxlab.panelOpen') === '0',
  });
})()`));

console.log("P6. AFTER A RELOAD IT IS STILL HIDDEN:", await (async () => {
  await send("Page.enable");
  await send("Page.reload", { ignoreCache: false });
  await sleep(5000);
  const r = await evalJs(`(() => {
    const aside = document.querySelector('aside.panel');
    return JSON.stringify({
      // a fresh start screen may be showing; that is fine, the assertion is about persistence
      stillHidden: !aside || getComputedStyle(aside).display === 'none',
      stored: localStorage.getItem('fxlab.panelOpen'),
      rootRendered: (document.getElementById('root')?.children.length ?? 0) > 0,
    });
  })()`);
  // leave the app in the default state for later runs
  await evalJs(`localStorage.setItem('fxlab.panelOpen', '1')`);
  return r;
})());

console.log("P7. NO RENDERER CRASH:", await evalJs(`JSON.stringify({
  rendererAlive: (document.getElementById('root')?.children.length ?? 0) > 0,
})`));

ws.close();
JS

echo
echo "=== renderer errors ==="
grep -iE 'error|cannot read|is not a function' "$LOG" \
  | grep -viE 'bus.cc|net::ERR|devtools|Autofill|GPU|gpu_|Missing X|dbus|favicon|NODE_OPTION' | head -5
echo "(nothing above = clean)"
