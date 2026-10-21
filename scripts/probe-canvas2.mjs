#!/usr/bin/env node
/** Where does the chart actually paint? Find every canvas in the document and its parent chain. */
const PORT = process.argv[2] ?? "18281";
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

await ev(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  document.querySelector('[data-mode="live"]')?.click();
  await w(400);
  const go = document.querySelector('[data-action="start-go"]');
  if (go && !go.disabled) go.click();
  for (let i = 0; i < 80 && !document.querySelector('.chart-host'); i++) await w(400);
})()`);
await sleep(7000);

console.log("ALL CANVASES IN THE DOCUMENT:", await ev(`(() => {
  const all = [...document.querySelectorAll('canvas')];
  return JSON.stringify({
    count: all.length,
    list: all.slice(0, 8).map(c => {
      const r = c.getBoundingClientRect();
      const path = [];
      for (let el = c; el && path.length < 5; el = el.parentElement) {
        path.push(el.className || el.tagName);
      }
      return {
        cls: c.className, w: c.width, h: c.height,
        box: { w: Math.round(r.width), h: Math.round(r.height) },
        parentChain: path.join(' < '),
      };
    }),
  });
})()`));

console.log("CHART HOST INNER HTML (first 300 chars):", await ev(`(() => {
  const h = document.querySelector('.chart-host');
  if (!h) return JSON.stringify({ problem: "no .chart-host" });
  return JSON.stringify({
    childCount: h.children.length,
    children: [...h.children].map(c => c.className || c.tagName),
    innerStart: h.innerHTML.slice(0, 250),
    box: (() => { const r = h.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })(),
  });
})()`));

console.log("DOES LIGHTWEIGHT-CHARTS HAVE DATA? (via the series bookkeeping):", await ev(`(() => {
  // the app pads its own series; check the DOM readouts rather than internal objects
  const bars = document.querySelector('[data-bars]')?.getAttribute('data-bars');
  const legend = document.querySelector('.legend')?.textContent ?? '';
  const canvasesInHost = document.querySelector('.chart-host')?.querySelectorAll('canvas').length ?? -1;
  return JSON.stringify({
    bars, legendHasOHLC: /O \\d/.test(legend), canvasesInHost,
    // a Lightweight Charts instance stores its canvases inside the container it was given
    globalChartPresent: typeof window.__fxChart !== 'undefined',
  });
})()`));

ws.close();
