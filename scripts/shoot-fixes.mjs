#!/usr/bin/env node
/**
 * Screenshot the two fixed states: timezone dialog anchored below its button, and a tool flyout
 * open beside the rail with the active tool showing.
 */
import { writeFileSync } from "node:fs";

const PORT = process.argv[2] ?? "18241";
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
await send("Emulation.setDeviceMetricsOverride", {
  width: 1500, height: 940, deviceScaleFactor: 1.5, mobile: false,
});
const ev = async (e) => {
  const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { EXC: r.result.exceptionDetails.exception?.description?.slice(0, 200) };
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(3000);

// get a session with a chart
await ev(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  document.querySelector('[data-mode="live"]')?.click();
  await w(400);
  const go = document.querySelector('[data-action="start-go"]');
  if (go && !go.disabled) go.click();
  for (let i = 0; i < 80 && !document.querySelector('.chart-host'); i++) await w(400);
})()`);
await sleep(2500);

// open a tool family so the portalled flyout is visible
await ev(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  const rail = document.querySelector('[data-rail="draw"]');
  [...rail.querySelectorAll('[data-group]')][1]?.click();
  await w(500);
  const item = [...document.querySelectorAll('[data-tool-item]')].find(b => /fib/i.test(b.textContent ?? ''));
  item?.click();
  await w(400);
  // leave the flyout open for the shot
  [...rail.querySelectorAll('[data-group]')][1]?.click();
  await w(500);
})()`);
await sleep(900);

const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync("/tmp/fx-rail-fixed.png", Buffer.from(shot.result.data, "base64"));
console.log("rail shot saved");

// now the timezone dialog
await ev(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  document.querySelector('[data-action="tz-open"]')?.click();
  await w(700);
})()`);
await sleep(900);
const shot2 = await send("Page.captureScreenshot", { format: "png" });
writeFileSync("/tmp/fx-tz-fixed.png", Buffer.from(shot2.result.data, "base64"));
console.log("tz shot saved");

ws.close();
