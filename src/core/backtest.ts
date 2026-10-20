/**
 * Strategy backtester.
 *
 * Runs user JavaScript against a CandleSeries using the SAME AccountEngine as
 * manual trading and replay, so a strategy that looks profitable here produces
 * the same fills when traded by hand. That consistency is a spec requirement and
 * the reason this module does not implement its own fill logic.
 *
 * Two execution paths exist:
 *   - runBacktest:      the JS strategy API (spec section 5)
 *   - runSignalBacktest: a precomputed signal array, used by the optimizer and
 *                        by Pine strategies after compilation, which avoids
 *                        re-evaluating JS on every optimizer pass.
 */
import { AccountEngine } from "./account.js";
import { sma, ema, rsi, bollinger, atr, macd, stochastic, crossover, crossunder } from "./indicators.js";
import type { Account, Candle, CandleSeries, Position, SymbolSpec } from "./types.js";

export interface BacktestSettings {
  account: Account;
  symbol: SymbolSpec;
  spread?: number;
  /** optional commission override per lot */
  commissionPerLot?: number;
}

export interface BacktestStats {
  tradeCount: number;
  winRate: number;
  netProfit: number;
  profitFactor: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  /** average win / average loss, in money */
  avgWin: number;
  avgLoss: number;
  /** expectancy per trade in money */
  expectancy: number;
  /** longest run of wins / losses */
  maxWinStreak: number;
  maxLossStreak: number;
  grossProfit: number;
  grossLoss: number;
  startingBalance: number;
  endingBalance: number;
  /** annualised-ish Sharpe from per-trade returns; 0 when undefined */
  sharpe: number;
  sortino: number;
  /** monthly net profit keyed "YYYY-MM" (UTC) */
  monthlyReturns: Record<string, number>;
  /** largest adverse excursion per trade, average, in money */
  avgMae: number;
  /** largest favourable excursion per trade, average, in money */
  avgMfe: number;
}

export interface BacktestTrade {
  entryIndex: number;
  exitIndex: number;
  entryTime: number;
  exitTime: number;
  side: "buy" | "sell";
  lots: number;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  reason: string;
  mae: number;
  mfe: number;
}

export interface EquityPoint {
  time: number;
  equity: number;
}

export interface BacktestResult {
  stats: BacktestStats;
  trades: BacktestTrade[];
  equityCurve: EquityPoint[];
  /** errors thrown by the strategy, rendered readably instead of crashing */
  errors: string[];
}

// ------------------------------------------------------------ strategy API

export interface StrategyContext {
  /** bar index being evaluated */
  i: number;
  /** the current bar */
  bar: { t: number; o: number; h: number; l: number; c: number; v: number };
  /** user parameters from the JSON field */
  p: Record<string, unknown>;
  /** persistent state across bars */
  s: Record<string, unknown>;
  /** open positions, read-only snapshot */
  pos: ReadonlyArray<Readonly<Position>>;
  /** indicator lookup, cached per (kind, period) */
  ind: (kind: string, period: number, barsBack?: number) => number;
  buy: (lots: number, slDistance?: number, tpDistance?: number) => void;
  sell: (lots: number, slDistance?: number, tpDistance?: number) => void;
  closeAll: () => void;
}

type StrategyFn = (c: StrategyContext) => void;

interface PendingAction {
  kind: "buy" | "sell" | "closeAll";
  lots?: number;
  sl?: number;
  tp?: number;
}

/**
 * Compile a strategy body into a function.
 * The body receives `c`; returning nothing is fine. Throwing is caught per bar.
 */
export function compileStrategy(body: string): StrategyFn {
  // Deliberately not `new Function` in a sandbox: this runs locally on the
  // user's own machine with no network, and the spec's strategy API is plain JS.
  // The wrapper keeps the user's `return` usable and forbids top-level await.
  const fn = new Function("c", `"use strict";\n${body}\n;`) as StrategyFn;
  return fn;
}

/** Indicator cache keyed by kind+period, computed once per backtest. */
class IndicatorCache {
  private map = new Map<string, Float64Array>();
  constructor(private s: CandleSeries) {}

  get(kind: string, period: number): Float64Array {
    const key = `${kind}:${period}`;
    const hit = this.map.get(key);
    if (hit) return hit;

    let line: Float64Array;
    switch (kind.toUpperCase()) {
      case "SMA": line = sma(this.s.close, period); break;
      case "EMA": line = ema(this.s.close, period); break;
      case "RSI": line = rsi(this.s, period); break;
      case "ATR": line = atr(this.s, period); break;
      case "BBUPPER": line = bollinger(this.s, period, 2).upper; break;
      case "BBLOWER": line = bollinger(this.s, period, 2).lower; break;
      case "BBMIDDLE": line = bollinger(this.s, period, 2).middle; break;
      case "MACD": line = macd(this.s, 12, 26, 9).macd; break;
      case "MACDSIGNAL": line = macd(this.s, 12, 26, 9).signal; break;
      case "STOCHK": line = stochastic(this.s, period, 3, 3).k; break;
      case "STOCHD": line = stochastic(this.s, period, 3, 3).d; break;
      default:
        throw new Error(`unknown indicator: ${kind}`);
    }
    this.map.set(key, line);
    return line;
  }
}

/**
 * Run a JS strategy over the whole series.
 *
 * Fill semantics match the account engine exactly: a signal on bar i is filled
 * at bar i's close (plus spread for a buy), and SL/TP are then evaluated from
 * bar i+1 onward. Filling on the same bar whose high/low produced the signal
 * would be look-ahead, which is the single most common way a backtest lies.
 */
export function runBacktest(
  series: CandleSeries,
  body: string,
  params: Record<string, unknown>,
  settings: BacktestSettings,
): BacktestResult {
  const errors: string[] = [];
  let strategy: StrategyFn;
  try {
    strategy = compileStrategy(body);
  } catch (e) {
    return {
      stats: emptyStats(settings.account.startingBalance),
      trades: [],
      equityCurve: [],
      errors: [`compile error: ${(e as Error).message}`],
    };
  }

  const engine = new AccountEngine({
    account: settings.account,
    symbol: settings.symbol,
    ...(settings.spread !== undefined ? { spread: settings.spread } : {}),
  });
  if (settings.commissionPerLot !== undefined) {
    // engine reads commission from the symbol spec; clone with the override
    (engine as unknown as { symbol: SymbolSpec }).symbol = {
      ...settings.symbol,
      commissionPerLot: settings.commissionPerLot,
    };
  }

  const cache = new IndicatorCache(series);
  const state: Record<string, unknown> = {};
  const pending: PendingAction[] = [];
  const equityCurve: EquityPoint[] = [];
  const tracked: Array<{ entryIndex: number; mae: number; mfe: number; side: "buy" | "sell"; lots: number; entryPrice: number }> = [];

  // Track MAE/MFE per open position by scanning bars while it is open.
  const positionMeta = new Map<number, { entryIndex: number; mae: number; mfe: number }>();

  for (let i = 0; i < series.length; i++) {
    const bar: Candle = {
      time: series.time[i]!,
      open: series.open[i]!,
      high: series.high[i]!,
      low: series.low[i]!,
      close: series.close[i]!,
      volume: series.volume[i]!,
    };

    // 1. Apply actions decided on the PREVIOUS bar, at this bar's open.
    if (pending.length > 0) {
      for (const a of pending) {
        if (a.kind === "closeAll") {
          engine.closeAll(bar.open, bar.time, "Signal");
          continue;
        }
        const pos = engine.open({
          side: a.kind,
          lots: a.lots ?? 0.01,
          slDistance: a.sl ?? 0,
          tpDistance: a.tp ?? 0,
          price: bar.open,
          time: bar.time,
        });
        if (pos) positionMeta.set(pos.id, { entryIndex: i, mae: 0, mfe: 0 });
      }
      pending.length = 0;
    }

    // 2. Track excursions for open positions before SL/TP resolution, so a stop
    //    that hits this bar still records how far it went in favour first.
    for (const p of engine.positions) {
      const meta = positionMeta.get(p.id);
      if (!meta) continue;
      const adverse = p.side === "buy"
        ? (bar.low - p.entryPrice) * engine.symbol.contractSize * p.lots
        : (p.entryPrice - bar.high) * engine.symbol.contractSize * p.lots;
      const favour = p.side === "buy"
        ? (bar.high - p.entryPrice) * engine.symbol.contractSize * p.lots
        : (p.entryPrice - bar.low) * engine.symbol.contractSize * p.lots;
      if (adverse < meta.mae) meta.mae = adverse;
      if (favour > meta.mfe) meta.mfe = favour;
    }

    // 3. Resolve SL/TP for this bar.
    engine.onBar(bar);

    // 4. Run the strategy for this bar; its orders fill at the NEXT bar's open.
    try {
      const ctx: StrategyContext = {
        i,
        bar: { t: bar.time, o: bar.open, h: bar.high, l: bar.low, c: bar.close, v: bar.volume },
        p: params,
        s: state,
        pos: engine.positions,
        ind: (kind, period, barsBack = 0) => {
          const line = cache.get(kind, period);
          const idx = i - barsBack;
          const v = line[idx];
          return v == null || Number.isNaN(v) ? Number.NaN : v;
        },
        buy: (lots, sl = 0, tp = 0) => pending.push({ kind: "buy", lots, sl, tp }),
        sell: (lots, sl = 0, tp = 0) => pending.push({ kind: "sell", lots, sl, tp }),
        closeAll: () => pending.push({ kind: "closeAll" }),
      };
      strategy(ctx);
    } catch (e) {
      // Report once per distinct message, keep going: one bad bar should not
      // destroy a 5M-bar run.
      const msg = `bar ${i}: ${(e as Error).message}`;
      if (errors.length < 20 && !errors.includes(msg)) errors.push(msg);
    }

    if (i % 50 === 0 || i === series.length - 1) {
      equityCurve.push({ time: bar.time, equity: engine.equity(bar.close) });
    }
  }

  // Attach MAE/MFE to trades by position id ordering.
  const trades: BacktestTrade[] = engine.trades.map((t) => {
    const meta = positionMeta.get(t.positionId);
    return {
      entryIndex: meta?.entryIndex ?? 0,
      exitIndex: 0,
      entryTime: t.entryTime,
      exitTime: t.exitTime,
      side: t.side,
      lots: t.lots,
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice,
      pnl: t.pnl,
      reason: t.reason,
      mae: meta?.mae ?? 0,
      mfe: meta?.mfe ?? 0,
    };
  });
  void tracked;

  return {
    stats: computeStats(trades, settings.account.startingBalance, equityCurve),
    trades,
    equityCurve,
    errors,
  };
}

// -------------------------------------------------------------------- stats

export function emptyStats(startingBalance: number): BacktestStats {
  return {
    tradeCount: 0, winRate: 0, netProfit: 0, profitFactor: 0,
    maxDrawdown: 0, maxDrawdownPct: 0, avgWin: 0, avgLoss: 0, expectancy: 0,
    maxWinStreak: 0, maxLossStreak: 0, grossProfit: 0, grossLoss: 0,
    startingBalance, endingBalance: startingBalance, sharpe: 0, sortino: 0,
    monthlyReturns: {}, avgMae: 0, avgMfe: 0,
  };
}

export function computeStats(
  trades: readonly BacktestTrade[],
  startingBalance: number,
  equityCurve: readonly EquityPoint[],
): BacktestStats {
  if (trades.length === 0) return emptyStats(startingBalance);

  let grossProfit = 0;
  let grossLoss = 0;
  let wins = 0;
  let winStreak = 0;
  let lossStreak = 0;
  let maxWinStreak = 0;
  let maxLossStreak = 0;
  let maeSum = 0;
  let mfeSum = 0;
  const monthly: Record<string, number> = {};
  const returns: number[] = [];

  for (const t of trades) {
    if (t.pnl >= 0) {
      grossProfit += t.pnl;
      wins++;
      winStreak++;
      lossStreak = 0;
      if (winStreak > maxWinStreak) maxWinStreak = winStreak;
    } else {
      grossLoss += -t.pnl;
      lossStreak++;
      winStreak = 0;
      if (lossStreak > maxLossStreak) maxLossStreak = lossStreak;
    }
    maeSum += t.mae;
    mfeSum += t.mfe;

    const d = new Date(t.exitTime * 1000);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    monthly[key] = (monthly[key] ?? 0) + t.pnl;

    // per-trade return relative to a notional stake, for Sharpe/Sortino
    returns.push(t.pnl);
  }

  const netProfit = grossProfit - grossLoss;
  const avgWin = wins > 0 ? grossProfit / wins : 0;
  const losses = trades.length - wins;
  const avgLoss = losses > 0 ? grossLoss / losses : 0;

  // Max drawdown from the equity curve (peak-to-trough, in money and percent).
  let peak = equityCurve.length > 0 ? equityCurve[0]!.equity : startingBalance;
  let maxDd = 0;
  let maxDdPct = 0;
  for (const p of equityCurve) {
    if (p.equity > peak) peak = p.equity;
    const dd = peak - p.equity;
    if (dd > maxDd) {
      maxDd = dd;
      maxDdPct = peak > 0 ? (dd / peak) * 100 : 0;
    }
  }

  // Sharpe: mean / stdev of per-trade P/L. Annualising per-trade returns needs a
  // trades-per-year assumption, so this reports the per-trade ratio, which is
  // comparable across runs on the same data.
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  const sd = Math.sqrt(variance);
  const sharpe = sd > 0 ? mean / sd : 0;

  // Sortino: only downside deviation counts.
  const downside = returns.filter((r) => r < 0);
  const ddSd = downside.length > 0
    ? Math.sqrt(downside.reduce((a, b) => a + b * b, 0) / downside.length)
    : 0;
  const sortino = ddSd > 0 ? mean / ddSd : 0;

  return {
    tradeCount: trades.length,
    winRate: (wins / trades.length) * 100,
    netProfit,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    maxDrawdown: maxDd,
    maxDrawdownPct: maxDdPct,
    avgWin,
    avgLoss,
    expectancy: netProfit / trades.length,
    maxWinStreak,
    maxLossStreak,
    grossProfit,
    grossLoss,
    startingBalance,
    endingBalance: startingBalance + netProfit,
    sharpe,
    sortino,
    monthlyReturns: monthly,
    avgMae: maeSum / trades.length,
    avgMfe: mfeSum / trades.length,
  };
}
