#!/usr/bin/env bash
# Probe why the drawing overlay paints nothing: check the canvas backing store,
# the coordinate conversions, and whether the shapes reach the painter.
set -u
cd /root/fx-replay-lab
LOG=/tmp/fxprobe.log
: > "$LOG"

timeout 120 xvfb-run -a --server-args="-screen 0 1600x1000x24" \
  npx electron . --no-sandbox --remote-debugging-port=9230 >> "$LOG" 2>&1 &
APP_PID=$!
for i in $(seq 1 40); do
  curl -s --max-time 1 http://127.0.0.1:9230/json/version >/dev/null 2>&1 && break
  sleep 1
done

node --input-type=module <<'JS'
const list = await (await fetch("http://127.0.0.1:9230/json/list")).json();
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
await sleep(3000);

console.log("CANVAS_GEOMETRY:", await evalJs(`(function(){
  const c = document.querySelector('.draw-canvas');
  const r = c.getBoundingClientRect();
  return JSON.stringify({
    attrW: c.width, attrH: c.height,
    cssW: Math.round(r.width), cssH: Math.round(r.height),
    dpr: window.devicePixelRatio,
    styleW: getComputedStyle(c).width,
    styleH: getComputedStyle(c).height,
  });
})()`));

console.log("HAS_CTX:", await evalJs(`(function(){
  const c = document.querySelector('.draw-canvas');
  const ctx = c.getContext('2d');
  return JSON.stringify({ ctx: !!ctx, transform: ctx ? ctx.getTransform() : null });
})()`));

// Manually paint a known line and see whether pixels appear at all.
console.log("MANUAL_PAINT:", await evalJs(`(function(){
  const c = document.querySelector('.draw-canvas');
  const ctx = c.getContext('2d');
  ctx.save();
  ctx.strokeStyle = '#ff0000';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(50, 50);
  ctx.lineTo(400, 400);
  ctx.stroke();
  ctx.restore();
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let painted = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 8) painted++;
  return JSON.stringify({ paintedAfterManualStroke: painted, attrW: c.width });
})()`));

ws.close();
JS

kill "$APP_PID" 2>/dev/null; wait "$APP_PID" 2>/dev/null
