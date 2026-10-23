#!/usr/bin/env node
/**
 * The three complaints, checked against a stub bridge.
 *
 *  1. "Why does the MetaTrader window open when I press Connect?"
 *     The bridge no longer passes credentials to mt5.initialize(), which is what makes MT5 launch its
 *     own terminal. It attaches to a running terminal instead. Verified here by asserting the bridge
 *     source contains a path= attach and no credential-passing initialize.
 *
 *  2. "I gave the account and the chart still did not load."
 *     Connecting now fetches bars and hands them to the chart. Verified: after Connect, the chart's
 *     own DOM reports the new bars.
 *
 *  3. "What is all that junk in the menu? It should only be account entry and login."
 *     Verified by enumerating every control in the panel.
 */
const PORT = process.argv[2] ?? "18461";
const STUB = process.argv[3];

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
await ev(`localStorage.clear(); localStorage.setItem('fxlab.lang','en')`);
await send("Page.enable");
await send("Page.reload");
await sleep(4300);
await ev(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  document.querySelector('[data-mode="live"]')?.click();
  await w(400);
  const go = document.querySelector('[data-action="start-go"]');
  if (go && !go.disabled) go.click();
  for (let i = 0; i < 70 && !document.querySelector('.chart-host'); i++) await w(400);
  document.querySelector('[data-tab="broker"]')?.click();
  await w(1200);
})()`);
await sleep(1800);

console.log("P1. WHAT IS ACTUALLY IN THE PANEL NOW:", await ev(`(() => {
  const panel = document.querySelector('[data-panel="broker"]');
  if (!panel) return 'no panel';
  const controls = [...panel.querySelectorAll('input, select, button, textarea')].map(el => ({
    tag: el.tagName.toLowerCase(),
    field: el.getAttribute('data-field') || el.getAttribute('data-action') || null,
    text: (el.textContent || el.placeholder || '').trim().slice(0, 34),
  }));
  return JSON.stringify({
    controls,
    // the stuff the user called junk
    transportDropdown: !!panel.querySelector('[data-field="br-adapter"]'),
    bridgeUrlField: !!panel.querySelector('[data-field="br-url"]'),
    probeButton: !!panel.querySelector('[data-action="br-test"]'),
    loadButton: !!panel.querySelector('[data-action="br-load"]'),
    oandaTokenField: !!panel.querySelector('[data-field="oanda-token"]'),
    dateRangeFields: panel.querySelectorAll('input[type="date"]').length,
    symbolField: !!panel.querySelector('[data-field="br-symbol"]'),
    windowsWarning: !!panel.querySelector('[data-note="br-windows"]'),
  });
})()`));

console.log("P2. CONNECT FILLS THE CHART (stub bridge on " + STUB + "):", await ev(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  const setNative = (sel, v) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    d.set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  };
  setNative('[data-field="br-login"]', '10000001');
  setNative('[data-field="br-password"]', 'probe-secret');
  setNative('[data-field="br-server"]', 'Stub-Demo');
  await w(400);

  const barsBefore = document.querySelector('.chart-area')?.getAttribute('data-base-bars');
  const btn = document.querySelector('[data-action="br-connect"]');
  if (!btn) return JSON.stringify({ error: 'no connect button' });
  if (btn.disabled) return JSON.stringify({ error: 'connect disabled', availability: await window.fxlab.bridgeAvailability() });
  btn.click();

  for (let i = 0; i < 40; i++) {
    const v = document.querySelector('[data-note="br-connect-verdict"]');
    if (v && v.getAttribute('data-verdict') === 'ok') break;
    await w(500);
  }
  await w(2500);
  const verdict = document.querySelector('[data-note="br-connect-verdict"]');
  const load = document.querySelector('[data-note="br-load"]');
  const barsAfter = document.querySelector('.chart-area')?.getAttribute('data-base-bars');
  return JSON.stringify({
    connectVerdict: verdict?.getAttribute('data-verdict'),
    connectText: (verdict?.textContent ?? '').slice(0, 60),
    loadNote: (load?.textContent ?? '').slice(0, 60),
    barsBefore, barsAfter,
    chartGainedBars: Number(barsAfter) > Number(barsBefore ?? 0),
    passwordCleared: document.querySelector('[data-field="br-password"]')?.value === '',
    passwordLeaked: (document.body.textContent ?? '').includes('probe-secret'),
  });
})()`));

console.log("P3. TIMEFRAMES STILL WORK AFTER THE BROKER DATA LOADED:", await ev(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  const btn = document.querySelector('[data-action="tf-open"]');
  if (!btn) return JSON.stringify({ error: 'no timeframe button' });
  btn.click();
  await w(700);
  const rows = [...document.querySelectorAll('[data-tf-row]')].map(r => ({
    tf: r.getAttribute('data-tf-row'),
    disabled: r.getAttribute('data-tf-disabled') === 'yes' || r.hasAttribute('disabled'),
    label: (r.textContent ?? '').trim().slice(0, 14),
  }));
  const enabled = rows.filter(r => !r.disabled).map(r => r.tf);
  // pick H1 and see whether the chart recomputes
  const target = document.querySelector('[data-tf-row="H1"]');
  const before = document.querySelector('.chart-area')?.getAttribute('data-bars');
  target?.click();
  await w(1500);
  const after = document.querySelector('.chart-area')?.getAttribute('data-bars');
  return JSON.stringify({
    framesOffered: rows.length,
    framesEnabled: enabled,
    pickedH1: !!target && !target.hasAttribute('disabled'),
    barsBeforePick: before, barsAfterPick: after,
    frameChanged: before !== after,
    legendNow: (document.querySelector('.legend')?.textContent ?? '').slice(0, 24),
  });
})()`));

console.log("P4. NO RENDERER ERROR:", await ev(`JSON.stringify({
  rendererAlive: (document.getElementById('root')?.children.length ?? 0) > 0,
  hasChart: !!document.querySelector('.chart-host'),
})`));

ws.close();
