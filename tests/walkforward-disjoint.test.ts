import { describe, it, expect } from "vitest";
import { walkForward } from "../src/core/optimize.js";
import { seriesFromCandles } from "../src/core/series.js";
import { findSymbol } from "../src/core/symbol.js";
import type { Account } from "../src/core/types.js";

/**
 * Walk-forward must keep train and test strictly disjoint ACROSS windows.
 *
 * The bug this guards: stepping forward by only `trainBars` made the test segment of window N the
 * train segment of window N+1. Every out-of-sample bar was then used for fitting, which silently
 * turns a walk-forward into an in-sample optimisation — the combined figure looks like an honest
 * out-of-sample result while being nothing of the kind.
 */
const candles = [];
let p = 1.10;
for (let i = 0; i < 1200; i++) {
  p += Math.sin(i / 11) * 0.0005 + (i % 3 === 0 ? 0.00008 : -0.00006);
  candles.push({
    time: 1400000000 + i * 60,
    open: p, high: p + 0.00015, low: p - 0.00015, close: p, volume: 1,
  });
}
const series = seriesFromCandles(candles);
const symbol = findSymbol("GBPUSD");
const account: Account = {
  id: 1, name: "wf", currency: "USD",
  startingBalance: 10000, leverage: 100, mode: "hedging",
};

const CODE = `
const fast = c.ind("SMA", c.p.fast);
const slow = c.ind("SMA", c.p.slow);
if (!isNaN(fast) && !isNaN(slow)) {
  const long = c.pos.some((q) => q.side === "buy");
  if (fast > slow && !long) c.buy(1);
  else if (fast < slow && long) c.closeAll();
}
`;

const TRAIN = 200;
const TEST = 100;

const wf = walkForward(
  series, CODE,
  [{ name: "fast", from: 5, to: 15, step: 5 }, { name: "slow", from: 20, to: 40, step: 10 }],
  { account, symbol },
  { trainBars: TRAIN, testBars: TEST, maxRunsPerWindow: 20 },
);

describe("walkForward disjointness", () => {
  it("produced more than one window, so the check is meaningful", () => {
    expect(wf.windows.length).toBeGreaterThan(1);
  });

  it("never lets one window's TEST bars become another window's TRAIN bars", () => {
    for (let i = 0; i < wf.windows.length; i++) {
      for (let j = 0; j < wf.windows.length; j++) {
        if (i === j) continue;
        const a = wf.windows[i]!;
        const b = wf.windows[j]!;
        // a train range and any other window's test range must not intersect
        const overlap =
          a.trainFrom <= b.testTo && a.trainTo >= b.testFrom;
        expect(overlap, `window ${i} train overlaps window ${j} test`).toBe(false);
      }
    }
  });

  it("keeps train strictly before test inside each window", () => {
    for (const w of wf.windows) {
      expect(w.trainTo).toBeLessThan(w.testFrom);
    }
  });

  it("advances the window start by train + test, not by train alone", () => {
    if (wf.windows.length < 2) return;
    const first = wf.windows[0]!;
    const second = wf.windows[1]!;
    const expectedGap = (TRAIN + TEST) * 60; // bars are 1 minute apart
    const actualGap = second.trainFrom - first.trainFrom;
    expect(actualGap).toBe(expectedGap);
  });

  it("combines out-of-sample stats from the test segments only", () => {
    // the combined trade count must equal the sum over TEST stats, never train stats
    const testSum = wf.windows.reduce((a, w) => a + w.testStats.tradeCount, 0);
    expect(wf.combinedTest.tradeCount).toBe(testSum);
  });
});
