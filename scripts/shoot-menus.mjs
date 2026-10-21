#!/usr/bin/env node
/** Screenshot the timeframe menu open, with favourites pinned. */
import { writeFileSync } from "node:fs";

const PORT = process.argv[2] ?? "18321";
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

// start screen first
const startShot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync("/tmp/fx-start-noinst.png", Buffer.from(startShot.result.data, "base64"));
console.log("start screen shot saved");

await ev(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  document.querySelector('[data-mode="live"]')?.click();
  await w(400);
  const go = document.querySelector('[data-action="start-go"]');
  if (go && !go.disabled) go.click();
  for (let i = 0; i < 80 && !document.querySelector('.chart-host'); i++) await w(400);
  for (let i = 0; i < 30; i++) {
    if (document.querySelectorAll('.chart-host canvas').length > 3) break;
    await w(400);
  }
  await w(2500);
})()`);
await sleep(2500);

// open the timeframe menu
await ev(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  document.querySelector('[data-action="tf-open"]')?.click();
  await w(800);
})()`);
await sleep(1200);
const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync("/tmp/fx-tf-menu.png", Buffer.from(shot.result.data, "base64"));
console.log("tf menu shot saved");

// and the symbol menu
await ev(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  document.querySelector('[data-action="tf-open"]')?.click();
  await w(400);
  document.querySelector('[data-action="sym-open"]')?.click();
  await w(800);
})()`);
await sleep(1200);
const shot2 = await send("Page.captureScreenshot", { format: "png" });
writeFileSync("/tmp/fx-sym-menu.png", Buffer.from(shot2.result.data, "base64"));
console.log("symbol menu shot saved");
ws.close();
