#!/usr/bin/env node
/**
 * Is the chart actually painting candles?
 *
 * A screenshot in a headless X server can come out blank for environmental reasons, so "the chart
 * looks empty" is not evidence either way. Reading the canvas's own pixels is: count how many
 * pixels differ from the background colour. A chart with candles has thousands; an empty one has
 * almost none.
 *
 * Run twice — panel open, then panel hidden — because a resize that breaks painting would be a
 * real bug in the toggle, not an environment artefact.
 */
const PORT = process.argv[2] ?? "18271";
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
  if (r.result?.exceptionDetails) return { EXC: r.result.exceptionDetails.exception?.description?.slice(0, 300) };
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(3200);

await ev(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  document.querySelector('[data-mode="live"]')?.click();
  await w(400);
  const go = document.querySelector('[data-action="start-go"]');
  if (go && !go.disabled) go.click();
  for (let i = 0; i < 80 && !document.querySelector('.chart-host'); i++) await w(400);
})()`);
await sleep(6000);

const probe = `(() => {
  const host = document.querySelector('.chart-host');
  const canvases = [...(host?.querySelectorAll('canvas') ?? [])];
  const report = canvases.map((c) => {
    // read the real pixels; a tainted canvas would throw, and there is no cross-origin content here
    let nonBg = 0, sampled = 0;
    try {
      const ctx = c.getContext('2d');
      if (!ctx) return { w: c.width, h: c.height, mode: "no-2d-context" };
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      // sample every 4th pixel in each axis: full scan of a 1400x800 canvas is slow
      for (let y = 0; y < c.height; y += 4) {
        for (let x = 0; x < c.width; x += 4) {
          const i = (y * c.width + x) * 4;
          sampled++;
          const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
          // background is ~#131722; anything materially brighter is content
          if (a > 0 && (r > 40 || g > 44 || b > 55)) nonBg++;
        }
      }
    } catch (e) {
      return { w: c.width, h: c.height, mode: "read-failed", err: String(e).slice(0, 80) };
    }
    return {
      w: c.width, h: c.height, sampled,
      nonBgPixels: nonBg,
      contentPercent: sampled > 0 ? +(100 * nonBg / sampled).toFixed(2) : 0,
      painted: nonBg > 200,
    };
  });
  return JSON.stringify({
    canvasCount: canvases.length,
    canvases: report,
    anyPainted: report.some((r) => r.painted),
    legend: (document.querySelector('.legend')?.textContent ?? '').slice(0, 40),
  });
})()`;

console.log("PANEL OPEN  :", await ev(probe));

await ev(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  const btn = document.querySelector('[data-action="panel-toggle"]');
  if (btn?.getAttribute('aria-pressed') === 'true') { btn.click(); await w(2000); }
})()`);
await sleep(3000);
console.log("PANEL HIDDEN:", await ev(probe));

await ev(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  const btn = document.querySelector('[data-action="panel-toggle"]');
  if (btn?.getAttribute('aria-pressed') === 'false') { btn.click(); await w(2000); }
})()`);
await sleep(3000);
console.log("RESTORED    :", await ev(probe));

ws.close();
