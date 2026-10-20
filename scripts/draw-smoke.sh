#!/usr/bin/env bash
# Verify drawing tools actually work in the running app.
#
# Dispatches REAL pointer events at the canvas and then checks that (a) a drawing
# was created in the model, (b) the overlay canvas has non-transparent pixels, and
# (c) the tool flyout lists the groups. Asserting the model alone would pass even if
# nothing was ever painted, so the pixel check is the point.
set -u
cd /root/fx-replay-lab
LOG=/tmp/fxdraw.log
: > "$LOG"
export NODE_OPTIONS="--max-old-space-size=1600"

timeout 150 xvfb-run -a --server-args="-screen 0 1600x1000x24" \
  npx electron . --no-sandbox --remote-debugging-port=9229 >> "$LOG" 2>&1 &
APP_PID=$!
for i in $(seq 1 40); do
  curl -s --max-time 1 http://127.0.0.1:9229/json/version >/dev/null 2>&1 && break
  kill -0 "$APP_PID" 2>/dev/null || { echo "app died"; tail -20 "$LOG"; exit 1; }
  sleep 1
done

node --input-type=module <<'JS'
const list = await (await fetch("http://127.0.0.1:9229/json/list")).json();
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
  if (r.result?.exceptionDetails) {
    return { EXC: r.result.exceptionDetails.exception?.description?.slice(0, 400) };
  }
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(2800);

// 1. Tool rail exists and the flyouts list real tools.
console.log("RAIL:", await evalJs(`JSON.stringify({
  buttons: document.querySelectorAll('.draw-rail .tool-btn').length,
  groups: document.querySelectorAll('.draw-rail .tool-group').length,
  canvas: !!document.querySelector('.draw-canvas'),
  separators: document.querySelectorAll('.draw-rail .rail-sep').length,
  separatorsVisible: [...document.querySelectorAll('.draw-rail .rail-sep')]
    .filter(s => { const r = s.getBoundingClientRect();
                   return r.height >= 1 && r.width >= 20; }).length,
  railScrollH: document.querySelector('.draw-rail').scrollHeight,
  railClientH: document.querySelector('.draw-rail').clientHeight,
})`));

// 2. Open the Lines flyout and confirm tools are listed.
console.log("LINES_FLYOUT:", await evalJs(`(async () => {
  const g = document.querySelectorAll('.draw-rail .tool-group')[0];
  g.querySelector('.tool-btn').click();
  await new Promise(r=>setTimeout(r,250));
  const items = [...document.querySelectorAll('.tool-flyout .flyout-item')].map(b=>b.textContent.trim());
  return JSON.stringify({ count: items.length, items: items.slice(0,5) });
})()`));

// 3. Draw a trend line with real pointer events on the overlay canvas.
console.log("DRAW_TRENDLINE:", await evalJs(`(async () => {
  // pick the trend line tool from the open flyout
  const items = [...document.querySelectorAll('.tool-flyout .flyout-item')];
  const tl = items.find(b => b.textContent.includes('Trend Line'));
  if (!tl) return 'no trend line item';
  tl.click();
  await new Promise(r=>setTimeout(r,250));

  const c = document.querySelector('.draw-canvas');
  const r = c.getBoundingClientRect();
  const down = (x,y) => c.dispatchEvent(new PointerEvent('pointerdown', {
    bubbles:true, clientX:r.left+x, clientY:r.top+y, pointerId:1, button:0, buttons:1,
  }));
  const move = (x,y) => c.dispatchEvent(new PointerEvent('pointermove', {
    bubbles:true, clientX:r.left+x, clientY:r.top+y, pointerId:1, buttons:1,
  }));
  const up = (x,y) => c.dispatchEvent(new PointerEvent('pointerup', {
    bubbles:true, clientX:r.left+x, clientY:r.top+y, pointerId:1, button:0, buttons:0,
  }));

  down(300, 400); move(500, 300); move(700, 220); up(700, 220);
  await new Promise(r=>setTimeout(r,350));

  // count opaque pixels on the overlay: proves something was painted
  const ctx = c.getContext('2d');
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let opaque = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 8) opaque++;
  return JSON.stringify({
    toolLabel: document.querySelector('.active-tool')?.textContent,
    paintedPixels: opaque,
    railCount: document.querySelector('.rail-count')?.textContent,
  });
})()`));

// 4. Draw a Fib retracement and a rectangle too.
console.log("MORE_SHAPES:", await evalJs(`(async () => {
  const results = [];
  const openAndPick = async (groupIdx, label) => {
    const g = document.querySelectorAll('.draw-rail .tool-group')[groupIdx];
    g.querySelector('.tool-btn').click();
    await new Promise(r=>setTimeout(r,200));
    const item = [...document.querySelectorAll('.tool-flyout .flyout-item')]
      .find(b => b.textContent.includes(label));
    if (!item) return false;
    item.click();
    await new Promise(r=>setTimeout(r,200));
    return true;
  };

  const c = document.querySelector('.draw-canvas');
  const rect = c.getBoundingClientRect();
  const ev = (type, x, y, buttons) => c.dispatchEvent(new PointerEvent(type, {
    bubbles:true, clientX:rect.left+x, clientY:rect.top+y, pointerId:1, button:0, buttons,
  }));

  // Fibonacci group is index 3
  if (await openAndPick(3, 'Fib Retracement')) {
    ev('pointerdown', 400, 250, 1); ev('pointermove', 800, 500, 1); ev('pointerup', 800, 500, 0);
    await new Promise(r=>setTimeout(r,250));
    results.push('fib');
  }
  // Shapes group is index 2
  if (await openAndPick(2, 'Rectangle')) {
    ev('pointerdown', 500, 600, 1); ev('pointermove', 900, 750, 1); ev('pointerup', 900, 750, 0);
    await new Promise(r=>setTimeout(r,250));
    results.push('rect');
  }

  const ctx = c.getContext('2d');
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let opaque = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 8) opaque++;
  return JSON.stringify({ created: results, paintedPixels: opaque, count: document.querySelector('.rail-count')?.textContent });
})()`));

// 4b. Screenshot with everything drawn (the undo step below removes it).
{
  const shot = await send("Page.captureScreenshot", { format: "png" });
  if (shot.result?.data) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync("/tmp/fx-drawings-all.png", Buffer.from(shot.result.data, "base64"));
    console.log("screenshot /tmp/fx-drawings-all.png (all shapes)");
  }
}

// 5. Undo twice and confirm the painting shrinks (proves undo repaints).
console.log("UNDO:", await evalJs(`(async () => {
  const countOf = () => {
    const c = document.querySelector('.draw-canvas');
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
    return n;
  };
  const before = countOf();
  const undoBtn = [...document.querySelectorAll('.draw-rail .tool-btn')].find(b => b.title.includes('Undo'));
  if (!undoBtn) return 'no undo button';
  undoBtn.click();
  await new Promise(r=>setTimeout(r,300));
  undoBtn.click();
  await new Promise(r=>setTimeout(r,300));
  return JSON.stringify({ before, after: countOf(), count: document.querySelector('.rail-count')?.textContent });
})()`));

const shot = await send("Page.captureScreenshot", { format: "png" });
if (shot.result?.data) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync("/tmp/fx-drawings.png", Buffer.from(shot.result.data, "base64"));
  console.log("screenshot /tmp/fx-drawings.png");
}
ws.close();
JS

echo "=== errors ==="
grep -iE "\b(error|exception|uncaught)\b" "$LOG" \
  | grep -viE "bus\.cc|gpu|vulkan|libva|gbm|dri3|MESA|fontconfig|sandbox|X11|NODE_OPTION" | head -6 || echo "  (none)"
kill "$APP_PID" 2>/dev/null; wait "$APP_PID" 2>/dev/null
