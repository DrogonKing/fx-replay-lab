#!/usr/bin/env node
/**
 * Call the login IPC from the renderer and print the FULL result, plus the underlying cause.
 *
 * "fetch failed" is a wrapper. The useful part is `cause`, which the current code throws away — so
 * the first job here is to see what it actually is before deciding what to fix.
 */
const PORT = process.argv[2] ?? "18351";
const BRIDGE = process.argv[3];
if (!BRIDGE) { console.log("pass a bridge url"); process.exit(1); }

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
  if (r.result?.exceptionDetails) return { EXC: r.result.exceptionDetails.exception?.description?.slice(0, 500) };
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(3000);

// renderer-side fetch to the same URL: if this works, the problem is in main/IPC
console.log("renderer fetch to /health:", await ev(`
  fetch('${BRIDGE}/health').then(r => 'HTTP ' + r.status).catch(e => 'ERR ' + e.message + ' / ' + (e.cause && e.cause.code))
`));

console.log("IPC testBridge:", JSON.stringify(await ev(`
  window.fxlab.testBridge('${BRIDGE}')
`)));

console.log("IPC bridgeLogin:", JSON.stringify(await ev(`
  window.fxlab.bridgeLogin({ url: '${BRIDGE}', login: '10000001', password: 'p', server: 'Stub-Demo' })
`)));

// and the same POST from the renderer, to see whether main is the odd one out
console.log("renderer POST /login:", await ev(`
  fetch('${BRIDGE}/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: '10000001', password: 'p', server: 'Stub-Demo' }),
  }).then(r => r.text()).then(t => t.slice(0, 120)).catch(e => 'ERR ' + e.message + ' / ' + (e.cause && e.cause.code))
`));

ws.close();
