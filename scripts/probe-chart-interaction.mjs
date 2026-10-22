#!/usr/bin/env node
/**
 * Why can't the chart be zoomed or dragged?
 *
 * Hypothesis: the drawing overlay (`.draw-canvas`) is a full-area canvas stacked ABOVE the chart
 * with default pointer-events, so it swallows every wheel and drag. That would explain both
 * symptoms at once, and it is testable without guessing: ask the DOM who is on top at the centre of
 * the chart, read pointer-events, then send a real wheel event through CDP and see whether the
 * visible time range changes.
 */
const PORT = process.argv[2] ?? "18421";
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
  await w(3000);
})()`);
await sleep(2500);

console.log("C1. WHO IS ON TOP AT THE MIDDLE OF THE CHART?", await ev(`(() => {
  const host = document.querySelector('.chart-host');
  const r = host.getBoundingClientRect();
  const x = Math.round(r.left + r.width / 2);
  const y = Math.round(r.top + r.height / 2);
  const top = document.elementFromPoint(x, y);
  const overlay = document.querySelector('.draw-canvas');
  const os = overlay ? getComputedStyle(overlay) : null;
  const or = overlay ? overlay.getBoundingClientRect() : null;
  return JSON.stringify({
    point: { x, y },
    topElement: top ? (top.className || top.tagName) : null,
    overlay: {
      present: !!overlay,
      pointerEvents: os ? os.pointerEvents : null,
      zIndex: os ? os.zIndex : null,
      // does it cover the whole chart?
      coversChart: !!(or && r && or.width >= r.width - 2 && or.height >= r.height - 2),
      size: or ? { w: Math.round(or.width), h: Math.round(or.height) } : null,
    },
    chartSize: { w: Math.round(r.width), h: Math.round(r.height) },
    topIsOverlay: !!(top && (top.classList?.contains('draw-canvas'))),
  });
})()`));

console.log("C2. THE VISIBLE TIME RANGE BEFORE ANY INPUT:", await ev(`(() => {
  // the chart instance is not exposed, so read the axis labels as the observable proxy
  const labels = [...document.querySelectorAll('.chart-host canvas')].length;
  const axisText = document.querySelector('.legend')?.textContent ?? '';
  return JSON.stringify({ canvases: labels, legend: axisText.slice(0, 30) });
})()`));

// A real wheel event through CDP's Input domain, at the chart's centre.
const box = await ev(`(() => {
  const r = document.querySelector('.chart-host').getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`);
console.log("C3. SENDING A REAL WHEEL AT", box);

// capture a screenshot of the plot area so the before/after can be compared by pixels, not by trust
const shotBefore = await send("Page.captureScreenshot", { format: "png" });
const beforeData = shotBefore.result.data;

for (let i = 0; i < 6; i++) {
  await send("Input.dispatchMouseEvent", {
    type: "mouseWheel", x: box.x, y: box.y,
    deltaX: 0, deltaY: -120, modifiers: 0,
  });
  await sleep(160);
}
await sleep(900);

const shotAfter = await send("Page.captureScreenshot", { format: "png" });
const changed = beforeData !== shotAfter.result.data;
console.log("C4. DID THE CHART REACT TO THE WHEEL?", JSON.stringify({ pixelsChanged: changed }));

// and a real drag: press, move, release
console.log("C5. SENDING A REAL DRAG:", await (async () => {
  const shotPre = await send("Page.captureScreenshot", { format: "png" });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
  for (let i = 1; i <= 8; i++) {
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved", x: box.x - i * 18, y: box.y, button: "left", buttons: 1,
    });
    await sleep(40);
  }
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x - 144, y: box.y, button: "left", clickCount: 1 });
  await sleep(800);
  const shotPost = await send("Page.captureScreenshot", { format: "png" });
  return JSON.stringify({ pixelsChanged: shotPre.result.data !== shotPost.result.data });
})());

console.log("C6. ASK THE CHART DIRECTLY — is it even receiving events?", await ev(`(() => {
  const overlay = document.querySelector('.draw-canvas');
  const host = document.querySelector('.chart-host');
  // install a probe that counts events arriving at each layer, then clear it
  const count = { overlay: 0, host: 0, document: 0 };
  const onWheelDoc = () => { count.document++; };
  document.addEventListener('wheel', onWheelDoc, { passive: true, once: false });
  return JSON.stringify({
    overlayPointerEvents: overlay ? getComputedStyle(overlay).pointerEvents : 'no overlay',
    hostPointerEvents: host ? getComputedStyle(host).pointerEvents : null,
    chartChildren: host?.children.length ?? 0,
    // Lightweight Charts puts its own canvases inside the host
    canvasesInHost: host?.querySelectorAll('canvas').length ?? 0,
    firstChildClass: host?.firstElementChild?.className ?? null,
  });
})()`));

ws.close();
