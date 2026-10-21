#!/usr/bin/env node
/**
 * Walk-forward on real data, headless.
 *
 * The point of walk-forward is that it is the only honest number: parameters are chosen on one
 * stretch and measured on the next. If the test result differs wildly from the train result, the
 * optimization was curve fitting. This script reports both, per window, and the combined
 * out-of-sample figure.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";

const CORE = process.env.FXLAB_CORE ?? "/tmp/coredist";
const { runBacktest } = await import(`${CORE}/backtest.js`);
const { walkForward } = await import(`${CORE}/optimize.js`);
const { seriesFromCandles } = await import(`${CORE}/series.js`);
const { findSymbol } = await import(`${CORE}/symbol.js`);

const dir = "history/GBPUSD";
if (!existsSync(dir)) { console.log("no data — run scripts/fetch-test-data.mjs"); process.exit(1); }
const map = new Map();
for (const f of readdirSync(dir).filter((x) => x.endsWith(".csv")).sort()) {
  for (const line of readFileSync(`${dir}/${f}`, "utf8").split("\n")) {
    const t = line.trim();
    if (t === "" || /^[a-z]/i.test(t)) continue;
    const p = t.split(",");
    if (p.length < 5) continue;
    const time = Number(p[0]);
    const [open, high, low, close, volume] = p.slice(1).map(Number);
    if (![time, open, high, low, close].every(Number.isFinite)) continue;
    if (open <= 0) continue;
    map.set(time, { time, open, high, low, close, volume: volume || 0 });
  }
}
const candles = [...map.values()].sort((a, b) => a.time - b.time);
const series = seriesFromCandles(candles);
console.log(`data: ${series.length} bars`);

const symbol = findSymbol("GBPUSD");
const settings = {
  startingBalance: 10000,
  spread: 0.00002,
  commissionPerLot: 3,
  account: { id: 1, name: "wf", currency: "USD", startingBalance: 10000, leverage: 100, mode: "hedging" },
  symbol,
};

const CODE = `
const fast = c.ind("SMA", c.p.fast);
const slow = c.ind("SMA", c.p.slow);
if (!isNaN(fast) && !isNaN(slow)) {
  const long = c.pos.some((q) => q.side === "buy");
  const short = c.pos.some((q) => q.side === "sell");
  if (fast > slow && !long) { if (short) c.closeAll(); c.buy(1); }
  else if (fast < slow && !short) { if (long) c.closeAll(); c.sell(1); }
}
`;

const AXES = [
  { name: "fast", from: 5, to: 20, step: 5 },
  { name: "slow", from: 20, to: 60, step: 10 },
];

// 5 trading days of 1m bars = 7200. Train on ~1 day, test on the next.
const t0 = Date.now();
const wf = walkForward(series, CODE, AXES, settings, { trainBars: 1440, testBars: 1440 });
const ms = Date.now() - t0;

console.log(`\n=== WALK-FORWARD: ${wf.windows.length} windows in ${ms} ms ===`);
console.log("train on one day, test on the next, never the same bars\n");

const iso = (s) => new Date(s * 1000).toISOString().slice(0, 16).replace("T", " ");
console.log("  #  train window            best        train net   test net   test trades");
for (let i = 0; i < wf.windows.length; i++) {
  const w = wf.windows[i];
  const p = `f${w.bestParams.fast}/s${w.bestParams.slow}`;
  console.log(
    `  ${String(i + 1).padStart(2)}  ${iso(w.trainFrom)} → ${iso(w.trainTo)}  ${p.padEnd(10)}  ` +
    `${w.trainStats.netProfit.toFixed(2).padStart(9)}  ${w.testStats.netProfit.toFixed(2).padStart(9)}  ` +
    `${String(w.testStats.tradeCount).padStart(4)}`,
  );
}

const c = wf.combinedTest;
console.log("\n=== combined OUT-OF-SAMPLE (the only number that counts) ===");
console.log(`trades        ${c.tradeCount}`);
console.log(`net profit    ${c.netProfit.toFixed(2)}`);
console.log(`win rate      ${c.winRate.toFixed(1)}%`);
console.log(`profit factor ${Number.isFinite(c.profitFactor) ? c.profitFactor.toFixed(2) : "n/a"}`);
console.log(`max drawdown  ${c.maxDrawdown.toFixed(2)}`);

// the diagnostic that matters: does the train result predict the test result?
if (wf.windows.length > 1) {
  const pairs = wf.windows.map((w) => [w.trainStats.netProfit, w.testStats.netProfit]);
  const trainWins = pairs.filter(([tr]) => tr > 0).length;
  const testWins = pairs.filter(([, te]) => te > 0).length;
  console.log(`\nwindows where TRAIN was profitable: ${trainWins}/${pairs.length}`);
  console.log(`windows where TEST  was profitable: ${testWins}/${pairs.length}`);
  if (trainWins > 0 && testWins === 0) {
    console.log("VERDICT: profitable in training, unprofitable out of sample — that is curve fitting,");
    console.log("         and it is exactly what walk-forward exists to reveal.");
  } else if (trainWins === testWins) {
    console.log("VERDICT: train and test agree, which is the only sign of a result worth trusting.");
  }
}
