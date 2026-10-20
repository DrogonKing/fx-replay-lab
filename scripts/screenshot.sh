#!/usr/bin/env bash
# Capture a real screenshot of the running app via CDP, so the UI can be
# inspected as an image rather than inferred from the DOM.
#
# This box has no display, so the app runs under Xvfb; Page.captureScreenshot
# works headlessly and gives the actual pixels the renderer produced.
set -u
cd /root/fx-replay-lab
OUT="${1:-/tmp/fx-app.png}"
LOG=/tmp/fxshot.log
: > "$LOG"
export NODE_OPTIONS="--max-old-space-size=1600"

timeout 90 xvfb-run -a --server-args="-screen 0 1600x1000x24" \
  npx electron . --no-sandbox --remote-debugging-port=9224 \
  >> "$LOG" 2>&1 &
APP_PID=$!

for i in $(seq 1 40); do
  curl -s --max-time 1 http://127.0.0.1:9224/json/version >/dev/null 2>&1 && break
  kill -0 "$APP_PID" 2>/dev/null || { echo "app died"; tail -20 "$LOG"; exit 1; }
  sleep 1
done

node --input-type=module - "$OUT" <<'JS'
import { writeFileSync } from "node:fs";
const out = process.argv[2];
const list = await (await fetch("http://127.0.0.1:9224/json/list")).json();
const page = list.find((t) => t.type === "page");
if (!page) { console.error("no page"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
const send = (id, method, params) =>
  new Promise((res) => {
    const on = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === id) { ws.removeEventListener("message", on); res(m); }
    };
    ws.addEventListener("message", on);
    ws.send(JSON.stringify({ id, method, params }));
  });
await new Promise((r) => ws.addEventListener("open", r));
await send(1, "Page.enable", {});
await send(2, "Emulation.setDeviceMetricsOverride", {
  width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false,
});
await new Promise((r) => setTimeout(r, 2500)); // let the chart paint
const shot = await send(3, "Page.captureScreenshot", { format: "png" });
if (!shot.result?.data) { console.error("no screenshot data"); process.exit(1); }
writeFileSync(out, Buffer.from(shot.result.data, "base64"));
console.log("saved", out);
ws.close();
JS

RC=$?
kill "$APP_PID" 2>/dev/null
wait "$APP_PID" 2>/dev/null
exit $RC
