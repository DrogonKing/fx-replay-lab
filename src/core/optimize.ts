/**
 * Optimizer, walk-forward analysis and Monte Carlo resampling.
 *
 * All three reuse `runBacktest`, so an optimised parameter set produces exactly
 * the fills the strategy tester reports -- no second backtest engine to drift.
 *
 * Two properties are deliberately enforced because they are what separates a
 * useful optimizer from a curve-fitting machine:
 *
 *  1. A HARD cap on total runs. Without it a careless step size turns a 3-value
 *     sweep into 100k backtests and hangs the app.
 *  2. Walk-forward trains on one window and scores on the NEXT one, never
 *     overlapping. In-sample performance is reported separately so the
 *     out-of-sample drop is visible.
 */
import { runBacktest, type BacktestSettings, type BacktestStats } from "./backtest.js";
import type { CandleSeries } from "./types.js";

export interface GridAxis {
  /** parameter name passed to the strategy via `c.p` */
  name: string;
  from: number;
  to: number;
  step: number;
}

export interface OptimizerOptions {
  axes: GridAxis[];
  /** hard cap; the search refuses to exceed it rather than running for hours */
  maxRuns?: number;
  /** "grid" exhausts the axes, "random" samples maxRuns points */
  method?: "grid" | "random";
  /** deterministic seed for random search, so results are reproducible */
  seed?: number;
}

export interface OptimizationRun {
  params: Record<string, number>;
  stats: BacktestStats;
}

export interface OptimizationResult {
  runs: OptimizationRun[];
  /** the same runs sorted by the chosen metric, best first */
  ranked: OptimizationRun[];
  totalRuns: number;
  /** true when the cap was hit and the space was NOT fully explored */
  truncated: boolean;
  durationMs: number;
}

/**
 * Expand an axis into its values, guarding against a zero or negative step.
 *
 * Float division makes the naive count wrong at the boundary:
 *   (0.3 - 0.1) / 0.1 === 1.9999999999999998
 * so Math.floor(...) + 1 === 2 and the `to` value is silently dropped. Adding a
 * relative epsilon before flooring keeps the upper bound inclusive, which is what
 * a user typing from=0.1 to=0.3 step=0.1 means.
 */
export function axisValues(axis: GridAxis): number[] {
  if (axis.step <= 0) return [axis.from];
  const span = (axis.to - axis.from) / axis.step;
  const count = Math.floor(span + 1e-9) + 1;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    // round to 10 dp to avoid 0.30000000000000004 keys
    out.push(Number((axis.from + i * axis.step).toFixed(10)));
  }
  return out;
}

/** Deterministic LCG so random search is reproducible. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function gridCombinations(
  axes: GridAxis[],
  maxRuns: number,
  method: "grid" | "random" = "grid",
  seed = 12345,
): { combos: Array<Record<string, number>>; truncated: boolean } {
  const values = axes.map(axisValues);
  const total = values.reduce((acc, v) => acc * v.length, 1);

  if (method === "random") {
    const rand = lcg(seed);
    const combos: Array<Record<string, number>> = [];
    const seen = new Set<string>();
    const limit = Math.min(maxRuns, Math.max(total, 1));
    let guard = 0;
    while (combos.length < limit && guard < limit * 50) {
      guard++;
      const combo: Record<string, number> = {};
      axes.forEach((axis, ai) => {
        const opts = values[ai]!;
        combo[axis.name] = opts[Math.floor(rand() * opts.length)]!;
      });
      const key = JSON.stringify(combo);
      if (seen.has(key)) continue;
      seen.add(key);
      combos.push(combo);
    }
    return { combos, truncated: combos.length < total };
  }

  // grid: build the cartesian product, stopping at the cap
  const combos: Array<Record<string, number>> = [];
  const idx = new Array(axes.length).fill(0) as number[];
  let truncated = false;

  for (;;) {
    if (combos.length >= maxRuns) {
      truncated = total > maxRuns;
      break;
    }
    const combo: Record<string, number> = {};
    axes.forEach((axis, ai) => {
      combo[axis.name] = values[ai]![idx[ai]!]!;
    });
    combos.push(combo);

    // increment the odometer
    let pos = axes.length - 1;
    for (;;) {
      if (pos < 0) return { combos, truncated };
      idx[pos]! += 1;
      if (idx[pos]! < values[pos]!.length) break;
      idx[pos] = 0;
      pos--;
    }
  }
  return { combos, truncated };
}

/** Score used for ranking. Net profit is the spec's default. */
export type RankMetric =
  | "netProfit" | "profitFactor" | "winRate" | "maxDrawdown" | "sharpe" | "expectancy";

export function optimize(
  series: CandleSeries,
  body: string,
  baseParams: Record<string, unknown>,
  settings: BacktestSettings,
  opts: OptimizerOptions,
  metric: RankMetric = "netProfit",
  /** called after each run so the UI can show progress and cancel */
  onProgress?: (done: number, total: number) => boolean | void,
): OptimizationResult {
  const maxRuns = opts.maxRuns ?? 500;
  const { combos, truncated } = gridCombinations(
    opts.axes, maxRuns, opts.method ?? "grid", opts.seed ?? 12345,
  );

  const started = Date.now();
  const runs: OptimizationRun[] = [];

  for (let i = 0; i < combos.length; i++) {
    const params = { ...baseParams, ...combos[i]! };
    const r = runBacktest(series, body, params, settings);
    runs.push({ params: combos[i]!, stats: r.stats });
    if (onProgress) {
      const keepGoing = onProgress(i + 1, combos.length);
      if (keepGoing === false) break;    // user cancelled
    }
  }

  // A run with no trades is not a good run, it is not a run. Scoring it puts net profit 0.00 at
  // the top of every grid where everything else loses — so the "best parameters" reported to the
  // user would be the ones that never opened a position. That is the classic way an optimizer
  // lies, and it is worse than a wrong number because it looks like a safe result.
  //
  // Runs are ordered in two groups: those with a real sample first (by metric), then the empty
  // ones. The empty ones are kept rather than dropped, because "this axis setting cannot trade"
  // is information the user needs.
  const tradable = runs.filter((r) => r.stats.tradeCount > 0);
  const empty = runs.filter((r) => r.stats.tradeCount === 0);
  const ranked = [
    ...tradable.sort((a, b) => score(b.stats, metric) - score(a.stats, metric)),
    ...empty,
  ];
  return {
    runs,
    ranked,
    totalRuns: runs.length,
    truncated,
    durationMs: Date.now() - started,
  };
}

function score(s: BacktestStats, metric: RankMetric): number {
  switch (metric) {
    case "netProfit": return s.netProfit;
    case "profitFactor": return Number.isFinite(s.profitFactor) ? s.profitFactor : 1e9;
    case "winRate": return s.winRate;
    // drawdown is "lower is better": invert so a plain descending sort works
    case "maxDrawdown": return -s.maxDrawdownPct;
    case "sharpe": return s.sharpe;
    case "expectancy": return s.expectancy;
  }
}

// --------------------------------------------------------- walk-forward

export interface WalkForwardWindow {
  trainFrom: number;
  trainTo: number;
  testFrom: number;
  testTo: number;
  bestParams: Record<string, number>;
  trainStats: BacktestStats;
  testStats: BacktestStats;
}

export interface WalkForwardResult {
  windows: WalkForwardWindow[];
  /** aggregate of the out-of-sample segments only -- the honest number */
  combinedTest: BacktestStats;
}

/**
 * Walk-forward analysis.
 *
 * Anchored rolling windows: train on `trainBars`, then immediately test on the
 * following `testBars` which were NOT part of training. The gap between train
 * and test performance is the only trustworthy estimate of live behaviour.
 */
export function walkForward(
  series: CandleSeries,
  body: string,
  axes: GridAxis[],
  settings: BacktestSettings,
  opts: { trainBars: number; testBars: number; maxRunsPerWindow?: number },
): WalkForwardResult {
  const windows: WalkForwardWindow[] = [];
  const n = series.length;
  let pos = 0;

  while (pos + opts.trainBars + opts.testBars <= n) {
    const trainEnd = pos + opts.trainBars;
    const testEnd = trainEnd + opts.testBars;

    const trainSlice: CandleSeries = {
      time: series.time.subarray(pos, trainEnd),
      open: series.open.subarray(pos, trainEnd),
      high: series.high.subarray(pos, trainEnd),
      low: series.low.subarray(pos, trainEnd),
      close: series.close.subarray(pos, trainEnd),
      volume: series.volume.subarray(pos, trainEnd),
      length: trainEnd - pos,
    };
    const testSlice: CandleSeries = {
      time: series.time.subarray(trainEnd, testEnd),
      open: series.open.subarray(trainEnd, testEnd),
      high: series.high.subarray(trainEnd, testEnd),
      low: series.low.subarray(trainEnd, testEnd),
      close: series.close.subarray(trainEnd, testEnd),
      volume: series.volume.subarray(trainEnd, testEnd),
      length: testEnd - trainEnd,
    };

    const opt = optimize(
      trainSlice, body, {}, settings,
      { axes, maxRuns: opts.maxRunsPerWindow ?? 200 },
    );
    const best = opt.ranked[0];
    if (best) {
      const testRun = runBacktest(testSlice, body, best.params, settings);
      windows.push({
        trainFrom: series.time[pos]!,
        trainTo: series.time[trainEnd - 1]!,
        testFrom: series.time[trainEnd]!,
        testTo: series.time[testEnd - 1]!,
        bestParams: best.params,
        trainStats: best.stats,
        testStats: testRun.stats,
      });
    }
    pos = trainEnd;      // roll forward by the train size (no overlap in test)
  }

  // Combine out-of-sample results by summing trades into one pseudo-set.
  const combined = combineStats(windows.map((w) => w.testStats));
  return { windows, combinedTest: combined };
}

/** Merge several stat blocks into one, weighting by trade count. */
function combineStats(all: BacktestStats[]): BacktestStats {
  const usable = all.filter((s) => s.tradeCount > 0);
  if (usable.length === 0) {
    return {
      tradeCount: 0, winRate: 0, netProfit: 0, profitFactor: 0, maxDrawdown: 0,
      maxDrawdownPct: 0, avgWin: 0, avgLoss: 0, expectancy: 0, maxWinStreak: 0,
      maxLossStreak: 0, grossProfit: 0, grossLoss: 0, startingBalance: 0,
      endingBalance: 0, sharpe: 0, sortino: 0, monthlyReturns: {}, avgMae: 0, avgMfe: 0,
    };
  }
  const totalTrades = usable.reduce((a, s) => a + s.tradeCount, 0);
  const netProfit = usable.reduce((a, s) => a + s.netProfit, 0);
  const grossProfit = usable.reduce((a, s) => a + s.grossProfit, 0);
  const grossLoss = usable.reduce((a, s) => a + s.grossLoss, 0);
  const weightedWinRate =
    usable.reduce((a, s) => a + s.winRate * s.tradeCount, 0) / totalTrades;
  const maxDd = Math.max(...usable.map((s) => s.maxDrawdown));
  const maxDdPct = Math.max(...usable.map((s) => s.maxDrawdownPct));
  const monthly: Record<string, number> = {};
  for (const s of usable) {
    for (const [k, v] of Object.entries(s.monthlyReturns)) {
      monthly[k] = (monthly[k] ?? 0) + v;
    }
  }
  return {
    tradeCount: totalTrades,
    winRate: weightedWinRate,
    netProfit,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    maxDrawdown: maxDd,
    maxDrawdownPct: maxDdPct,
    avgWin: usable.reduce((a, s) => a + s.avgWin, 0) / usable.length,
    avgLoss: usable.reduce((a, s) => a + s.avgLoss, 0) / usable.length,
    expectancy: netProfit / totalTrades,
    maxWinStreak: Math.max(...usable.map((s) => s.maxWinStreak)),
    maxLossStreak: Math.max(...usable.map((s) => s.maxLossStreak)),
    grossProfit,
    grossLoss,
    startingBalance: usable[0]!.startingBalance,
    endingBalance: usable[0]!.startingBalance + netProfit,
    sharpe: usable.reduce((a, s) => a + s.sharpe, 0) / usable.length,
    sortino: usable.reduce((a, s) => a + s.sortino, 0) / usable.length,
    monthlyReturns: monthly,
    avgMae: usable.reduce((a, s) => a + s.avgMae, 0) / usable.length,
    avgMfe: usable.reduce((a, s) => a + s.avgMfe, 0) / usable.length,
  };
}

// ------------------------------------------------------------- Monte Carlo

export interface MonteCarloResult {
  /** equity paths, each starting from the same balance */
  paths: number[][];
  /** percentile bands at each trade index: p5, p50, p95 */
  p5: number[];
  p50: number[];
  p95: number[];
  /** share of paths that ended below the starting balance */
  probLoss: number;
  /** worst final balance across all paths */
  worstFinal: number;
  /** best final balance across all paths */
  bestFinal: number;
}

/**
 * Monte Carlo resampling of trade order.
 *
 * Reshuffling the trade sequence preserves the P/L distribution and destroys the
 * ordering, which is exactly what answers "was my result luck of the sequence?".
 * Drawdown is the metric that changes most, and it is the one that matters.
 */
export function monteCarlo(
  tradePnls: readonly number[],
  startingBalance: number,
  iterations = 1000,
  seed = 987654,
): MonteCarloResult {
  const n = tradePnls.length;
  if (n === 0) {
    return { paths: [], p5: [], p50: [], p95: [], probLoss: 0, worstFinal: 0, bestFinal: 0 };
  }
  const rand = lcg(seed);
  const finals: number[] = [];
  const paths: number[][] = [];
  const keepPaths = Math.min(iterations, 200); // memory bound

  // collect per-index equity across iterations for the bands
  const perIndex: number[][] = Array.from({ length: n + 1 }, () => []);

  for (let it = 0; it < iterations; it++) {
    // Fisher-Yates on a copy
    const order = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = order[i]!;
      order[i] = order[j]!;
      order[j] = tmp;
    }
    let equity = startingBalance;
    const path = [equity];
    perIndex[0]!.push(equity);
    for (let k = 0; k < n; k++) {
      equity += tradePnls[order[k]!]!;
      path.push(equity);
      perIndex[k + 1]!.push(equity);
    }
    finals.push(equity);
    if (paths.length < keepPaths) paths.push(path);
  }

  const pct = (arr: number[], p: number): number => {
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
    return sorted[idx]!;
  };

  return {
    paths,
    p5: perIndex.map((a) => pct(a, 5)),
    p50: perIndex.map((a) => pct(a, 50)),
    p95: perIndex.map((a) => pct(a, 95)),
    probLoss: finals.filter((f) => f < startingBalance).length / finals.length,
    worstFinal: Math.min(...finals),
    bestFinal: Math.max(...finals),
  };
}
