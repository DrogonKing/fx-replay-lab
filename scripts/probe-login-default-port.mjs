#!/usr/bin/env node
/**
 * Click the real login button with the bridge on the app's DEFAULT port, so no URL editing is
 * involved. This separates "the button is broken" from "my previous test failed to change the URL".
 */
const PORT = process.argv[2] ?? "18361";
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 1;
const pending = new Map();
const logs = [];
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === "Runtime.exceptionThrown") {
    logs.push(`[exception] ${(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text)}`.slice(0, 300));
  }
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
})()`);
await sleep(1500);

console.log("URL field value (default port, untouched):", await ev(
  `document.querySelector('[data-field="br-url"]')?.value`));

console.log("probe state before login:", await ev(`JSON.stringify({
  verdict: document.querySelector('[data-note="br-verdict"]')?.getAttribute('data-verdict'),
  text: (document.querySelector('[data-note="br-verdict"]')?.textContent ?? '').slice(0, 70),
})`));

console.log("FILL AND CLICK THE REAL BUTTON:", await ev(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  const setNative = (sel, v) => {
    const el = document.querySelector(sel);
    if (!el) return 'missing ' + sel;
    const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    d.set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value;
  };
  setNative('[data-field="br-login"]', '10000001');
  setNative('[data-field="br-password"]', 'stub-password');
  setNative('[data-field="br-server"]', 'Stub-Demo');
  await w(500);
  const before = {
    login: document.querySelector('[data-field="br-login"]')?.value,
    server: document.querySelector('[data-field="br-server"]')?.value,
    btnText: document.querySelector('[data-action="br-login"]')?.textContent?.trim(),
  };
  document.querySelector('[data-action="br-login"]')?.click();
  for (let i = 0; i < 24; i++) {
    const v = document.querySelector('[data-note="br-login-verdict"]');
    const verdict = v?.getAttribute('data-verdict');
    if (verdict === 'ok' || verdict === 'fail') break;
    await w(500);
  }
  const v = document.querySelector('[data-note="br-login-verdict"]');
  return JSON.stringify({
    valuesBeforeClick: before,
    verdict: v?.getAttribute('data-verdict'),
    message: (v?.textContent ?? '').slice(0, 120),
    passwordCleared: (document.querySelector('[data-field="br-password"]')?.value ?? 'x') === '',
  });
})()`));

if (logs.length) {
  console.log("exceptions:", logs.slice(-4));
}
ws.close();
