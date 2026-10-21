#!/usr/bin/env bash
# Prove the TradingView-style rail, per-tool customisation and timeframe filter work.
set -u
cd /root/fx-replay-lab
LOG=/tmp/fxtools.log
: > "$LOG"
export NODE_OPTIONS="--max-old-space-size=1600"

pkill -9 -f "fx-replay-lab/node_modules/electron" 2>/dev/null
sleep 1
PORT=$(( 9500 + RANDOM % 200 ))

timeout 180 xvfb-run -a --server-args="-screen 0 1700x1050x24" \
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
await sleep(3800);

console.log("0. RESET STORED TOOL CONFIGS:", await evalJs(`(async () => {
  // A previous run leaves customisations in SQLite — which is the feature working, but a test
  // must start from a known state or it fails for the wrong reason.
  await window.fxlab.saveToolConfigs({});
  location.reload();
  return 'reset';
})()`));
await sleep(4200);

console.log("1. RAIL ORDER MATCHES TRADINGVIEW:", await evalJs(`(async () => {
  const rail = document.querySelector('[data-rail="draw"]');
  if (!rail) return 'no rail';
  const groups = [...rail.querySelectorAll('[data-group]')].map(b => b.getAttribute('data-group'));
  const tools = [...rail.querySelectorAll('[data-tool]')].map(b => b.getAttribute('data-tool'));
  const toggles = [...rail.querySelectorAll('[data-toggle]')].map(b => b.getAttribute('data-toggle'));
  const chevrons = rail.querySelectorAll('.tool-chev').length;
  return JSON.stringify({ groups, tools, toggles, chevrons });
})()`));

console.log("2. TOOL COUNT AND GROUPS:", await evalJs(`(async () => {
  const rail = document.querySelector('[data-rail="draw"]');
  // open every family and count the items
  const buttons = [...rail.querySelectorAll('[data-group]')];
  let total = 0;
  const perGroup = {};
  for (const b of buttons) {
    const name = b.getAttribute('data-group');
    b.click();
    await new Promise(r => setTimeout(r, 400));
    const n = document.querySelectorAll('[data-tool-item]').length;
    perGroup[name] = n;
    total += n;
    b.click();
    await new Promise(r => setTimeout(r, 60));
  }
  return JSON.stringify({ totalItems: total, perGroup });
})()`));

console.log("3. CUSTOMISE A TOOL (colour + dashed + width):", await evalJs(`(async () => {
  const rail = document.querySelector('[data-rail="draw"]');
  // open Lines, then the gear on Trend Line
  const lines = [...rail.querySelectorAll('[data-group]')].find(b => b.getAttribute('data-group') === 'Lines');
  lines.click();
  // 300ms was not always enough for the flyout to mount; the probe that waited 600ms found
  // all 17 gears every time.
  await new Promise(r => setTimeout(r, 700));
  const gear = document.querySelector('[data-settings="trendline"]');
  if (!gear) return JSON.stringify({
    error: 'no gear',
    flyouts: document.querySelectorAll('.tool-flyout').length,
    gears: document.querySelectorAll('.fi-gear').length,
  });
  gear.click();
  await new Promise(r => setTimeout(r, 500));

  const panel = document.querySelector('[data-panel="tool-settings"]');
  if (!panel) return 'no settings panel';

  // colour
  document.querySelector('[data-swatch="#ef5350"]')?.click();
  await new Promise(r => setTimeout(r, 150));
  // width 3
  document.querySelector('[data-width="3"]')?.click();
  await new Promise(r => setTimeout(r, 150));
  // dashed
  document.querySelector('[data-linestyle="dashed"]')?.click();
  await new Promise(r => setTimeout(r, 300));

  const activeSw = document.querySelector('.ts-swatches .sw.on')?.getAttribute('data-swatch');
  const activeW = document.querySelector('.ts-widths .ts-w.on')?.getAttribute('data-width');
  const activeLs = document.querySelector('.ts-styles .ts-ls.on')?.getAttribute('data-linestyle');
  const preview = document.querySelector('.ts-preview')?.textContent?.trim();
  return JSON.stringify({ colour: activeSw, width: activeW, lineStyle: activeLs, preview });
})()`));

console.log("4. TIMEFRAME FILTER HIDES THE TOOL:", await evalJs(`(async () => {
  const rail = document.querySelector('[data-rail="draw"]');
  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  // Idempotent: the flyout may already be open from step 3, and clicking the group again
  // would CLOSE it. That was the bug in the previous version of this test.
  const flyoutOpen = (name) => {
    const t = document.querySelector('.tool-flyout .flyout-title');
    return t && t.textContent === name;
  };
  const openFlyout = async (name) => {
    if (flyoutOpen(name)) return;
    const b = [...rail.querySelectorAll('[data-group]')]
      .find(x => x.getAttribute('data-group') === name);
    b.click();
    await wait(800);
  };
  const items = () => [...document.querySelectorAll('[data-tool-item]')]
    .map(b => b.getAttribute('data-tool-item'));

  // scope Trend Line to D1 through its own settings
  await openFlyout('Lines');
  document.querySelector('[data-settings="trendline"]')?.click();
  await wait(700);
  const panel = document.querySelector('[data-panel="tool-settings"]');
  if (!panel) return JSON.stringify({ error: 'no settings panel' });
  document.querySelector('[data-tf="D1"]')?.click();
  await wait(400);
  const scoped = document.querySelector('[data-tf="D1"]')?.className.includes('on');
  document.querySelector('[data-action="ts-close"]')?.click();
  await wait(400);

  // find the chart timeframe select: the one offering every timeframe
  const tfSel = [...document.querySelectorAll('select')].find(s =>
    [...s.options].some(o => o.value === 'M1') && [...s.options].some(o => o.value === 'D1'));
  if (!tfSel) return JSON.stringify({ error: 'no tf select', scoped });
  const set = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
  const setTf = async (v) => {
    set.call(tfSel, v);
    tfSel.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(1500);
  };

  await setTf('M5');
  await openFlyout('Lines');
  const m5 = items();

  await setTf('D1');
  await openFlyout('Lines');
  const d1 = items();

  return JSON.stringify({
    scopedToD1: scoped,
    onM5_hasTrendline: m5.includes('trendline'),
    onM5_otherLineTools: m5.includes('hline'),
    onM5_count: m5.length,
    onD1_hasTrendline: d1.includes('trendline'),
    onD1_count: d1.length,
  });
})()`));

console.log("5. SETTINGS PERSIST ACROSS RELOAD:", await evalJs(`(async () => {
  // the stored value lives in SQLite via IPC; read it back directly
  const raw = await window.fxlab.loadToolConfigs();
  if (!raw.raw) return 'nothing stored';
  const parsed = JSON.parse(raw.raw);
  return JSON.stringify({
    storedKinds: Object.keys(parsed),
    trendline: parsed.trendline ? {
      color: parsed.trendline.style.color,
      width: parsed.trendline.style.width,
      style: parsed.trendline.style.style,
      timeframes: parsed.trendline.timeframes,
    } : null,
  });
})()`));

console.log("6. MAGNET / LOCK / HIDE TOGGLES:", await evalJs(`(async () => {
  const rail = document.querySelector('[data-rail="draw"]');
  const magnet = rail.querySelector('[data-toggle="magnet"]');
  const lock = rail.querySelector('[data-toggle="lock"]');
  const hide = rail.querySelector('[data-toggle="hide"]');
  magnet.click();
  lock.click();
  hide.click();
  await new Promise(r => setTimeout(r, 500));
  return JSON.stringify({
    magnetOn: magnet.className.includes('on'),
    lockOn: lock.className.includes('on'),
    hideOn: hide.className.includes('on'),
  });
})()`));

console.log("7. FAVOURITES PIN A TOOL:", await evalJs(`(async () => {
  const rail = document.querySelector('[data-rail="draw"]');
  const shapes = [...rail.querySelectorAll('[data-group]')].find(b => b.getAttribute('data-group') === 'Shapes');
  shapes.click();
  await new Promise(r => setTimeout(r, 300));
  document.querySelector('[data-fav="rectangle"]')?.click();
  await new Promise(r => setTimeout(r, 300));
  shapes.click();
  await new Promise(r => setTimeout(r, 200));

  document.querySelector('[data-toggle="favourites"]')?.click();
  await new Promise(r => setTimeout(r, 400));
  const favText = document.querySelector('.star-flyout')?.textContent ?? '';
  return JSON.stringify({ hasRectangle: favText.includes('Rectangle'), text: favText.slice(0, 60) });
})()`));

const shot = await send("Page.captureScreenshot", { format: "png" });
if (shot.result?.data) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync("/tmp/fx-tools.png", Buffer.from(shot.result.data, "base64"));
  console.log("screenshot /tmp/fx-tools.png");
}
ws.close();
JS

echo "=== errors ==="
grep -iE "\b(error|exception|uncaught)\b" "$LOG" \
  | grep -viE "bus\.cc|gpu|vulkan|libva|gbm|dri3|MESA|fontconfig|sandbox|X11|NODE_OPTION|sqlite-error" | head -6 || echo "  (none)"

kill -9 $APP 2>/dev/null; wait $APP 2>/dev/null
