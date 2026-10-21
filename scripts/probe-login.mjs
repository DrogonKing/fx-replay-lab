#!/usr/bin/env node
/**
 * Why does the login button "not work"?
 *
 * Three possibilities, and they need separating before anything is changed:
 *   a) the button does nothing at all (a wiring bug in the renderer)
 *   b) the button fires but the bridge is not running, and the failure is invisible
 *   c) the bridge runs but refuses, and the message is unhelpful
 *
 * Each is tested here with no bridge, then again with a bridge that answers /login. No real
 * credentials are used anywhere in this file.
 */
const PORT = process.argv[2] ?? "18341";
const BRIDGE = process.argv[3] ?? null;

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
    logs.push(`[console] ${(m.params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(" ")}`.slice(0, 240));
  }
  if (m.method === "Runtime.exceptionThrown") {
    logs.push(`[exception] ${(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text)}`.slice(0, 400));
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

// get to a chart so the broker panel exists
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
  await w(900);
})()`);
await sleep(1200);

console.log("D1. IS THE LOGIN FORM EVEN ON SCREEN WHEN THE PROBE FAILS?", await ev(`(() => {
  const block = document.querySelector('[data-note="br-login-block"]');
  const login = document.querySelector('[data-field="br-login"]');
  const btn = document.querySelector('[data-action="br-login"]');
  const probe = document.querySelector('[data-note="br-verdict"]');
  const r = btn?.getBoundingClientRect();
  const hit = r ? document.elementFromPoint(Math.round(r.left + r.width/2), Math.round(r.top + r.height/2)) : null;
  return JSON.stringify({
    blockPresent: !!block,
    collapsed: block?.getAttribute('data-collapsed'),
    loginField: !!login,
    buttonPresent: !!btn,
    buttonDisabled: btn?.disabled,
    // a real mouse must be able to reach it
    clickReachesButton: !!(hit && btn && (hit === btn || btn.contains(hit))),
    probeVerdict: probe?.getAttribute('data-verdict') ?? "(no probe yet)",
    probeText: (probe?.textContent ?? "").slice(0, 90),
  });
})()`));

console.log("D2. CLICKING LOGIN WITH NO BRIDGE RUNNING — WHAT DOES THE USER SEE?", await ev(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  const setNative = (sel, v) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    d.set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  };
  // deliberately a port nothing is listening on, and NOT the user's credentials
  setNative('[data-field="br-url"]', 'http://127.0.0.1:18777');
  setNative('[data-field="br-login"]', '10000001');
  setNative('[data-field="br-password"]', 'probe-only');
  setNative('[data-field="br-server"]', 'Probe-Demo');
  await w(400);
  const btn = document.querySelector('[data-action="br-login"]');
  btn?.click();
  // the fetch has a timeout; wait long enough to see the outcome
  for (let i = 0; i < 24; i++) {
    const v = document.querySelector('[data-note="br-login-verdict"]');
    if (v?.getAttribute('data-verdict') === 'fail' || v?.getAttribute('data-verdict') === 'ok') break;
    await w(500);
  }
  const v = document.querySelector('[data-note="br-login-verdict"]');
  const status = document.querySelector('.status')?.textContent ?? '';
  return JSON.stringify({
    verdict: v?.getAttribute('data-verdict'),
    message: (v?.textContent ?? "").slice(0, 140),
    buttonBackToIdle: document.querySelector('[data-action="br-login"]')?.textContent?.trim(),
    statusBar: status.slice(0, 80),
    // the password must never appear in whatever is shown
    passwordLeakedIntoMessage: (v?.textContent ?? "").includes('probe-only'),
  });
})()`));

if (BRIDGE) {
  console.log("D3. WITH A BRIDGE THAT ANSWERS /login — DOES THE UI REPORT SUCCESS?", await ev(`(async () => {
    const w = (ms) => new Promise(r => setTimeout(r, ms));
    const setNative = (sel, v) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      d.set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    };
    setNative('[data-field="br-url"]', '${BRIDGE}');
    setNative('[data-field="br-password"]', 'stub-password');
    await w(400);
    document.querySelector('[data-action="br-login"]')?.click();
    for (let i = 0; i < 20; i++) {
      const v = document.querySelector('[data-note="br-login-verdict"]');
      if (v?.getAttribute('data-verdict') === 'ok' || v?.getAttribute('data-verdict') === 'fail') break;
      await w(500);
    }
    const v = document.querySelector('[data-note="br-login-verdict"]');
    return JSON.stringify({
      verdict: v?.getAttribute('data-verdict'),
      account: (v?.textContent ?? "").slice(0, 80),
      passwordCleared: (document.querySelector('[data-field="br-password"]')?.value ?? "x") === "",
      passwordLeaked: (v?.textContent ?? "").includes('stub-password'),
    });
  })()`));
}

console.log("\n=== console / exceptions during all of this ===");
for (const l of logs.slice(-12)) console.log("  " + l);
if (logs.length === 0) console.log("  (none)");

ws.close();
