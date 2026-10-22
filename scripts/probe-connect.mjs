#!/usr/bin/env node
/**
 * The Connect button, tested where the bridge cannot run.
 *
 * On Linux the bundled runtime is win_amd64, so `resolveBridgePaths` must report unavailable with a
 * reason, the panel must show that reason, and the button must be disabled rather than firing a
 * request into nothing. That is the honest behaviour to verify here — a green "connected" on this
 * host would mean the code is lying, because there is no MetaTrader to connect to.
 *
 * Also verifies the HTTP/IPC layer with a stub bridge, so the parts that CAN be proven are proven.
 */
const PORT = process.argv[2] ?? "18441";
const STUB = process.argv[3] ?? null;

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
  document.querySelector('[data-tab="broker"]')?.click();
  await w(1000);
})()`);
await sleep(1500);

console.log("B1. THE APP REPORTS THE RUNTIME TRUTHFULLY ON THIS PLATFORM:", await ev(`
  (async () => JSON.stringify(await window.fxlab.bridgeAvailability()))()
`));

console.log("B2. THE PANEL SHOWS THE REASON AND DISABLES CONNECT:", await ev(`(() => {
  const note = document.querySelector('[data-note="br-unavailable"]');
  const btn = document.querySelector('[data-action="br-connect"]');
  const oldHowto = document.querySelector('[data-note="br-bridge-howto"]');
  return JSON.stringify({
    // the manual instructions must be gone: the app owns the setup now
    manualInstructionsRemoved: !oldHowto,
    reasonShown: !!note,
    reasonText: (note?.textContent ?? '').slice(0, 110),
    connectButtonPresent: !!btn,
    connectDisabled: btn?.disabled,
    fieldsPresent: ['br-login','br-password','br-server'].every(f => !!document.querySelector('[data-field="'+f+'"]')),
  });
})()`));

console.log("B3. CLICKING CONNECT WITH NO RUNTIME SAYS SO, AND DOES NOT HANG:", await ev(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  const setNative = (sel, v) => {
    const el = document.querySelector(sel);
    if (!el) return;
    const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    d.set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  // the user's real account number is NOT used anywhere in this file
  setNative('[data-field="br-login"]', '10000001');
  setNative('[data-field="br-password"]', 'probe-secret');
  setNative('[data-field="br-server"]', 'Probe-Demo');
  await w(400);
  const btn = document.querySelector('[data-action="br-connect"]');
  if (btn?.disabled) {
    return JSON.stringify({ skipped: true, because: 'button correctly disabled without a runtime' });
  }
  btn?.click();
  for (let i = 0; i < 20; i++) {
    const v = document.querySelector('[data-note="br-connect-verdict"]');
    if (v) break;
    await w(500);
  }
  const v = document.querySelector('[data-note="br-connect-verdict"]');
  return JSON.stringify({
    verdict: v?.getAttribute('data-verdict'),
    message: (v?.textContent ?? '').slice(0, 150),
    passwordLeaked: (v?.textContent ?? '').includes('probe-secret'),
  });
})()`));

if (STUB) {
  console.log("B4. THE HTTP LAYER, AGAINST A STUB BRIDGE (the part that can be proven here):", await ev(`
    (async () => {
      const probe = await window.fxlab.testBridge('${STUB}');
      const login = await window.fxlab.bridgeConnect
        ? await window.fxlab.bridgeLogin({ url: '${STUB}', login: '10000001', password: 'x', server: 'Stub' })
        : null;
      return JSON.stringify({
        probeOk: probe?.ok,
        symbols: probe?.symbols?.length ?? 0,
        bars: probe?.bars,
        loginOk: login?.ok,
        account: login?.account,
      });
    })()
  `));
}

console.log("B5. NO RENDERER CRASH:", await ev(`JSON.stringify({
  rendererAlive: (document.getElementById('root')?.children.length ?? 0) > 0,
  hasChart: !!document.querySelector('.chart-host'),
})`));

ws.close();
