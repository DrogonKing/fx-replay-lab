// Diagnose: does runBacktest actually execute the strategy body?
const { runBacktest, compileStrategy } = await import("../dist/core/backtest.js");
const { seriesFromCandles } = await import("../dist/core/series.js");
const { findSymbol } = await import("../dist/core/symbol.js");

// 200 synthetic bars with a clear trend change, so a cross MUST happen
const candles = [];
let p = 1.10;
for (let i = 0; i < 200; i++) {
  p += i < 100 ? 0.0005 : -0.0005;
  candles.push({
    time: 1400000000 + i * 60,
    open: p, high: p + 0.0002, low: p - 0.0002, close: p, volume: 1,
  });
}
const series = seriesFromCandles(candles);
const symbol = findSymbol("GBPUSD");
const settings = {
  startingBalance: 10000,
  spread: 0.00002,
  commissionPerLot: 3,
  account: { balance: 10000, equity: 10000, margin: 0, freeMargin: 10000, currency: "USD" },
  symbol,
};

// what does compileStrategy accept?
console.log("=== compileStrategy with a bare body ===");
try {
  const fn = compileStrategy(`
const fast = sma(close, 3);
const slow = sma(close, 8);
if (!isNaN(fast) && !isNaN(slow)) {
  if (fast > slow && position.size === 0) buy(1);
  else if (fast < slow && position.size > 0) closeAll();
}
`);
  console.log("compiled OK, type:", typeof fn);
} catch (e) {
  console.log("compile FAILED:", e.message);
}

const r = runBacktest(series, `
const fast = sma(close, 3);
const slow = sma(close, 8);
if (!isNaN(fast) && !isNaN(slow)) {
  if (fast > slow && position.size === 0) buy(1);
  else if (fast < slow && position.size > 0) closeAll();
}
`, {}, settings);

console.log("\n=== result ===");
console.log("errors:", r.errors);
console.log("stats keys:", Object.keys(r.stats).join(", "));
console.log("tradeCount:", r.stats.tradeCount, "netProfit:", r.stats.netProfit);
console.log("trades:", r.trades.length);
console.log("equity points:", r.equityCurve.length);

// is the strategy function even being called? wrap a counting strategy
const probe = compileStrategy(`
count = (count ?? 0) + 1;
`);
console.log("\n=== does the engine call the strategy at all? ===");
console.log("probe compiled:", typeof probe);

// what does a strategy function receive?
const seen = [];
const counting = (ctx) => {
  seen.push(Object.keys(ctx).slice(0, 12).join(","));
};
try {
  counting({ close: 1 });
  console.log("ctx keys sample:", seen[0]);
} catch (e) {
  console.log("ctx probe failed:", e.message);
}
