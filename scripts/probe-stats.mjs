// Diagnose the stats: win rate 2748% and drawdown 0 are impossible, so find out where it breaks.
const { runBacktest } = await import("../dist/core/backtest.js");
const { seriesFromCandles } = await import("../dist/core/series.js");
const { findSymbol } = await import("../dist/core/symbol.js");

const candles = [];
let p = 1.10;
for (let i = 0; i < 300; i++) {
  p += i < 150 ? 0.0003 : -0.0003;
  candles.push({ time: 1400000000 + i * 60, open: p, high: p + 0.0001, low: p - 0.0001, close: p, volume: 1 });
}
const series = seriesFromCandles(candles);
const symbol = findSymbol("GBPUSD");
const settings = {
  startingBalance: 10000,
  account: { balance: 10000, equity: 10000, margin: 0, freeMargin: 10000, currency: "USD" },
  symbol,
};

const CODE = `
const fast = c.ind("SMA", 5);
const slow = c.ind("SMA", 10);
if (!isNaN(fast) && !isNaN(slow)) {
  const long = c.pos.some((q) => q.side === "buy");
  if (fast > slow && !long) c.buy(1);
  else if (fast < slow && long) c.closeAll();
}
`;
const r = runBacktest(series, CODE, {}, settings);
console.log("tradeCount:", r.stats.tradeCount);
console.log("winRate RAW:", r.stats.winRate);
console.log("maxDrawdown:", r.stats.maxDrawdown);
console.log("startingBalance:", r.stats.startingBalance);
console.log("endingBalance:", r.stats.endingBalance);
console.log("equity points:", r.equityCurve.length);
console.log("first 3 equity:", r.equityCurve.slice(0, 3));
console.log("account.startingBalance available?", settings.account.startingBalance);

// what does a trade look like?
if (r.trades.length > 0) {
  console.log("\nfirst trade:", JSON.stringify(r.trades[0], null, 1).slice(0, 400));
  const pnls = r.trades.map((t) => t.pnl);
  console.log("pnl sample:", pnls.slice(0, 8).map((x) => x.toFixed?.(2)));
  console.log("wins:", pnls.filter((x) => x >= 0).length, "of", pnls.length);
}

// equity curve shape — is it being sampled per bar or per trade?
console.log("\nequity curve length vs bars:", r.equityCurve.length, "vs", series.length);
console.log("last equity point:", r.equityCurve[r.equityCurve.length - 1]);
