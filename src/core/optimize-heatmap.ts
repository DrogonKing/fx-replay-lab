/**
 * The optimizer heatmap, and applying a winning parameter set.
 *
 * `optimize()` already returned `runs` and a `ranked` list, but the only way to read it was a
 * table sorted by one metric. A grid search's real output is a SURFACE: the point is to see
 * which region of the parameter space works and which is a cliff, not to read 400 rows.
 *
 * Pure, so the colour scale and the grid shape can be tested without a canvas.
 */
import type { OptimizationRun, OptimizationResult, RankMetric } from "./optimize.js";
import type { BacktestStats } from "./backtest.js";

/** The two axes a heatmap can show; any further dimensions are collapsed. */
export interface HeatmapAxes {
  x: keyof Record<string, number> & string;
  y: keyof Record<string, number> & string;
}

export interface HeatCell {
  x: number;
  y: number;
  /** the metric value; NaN when no run landed on this cell */
  value: number;
  /** how many runs were folded into this cell (a third dimension collapsed) */
  samples: number;
  /** index into `runs`, of the best sample in this cell */
  bestRun: number;
}

export interface Heatmap {
  xLabel: string;
  yLabel: string;
  xValues: number[];
  yValues: number[];
  /** row-major: cells[y][x] */
  cells: HeatCell[][];
  min: number;
  max: number;
  /** metric actually plotted */
  metric: RankMetric;
  /** names of parameter axes NOT shown, whose values were collapsed */
  collapsed: string[];
}

/** Read the metric a rank metric refers to. */
export function metricValue(stats: BacktestStats, metric: RankMetric): number {
  switch (metric) {
    case "netProfit": return stats.netProfit;
    case "profitFactor": return stats.profitFactor;
    case "expectancy": return stats.expectancy;
    case "maxDrawdown": return stats.maxDrawdown;
    case "winRate": return stats.winRate;
    case "sharpe": return stats.sharpe;
    default: return stats.netProfit;
  }
}

/**
 * Which direction is better.
 *
 * Drawdown is the exception: a SMALLER max drawdown is better, so the colour scale has to be
 * inverted or the heatmap reads backwards — the worst region looks like the best.
 */
export function higherIsBetter(metric: RankMetric): boolean {
  return metric !== "maxDrawdown";
}

/** The two axes with the most distinct values, which is what a 2-D view can show. */
export function pickAxes(runs: readonly OptimizationRun[]): HeatmapAxes | null {
  if (runs.length === 0) return null;
  const names = Object.keys(runs[0]!.params);
  if (names.length === 0) return null;
  if (names.length === 1) return { x: names[0]!, y: names[0]! };

  const distinct = names.map((n) => ({
    name: n,
    count: new Set(runs.map((r) => r.params[n])).size,
  }));
  // more distinct values first: a constant axis makes a one-column heatmap and shows nothing
  distinct.sort((a, b) => b.count - a.count);
  return { x: distinct[0]!.name, y: distinct[1]!.name };
}

/**
 * Fold the runs into a grid.
 *
 * When the grid has more than two parameters, several runs land on the same cell. The cell
 * keeps the BEST one — the alternative (averaging) invents a parameter set that was never
 * tested and can look better than any run that exists.
 */
export function buildHeatmap(
  result: OptimizationResult,
  axes?: HeatmapAxes,
  metric?: RankMetric,
): Heatmap | null {
  const chosenMetric: RankMetric = metric ?? "netProfit";
  const chosenAxes = axes ?? pickAxes(result.runs);
  if (!chosenAxes || result.runs.length === 0) return null;

  const { x: xName, y: yName } = chosenAxes;
  const xValues = Array.from(new Set(result.runs.map((r) => r.params[xName] ?? NaN)))
    .filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const yValues = Array.from(new Set(result.runs.map((r) => r.params[yName] ?? NaN)))
    .filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xValues.length === 0 || yValues.length === 0) return null;

  const cells: HeatCell[][] = yValues.map((_, yi) =>
    xValues.map((_, xi) => ({ x: xi, y: yi, value: NaN, samples: 0, bestRun: -1 })),
  );

  const better = higherIsBetter(chosenMetric);

  result.runs.forEach((run, idx) => {
    const xv = run.params[xName];
    const yv = run.params[yName];
    if (xv === undefined || yv === undefined) return;
    const xi = xValues.indexOf(xv);
    const yi = yValues.indexOf(yv);
    if (xi < 0 || yi < 0) return;

    const cell = cells[yi]![xi]!;
    const v = metricValue(run.stats, chosenMetric);
    cell.samples++;
    if (cell.bestRun < 0) {
      cell.value = v;
      cell.bestRun = idx;
      return;
    }
    const current = cells[yi]![xi]!.value;
    const wins = better
      ? (Number.isNaN(current) || v > current)
      : (Number.isNaN(current) || v < current);
    if (wins) {
      cell.value = v;
      cell.bestRun = idx;
    }
  });

  let min = Infinity;
  let max = -Infinity;
  for (const row of cells) {
    for (const c of row) {
      if (Number.isNaN(c.value)) continue;
      if (c.value < min) min = c.value;
      if (c.value > max) max = c.value;
    }
  }
  if (!Number.isFinite(min)) { min = 0; max = 0; }

  const allNames = Object.keys(result.runs[0]!.params);
  const collapsed = allNames.filter((n) => n !== xName && n !== yName);

  return {
    xLabel: xName,
    yLabel: yName,
    xValues,
    yValues,
    cells,
    min,
    max,
    metric: chosenMetric,
    collapsed,
  };
}

/**
 * Map a value to 0..1 for colouring.
 *
 * Inverted for drawdown, so dark always means "good" regardless of metric direction. That is
 * the one property a heatmap must have: the reader should not have to remember which way the
 * scale runs.
 */
export function normalise(value: number, min: number, max: number, metric: RankMetric): number {
  if (Number.isNaN(value)) return NaN;
  if (max === min) return 0.5;
  const t = (value - min) / (max - min);
  return higherIsBetter(metric) ? t : 1 - t;
}

/** The best cell, for the "apply this" button. */
export function bestCell(heat: Heatmap): HeatCell | null {
  let best: HeatCell | null = null;
  for (const row of heat.cells) {
    for (const c of row) {
      if (c.bestRun < 0 || Number.isNaN(c.value)) continue;
      if (!best) { best = c; continue; }
      const better = higherIsBetter(heat.metric);
      if (better ? c.value > best.value : c.value < best.value) best = c;
    }
  }
  return best;
}

/**
 * A parameter set is only applicable if it was actually RUN.
 *
 * Returning the cell's own params would mean reconstructing them from the axes, which loses
 * any collapsed dimension and produces a combination that was never tested — a backtest the
 * user never saw, presented as the best one.
 */
export function paramsForCell(
  heat: Heatmap,
  result: OptimizationResult,
  cell: HeatCell,
): Record<string, number> | null {
  if (cell.bestRun < 0) return null;
  const run = result.runs[cell.bestRun];
  if (!run) return null;
  return { ...run.params };
}

/** A one-line summary of the surface, including how ragged it is. */
export function describeHeatmap(heat: Heatmap): string {
  const filled = heat.cells.flat().filter((c) => !Number.isNaN(c.value));
  const empty = heat.cells.flat().length - filled.length;
  const parts = [
    `${heat.xLabel} × ${heat.yLabel}`,
    `${heat.xValues.length}×${heat.yValues.length} cells`,
    `${heat.metric} ${heat.min.toFixed(2)}…${heat.max.toFixed(2)}`,
  ];
  if (empty > 0) parts.push(`${empty} empty`);
  if (heat.collapsed.length > 0) parts.push(`collapsed: ${heat.collapsed.join(", ")}`);
  return parts.join(" · ");
}

/**
 * How jagged the surface is, as the mean absolute step between neighbours normalised by the
 * value range.
 *
 * A smooth surface means the parameter choice is not sensitive and the winner is probably
 * real. A jagged one means the grid is fitting noise, and the "best" cell is likely luck —
 * which is the single most useful thing a heatmap can tell a trader and the thing a ranked
 * table cannot.
 */
export function roughness(heat: Heatmap): number {
  const range = heat.max - heat.min;
  if (range === 0) return 0;
  let total = 0;
  let pairs = 0;
  for (let y = 0; y < heat.cells.length; y++) {
    for (let x = 0; x < heat.cells[y]!.length; x++) {
      const v = heat.cells[y]![x]!.value;
      if (Number.isNaN(v)) continue;
      const right = heat.cells[y]![x + 1]?.value;
      const down = heat.cells[y + 1]?.[x]?.value;
      if (right !== undefined && !Number.isNaN(right)) { total += Math.abs(right - v); pairs++; }
      if (down !== undefined && !Number.isNaN(down)) { total += Math.abs(down - v); pairs++; }
    }
  }
  return pairs === 0 ? 0 : total / pairs / range;
}
