#!/usr/bin/env bash
# Three requested changes, tested live:
#   1. no instrument picker on the start screen, default EUR/USD
#   2. instrument switching in the toolbar
#   3. timeframe as a menu with pinnable favourites
set -uo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-18301}"
LOG=/tmp/tfmenu.log
CACHE=/tmp/tfm-cache-$$
mkdir -p "$CACHE"
pkill -f "remote-debugging-port=$PORT" 2>/dev/null
cleanup() { pkill -f "remote-debugging-port=$PORT" 2>/dev/null; rm -rf "$CACHE"; }
trap cleanup EXIT

export NODE_OPTIONS=--max-old-space-size=1600
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  npx vite build > /tmp/vb-tfm.log 2>&1 || { echo "vite FAILED"; tail -5 /tmp/vb-tfm.log; exit 1; }
  npx tsc -p tsconfig.main.json > /tmp/tsc-tfm.log 2>&1 || { echo "tsc FAILED"; tail -5 /tmp/tsc-tfm.log; exit 1; }
  node scripts/postbuild-main.mjs >> /tmp/vb-tfm.log 2>&1
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
await evalJs(`localStorage.clear()`);
await send("Page.enable");
await send("Page.reload");
await sleep(4000);

console.log("S1. THE START SCREEN HAS NO INSTRUMENT PICKER:", await evalJs(`(() => {
  const start = document.querySelector('[data-panel="start"]');
  const text = start?.textContent ?? '';
  return JSON.stringify({
    startScreenUp: !!start,
    instrumentSelect: !!document.querySelector('[data-field="start-symbol"]'),
    noInstrumentLabel: !/INSTRUMENT|نماد/i.test(text),
    resolutionStillShown: !!document.querySelector('[data-kv="start-resolution"]'),
  });
})()`));

await evalJs(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  document.querySelector('[data-mode="live"]')?.click();
  await w(400);
  const go = document.querySelector('[data-action="start-go"]');
  if (go && !go.disabled) go.click();
  for (let i = 0; i < 80 && !document.querySelector('.chart-host'); i++) await w(400);
})()`);
await sleep(4000);

console.log("S2. IT OPENS ON EUR/USD:", await evalJs(`(() => {
  const sym = document.querySelector('[data-field="sym-current"]');
  const bar = document.querySelector('[data-field="tf-current"]');
  return JSON.stringify({
    symbolButtonShows: (sym?.textContent ?? '').trim(),
    symbolId: sym?.getAttribute('data-symbol'),
    isEurUsd: sym?.getAttribute('data-symbol') === 'EURUSD=X',
    tfButtonShows: (bar?.textContent ?? '').trim(),
    // an old select must not still be driving the chart
    oldSelectGone: !document.querySelector('[data-field="toolbar-tf"]'),
  });
})()`));

console.log("S3. THE TIMEFRAME MENU OPENS AND LISTS EVERY FRAME:", await evalJs(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  document.querySelector('[data-action="tf-menu-open"]')?.click()
    ?? document.querySelector('[data-action="tf-open"]')?.click();
  await w(600);
  const dlg = document.querySelector('[data-dialog="timeframe"]');
  if (!dlg) return JSON.stringify({ problem: "menu did not open" });
  const rows = [...document.querySelectorAll('[data-tf-row]')].map(r => r.getAttribute('data-tf-row'));
  const b = dlg.getBoundingClientRect();
  const topEl = document.elementFromPoint(Math.round(b.left + b.width/2), Math.round(b.top + 40));
  return JSON.stringify({
    open: true,
    framesListed: rows,
    allMainFrames: ['M1','M5','M15','M30','H1','H4','D1','W1'].every(f => rows.includes(f)),
    favouritesSection: !!document.querySelector('[data-list="tf-favourites"]'),
    customField: !!document.querySelector('[data-field="tf-custom"]'),
    dialogOnTop: !!(topEl && dlg.contains(topEl)),
    belowButton: b.top > 40,
  });
})()`));

console.log("S4. PINNING A FRAME MOVES IT TO FAVOURITES:", await evalJs(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  const before = [...document.querySelectorAll('[data-list="tf-favourites"] [data-tf-row]')]
    .map(r => r.getAttribute('data-tf-row'));
  // pin H4, which is not a default favourite
  document.querySelector('[data-tf-fav="H4"]')?.click();
  await w(500);
  const after = [...document.querySelectorAll('[data-list="tf-favourites"] [data-tf-row]')]
    .map(r => r.getAttribute('data-tf-row'));
  return JSON.stringify({
    favouritesBefore: before,
    favouritesAfter: after,
    h4Pinned: after.includes('H4') && !before.includes('H4'),
    stored: localStorage.getItem('fxlab.tfFavourites'),
  });
})()`));

console.log("S5. CHOOSING A FRAME CHANGES THE CHART:", await evalJs(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  const before = document.querySelector('[data-field="tf-current"]')?.textContent?.trim();
  const beforeBars = document.querySelector('[data-bars]')?.getAttribute('data-bars');
  document.querySelector('[data-tf-pick="H4"]')?.click();
  await w(1500);
  const after = document.querySelector('[data-field="tf-current"]')?.textContent?.trim();
  const afterBars = document.querySelector('[data-bars]')?.getAttribute('data-bars');
  return JSON.stringify({
    before, after,
    changed: before !== after,
    barsChanged: beforeBars !== afterBars,
    menuClosed: !document.querySelector('[data-dialog="timeframe"]'),
    bars: afterBars,
  });
})()`));

console.log("S6. AN UNBUILDABLE FRAME IS DISABLED WITH A REASON:", await evalJs(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  document.querySelector('[data-action="tf-open"]')?.click();
  await w(600);
  const row = document.querySelector('[data-tf-row="M1"]');
  const pick = document.querySelector('[data-tf-pick="M1"]');
  const out = JSON.stringify({
    m1Usable: row?.getAttribute('data-usable'),
    m1Disabled: pick?.disabled,
    reasonOnTitle: (pick?.getAttribute('title') ?? '').slice(0, 60),
  });
  document.querySelector('[data-action="tf-open"]')?.click();
  await w(300);
  return out;
})()`));

console.log("S7. THE INSTRUMENT MENU SWITCHES SYMBOL AND RELOADS:", await evalJs(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  document.querySelector('[data-action="sym-open"]')?.click();
  await w(600);
  const options = [...document.querySelectorAll('[data-sym-pick]')].map(b => b.getAttribute('data-sym-pick'));
  const before = document.querySelector('[data-field="sym-current"]')?.getAttribute('data-symbol');
  document.querySelector('[data-sym-pick="GBPUSD=X"]')?.click();
  await w(4000);
  const after = document.querySelector('[data-field="sym-current"]')?.getAttribute('data-symbol');
  const legend = document.querySelector('.legend')?.textContent ?? '';
  return JSON.stringify({
    optionsOffered: options,
    before, after,
    switched: after === 'GBPUSD=X' && before !== after,
    menuClosed: !document.querySelector('[data-dialog="symbol"]'),
    legendReflectsSymbol: /GBP/.test(legend),
  });
})()`));

console.log("S8. THE PINNED FRAME SURVIVES A RELOAD:", await (async () => {
  await evalJs(`localStorage.setItem('fxlab.tfFavourites', JSON.stringify(["M15","H1","H4"]))`);
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
  await sleep(3000);
  return await evalJs(`(async () => {
    const w = (ms) => new Promise(r => setTimeout(r, ms));
    document.querySelector('[data-action="tf-open"]')?.click();
    await w(600);
    const favs = [...document.querySelectorAll('[data-list="tf-favourites"] [data-tf-row]')]
      .map(r => r.getAttribute('data-tf-row'));
    document.querySelector('[data-action="tf-open"]')?.click();
    return JSON.stringify({ favouritesAfterReload: favs, h4StillPinned: favs.includes('H4') });
  })()`);
})());

console.log("S9. NO RENDERER CRASH:", await evalJs(`JSON.stringify({
  rendererAlive: (document.getElementById('root')?.children.length ?? 0) > 0,
  hasChart: !!document.querySelector('.chart-host'),
  canvases: document.querySelectorAll('.chart-host canvas').length,
})`));

ws.close();
JS

echo
echo "=== renderer errors ==="
grep -iE 'error|cannot read|is not a function' "$LOG" \
  | grep -viE 'bus.cc|net::ERR|devtools|Autofill|GPU|gpu_|Missing X|dbus|favicon|NODE_OPTION' | head -5
echo "(nothing above = clean)"
