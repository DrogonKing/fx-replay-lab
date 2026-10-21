#!/usr/bin/env node
/** Screenshot the panel hidden, showing the chart at full width. */
import { writeFileSync } from "node:fs";

const PORT = process.argv[2] ?? "18261";
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
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 940, deviceScaleFactor: 1.5, mobile: false });
const ev = async (e) => {
  const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { EXC: r.result.exceptionDetails.exception?.description?.slice(0, 200) };
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
await sleep(4000);

// hide the panel
await ev(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  const btn = document.querySelector('[data-action="panel-toggle"]');
  if (btn?.getAttribute('aria-pressed') === 'true') { btn.click(); await w(800); }
})()`);
// Wait for bars to actually paint. An empty chart in the screenshot would be a true picture of a
// moment but a false picture of the feature, and this shot exists to show the feature working.
await ev(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 40; i++) {
    const host = document.querySelector('.chart-host');
    const c = host?.querySelector('canvas');
    if (c && c.width > 200 && /GC=F|XAU/.test(document.querySelector('.legend')?.textContent ?? '')) break;
    await w(500);
  }
  await w(2500);
})()`);
await sleep(2500);
const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync("/tmp/fx-panel-hidden.png", Buffer.from(shot.result.data, "base64"));
console.log("panel-hidden shot saved");
ws.close();
