/**
 * Strategy execution host (runs in the MAIN process).
 *
 * Why not the renderer: the renderer's CSP is `script-src 'self'` with no
 * 'unsafe-eval', which is the correct posture for an app that imports untrusted
 * CSV files. That CSP also blocks `new Function`, which is how the specified
 * JavaScript strategy API has to be compiled.
 *
 * Rather than weakening the CSP for the whole UI (which would make a malicious CSV
 * description code-executable), the strategy compiles and runs here, in the main
 * process, and only plain result data crosses the IPC boundary. The renderer never
 * evaluates a string.
 *
 * Note the deliberate trade-off, recorded in DECISIONS.md: a strategy CAN execute
 * arbitrary code in the main process. That is inherent to "run the user's
 * JavaScript" and is the same trust boundary as opening a script file. It is
 * documented in docs/PINE-COMPATIBILITY.md and the user guide rather than hidden.
 */
import { runBacktest, type BacktestResult, type BacktestSettings } from "../core/backtest.js";
import { optimize, walkForward, monteCarlo, type GridAxis, type RankMetric } from "../core/optimize.js";
import { parsePine } from "../core/pine/parser.js";
import { runPine } from "../core/pine/runtime.js";
import { seriesFromCandles } from "../core/series.js";
import { findSymbol } from "../core/symbol.js";
import type { Account, Candle, CandleSeries } from "../core/types.js";

/** What the renderer sends: plain arrays, since typed arrays cross IPC as objects. */
export interface SeriesPayload {
  time: number[];
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
}

export interface RunRequest {
  series: SeriesPayload;
  code: string;
  params: Record<string, unknown>;
  account: Account;
  symbol: string;
  spread?: number;
}

export function toSeries(p: SeriesPayload): CandleSeries {
  const n = p.time.length;
  return {
    time: Float64Array.from(p.time),
    open: Float64Array.from(p.open),
    high: Float64Array.from(p.high),
    low: Float64Array.from(p.low),
    close: Float64Array.from(p.close),
    volume: Float64Array.from(p.volume),
    length: n,
  };
}

export function toPayload(s: CandleSeries): SeriesPayload {
  return {
    time: Array.from(s.time),
    open: Array.from(s.open),
    high: Array.from(s.high),
    low: Array.from(s.low),
    close: Array.from(s.close),
    volume: Array.from(s.volume),
  };
}

function settingsOf(req: RunRequest): BacktestSettings {
  return {
    account: req.account,
    symbol: findSymbol(req.symbol),
    ...(req.spread !== undefined ? { spread: req.spread } : {}),
  };
}

export function handleBacktest(req: RunRequest): BacktestResult {
  return runBacktest(toSeries(req.series), req.code, req.params, settingsOf(req));
}

export function handleOptimize(
  req: RunRequest,
  axes: GridAxis[],
  maxRuns: number,
  metric: RankMetric,
) {
  return optimize(toSeries(req.series), req.code, req.params, settingsOf(req), {
    axes, maxRuns,
  }, metric);
}

export function handleWalkForward(
  req: RunRequest,
  axes: GridAxis[],
  trainBars: number,
  testBars: number,
) {
  return walkForward(toSeries(req.series), req.code, axes, settingsOf(req), {
    trainBars, testBars,
  });
}

export function handleMonteCarlo(pnls: number[], startingBalance: number) {
  return monteCarlo(pnls, startingBalance, 1000);
}

export function handlePine(payload: SeriesPayload, source: string) {
  const series = toSeries(payload);
  const program = parsePine(source);
  return runPine(series, program);
}

/** Parse only, for the syntax-check-as-you-type path. */
export function handlePineParse(source: string): { ok: boolean; error?: string } {
  try {
    parsePine(source);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export type { Candle };
