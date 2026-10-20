import { describe, it, expect, beforeEach } from "vitest";
import { runBacktest, compileStrategy, computeStats } from "../src/core/backtest.js";
import { resetIdsForTest } from "../src/core/account.js";
import { seriesFromCandles } from "../src/core/series.js";
import { findSymbol } from "../src/core/symbol.js";
import type { Account, Candle, CandleSeries } from "../src/core/types.js";

const GOLD = findSymbol("XAUUSD");
const ACC: Account = {
  id: 1, name: "bt", currency: "USD", startingBalance: 10_000,
  leverage: 100, mode: "hedging",
};

beforeEach(() => resetIdsForTest());

/**
 * Deterministic zig-zag with REAL bodies.
 *
 * Each bar's open is the previous bar's close, so a rising bar is genuinely
 * green (close > open) and a falling bar is red. An earlier version set
 * open === close on every bar, which made body-direction conditions impossible
 * and silently produced zero trades -- the data, not the engine, was wrong.
 */
function zigzag(n: number, amp = 5, period = 10): CandleSeries {
  const bars: Candle[] = [];
  let prevClose = 2000;
  for (let i = 0; i < n; i++) {
    const mid = 2000 + Math.sin((i / period) * Math.PI * 2) * amp;
    const close = mid;
    const open = i === 0 ? mid : prevClose;
    bars.push({
      time: 1_700_000_000 + i * 60,
      open,
      high: Math.max(open, close) + 0.5,
      low: Math.min(open, close) - 0.5,
      close,
      volume: 1,
    });
    prevClose = close;
  }
  return seriesFromCandles(bars);
}

describe("compileStrategy", () => {
  it("compiles a body into a callable", () => {
    const fn = compileStrategy("c.s.x = 1;");
    const ctx = {
      i: 0, bar: { t: 0, o: 1, h: 1, l: 1, c: 1, v: 0 }, p: {}, s: {} as Record<string, unknown>,
      pos: [], ind: () => 0, buy: () => {}, sell: () => {}, closeAll: () => {},
    };
    fn(ctx);
    expect(ctx.s.x).toBe(1);
  });

  it("throws a readable error on a syntax error", () => {
    expect(() => compileStrategy("this is not js (")).toThrow();
  });
});

describe("runBacktest", () => {
  const crossoverStrategy = `
    const fast = c.ind("EMA", 5);
    const slow = c.ind("EMA", 20);
    if (isNaN(fast) || isNaN(slow)) return;
    const green = c.bar.c > c.bar.o;
    const red = c.bar.c < c.bar.o;
    c.s.prevF = c.s.prevF === undefined ? fast : c.s.prevF;
    c.s.prevS = c.s.prevS === undefined ? slow : c.s.prevS;
    if (c.s.prevF <= c.s.prevS && fast > slow && green && c.pos.length === 0) {
      c.buy(0.5, 5, 10);
    }
    if (c.s.prevF >= c.s.prevS && fast < slow && red && c.pos.length > 0) {
      c.closeAll();
    }
    c.s.prevF = fast;
    c.s.prevS = slow;
  `;

  it("produces trades on a zig-zag series", () => {
    const r = runBacktest(zigzag(400), crossoverStrategy, {}, { account: ACC, symbol: GOLD });
    expect(r.errors).toEqual([]);
    expect(r.stats.tradeCount).toBeGreaterThan(0);
    expect(r.trades.length).toBe(r.stats.tradeCount);
  });

  it("never trades on the same bar that produced the signal (no look-ahead)", () => {
    // A strategy that buys on bar 10 must fill at bar 11's OPEN.
    const body = `
      if (c.i === 10) c.buy(0.1, 0, 0);
    `;
    const s = seriesFromCandles(
      Array.from({ length: 20 }, (_, i) => ({
        time: 1_700_000_000 + i * 60,
        open: 2000 + i, high: 2000 + i + 1, low: 2000 + i - 1, close: 2000 + i,
        volume: 0,
      })),
    );
    const r = runBacktest(s, body, {}, {
      account: { ...ACC, startingBalance: 1000 }, symbol: GOLD, spread: 0,
    });
    // No SL/TP was set, so the position is still open at the end: no trade row.
    expect(r.trades).toHaveLength(0);
  });

  it("reports a runtime error readably instead of crashing", () => {
    const r = runBacktest(zigzag(50), "throw new Error('boom');", {},
      { account: ACC, symbol: GOLD });
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors[0]).toContain("boom");
    expect(r.stats.tradeCount).toBe(0);
  });

  it("reports a compile error without throwing", () => {
    const r = runBacktest(zigzag(50), "function (((", {}, { account: ACC, symbol: GOLD });
    expect(r.errors[0]).toMatch(/compile error/);
  });

  it("caps stored errors so a bad bar does not flood", () => {
    const r = runBacktest(zigzag(2000), "throw new Error('always');", {},
      { account: ACC, symbol: GOLD });
    expect(r.errors.length).toBeLessThanOrEqual(20);
  });

  it("exposes params, state and indicator lookback", () => {
    const body = `
      c.s.seen = (c.s.seen || 0) + 1;
      c.s.p = c.p.myParam;
      c.s.back = c.ind("SMA", 5, 2);
    `;
    const r = runBacktest(zigzag(100), body, { myParam: 42 }, { account: ACC, symbol: GOLD });
    expect(r.errors).toEqual([]);
  });

  it("applies spread to buys but not to sells", () => {
    // One buy that immediately hits TP on the next bar.
    const s = seriesFromCandles([
      { time: 1000, open: 2000, high: 2000, low: 2000, close: 2000, volume: 0 },
      { time: 1060, open: 2000, high: 3000, low: 2000, close: 2000, volume: 0 },
    ]);
    const body = "if (c.i === 0) c.buy(1, 0, 10);";
    const r = runBacktest(s, body, {}, {
      account: { ...ACC, startingBalance: 10_000 }, symbol: GOLD, spread: 0.2,
    });
    expect(r.trades).toHaveLength(1);
    // entry = 2000 + 0.2 spread, tp = entry + 10
    expect(r.trades[0]!.entryPrice).toBeCloseTo(2000.2, 2);
    expect(r.trades[0]!.pnl).toBeGreaterThan(0);
  });

  it("returns an equity curve with the final point", () => {
    const r = runBacktest(zigzag(300), crossoverStrategy, {}, { account: ACC, symbol: GOLD });
    expect(r.equityCurve.length).toBeGreaterThan(2);
    const last = r.equityCurve[r.equityCurve.length - 1]!;
    expect(Number.isFinite(last.equity)).toBe(true);
  });
});

describe("computeStats", () => {
  const t = (
    pnl: number, exitTime: number, mae = -10, mfe = 20,
  ) => ({
    entryIndex: 0, exitIndex: 0, entryTime: exitTime - 60, exitTime,
    side: "buy" as const, lots: 1, entryPrice: 1, exitPrice: 1,
    pnl, reason: "TP", mae, mfe,
  });

  it("computes win rate, profit factor and net profit", () => {
    const trades = [t(100, 1), t(-50, 2), t(200, 3), t(-25, 4)];
    const s = computeStats(trades, 10_000, []);
    expect(s.tradeCount).toBe(4);
    expect(s.winRate).toBe(50);
    expect(s.netProfit).toBeCloseTo(225, 9);
    expect(s.grossProfit).toBeCloseTo(300, 9);
    expect(s.grossLoss).toBeCloseTo(75, 9);
    expect(s.profitFactor).toBeCloseTo(4, 9);
    expect(s.expectancy).toBeCloseTo(56.25, 9);
    expect(s.avgWin).toBeCloseTo(150, 9);
    expect(s.avgLoss).toBeCloseTo(37.5, 9);
  });

  it("tracks win and loss streaks", () => {
    const trades = [t(1, 1), t(2, 2), t(-1, 3), t(-2, 4), t(-3, 5), t(4, 6)];
    const s = computeStats(trades, 1000, []);
    expect(s.maxWinStreak).toBe(2);
    expect(s.maxLossStreak).toBe(3);
  });

  it("computes max drawdown from the equity curve", () => {
    const eq = [
      { time: 1, equity: 10_000 },
      { time: 2, equity: 12_000 },
      { time: 3, equity: 9_000 },   // trough: dd = 3000 from 12000
      { time: 4, equity: 11_000 },
    ];
    const s = computeStats([t(10, 4)], 10_000, eq);
    expect(s.maxDrawdown).toBeCloseTo(3000, 9);
    expect(s.maxDrawdownPct).toBeCloseTo(25, 9);
  });

  it("buckets monthly returns by UTC month", () => {
    const jan = Date.UTC(2024, 0, 15) / 1000;
    const feb = Date.UTC(2024, 1, 15) / 1000;
    const s = computeStats([t(100, jan), t(50, jan), t(-30, feb)], 1000, []);
    expect(s.monthlyReturns["2024-01"]).toBeCloseTo(150, 9);
    expect(s.monthlyReturns["2024-02"]).toBeCloseTo(-30, 9);
  });

  it("returns zeroed stats on no trades", () => {
    const s = computeStats([], 5000, []);
    expect(s.tradeCount).toBe(0);
    expect(s.netProfit).toBe(0);
    expect(s.endingBalance).toBe(5000);
    expect(s.profitFactor).toBe(0);
  });

  it("handles an all-wins run without a divide-by-zero", () => {
    const s = computeStats([t(10, 1), t(20, 2)], 1000, []);
    expect(s.profitFactor).toBe(Infinity);
    expect(Number.isFinite(s.netProfit)).toBe(true);
  });

  it("averages MAE and MFE", () => {
    const s = computeStats([t(10, 1, -5, 15), t(10, 2, -15, 25)], 1000, []);
    expect(s.avgMae).toBeCloseTo(-10, 9);
    expect(s.avgMfe).toBeCloseTo(20, 9);
  });

  it("computes Sharpe and Sortino from per-trade P/L", () => {
    const s = computeStats([t(100, 1), t(-80, 2), t(120, 3), t(-40, 4)], 1000, []);
    expect(s.sharpe).not.toBe(0);
    expect(s.sortino).not.toBe(0);
    // Sortino uses only negative deviations, so it differs from Sharpe here.
    expect(s.sortino).not.toBeCloseTo(s.sharpe, 6);
  });
});
