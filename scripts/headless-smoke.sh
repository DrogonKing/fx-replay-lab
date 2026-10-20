#!/usr/bin/env bash
# Launch the built Electron app headlessly and prove it actually renders.
#
# "It compiles" is not evidence. This does three things:
#   1. runs the packaged main process under Xvfb (no display on this box);
#   2. waits for the window, then verifies the renderer really painted by
#      reading the DOM through the debugger port;
#   3. fails loudly if the app crashed, printed an error, or rendered nothing.
#
# Runs with --no-sandbox because Chromium refuses its own sandbox as root.
set -u
cd /root/fx-replay-lab

LOG=/tmp/fxapp.log
: > "$LOG"

# Node 22 + Electron 32: give it room, this box has 3.9 GB.
export NODE_OPTIONS="--max-old-space-size=1600"

timeout 60 xvfb-run -a --server-args="-screen 0 1600x1000x24" \
  npx electron . --no-sandbox --remote-debugging-port=9223 \
  >> "$LOG" 2>&1 &
APP_PID=$!

echo "launched pid=$APP_PID; waiting for the debugger port..."

READY=0
for i in $(seq 1 40); do
  if curl -s --max-time 1 http://127.0.0.1:9223/json/version >/dev/null 2>&1; then
    READY=1
    echo "debugger ready after ${i}s"
    break
  fi
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    echo "APP DIED before the debugger opened"
    break
  fi
  sleep 1
done

if [ "$READY" != "1" ]; then
  echo "=== app log ==="
  tail -40 "$LOG"
  kill "$APP_PID" 2>/dev/null
  exit 1
fi

# Ask the renderer what it actually rendered.
node --input-type=module - <<'JS' > /tmp/render_check.json 2>/tmp/render_check.err
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page");
if (!page) { console.log(JSON.stringify({ error: "no page target" })); process.exit(0); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
const send = (id, method, params) =>
  new Promise((res) => {
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === id) { ws.removeEventListener("message", onMsg); res(m); }
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
await new Promise((r) => ws.addEventListener("open", r));
await send(1, "Runtime.enable", {});
const expr = `(() => {
  const root = document.getElementById("root");
  const canvases = document.querySelectorAll("canvas");
  const panels = document.querySelectorAll(".panel");
  const buttons = document.querySelectorAll(".toolbar button");
  const inds = document.querySelectorAll(".ind-list li");
  const bodyText = (document.body.innerText || "").slice(0, 400);
  let pixels = 0;
  for (const c of canvases) pixels += c.width * c.height;
  return JSON.stringify({
    title: document.title,
    rootChildren: root ? root.children.length : -1,
    canvases: canvases.length,
    totalCanvasPixels: pixels,
    panels: panels.length,
    toolbarButtons: buttons.length,
    indicatorRows: inds.length,
    hasBrand: bodyText.includes("FX Replay Lab"),
    hasCredit: bodyText.includes("Lightweight Charts"),
    bodyText,
  });
})()`;
const r = await send(2, "Runtime.evaluate", { expression: expr, returnByValue: true });
console.log(r.result?.result?.value ?? JSON.stringify({ error: "eval failed", r }));
ws.close();
JS

echo "=== renderer state ==="
cat /tmp/render_check.json
if [ -s /tmp/render_check.err ]; then
  echo "=== debugger stderr ==="
  head -10 /tmp/render_check.err
fi

echo "=== console/errors from the app log ==="
grep -iE "error|exception|failed|crash" "$LOG" | grep -viE "sandbox|dbus|gpu|vulkan|libva|gbm|dri3|MESA|fontconfig|Passthrough" | head -15 || echo "  (none)"

kill "$APP_PID" 2>/dev/null
wait "$APP_PID" 2>/dev/null
echo "=== done ==="
