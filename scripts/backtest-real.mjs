#!/usr/bin/env node
/**
 * Run the app's own strategy tester on REAL downloaded data, headless.
 *
 * Uses the documented StrategyContext API (c.ind / c.buy / c.pos), real GBPUSD 1-minute bars
 * fetched by the app's own Dukascopy downloader, and a real ECN cost model ($3/lot each way,
 * 0.2 pip spread). Whatever the numbers are, they are what came out.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";

// /tmp/coredist is the whole src/core tree built with esbuild, because tsconfig has noEmit for
// the renderer build and the main-process build only covers main/. Building all of core keeps
// every transitive import intact.
const CORE = process.env.FXLAB_CORE ?? "/tmp/coredist";
const { runBacktest } = await import(`${CORE}/backtest.js`);
const { optimize } = await import(`${CORE}/optimize.js`);
const { seriesFromCandles } = await import(`${CORE}/series.js`);
const { findSymbol } = await import(`${CORE}/symbol.js`);

// ---------------------------------------------------------------- data
const dir = "history/GBPUSD";
if (!existsSync(dir)) { console.log("no data — run scripts/fetch-test-data.mjs first"); process.exit(1); }
const candleMap = new Map();
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
    candleMap.set(time, { time, open, high, low, close, volume: volume || 0 });
  }
}
const candles = [...candleMap.values()].sort((a, b) => a.time - b.time);
const series = seriesFromCandles(candles);
const days = readdirSync(dir).filter((x) => x.endsWith(".csv")).length;
console.log(`data: ${days} days, ${series.length} bars`);
console.log(`from ${new Date(series.time[0] * 1000).toISOString()} to ${new Date(series.time[series.length - 1] * 1000).toISOString()}`);

const symbol = findSymbol("GBPUSD");
const settings = {
  startingBalance: 10000,
  spread: 0.00002,          // 0.2 pip
  commissionPerLot: 3,      // $3 per lot, each way
  account: {
    id: 1, name: "Backtest", currency: "USD",
    startingBalance: 10000, leverage: 100, mode: "hedging",
  },
  symbol,
};

// ---------------------------------------------------------------- one strategy
// SMA cross, both directions, no stop. Deliberately plain: the point is to prove the tester
// runs on real bars, not to sell a strategy.
const CODE = `
const fast = c.ind("SMA", 9);
const slow = c.ind("SMA", 21);
if (!isNaN(fast) && !isNaN(slow)) {
  const long = c.pos.some((p) => p.side === "buy");
  const short = c.pos.some((p) => p.side === "sell");
  if (fast > slow && !long) { if (short) c.closeAll(); c.buy(1); }
  else if (fast < slow && !short) { if (long) c.closeAll(); c.sell(1); }
}
`;

const t0 = Date.now();
const r = runBacktest(series, CODE, {}, settings);
const ms = Date.now() - t0;
const s = r.stats;

console.log("\n=== SMA 9/21 cross on real GBPUSD, ECN costs ===");
console.log(`trades           ${s.tradeCount}`);
console.log(`net profit       ${s.netProfit.toFixed(2)}`);
console.log(`ending balance   ${(s.endingBalance ?? 0).toFixed(2)} (from ${(s.startingBalance ?? 10000).toFixed(2)})`);
// winRate is already a percentage (0..100); multiplying again was my bug, not the app's
console.log(`win rate         ${s.winRate.toFixed(1)}%`);
console.log(`profit factor    ${Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : "n/a"}`);
console.log(`max drawdown     ${s.maxDrawdown.toFixed(2)} (${s.maxDrawdownPct.toFixed(2)}%)`);
console.log(`expectancy       ${s.expectancy.toFixed(4)} / trade`);
console.log(`sharpe / sortino ${s.sharpe.toFixed(2)} / ${s.sortino.toFixed(2)}`);
console.log(`gross profit/loss ${s.grossProfit.toFixed(2)} / ${s.grossLoss.toFixed(2)}`);
console.log(`engine time      ${ms} ms for ${series.length} bars (${(series.length / (ms / 1000) / 1000).toFixed(0)}k bars/s)`);
if (r.errors.length) console.log(`errors (${r.errors.length}): ${r.errors.slice(0, 3).join(" | ")}`);

// cost transparency: what did spread+commission take out?
if (s.tradeCount > 0) {
  const perTradeCost = 3 * 2; // commission both ways
  console.log(`\ncosts: ${s.tradeCount} trades x $${perTradeCost} commission = $${(s.tradeCount * perTradeCost).toFixed(2)}`);
  console.log(`       plus spread on every entry and exit`);
}

// ---------------------------------------------------------------- optimizer
// GridAxis is {name, from, to, step} — an axis is a RANGE, not a list of hand-picked values.
// That is the right design (it keeps the grid honest and bounded) and my first attempt used a
// `values` array, which silently produced a single combination.
const AXES = [
  { name: "fast", from: 5, to: 20, step: 5 },   // 5, 10, 15, 20
  { name: "slow", from: 20, to: 60, step: 10 }, // 20, 30, 40, 50, 60
];
const PARAM_CODE = `
const fast = c.ind("SMA", c.p.fast);
const slow = c.ind("SMA", c.p.slow);
if (!isNaN(fast) && !isNaN(slow)) {
  const long = c.pos.some((p) => p.side === "buy");
  const short = c.pos.some((p) => p.side === "sell");
  if (fast > slow && !long) { if (short) c.closeAll(); c.buy(1); }
  else if (fast < slow && !short) { if (long) c.closeAll(); c.sell(1); }
}
`;
const t1 = Date.now();
const opt = optimize(
  series, PARAM_CODE, {}, settings,
  { axes: AXES, maxRuns: 500 }, "netProfit",
);
const oms = Date.now() - t1;

console.log(`\n=== OPTIMIZER: ${opt.totalRuns} combinations in ${oms} ms (truncated: ${opt.truncated}) ===`);
for (const x of opt.ranked.slice(0, 5)) {
  console.log(`  fast=${String(x.params.fast).padEnd(3)} slow=${String(x.params.slow).padEnd(3)} net=${x.stats.netProfit.toFixed(2).padStart(9)} trades=${String(x.stats.tradeCount).padStart(3)} dd=${x.stats.maxDrawdown.toFixed(2)}`);
}
const nets = opt.ranked.map((x) => x.stats.netProfit);
const lo = Math.min(...nets);
const hi = Math.max(...nets);
console.log(`spread: min ${lo.toFixed(2)} max ${hi.toFixed(2)} range ${(hi - lo).toFixed(2)}`);
console.log(`best: ${JSON.stringify(opt.ranked[0].params)}`);
// the honest check: is the "best" actually special, or is the whole grid positive?
const positive = nets.filter((n) => n > 0).length;
console.log(`positive combinations: ${positive}/${nets.length}`);
