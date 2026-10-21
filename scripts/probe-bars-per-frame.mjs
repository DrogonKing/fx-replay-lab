#!/usr/bin/env node
/**
 * How many bars does each timeframe actually produce from the loaded window?
 *
 * H4 showing 137 bars while H1 shows 511 is plausible (a 30-day live window gives ~180 H4 bars),
 * but "plausible" is not "verified". This prints the count per frame so the aggregate maths can be
 * checked against arithmetic rather than trusted.
 */
const PORT = process.argv[2] ?? "18311";
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
await sleep(3200);

await ev(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  document.querySelector('[data-mode="live"]')?.click();
  await w(400);
  const go = document.querySelector('[data-action="start-go"]');
  if (go && !go.disabled) go.click();
  for (let i = 0; i < 80 && !document.querySelector('.chart-host'); i++) await w(400);
})()`);
await sleep(4500);

const base = await ev(`JSON.stringify({
  frame: document.querySelector('[data-frame]')?.getAttribute('data-frame'),
  viewBars: document.querySelector('[data-bars]')?.getAttribute('data-bars'),
  baseBars: document.querySelector('[data-base-bars]')?.getAttribute('data-base-bars'),
})`);
console.log("BASE:", base);

for (const label of ["M5", "M15", "M30", "H1", "H4", "D1", "W1"]) {
  const out = await ev(`(async () => {
    const w = (ms) => new Promise(r => setTimeout(r, ms));
    document.querySelector('[data-action="tf-open"]')?.click();
    await w(450);
    const pick = document.querySelector('[data-tf-pick="${label}"]');
    if (!pick) { document.querySelector('[data-action="tf-open"]')?.click(); return "not-listed"; }
    if (pick.disabled) { document.querySelector('[data-action="tf-open"]')?.click(); return "disabled"; }
    pick.click();
    await w(1200);
    return document.querySelector('[data-bars]')?.getAttribute('data-bars') ?? "?";
  })()`);
  console.log(`  ${label.padEnd(4)} -> ${out} bars`);
}

ws.close();
