#!/usr/bin/env node
/**
 * The overlay is now click-through with no tool selected. That must not break DRAWING.
 *
 * Assertions:
 *   - no tool: overlay is pointer-events none, wheel and drag reach the chart
 *   - tool chosen: overlay takes input again (pointer-events auto) and a real click-drag on the
 *     chart creates a drawing, so the fix did not trade one broken interaction for another
 */
const PORT = process.argv[2] ?? "18431";
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 1;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) =>
  new Promise((res) => { const id = seq++; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
await new Promise((r) => ws.addEventListener("open", r));
await send("Runtime.enable");
const ev = async (e) => {
  const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { EXC: r.result.exceptionDetails.exception?.description?.slice(0, 400) };
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(3200);
await ev(`localStorage.clear()`);
await send("Page.enable");
await send("Page.reload");
await sleep(4200);
await ev(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  document.querySelector('[data-mode="live"]')?.click();
  await w(400);
  const go = document.querySelector('[data-action="start-go"]');
  if (go && !go.disabled) go.click();
  for (let i = 0; i < 70 && !document.querySelector('.chart-host'); i++) await w(400);
  await w(2500);
})()`);
await sleep(2000);

const box = await ev(`(() => {
  const r = document.querySelector('.chart-host').getBoundingClientRect();
  return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2),
           left: Math.round(r.left), top: Math.round(r.top) };
})()`);

console.log("T1. NO TOOL — CHART OWNS THE INPUT:", await ev(`(() => {
  const o = document.querySelector('.draw-canvas');
  const area = document.querySelector('.chart-area');
  const top = document.elementFromPoint(${box.x}, ${box.y});
  return JSON.stringify({
    toolActiveAttr: area?.getAttribute('data-tool-active'),
    overlayPointerEvents: getComputedStyle(o).pointerEvents,
    topElementIsChart: !!(top && !top.classList?.contains('draw-canvas')),
  });
})()`));

console.log("T2. REAL WHEEL ZOOMS:", await (async () => {
  const pre = (await send("Page.captureScreenshot", { format: "png" })).result.data;
  for (let i = 0; i < 5; i++) {
    await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: box.x, y: box.y, deltaX: 0, deltaY: -120 });
    await sleep(150);
  }
  await sleep(700);
  const post = (await send("Page.captureScreenshot", { format: "png" })).result.data;
  return JSON.stringify({ zoomed: pre !== post });
})());

console.log("T3. REAL DRAG PANS:", await (async () => {
  const pre = (await send("Page.captureScreenshot", { format: "png" })).result.data;
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
  for (let i = 1; i <= 8; i++) {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x - i * 16, y: box.y, button: "left", buttons: 1 });
    await sleep(35);
  }
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x - 128, y: box.y, button: "left", clickCount: 1 });
  await sleep(700);
  const post = (await send("Page.captureScreenshot", { format: "png" })).result.data;
  return JSON.stringify({ panned: pre !== post });
})());

console.log("T4. PICKING A TOOL GIVES INPUT BACK TO THE OVERLAY:", await ev(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  // choose the trend line tool from the rail
  const rail = document.querySelector('[data-rail="draw"]');
  [...rail.querySelectorAll('[data-group]')][0]?.click();
  await w(500);
  const item = document.querySelector('[data-tool-item="trend-line"]') || document.querySelector('[data-tool-item]');
  const kind = item?.getAttribute('data-tool-item');
  item?.click();
  await w(600);
  const o = document.querySelector('.draw-canvas');
  const area = document.querySelector('.chart-area');
  const top = document.elementFromPoint(${box.x}, ${box.y});
  return JSON.stringify({
    choseTool: kind,
    toolActiveAttr: area?.getAttribute('data-tool-active'),
    overlayPointerEvents: getComputedStyle(o).pointerEvents,
    topIsOverlay: !!(top && top.classList?.contains('draw-canvas')),
    cursor: getComputedStyle(o).cursor,
  });
})()`));

console.log("T5. AND A REAL CLICK-DRAG NOW DRAWS:", await (async () => {
  const pre = (await send("Page.captureScreenshot", { format: "png" })).result.data;
  const a = { x: box.x - 160, y: box.y - 90 };
  const b = { x: box.x + 140, y: box.y + 70 };
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: a.x, y: a.y });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: a.x, y: a.y, button: "left", clickCount: 1 });
  for (let i = 1; i <= 6; i++) {
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: Math.round(a.x + (b.x - a.x) * i / 6),
      y: Math.round(a.y + (b.y - a.y) * i / 6),
      button: "left", buttons: 1,
    });
    await sleep(50);
  }
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: b.x, y: b.y, button: "left", clickCount: 1 });
  await sleep(900);
  const post = (await send("Page.captureScreenshot", { format: "png" })).result.data;
  const count = await ev(`document.querySelectorAll('[data-drawing-count], .active-tool').length`);
  const label = await ev(`(document.querySelector('.active-tool')?.textContent ?? '').trim()`);
  return JSON.stringify({ drawingAppeared: pre !== post, activeToolShown: label });
})());

console.log("T6. ESC RETURNS TO CURSOR, AND ZOOM WORKS AGAIN:", await (async () => {
  await ev(`(async () => {
    const w = (ms) => new Promise(r => setTimeout(r, ms));
    document.body.focus();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true }));
    await w(600);
  })()`);
  await sleep(500);
  const state = await ev(`(() => {
    const o = document.querySelector('.draw-canvas');
    return JSON.stringify({
      toolActiveAttr: document.querySelector('.chart-area')?.getAttribute('data-tool-active'),
      overlayPointerEvents: getComputedStyle(o).pointerEvents,
    });
  })()`);
  const pre = (await send("Page.captureScreenshot", { format: "png" })).result.data;
  await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: box.x, y: box.y, deltaX: 0, deltaY: 120 });
  await sleep(600);
  const post = (await send("Page.captureScreenshot", { format: "png" })).result.data;
  return `${state} zoomWorks=${pre !== post}`;
})());

ws.close();
