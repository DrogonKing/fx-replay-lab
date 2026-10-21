import { describe, it, expect } from "vitest";
import { optimize } from "../src/core/optimize.js";
import { seriesFromCandles } from "../src/core/series.js";
import { findSymbol } from "../src/core/symbol.js";
import type { Account } from "../src/core/types.js";

/**
 * A run that never trades must never rank first.
 *
 * This is the classic way an optimizer lies: net profit 0.00 beats every losing set, so "the best
 * parameters" reported to the user are the ones that never opened a position. It reads as a safe
 * result, which makes it worse than a wrong number.
 */
const candles = [];
let p = 1.10;
for (let i = 0; i < 400; i++) {
  p += Math.sin(i / 7) * 0.0004 + (i % 2 === 0 ? 0.00005 : -0.00005);
  candles.push({
    time: 1400000000 + i * 60,
    open: p, high: p + 0.00015, low: p - 0.00015, close: p, volume: 1,
  });
}
const series = seriesFromCandles(candles);
const symbol = findSymbol("GBPUSD");
const account: Account = {
  id: 1, name: "t", currency: "USD",
  startingBalance: 10000, leverage: 100, mode: "hedging",
};

// fast == slow can never cross, so this axis value produces zero trades
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

describe("optimizer ranking", () => {
  const opt = optimize(
    series, CODE, {}, { account, symbol },
    { axes: [{ name: "fast", from: 5, to: 15, step: 5 }, { name: "slow", from: 5, to: 25, step: 10 }] },
    "netProfit",
  );

  it("ran more than one combination", () => {
    expect(opt.totalRuns).toBeGreaterThan(1);
  });

  it("placed a zero-trade run last, even though its net profit is the highest", () => {
    const empty = opt.ranked.filter((r) => r.stats.tradeCount === 0);
    if (empty.length === 0) return; // this grid happened to trade everywhere; nothing to assert
    const firstEmptyAt = opt.ranked.findIndex((r) => r.stats.tradeCount === 0);
    const lastTradableAt = opt.ranked.map((r) => r.stats.tradeCount > 0).lastIndexOf(true);
    expect(firstEmptyAt).toBeGreaterThan(lastTradableAt);
  });

  it("never reports a zero-trade run as the single best result", () => {
    // the whole point: the top entry must have actually traded
    expect(opt.ranked[0]!.stats.tradeCount).toBeGreaterThan(0);
  });

  it("keeps the empty runs rather than dropping them, because that is information", () => {
    const total = opt.ranked.length;
    expect(total).toBe(opt.runs.length);
  });
});
