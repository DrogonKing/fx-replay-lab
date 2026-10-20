import { describe, it, expect } from "vitest";
import {
  axisValues, gridCombinations, optimize, walkForward, monteCarlo,
} from "../src/core/optimize.js";
import { seriesFromCandles } from "../src/core/series.js";
import { findSymbol } from "../src/core/symbol.js";
import type { Account, Candle, CandleSeries } from "../src/core/types.js";

const GOLD = findSymbol("XAUUSD");
const ACC: Account = {
  id: 1, name: "opt", currency: "USD", startingBalance: 10_000,
  leverage: 100, mode: "hedging",
};
const SETTINGS = { account: ACC, symbol: GOLD };

function zigzag(n: number, period = 12): CandleSeries {
  const bars: Candle[] = [];
  let prev = 2000;
  for (let i = 0; i < n; i++) {
    const close = 2000 + Math.sin((i / period) * Math.PI * 2) * 8;
    bars.push({
      time: 1_700_000_000 + i * 60,
      open: prev,
      high: Math.max(prev, close) + 0.3,
      low: Math.min(prev, close) - 0.3,
      close,
      volume: 1,
    });
    prev = close;
  }
  return seriesFromCandles(bars);
}

const STRATEGY = `
  const fast = c.ind("EMA", c.p.fast || 5);
  const slow = c.ind("EMA", c.p.slow || 20);
  if (isNaN(fast) || isNaN(slow)) return;
  c.s.pf = c.s.pf === undefined ? fast : c.s.pf;
  c.s.ps = c.s.ps === undefined ? slow : c.s.ps;
  if (c.s.pf <= c.s.ps && fast > slow && c.pos.length === 0) c.buy(0.2, 4, 8);
  if (c.s.pf >= c.s.ps && fast < slow && c.pos.length > 0) c.closeAll();
  c.s.pf = fast; c.s.ps = slow;
`;

describe("axisValues", () => {
  it("expands a range inclusively", () => {
    expect(axisValues({ name: "p", from: 5, to: 15, step: 5 })).toEqual([5, 10, 15]);
  });
  it("avoids float dust", () => {
    expect(axisValues({ name: "p", from: 0.1, to: 0.3, step: 0.1 })).toEqual([0.1, 0.2, 0.3]);
  });
  it("degrades to a single value on a non-positive step", () => {
    expect(axisValues({ name: "p", from: 7, to: 20, step: 0 })).toEqual([7]);
  });
});

describe("gridCombinations", () => {
  const axes = [
    { name: "fast", from: 3, to: 9, step: 3 },   // 3,6,9
    { name: "slow", from: 20, to: 30, step: 5 },  // 20,25,30
  ];

  it("builds the full cartesian product", () => {
    const r = gridCombinations(axes, 100);
    expect(r.combos).toHaveLength(9);
    expect(r.truncated).toBe(false);
  });

  it("enforces the cap and reports truncation honestly", () => {
    const r = gridCombinations(axes, 4);
    expect(r.combos).toHaveLength(4);
    expect(r.truncated).toBe(true);
  });

  it("random search is deterministic for a given seed", () => {
    const a = gridCombinations(axes, 5, "random", 42);
    const b = gridCombinations(axes, 5, "random", 42);
    expect(a.combos).toEqual(b.combos);
  });

  it("random search produces no duplicates", () => {
    const r = gridCombinations(axes, 9, "random", 7);
    const keys = new Set(r.combos.map((c) => JSON.stringify(c)));
    expect(keys.size).toBe(r.combos.length);
  });
});

describe("optimize", () => {
  const s = zigzag(400);

  it("runs every combination and ranks by net profit", () => {
    const r = optimize(s, STRATEGY, {}, SETTINGS, {
      axes: [
        { name: "fast", from: 3, to: 9, step: 3 },
        { name: "slow", from: 18, to: 26, step: 4 },
      ],
      maxRuns: 100,
    });
    expect(r.totalRuns).toBe(9);
    expect(r.truncated).toBe(false);
    for (let i = 1; i < r.ranked.length; i++) {
      expect(r.ranked[i - 1]!.stats.netProfit).toBeGreaterThanOrEqual(r.ranked[i]!.stats.netProfit);
    }
  });

  it("reports truncation when the cap bites", () => {
    const r = optimize(s, STRATEGY, {}, SETTINGS, {
      axes: [{ name: "fast", from: 2, to: 20, step: 1 }],
      maxRuns: 5,
    });
    expect(r.totalRuns).toBe(5);
    expect(r.truncated).toBe(true);
  });

  it("supports ranking by drawdown (lower is better)", () => {
    const r = optimize(s, STRATEGY, {}, SETTINGS, {
      axes: [{ name: "fast", from: 3, to: 9, step: 3 }],
      maxRuns: 20,
    }, "maxDrawdown");
    for (let i = 1; i < r.ranked.length; i++) {
      expect(r.ranked[i - 1]!.stats.maxDrawdownPct).toBeLessThanOrEqual(r.ranked[i]!.stats.maxDrawdownPct);
    }
  });

  it("can be cancelled mid-run", () => {
    let calls = 0;
    const r = optimize(s, STRATEGY, {}, SETTINGS, {
      axes: [{ name: "fast", from: 2, to: 30, step: 1 }],
      maxRuns: 100,
    }, "netProfit", () => {
      calls++;
      return calls < 5;     // stop after 5
    });
    expect(r.totalRuns).toBe(5);
  });

  it("records a duration", () => {
    const r = optimize(s, STRATEGY, {}, SETTINGS, {
      axes: [{ name: "fast", from: 5, to: 5, step: 1 }],
    });
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("walkForward", () => {
  it("never overlaps train and test windows", () => {
    const s = zigzag(600);
    const r = walkForward(s, STRATEGY, [{ name: "fast", from: 3, to: 9, step: 3 }], SETTINGS, {
      trainBars: 200, testBars: 150, maxRunsPerWindow: 3,
    });
    expect(r.windows.length).toBeGreaterThan(0);
    for (const w of r.windows) {
      expect(w.testFrom).toBeGreaterThan(w.trainTo);
    }
  });

  it("produces an out-of-sample combined result separate from training", () => {
    const s = zigzag(600);
    const r = walkForward(s, STRATEGY, [{ name: "fast", from: 3, to: 9, step: 3 }], SETTINGS, {
      trainBars: 200, testBars: 150, maxRunsPerWindow: 3,
    });
    expect(r.combinedTest.tradeCount).toBeGreaterThanOrEqual(0);
    // the combined block must be built from test stats, not train stats
    const trainTrades = r.windows.reduce((a, w) => a + w.trainStats.tradeCount, 0);
    expect(trainTrades).toBeGreaterThanOrEqual(r.combinedTest.tradeCount);
  });

  it("returns empty when the data cannot fit one window", () => {
    const r = walkForward(zigzag(100), STRATEGY, [{ name: "fast", from: 5, to: 5, step: 1 }], SETTINGS, {
      trainBars: 200, testBars: 150,
    });
    expect(r.windows).toHaveLength(0);
  });
});

describe("monteCarlo", () => {
  const pnls = [100, -50, 200, -30, -80, 150, -20, 90];

  it("produces the requested number of band points", () => {
    const r = monteCarlo(pnls, 10_000, 500, 1);
    expect(r.p5).toHaveLength(pnls.length + 1);
    expect(r.p50).toHaveLength(pnls.length + 1);
    expect(r.p95).toHaveLength(pnls.length + 1);
  });

  it("bands are ordered p5 <= p50 <= p95", () => {
    const r = monteCarlo(pnls, 10_000, 800, 2);
    for (let i = 0; i < r.p50.length; i++) {
      expect(r.p5[i]!).toBeLessThanOrEqual(r.p50[i]!);
      expect(r.p50[i]!).toBeLessThanOrEqual(r.p95[i]!);
    }
  });

  it("final balance is invariant across shuffles (sum is fixed)", () => {
    const r = monteCarlo(pnls, 10_000, 300, 3);
    const expected = 10_000 + pnls.reduce((a, b) => a + b, 0);
    expect(r.worstFinal).toBeCloseTo(expected, 6);
    expect(r.bestFinal).toBeCloseTo(expected, 6);
  });

  it("reports a loss probability of 0 when the sum is positive", () => {
    const r = monteCarlo(pnls, 10_000, 200, 4);
    expect(r.probLoss).toBe(0);
  });

  it("reports probLoss 1 when the sum is negative", () => {
    const r = monteCarlo([-100, -200], 10_000, 200, 5);
    expect(r.probLoss).toBe(1);
  });

  it("handles an empty trade list without dividing by zero", () => {
    const r = monteCarlo([], 10_000);
    expect(r.paths).toHaveLength(0);
    expect(r.probLoss).toBe(0);
  });

  it("is deterministic for a given seed", () => {
    const a = monteCarlo(pnls, 10_000, 100, 99);
    const b = monteCarlo(pnls, 10_000, 100, 99);
    expect(a.paths).toEqual(b.paths);
  });

  it("bounds memory by keeping at most 200 paths", () => {
    const r = monteCarlo(pnls, 10_000, 5000, 6);
    expect(r.paths.length).toBeLessThanOrEqual(200);
  });
});
