/**
 * Measure the hot paths before changing anything, so an "optimisation" can be judged instead of
 * assumed. Run with: npx vite-node scripts/bench-hotpaths.mts
 */
import { AccountEngine } from "../src/core/account.js";
import { aggregate, TIMEFRAMES } from "../src/core/aggregate.js";
import { sma, ema, atr } from "../src/core/indicators.js";
import { findSymbol } from "../src/core/symbol.js";
import type { Account, CandleSeries, Timeframe } from "../src/core/types.js";

function series(n: number): CandleSeries {
  const time = new Float64Array(n);
  const open = new Float64Array(n);
  const high = new Float64Array(n);
  const low = new Float64Array(n);
  const close = new Float64Array(n);
  const volume = new Float64Array(n);
  let p = 1.1;
  for (let i = 0; i < n; i++) {
    // deterministic pseudo-random walk, so runs are comparable run to run
    p += Math.sin(i * 0.017) * 0.0004 + Math.cos(i * 0.0031) * 0.0002;
    time[i] = 1_600_000_000 + i * 60;
    open[i] = p;
    close[i] = p + Math.sin(i) * 0.0001;
    high[i] = Math.max(open[i]!, close[i]!) + 0.0002;
    low[i] = Math.min(open[i]!, close[i]!) - 0.0002;
    volume[i] = 100;
  }
  return { time, open, high, low, close, volume, length: n };
}

function time(label: string, fn: () => unknown, runs = 3): number {
  fn(); // warm up
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    best = Math.min(best, performance.now() - t0);
  }
  console.log(`  ${label.padEnd(40)} ${best.toFixed(2).padStart(8)} ms`);
  return best;
}

const H1 = TIMEFRAMES.find((t) => t.label === "H1")!;
const D1 = TIMEFRAMES.find((t) => t.label === "D1")!;

const s = series(200_000);
console.log("200,000 M1 bars (about seven months of round-the-clock data)\n");

time("aggregate M1 -> H1", () => aggregate(s, H1));
time("aggregate M1 -> D1", () => aggregate(s, D1));
time("SMA(50) over 200k closes", () => sma(s.close, 50));
time("EMA(50) over 200k closes", () => ema(s.close, 50));
time("ATR(14) over 200k bars", () => atr(s, 14));

const account: Account = {
  id: 1, name: "bench", currency: "USD", startingBalance: 10_000, leverage: 100, mode: "hedging",
};
const sym = findSymbol("EURUSD");

time("10k open+close cycles", () => {
  const e = new AccountEngine({ account, symbol: sym });
  for (let i = 0; i < 10_000; i++) {
    e.open({ side: i % 2 === 0 ? "buy" : "sell", lots: 0.1, slDistance: 0, tpDistance: 0, price: 1.1, time: i });
    e.closeAll(1.1001, i);
  }
});

console.log("\n(these are the numbers an optimisation has to beat)");

function nanArrayOf(n: number): Float64Array {
  const a = new Float64Array(n);
  a.fill(Number.NaN);
  return a;
}
void nanArrayOf;
