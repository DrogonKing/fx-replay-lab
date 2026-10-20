#!/usr/bin/env bash
# Verify the PACKAGED artefact actually runs — not just the dev tree.
#
# This is the difference between "it builds" and "it works": asar packaging, the
# unpacked native module, and the main/renderer path all have to be correct inside
# the bundle, which a dev-mode run does not prove.
set -u
cd /root/fx-replay-lab
LOG=/tmp/fxpackaged.log
: > "$LOG"

APPIMAGE=$(ls release/*.AppImage 2>/dev/null | head -1)
if [ -z "$APPIMAGE" ]; then
  echo "FAIL: no AppImage found"
  exit 1
fi
echo "testing: $APPIMAGE"

timeout 120 xvfb-run -a --server-args="-screen 0 1600x1000x24" \
  "$APPIMAGE" --appimage-extract-and-run --no-sandbox \
  --remote-debugging-port=9228 >> "$LOG" 2>&1 &
APP_PID=$!

READY=0
for i in $(seq 1 45); do
  if curl -s --max-time 1 http://127.0.0.1:9228/json/version >/dev/null 2>&1; then
    READY=1
    echo "packaged app booted after ${i}s"
    break
  fi
  kill -0 "$APP_PID" 2>/dev/null || { echo "FAIL: packaged app died"; tail -20 "$LOG"; exit 1; }
  sleep 1
done

if [ "$READY" != "1" ]; then
  echo "FAIL: debugger never opened"
  tail -25 "$LOG"
  kill "$APP_PID" 2>/dev/null
  exit 1
fi

node --input-type=module <<'JS'
const list = await (await fetch("http://127.0.0.1:9228/json/list")).json();
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
await new Promise((r) => setTimeout(r, 3000));

const r = await send("Runtime.evaluate", {
  expression: `JSON.stringify({
    title: document.title,
    canvases: document.querySelectorAll("canvas").length,
    panels: document.querySelectorAll(".panel").length,
    railTabs: [...document.querySelectorAll(".rail-tab")].map(b => b.textContent),
    badge: document.querySelector(".badge")?.textContent,
    legend: document.querySelector(".legend")?.textContent?.slice(0, 60),
    bridgeOk: typeof window.fxlab?.backtest === "function",
    credit: (document.body.innerText||"").includes("Lightweight Charts"),
    hasError: (document.body.innerText||"").toLowerCase().includes("uncaught"),
  })`,
  returnByValue: true,
});
console.log("PACKAGED STATE:", r.result?.result?.value);

// PROVE better-sqlite3 loaded: accounts:list touches the database, and the native
// module lives in app.asar.unpacked. If the asarUnpack config were wrong this call
// throws instead of returning a list.
const db = await send("Runtime.evaluate", {
  expression: `window.fxlab.listAccounts().then(a => JSON.stringify({ ok: true, count: a.length })).catch(e => JSON.stringify({ ok: false, message: String(e).slice(0,200) }))`,
  returnByValue: true,
  awaitPromise: true,
});
console.log("SQLITE:", db.result?.result?.value);

// and prove the strategy host (main process) is reachable from the packaged app
const host = await send("Runtime.evaluate", {
  expression: `window.fxlab.pineParse('//@version=5\\nindicator("x")\\nplot(close)').then(r => JSON.stringify(r)).catch(e => JSON.stringify({ error: String(e).slice(0,150) }))`,
  returnByValue: true,
  awaitPromise: true,
});
console.log("STRATEGY HOST:", host.result?.result?.value);
ws.close();
JS

echo "=== runtime errors in the packaged app ==="
# Only real failures: strip known-noisy Chromium lines AND lines that merely
# mention a filename containing the word "error" (e.g. sqlite-error.js).
grep -iE "\b(error|exception|uncaught|cannot find|not defined)\b" "$LOG" \
  | grep -viE "bus\.cc|gpu|vulkan|libva|gbm|dri3|MESA|fontconfig|sandbox|X11" \
  | grep -viE "sqlite-error\.js|error-decoder" | head -10 || echo "  (none)"

kill "$APP_PID" 2>/dev/null
wait "$APP_PID" 2>/dev/null
echo "=== packaged smoke done ==="
