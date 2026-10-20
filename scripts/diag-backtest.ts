import { runBacktest } from "/root/fx-replay-lab/src/core/backtest.js";
import { seriesFromCandles } from "/root/fx-replay-lab/src/core/series.js";
import { findSymbol } from "/root/fx-replay-lab/src/core/symbol.js";
import { ema } from "/root/fx-replay-lab/src/core/indicators.js";

// synthetic but realistic 5-min gold series: trending + oscillating
const closes: number[] = [];
let p = 2000;
for (let i = 0; i < 5813; i++) {
  p += Math.sin(i / 40) * 1.2 + (Math.random() - 0.5) * 0.8;
  closes.push(p);
}
const bars = closes.map((c, i) => ({
  time: 1_700_000_000 + i * 300,
  open: i > 0 ? closes[i - 1]! : c,
  high: Math.max(c, i > 0 ? closes[i - 1]! : c) + 0.4,
  low: Math.min(c, i > 0 ? closes[i - 1]! : c) - 0.4,
  close: c,
  volume: 100,
}));
const series = seriesFromCandles(bars);

const GOLD = findSymbol("XAUUSD");
console.log("symbol:", GOLD.id, "contract:", GOLD.contractSize, "pip:", GOLD.pipSize);

const acc = { id: 1, name: "t", currency: "USD", startingBalance: 10000, leverage: 100, mode: "hedging" as const };

// how many crossovers are there at all?
const f = ema(series.close, 9);
const s = ema(series.close, 21);
let crosses = 0;
for (let i = 22; i < series.length; i++) {
  if (!Number.isNaN(f[i]!) && !Number.isNaN(s[i]!) && !Number.isNaN(f[i-1]!) && !Number.isNaN(s[i-1]!)) {
    if (f[i-1]! <= s[i-1]! && f[i]! > s[i]!) crosses++;
  }
}
console.log("crossovers in data:", crosses);

const BODY = `// EMA crossover
const fastN = c.p.fast || 9;
const slowN = c.p.slow || 21;
const fast = c.ind("EMA", fastN);
const slow = c.ind("EMA", slowN);
if (isNaN(fast) || isNaN(slow)) return;
if (c.s.pf === undefined) { c.s.pf = fast; c.s.ps = slow; return; }
const up = c.s.pf <= c.s.ps && fast > slow;
const dn = c.s.pf >= c.s.ps && fast < slow;
if (up && c.pos.length === 0) c.buy(0.10, 6, 12);
if (dn && c.pos.length > 0) c.closeAll();
c.s.pf = fast;
c.s.ps = slow;`;

const r = runBacktest(series, BODY, {}, { account: acc, symbol: GOLD });
console.log("errors:", r.errors.slice(0, 3));
console.log("trades:", r.stats.tradeCount);
console.log("net:", r.stats.netProfit);

// Probe the engine directly: can it open a position at all?
const BODY2 = `if (c.i === 100) c.buy(0.10, 6, 12);`;
const r2 = runBacktest(series, BODY2, {}, { account: acc, symbol: GOLD });
console.log("forced single buy -> errors:", r2.errors, "trades:", r2.stats.tradeCount);
