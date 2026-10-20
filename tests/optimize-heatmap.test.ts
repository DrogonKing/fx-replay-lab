import { describe, it, expect } from "vitest";
import {
  metricValue, higherIsBetter, pickAxes, buildHeatmap, normalise, bestCell,
  paramsForCell, describeHeatmap, roughness,
} from "../src/core/optimize-heatmap.js";
import type { OptimizationResult, OptimizationRun, RankMetric } from "../src/core/optimize.js";
import type { BacktestStats } from "../src/core/backtest.js";

/** Minimal stats with only the fields the heatmap reads. */
const stats = (over: Partial<BacktestStats> = {}): BacktestStats => ({
  tradeCount: 20, winRate: 55, netProfit: 1000, profitFactor: 1.6,
  maxDrawdown: 300, maxDrawdownPct: 3, avgWin: 100, avgLoss: -50,
  expectancy: 50, maxWinStreak: 4, maxLossStreak: 3,
  grossProfit: 2000, grossLoss: -1000, startingBalance: 10_000,
  endingBalance: 11_000, sharpe: 0.8, sortino: 1.1, ...over,
} as BacktestStats);

const run = (params: Record<string, number>, over: Partial<BacktestStats> = {}): OptimizationRun =>
  ({ params, stats: stats(over) });

const result = (runs: OptimizationRun[]): OptimizationResult => ({
  runs,
  ranked: [...runs].sort((a, b) => b.stats.netProfit - a.stats.netProfit),
  totalRuns: runs.length,
  truncated: false,
  durationMs: 5,
});

/** A 3x3 grid where profit rises with both axes. */
const GRID = result([
  run({ fast: 5, slow: 10 }, { netProfit: 100 }),
  run({ fast: 5, slow: 20 }, { netProfit: 200 }),
  run({ fast: 5, slow: 30 }, { netProfit: 300 }),
  run({ fast: 10, slow: 10 }, { netProfit: 400 }),
  run({ fast: 10, slow: 20 }, { netProfit: 500 }),
  run({ fast: 10, slow: 30 }, { netProfit: 600 }),
  run({ fast: 20, slow: 10 }, { netProfit: 700 }),
  run({ fast: 20, slow: 20 }, { netProfit: 800 }),
  run({ fast: 20, slow: 30 }, { netProfit: 900 }),
]);

describe("metricValue", () => {
  it("reads every rank metric from the real field names", () => {
    const s = stats({ netProfit: 1234, profitFactor: 1.9, winRate: 61, maxDrawdown: 77, sharpe: 1.4, expectancy: 12 });
    expect(metricValue(s, "netProfit")).toBe(1234);
    expect(metricValue(s, "profitFactor")).toBe(1.9);
    expect(metricValue(s, "winRate")).toBe(61);
    expect(metricValue(s, "maxDrawdown")).toBe(77);
    expect(metricValue(s, "sharpe")).toBe(1.4);
    expect(metricValue(s, "expectancy")).toBe(12);
  });
});

describe("higherIsBetter", () => {
  it("is true for profit-like metrics", () => {
    for (const m of ["netProfit", "profitFactor", "winRate", "sharpe", "expectancy"] as RankMetric[]) {
      expect(higherIsBetter(m), m).toBe(true);
    }
  });

  it("is FALSE for drawdown: less is better", () => {
    // getting this backwards makes the worst region of the heatmap look like the best
    expect(higherIsBetter("maxDrawdown")).toBe(false);
  });
});

describe("pickAxes", () => {
  it("returns null for no runs", () => {
    expect(pickAxes([])).toBeNull();
  });

  it("returns null when there are no parameters", () => {
    expect(pickAxes([run({})])).toBeNull();
  });

  it("picks the two axes with the most distinct values", () => {
    // 'noise' is constant, so plotting it would give a one-column heatmap
    const runs = [
      run({ fast: 5, slow: 10, noise: 1 }),
      run({ fast: 10, slow: 20, noise: 1 }),
      run({ fast: 20, slow: 30, noise: 1 }),
    ];
    const a = pickAxes(runs)!;
    expect([a.x, a.y].sort()).toEqual(["fast", "slow"]);
  });

  it("handles a single parameter by using it for both axes", () => {
    const a = pickAxes([run({ fast: 5 })])!;
    expect(a.x).toBe("fast");
    expect(a.y).toBe("fast");
  });
});

describe("buildHeatmap", () => {
  it("lays the runs out on a grid", () => {
    const heat = buildHeatmap(GRID)!;
    expect(heat.xValues).toEqual([5, 10, 20]);
    expect(heat.yValues).toEqual([10, 20, 30]);
    expect(heat.cells).toHaveLength(3);
    expect(heat.cells[0]).toHaveLength(3);
  });

  it("puts each run in the right cell", () => {
    const heat = buildHeatmap(GRID)!;
    const xi = heat.xValues.indexOf(10);
    const yi = heat.yValues.indexOf(20);
    expect(heat.cells[yi]![xi]!.value).toBe(500);
  });

  it("reports the metric range", () => {
    const heat = buildHeatmap(GRID)!;
    expect(heat.min).toBe(100);
    expect(heat.max).toBe(900);
  });

  it("sorts the axes, so the grid reads in order", () => {
    const shuffled = result([
      run({ fast: 20, slow: 30 }, { netProfit: 900 }),
      run({ fast: 5, slow: 10 }, { netProfit: 100 }),
      run({ fast: 10, slow: 20 }, { netProfit: 500 }),
    ]);
    const heat = buildHeatmap(shuffled)!;
    expect(heat.xValues).toEqual([5, 10, 20]);
    expect(heat.yValues).toEqual([10, 20, 30]);
  });

  it("KEEPS THE BEST run when a third dimension collapses onto one cell", () => {
    // averaging would invent a parameter set that was never tested
    const withThird = result([
      run({ fast: 5, slow: 10, rsi: 14 }, { netProfit: 100 }),
      run({ fast: 5, slow: 10, rsi: 20 }, { netProfit: 900 }),
      run({ fast: 5, slow: 10, rsi: 30 }, { netProfit: 400 }),
    ]);
    const heat = buildHeatmap(withThird, { x: "fast", y: "slow" })!;
    expect(heat.cells[0]![0]!.value).toBe(900);
    expect(heat.cells[0]![0]!.samples).toBe(3);
    expect(heat.collapsed).toContain("rsi");
  });

  it("keeps the LOWEST drawdown when collapsing on drawdown", () => {
    const ddBands = result([
      run({ fast: 5, slow: 10, rsi: 14 }, { maxDrawdown: 500 }),
      run({ fast: 5, slow: 10, rsi: 20 }, { maxDrawdown: 120 }),
      run({ fast: 5, slow: 10, rsi: 30 }, { maxDrawdown: 300 }),
    ]);
    const heat = buildHeatmap(ddBands, { x: "fast", y: "slow" }, "maxDrawdown")!;
    expect(heat.cells[0]![0]!.value).toBe(120);
  });

  it("marks an untested cell as NaN with no run", () => {
    // a 3x3 axis span with two corners missing, so the grid has holes
    const sparse = result([
      run({ fast: 5, slow: 10 }, { netProfit: 100 }),
      run({ fast: 10, slow: 20 }, { netProfit: 500 }),
      run({ fast: 20, slow: 30 }, { netProfit: 900 }),
    ]);
    const heat = buildHeatmap(sparse, { x: "fast", y: "slow" })!;
    expect(heat.xValues).toEqual([5, 10, 20]);
    expect(heat.yValues).toEqual([10, 20, 30]);
    // fast=20, slow=10 was never run
    const xi = heat.xValues.indexOf(20);
    const yi = heat.yValues.indexOf(10);
    expect(heat.cells[yi]![xi]!.value).toBeNaN();
    expect(heat.cells[yi]![xi]!.bestRun).toBe(-1);
    // and the corner that WAS run is filled
    expect(heat.cells[heat.yValues.indexOf(10)]![heat.xValues.indexOf(5)]!.value).toBe(100);
  });

  it("counts empty cells in the description", () => {
    const sparse = result([
      run({ fast: 5, slow: 10 }, { netProfit: 100 }),
      run({ fast: 20, slow: 30 }, { netProfit: 900 }),
    ]);
    const heat = buildHeatmap(sparse, { x: "fast", y: "slow" })!;
    expect(describeHeatmap(heat)).toContain("empty");
  });

  it("returns null for an empty result", () => {
    expect(buildHeatmap(result([]))).toBeNull();
  });

  it("defaults to netProfit", () => {
    expect(buildHeatmap(GRID)!.metric).toBe("netProfit");
  });
});

describe("normalise", () => {
  it("maps the range to 0..1 for a higher-is-better metric", () => {
    expect(normalise(100, 100, 900, "netProfit")).toBe(0);
    expect(normalise(900, 100, 900, "netProfit")).toBe(1);
    expect(normalise(500, 100, 900, "netProfit")).toBeCloseTo(0.5, 6);
  });

  it("INVERTS for drawdown, so dark always means good", () => {
    // the reader should not have to remember which way the scale runs
    expect(normalise(100, 100, 900, "maxDrawdown")).toBe(1);
    expect(normalise(900, 100, 900, "maxDrawdown")).toBe(0);
  });

  it("returns the middle for a flat range", () => {
    expect(normalise(5, 5, 5, "netProfit")).toBe(0.5);
  });

  it("propagates NaN for an empty cell", () => {
    expect(normalise(NaN, 0, 10, "netProfit")).toBeNaN();
  });
});

describe("bestCell / paramsForCell", () => {
  it("finds the highest profit cell", () => {
    const heat = buildHeatmap(GRID)!;
    const best = bestCell(heat)!;
    expect(best.value).toBe(900);
  });

  it("finds the LOWEST drawdown cell for the drawdown metric", () => {
    const runs = result([
      run({ fast: 5, slow: 10 }, { maxDrawdown: 500 }),
      run({ fast: 10, slow: 10 }, { maxDrawdown: 120 }),
      run({ fast: 20, slow: 10 }, { maxDrawdown: 300 }),
    ]);
    const heat = buildHeatmap(runs, { x: "fast", y: "slow" }, "maxDrawdown")!;
    expect(bestCell(heat)!.value).toBe(120);
  });

  it("returns the parameters that were ACTUALLY run", () => {
    const heat = buildHeatmap(GRID)!;
    const params = paramsForCell(heat, GRID, bestCell(heat)!)!;
    expect(params).toEqual({ fast: 20, slow: 30 });
  });

  it("includes a collapsed dimension, which the cell alone could not reconstruct", () => {
    // reconstructing from the two axes would produce a set that was never tested
    const withThird = result([
      run({ fast: 5, slow: 10, rsi: 14 }, { netProfit: 100 }),
      run({ fast: 5, slow: 10, rsi: 20 }, { netProfit: 900 }),
    ]);
    const heat = buildHeatmap(withThird, { x: "fast", y: "slow" })!;
    const params = paramsForCell(heat, withThird, bestCell(heat)!)!;
    expect(params.rsi).toBe(20);
  });

  it("returns null for an empty cell", () => {
    const sparse = result([run({ fast: 5, slow: 10 }, { netProfit: 100 })]);
    const heat = buildHeatmap(sparse, { x: "fast", y: "slow" })!;
    const empty = heat.cells[0]!.find((c) => c.bestRun === -1);
    if (empty) expect(paramsForCell(heat, sparse, empty)).toBeNull();
  });

  it("is null when nothing is filled", () => {
    const heat = buildHeatmap(GRID)!;
    const hollow = { ...heat, cells: heat.cells.map((r) => r.map((c) => ({ ...c, bestRun: -1 }))) };
    expect(bestCell(hollow)).toBeNull();
  });
});

describe("roughness", () => {
  it("is low and predictable for a smooth plane", () => {
    // profit rises 100 per step across a range of 800, so each neighbour step is 200 and
    // mean|step|/range = 200/800 = 0.25. A smooth surface is not near ZERO — it is simply
    // small and uniform, which is what distinguishes it from a jagged one.
    const heat = buildHeatmap(GRID)!;
    expect(roughness(heat)).toBeCloseTo(0.25, 2);
    expect(roughness(heat)).toBeLessThan(0.4);
  });

  it("is high for a jagged surface", () => {
    // alternating 0 / 1000: the classic signature of fitting noise
    const jagged = result([
      run({ fast: 5, slow: 10 }, { netProfit: 0 }),
      run({ fast: 10, slow: 10 }, { netProfit: 1000 }),
      run({ fast: 20, slow: 10 }, { netProfit: 0 }),
      run({ fast: 5, slow: 20 }, { netProfit: 1000 }),
      run({ fast: 10, slow: 20 }, { netProfit: 0 }),
      run({ fast: 20, slow: 20 }, { netProfit: 1000 }),
    ]);
    const heat = buildHeatmap(jagged, { x: "fast", y: "slow" })!;
    expect(roughness(heat)).toBeGreaterThan(0.4);
  });

  it("is zero for a flat surface, without dividing by zero", () => {
    const flat = result([
      run({ fast: 5, slow: 10 }, { netProfit: 500 }),
      run({ fast: 10, slow: 20 }, { netProfit: 500 }),
    ]);
    const heat = buildHeatmap(flat, { x: "fast", y: "slow" })!;
    expect(roughness(heat)).toBe(0);
  });
});

describe("describeHeatmap", () => {
  it("names the axes, the size and the range", () => {
    const d = describeHeatmap(buildHeatmap(GRID)!);
    expect(d).toContain("×");
    expect(d).toContain("3×3");
    expect(d).toContain("netProfit");
  });

  it("mentions collapsed dimensions", () => {
    const withThird = result([
      run({ fast: 5, slow: 10, rsi: 14 }, { netProfit: 100 }),
      run({ fast: 10, slow: 20, rsi: 14 }, { netProfit: 200 }),
    ]);
    const heat = buildHeatmap(withThird, { x: "fast", y: "slow" })!;
    expect(describeHeatmap(heat)).toContain("collapsed: rsi");
  });
});
