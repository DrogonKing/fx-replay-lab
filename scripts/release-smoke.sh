#!/usr/bin/env bash
# Test the REAL release artefact, not the source tree.
#
# This is the only test that proves what the user will actually run: the AppImage downloaded from
# the GitHub release, unpacked and driven over CDP. A green CI plus green source tests still would
# not catch a packaging mistake (wrong entry point, missing file in the asar, dev-only paths).
set -uo pipefail

APP="${1:-/tmp/buildtest/app.AppImage}"
PORT="${PORT:-18181}"
LOG=/tmp/release-test.log
CACHE=/tmp/rel-cache-$$
mkdir -p "$CACHE"

cleanup() {
  pkill -f "remote-debugging-port=$PORT" 2>/dev/null
  rm -rf "$CACHE"
}
trap cleanup EXIT

[ -x "$APP" ] || { echo "FAIL: $APP is not executable"; exit 1; }
echo "=== artefact under test ==="
ls -la "$APP"
file "$APP" | cut -c1-90

# An AppImage self-mounts through FUSE. On a host without libfuse it cannot, and the error is
# indistinguishable from "the app is broken" unless handled. --appimage-extract runs the SAME
# bytes without the mount, so the app itself is still what gets tested.
EXTRACTED=""
if ! "$APP" --appimage-version > /dev/null 2>&1 || ! ldconfig -p 2>/dev/null | grep -q 'libfuse.so.2'; then
  echo "note: FUSE unavailable on this host — extracting instead of mounting"
  EXTRACTED="$CACHE/extracted"
  mkdir -p "$EXTRACTED"
  ( cd "$EXTRACTED" && "$APP" --appimage-extract > /dev/null 2>&1 )
  RUN="$EXTRACTED/squashfs-root/AppRun"
  [ -x "$RUN" ] || RUN="$EXTRACTED/squashfs-root/fx-replay-lab"
  echo "extracted entry point: $RUN"
else
  RUN="$APP"
fi

echo "=== launching the packaged app ==="
# APPDIR is what AppRun uses to find the binary; it is set by the mount, so an extracted tree
# needs it explicitly or AppRun resolves to "/fx-replay-lab".
APPDIR="$(dirname "$RUN")"
FXLAB_DATA_DIR="$CACHE" APPDIR="$APPDIR" \
  xvfb-run -a --server-args="-screen 0 1700x1050x24" \
  "$RUN" --no-sandbox --remote-debugging-port="$PORT" \
  > "$LOG" 2>&1 &

READY=0
for _ in $(seq 1 90); do
  if curl -s "http://127.0.0.1:$PORT/json/list" 2>/dev/null | grep -q webSocketDebuggerUrl; then
    READY=1; break
  fi
  sleep 0.5
done
[ "$READY" = "1" ] || { echo "FAIL: the packaged app did not start"; tail -20 "$LOG"; exit 1; }
echo "app started"

export FX_PORT=$PORT

node --input-type=module <<'JS'
const PORT = process.env.FX_PORT;
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page");
if (!page) { console.log("FAIL: no page target"); process.exit(1); }
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
await sleep(4000);

console.log("1. THE PACKAGED APP RENDERS (no white screen):", await evalJs(`JSON.stringify({
  title: document.title,
  rootChildren: document.getElementById('root')?.children.length ?? 0,
  startScreen: !!document.querySelector('[data-panel="start"]'),
  // the version the package reports, which must not be a dev build
  hasMenu: !!document.querySelector('.start-title'),
})`));

console.log("2. IT LOADS A CHART, SHOWS EUR/USD, AND THE FRAME MENU LISTS ALL FRAMES:", await evalJs(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  document.querySelector('[data-mode="live"]')?.click();
  await w(500);
  const go = document.querySelector('[data-action="start-go"]');
  const wasDisabled = go ? go.disabled : null;
  if (go && !go.disabled) go.click();
  for (let i = 0; i < 80 && !document.querySelector('.chart-host'); i++) await w(400);
  // the select is gone by design; the frames now live in the menu
  document.querySelector('[data-action="tf-open"]')?.click();
  await w(700);
  const rows = [...document.querySelectorAll('[data-tf-row]')].map(r => r.getAttribute('data-tf-row'));
  const usable = [...document.querySelectorAll('[data-tf-row][data-usable="yes"]')].length;
  document.querySelector('[data-action="tf-open"]')?.click();
  await w(300);
  const sym = document.querySelector('[data-field="sym-current"]');
  return JSON.stringify({
    goWasDisabled: wasDisabled,
    hasChart: !!document.querySelector('.chart-host'),
    frame: document.querySelector('[data-frame]')?.getAttribute('data-frame'),
    symbol: sym?.getAttribute('data-symbol'),
    defaultIsEurUsd: sym?.getAttribute('data-symbol') === 'EURUSD=X',
    allMainFramesListed: ['M1','M5','M15','M30','H1','H4','D1','W1']
      .every(f => rows.includes(f)),
    usableCount: usable,
    oldSelectGone: !document.querySelector('[data-field="toolbar-tf"]'),
    bars: document.querySelector('[data-bars]')?.getAttribute('data-bars'),
  });
})()`));

console.log("3. THE TIMEZONE PICKER WORKS IN THE PACKAGE:", await evalJs(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  const before = document.querySelector('[data-field="tz-current"]')?.textContent;
  document.querySelector('[data-action="tz-open"]')?.click();
  await w(600);
  const rows = document.querySelectorAll('[data-tz]').length;
  const setNative = (sel, v) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    d.set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  };
  setNative('[data-field="tz-search"]', 'tehran');
  await w(500);
  const found = document.querySelectorAll('[data-tz]').length;
  document.querySelector('[data-tz="Asia/Tehran"]')?.click();
  await w(600);
  const after = document.querySelector('[data-field="tz-current"]')?.textContent;
  return JSON.stringify({
    before, rows, foundTehran: found === 1, after,
    changed: before !== after,
    showsOffset: /UTC\\+3:30/.test(after ?? ''),
    closed: !document.querySelector('[data-dialog="timezone"]'),
  });
})()`));

console.log("4. THE DOWNLOADER AND BROKER TABS EXIST IN THE PACKAGE:", await evalJs(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  document.querySelector('[data-tab="download"]')?.click();
  await w(600);
  // the TAB is data-tab="download"; the PANEL is data-panel="downloader"
  const dl = !!document.querySelector('[data-panel="downloader"]');
  const dlFields = document.querySelectorAll('[data-panel="downloader"] input, [data-panel="downloader"] select').length;
  document.querySelector('[data-tab="broker"]')?.click();
  await w(700);
  const br = !!document.querySelector('[data-panel="broker"]');
  const adapters = [...(document.querySelector('[data-field="br-adapter"]')?.options ?? [])].map(o => o.value);
  return JSON.stringify({ downloadPanel: dl, downloadFields: dlFields, brokerPanel: br, adapters });
})()`));

console.log("5. THE BRIDGE BOUNDARY HOLDS IN THE PACKAGED BUILD:", await evalJs(`(async () => {
  // main's URL guard, exercised through the real IPC channel of the packaged app
  const bad = await window.fxlab.testBridge('http://evil.example.com:8765/health');
  const good = await window.fxlab.testBridge('http://127.0.0.1:18999/health');
  return JSON.stringify({
    remoteRefused: bad.ok === false && /not a local bridge address/i.test(bad.error ?? ''),
    // a loopback URL is allowed through to the network layer, which then fails to connect —
    // which is the correct outcome when no bridge is running
    loopbackAttempted: good.ok === false && /could not reach|bridge running/i.test(good.error ?? ''),
    loopbackError: (good.error ?? '').slice(0, 70),
  });
})()`));

console.log("6. THE CHART ACTUALLY PAINTS (the v0.1.0 bug):", await evalJs(`(() => {
  // v0.1.0 shipped with .chart-host permanently empty: the creation effect ran once on the start
  // screen where the host did not exist. Counting canvases AND their painted pixels is the check
  // that would have caught it.
  const host = document.querySelector('.chart-host');
  const canvases = [...(host?.querySelectorAll('canvas') ?? [])];
  let painted = 0;
  for (const c of canvases) {
    try {
      const ctx = c.getContext('2d');
      if (!ctx) continue;
      const d = ctx.getImageData(0, 0, Math.min(c.width, 400), Math.min(c.height, 400)).data;
      let nonBg = 0;
      for (let i = 0; i < d.length; i += 16) {
        if (d[i] > 40 || d[i + 1] > 44 || d[i + 2] > 55) nonBg++;
      }
      if (nonBg > 200) painted++;
    } catch { /* a canvas we cannot read is not evidence of painting */ }
  }
  return JSON.stringify({
    chartHostChildren: host?.children.length ?? -1,
    canvasCount: canvases.length,
    paintedCanvases: painted,
    chartPaints: canvases.length > 0 && painted > 0,
  });
})()`));

console.log("7. THE SIDE PANEL CAN BE HIDDEN IN THE PACKAGE:", await evalJs(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  const btn = document.querySelector('[data-action="panel-toggle"]');
  if (!btn) return JSON.stringify({ problem: "no toggle" });
  const before = Math.round(document.querySelector('.chart-host')?.getBoundingClientRect().width ?? 0);
  btn.click();
  await w(700);
  const after = Math.round(document.querySelector('.chart-host')?.getBoundingClientRect().width ?? 0);
  const hidden = !document.querySelector('aside.panel') ||
    getComputedStyle(document.querySelector('aside.panel')).display === 'none';
  btn.click();
  await w(600);
  return JSON.stringify({ panelHidden: hidden, chartGrew: after > before, gainedPx: after - before });
})()`));

console.log("8. NO CRASH AFTER ALL OF THAT:", await evalJs(`JSON.stringify({
  rendererAlive: (document.getElementById('root')?.children.length ?? 0) > 0,
  hasChart: !!document.querySelector('.chart-host'),
  status: (document.querySelector('.status')?.textContent ?? '').slice(0, 70),
})`));

ws.close();
JS

echo
echo "=== packaged-app stderr (filtered) ==="
grep -iE 'error|cannot read|undefined is not|ERR_' "$LOG" \
  | grep -viE 'bus.cc|net::ERR|devtools|Autofill|GPU|gpu_|Missing X|dbus|faicon|libva|Fontconfig' \
  | head -8
echo "(nothing above = clean)"
