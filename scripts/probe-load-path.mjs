#!/usr/bin/env node
/**
 * Prove the exact two IPC calls `fillChart` makes, against a stub bridge.
 *
 * Connect is disabled on this host because the bundled runtime is win_amd64, so the panel cannot be
 * driven end to end here. That is correct behaviour, not a gap to paper over. What CAN be proven is
 * the data path the panel takes after a successful login:
 *
 *   testBridge(url)                        -> symbol list
 *   fetchBridgeCandles(url, symbol, ...)    -> bars
 *
 * Those are the same calls the panel makes, with the same arguments, and the bars go to onLoad ->
 * loadCandles -> the chart, which CSV import and drag-drop already exercise.
 */
const PORT = process.argv[2] ?? "18471";
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
await sleep(3500);

console.log("D1. THE CHART-CALL THE PANEL MAKES AFTER LOGIN:", await ev(`(async () => {
  const now = Math.floor(Date.now() / 1000);
  const probe = await window.fxlab.testBridge('${STUB}');
  if (!probe?.ok) return JSON.stringify({ step: 'testBridge', failed: probe?.error });
  const wanted = 'EURUSD';
  const symbol = probe.symbols?.includes(wanted) ? wanted : (probe.symbols?.[0] ?? wanted);
  const res = await window.fxlab.fetchBridgeCandles({
    url: '${STUB}', symbol, timeframe: 'M1',
    from: now - 60 * 60 * 24 * 14, to: now,
  });
  const c = res?.candles ?? [];
  return JSON.stringify({
    symbols: probe.symbols?.length ?? 0,
    pickedSymbol: symbol,
    ok: res?.ok,
    bars: c.length,
    firstBar: c[0] ? { t: c[0].time, o: c[0].open, c: c[0].close } : null,
    // a bar must be a real candle, not a shape with the right keys
    firstBarIsUsable: !!c[0] && Number.isFinite(c[0].open) && Number.isFinite(c[0].close),
    error: res?.error ?? null,
  });
})()`));

console.log("D2. SYMBOL RESOLUTION: our name -> the broker's actual name:", await ev(`(async () => {
  const probe = await window.fxlab.testBridge('${STUB}');
  const list = probe?.symbols ?? [];
  const wanted = 'EURUSD';
  const decorated = list.find(s => s.toUpperCase().startsWith(wanted));
  const exact = list.includes(wanted);
  const chosen = exact ? wanted : (decorated ?? list[0]);
  const now = Math.floor(Date.now() / 1000);
  const withChosen = await window.fxlab.fetchBridgeCandles({
    url: '${STUB}', symbol: chosen, timeframe: 'M1', from: now - 86400 * 30, to: now,
  });
  const withExact = exact ? null : await window.fxlab.fetchBridgeCandles({
    url: '${STUB}', symbol: 'EURUSD', timeframe: 'M1', from: now - 86400 * 30, to: now,
  });
  return JSON.stringify({
    brokerSymbols: list,
    exactMatchAvailable: exact,
    resolvedTo: chosen,
    barsWithResolved: withChosen?.candles?.length ?? 0,
    // this is the bug: asking for the undecorated name returns nothing on this broker
    barsWithPlainName: withExact === null ? 'n/a' : (withExact?.candles?.length ?? 0),
    plainNameError: withExact?.error ?? null,
  });
})()`));

console.log("D2b. WRONG SYMBOL IS REPORTED, NOT SWALLOWED:", await ev(`(async () => {
  const now = Math.floor(Date.now() / 1000);
  const res = await window.fxlab.fetchBridgeCandles({
    url: '${STUB}', symbol: 'NOSUCHPAIR', timeframe: 'M1', from: now - 86400, to: now,
  });
  return JSON.stringify({ ok: res?.ok, bars: res?.candles?.length ?? 0, error: (res?.error ?? '').slice(0, 80) });
})()`));

console.log("D3. THE BARS SURVIVE EVERY FIELD THE CHART READS:", await ev(`(async () => {
  const now = Math.floor(Date.now() / 1000);
  const probe = await window.fxlab.testBridge('${STUB}');
  const list = probe?.symbols ?? [];
  const symbol = list.find(s => s.toUpperCase().startsWith('EURUSD')) ?? list[0];
  const res = await window.fxlab.fetchBridgeCandles({
    url: '${STUB}', symbol, timeframe: 'M1', from: now - 86400 * 30, to: now,
  });
  const c = res?.candles ?? [];
  if (!c.length) return JSON.stringify({ failed: 'no bars' });

  // What the chart actually needs from each bar: a sortable epoch second and four finite prices.
  // The bridge returns broker SERVER time, which is what a real chart shows, so it is compared for
  // monotonicity rather than against UTC.
  const sorted = c.every((b, i) => i === 0 || b.time >= c[i - 1].time);
  const finite = c.every(b => [b.open, b.high, b.low, b.close].every(Number.isFinite));
  const sane = c.every(b => b.high >= b.low && b.high >= b.open && b.high >= b.close && b.low <= b.open && b.low <= b.close);
  const gap = c.length > 1 ? (c[c.length - 1].time - c[0].time) / (c.length - 1) : 0;

  return JSON.stringify({
    bars: c.length,
    sortedByTime: sorted,
    allPricesFinite: finite,
    ohlcConsistent: sane,
    medianGapSeconds: Math.round(gap),
    // M1 bars: a 60s gap means this really is one-minute data
    isOneMinuteData: Math.abs(gap - 60) <= 1,
    firstTimeIso: new Date(c[0].time * 1000).toISOString(),
    lastTimeIso: new Date(c[c.length - 1].time * 1000).toISOString(),
  });
})()`));

ws.close();
