#!/usr/bin/env node
/** Screenshot the broker panel: the how-to block and the actionable failure message. */
import { writeFileSync } from "node:fs";

const PORT = process.argv[2] ?? "18381";
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
await send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 1080, deviceScaleFactor: 1.5, mobile: false });
const ev = async (e) => {
  const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { EXC: r.result.exceptionDetails.exception?.description?.slice(0, 200) };
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(3200);

await ev(`localStorage.clear()`);
await send("Page.reload");
await sleep(4000);
await ev(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  document.querySelector('[data-mode="live"]')?.click();
  await w(400);
  const go = document.querySelector('[data-action="start-go"]');
  if (go && !go.disabled) go.click();
  for (let i = 0; i < 70 && !document.querySelector('.chart-host'); i++) await w(400);
  document.querySelector('[data-tab="broker"]')?.click();
  await w(1000);
  // show the real failure a user with no bridge sees
  const setNative = (sel, v) => {
    const el = document.querySelector(sel);
    if (!el) return;
    const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    d.set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  setNative('[data-field="br-login"]', '53109710');
  setNative('[data-field="br-server"]', 'ICMarketsEU-Demo');
  await w(400);
  document.querySelector('[data-action="br-login"]')?.click();
  for (let i = 0; i < 18; i++) {
    const v = document.querySelector('[data-note="br-login-verdict"]');
    if (v?.getAttribute('data-verdict') === 'fail') break;
    await w(500);
  }
  await w(500);
})()`);
await sleep(1500);
const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync("/tmp/fx-login-explained.png", Buffer.from(shot.result.data, "base64"));
console.log("login shot saved");
ws.close();
