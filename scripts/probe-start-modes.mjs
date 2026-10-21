#!/usr/bin/env node
/**
 * Is the instrument picker gone from BOTH start-screen modes, or only from replay?
 *
 * The JSX was deleted outright, not conditionally, so it should be gone from both — but "should be"
 * is exactly the kind of claim that turns out wrong when a second block exists elsewhere. This
 * checks live and replay separately, and reports what each mode shows.
 */
const PORT = process.argv[2] ?? "18331";
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
  if (r.result?.exceptionDetails) return { EXC: r.result.exceptionDetails.exception?.description?.slice(0, 300) };
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(3500);

const probe = `(() => {
  const start = document.querySelector('[data-panel="start"]');
  const text = start?.textContent ?? '';
  // every select and input on the start screen, so nothing hides by being a different control
  const controls = [...(start?.querySelectorAll('select, input') ?? [])].map(c => ({
    field: c.getAttribute('data-field') ?? '(none)',
    type: c.tagName.toLowerCase(),
  }));
  const modeCards = [...(start?.querySelectorAll('[data-mode]') ?? [])].map(b => b.getAttribute('data-mode'));
  const activeMode = [...(start?.querySelectorAll('[data-mode]') ?? [])]
    .find(b => /on/.test(b.className))?.getAttribute('data-mode');
  const go = start?.querySelector('[data-action="start-go"]');
  return JSON.stringify({
    activeMode,
    modeCardsPresent: modeCards,
    instrumentSelect: !!start?.querySelector('[data-field="start-symbol"]'),
    mentionsInstrument: /INSTRUMENT|نماد/i.test(text),
    controls,
    goLabel: (go?.textContent ?? '').trim(),
  });
})()`;

console.log("LIVE MODE   :", await ev(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  document.querySelector('[data-panel="start"] [data-mode="live"]')?.click();
  await w(600);
  return ${probe};
})()`));

console.log("REPLAY MODE :", await ev(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  document.querySelector('[data-panel="start"] [data-mode="replay"]')?.click();
  await w(600);
  return ${probe};
})()`));

// and confirm the live mode still actually starts, since its choice object depends on the symbol
console.log("LIVE STILL STARTS:", await ev(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  document.querySelector('[data-panel="start"] [data-mode="live"]')?.click();
  await w(500);
  const go = document.querySelector('[data-action="start-go"]');
  if (!go || go.disabled) return JSON.stringify({ problem: "live start button unusable" });
  go.click();
  for (let i = 0; i < 70 && !document.querySelector('.chart-host'); i++) await w(400);
  const sym = document.querySelector('[data-field="sym-current"]');
  return JSON.stringify({
    chartUp: !!document.querySelector('.chart-host'),
    symbolInToolbar: sym?.getAttribute('data-symbol'),
    isEurUsd: sym?.getAttribute('data-symbol') === 'EURUSD=X',
    legend: (document.querySelector('.legend')?.textContent ?? '').slice(0, 40),
    canvases: document.querySelectorAll('.chart-host canvas').length,
  });
})()`));

ws.close();
