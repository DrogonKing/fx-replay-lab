#!/usr/bin/env node
/**
 * The login button was working and still felt broken, because the failure said "fetch failed" and
 * nothing on screen mentioned the prerequisite. Both are asserted here:
 *   - the how-to block is visible with the exact command
 *   - a missing bridge produces a message that names the cause and the next action
 */
const PORT = process.argv[2] ?? "18371";
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
await sleep(1200);

console.log("H1. THE PREREQUISITE IS ON SCREEN:", await ev(`(() => {
  const block = document.querySelector('[data-note="br-bridge-howto"]');
  const text = block?.textContent ?? '';
  return JSON.stringify({
    blockPresent: !!block,
    hasCommand: /python bridge\\/mt5-bridge\\.py/.test(text),
    mentionsPython: /Python|پایتون/i.test(text),
    mentionsMetaTrader: /MetaTrader|متاتریدر/i.test(text),
    steps: block?.querySelectorAll('li').length ?? 0,
    visible: !!block && block.getBoundingClientRect().height > 20,
  });
})()`));

console.log("H2. LOGIN WITH NO BRIDGE GIVES AN ACTIONABLE MESSAGE:", await ev(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  const setNative = (sel, v) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    d.set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  };
  // a port with nothing on it, and fake credentials - never the user's
  setNative('[data-field="br-url"]', 'http://127.0.0.1:18777');
  setNative('[data-field="br-login"]', '10000001');
  setNative('[data-field="br-password"]', 'probe-only-secret');
  setNative('[data-field="br-server"]', 'Probe-Demo');
  await w(500);
  document.querySelector('[data-action="br-login"]')?.click();
  for (let i = 0; i < 20; i++) {
    const v = document.querySelector('[data-note="br-login-verdict"]');
    if (v?.getAttribute('data-verdict') === 'fail') break;
    await w(500);
  }
  const v = document.querySelector('[data-note="br-login-verdict"]');
  const msg = v?.textContent ?? '';
  return JSON.stringify({
    verdict: v?.getAttribute('data-verdict'),
    message: msg.slice(0, 180),
    // the old message was literally 'could not reach the bridge: fetch failed'
    stillSaysFetchFailed: /fetch failed/i.test(msg),
    namesTheProblem: /not running|nothing is listening|bridge/i.test(msg),
    saysHowToStart: /mt5-bridge\\.py/i.test(msg),
    passwordLeaked: msg.includes('probe-only-secret'),
  });
})()`));

console.log("H3. PROBE ALSO EXPLAINS ITSELF NOW:", await ev(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  document.querySelector('[data-action="br-probe"]')?.click();
  for (let i = 0; i < 20; i++) {
    const v = document.querySelector('[data-note="br-verdict"]');
    if (v?.getAttribute('data-verdict') === 'fail') break;
    await w(500);
  }
  const v = document.querySelector('[data-note="br-verdict"]');
  const msg = v?.textContent ?? '';
  return JSON.stringify({
    verdict: v?.getAttribute('data-verdict'),
    message: msg.slice(0, 170),
    stillSaysFetchFailed: /fetch failed/i.test(msg),
    saysHowToStart: /mt5-bridge\\.py/i.test(msg),
  });
})()`));

ws.close();
