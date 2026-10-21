#!/usr/bin/env node
/** Capture every console message and page error from the renderer while a session starts. */
const PORT = process.argv[2] ?? "18291";
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 1;
const pending = new Map();
const logs = [];
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === "Runtime.consoleAPICalled") {
    const args = (m.params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(" ");
    logs.push(`[${m.params.type}] ${args}`.slice(0, 300));
  }
  if (m.method === "Runtime.exceptionThrown") {
    const d = m.params.exceptionDetails;
    logs.push(`[EXCEPTION] ${d.exception?.description ?? d.text}`.slice(0, 500));
  }
});
const send = (method, params = {}) =>
  new Promise((res) => { const id = seq++; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
await new Promise((r) => ws.addEventListener("open", r));
await send("Runtime.enable");
await send("Log.enable");
const ev = async (e) => {
  const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { EXC: r.result.exceptionDetails.exception?.description?.slice(0, 300) };
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(3000);

console.log("BEFORE CLICK — is the start screen up?", await ev(`JSON.stringify({
  startScreen: !!document.querySelector('[data-panel="start"]'),
  chartHost: !!document.querySelector('.chart-host'),
  rootChildren: document.getElementById('root')?.children.length ?? 0,
})`));

await ev(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  document.querySelector('[data-mode="live"]')?.click();
  await w(500);
  const go = document.querySelector('[data-action="start-go"]');
  if (go && !go.disabled) go.click();
  for (let i = 0; i < 60 && !document.querySelector('.chart-host'); i++) await w(400);
})()`);
await sleep(6000);

console.log("AFTER CLICK — chart host and canvases:", await ev(`JSON.stringify({
  chartHost: !!document.querySelector('.chart-host'),
  hostChildren: document.querySelector('.chart-host')?.children.length ?? -1,
  canvasesInHost: document.querySelector('.chart-host')?.querySelectorAll('canvas').length ?? -1,
  totalCanvases: document.querySelectorAll('canvas').length,
  legend: (document.querySelector('.legend')?.textContent ?? "").slice(0, 30),
})`));

console.log("\n=== CONSOLE / EXCEPTIONS ===");
for (const l of logs.slice(-25)) console.log("  " + l);
if (logs.length === 0) console.log("  (none captured)");

ws.close();
