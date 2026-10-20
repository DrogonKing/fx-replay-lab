/**
 * The single account engine.
 *
 * Used by manual trading, replay and the backtester, per the spec: one engine so
 * results are identical everywhere. It is pure TypeScript with no environment
 * dependencies, so it can run on the UI thread for interactive trades and inside
 * a worker for 5M-bar backtests.
 *
 * Conventions (see ADR-007):
 *   - the chart shows BID candles;
 *   - a buy fills at ask = price + spread, a sell fills at bid = price;
 *   - exits use the opposite side: a buy closes at bid, a sell closes at ask.
 *
 * SL/TP are checked per bar against that bar's high/low, and if both could
 * trigger within the same bar, SL wins (the pessimistic, industry-standard rule;
 * intrabar order is unknowable without lower-timeframe data).
 */
import type {
  Account,
  Candle,
  ExitReason,
  Position,
  Side,
  SymbolSpec,
  Trade,
} from "./types.js";
import { moneyFromPriceDelta, roundPrice } from "./symbol.js";

export interface EngineOptions {
  account: Account;
  symbol: SymbolSpec;
  /** spread in price units; overrides the symbol default when provided */
  spread?: number;
}

export interface OpenRequest {
  side: Side;
  lots: number;
  /** SL distance in price units (0 = none) */
  slDistance: number;
  /** TP distance in price units (0 = none) */
  tpDistance: number;
  /** optional trailing stop distance in price units */
  trailDistance?: number | null;
  /** current bid price at decision time */
  price: number;
  /** bar time used as the entry timestamp */
  time: number;
  /** set when the fill came from a strategy rather than a click */
  reason?: Extract<ExitReason, "Signal">;
}

export interface CloseResult {
  trade: Trade;
  /** money removed from the position's remaining lots */
  realised: number;
}

let nextId = 1;
function id(): number {
  return nextId++;
}
/** Tests need deterministic ids; production ids come from SQLite anyway. */
export function resetIdsForTest(): void {
  nextId = 1;
}

export class AccountEngine {
  readonly account: Account;
  readonly symbol: SymbolSpec;
  readonly spread: number;

  balance: number;
  positions: Position[] = [];
  trades: Trade[] = [];
  /** true once equity hit zero and everything was force-closed */
  stoppedOut = false;

  constructor(opts: EngineOptions) {
    this.account = opts.account;
    this.symbol = opts.symbol;
    this.spread = opts.spread ?? opts.symbol.spread;
    this.balance = opts.account.startingBalance;
  }

  // ---------------------------------------------------------------- pricing

  /** Price a buyer pays, and a seller receives. */
  ask(bid: number): number {
    return roundPrice(bid + this.spread, this.symbol);
  }
  bid(bid: number): number {
    return roundPrice(bid, this.symbol);
  }

  /** Entry price for a side, from the current bid. */
  entryPrice(side: Side, bidPrice: number): number {
    return side === "buy" ? this.ask(bidPrice) : this.bid(bidPrice);
  }

  /** Exit price for a side, from the current bid. */
  exitPrice(side: Side, bidPrice: number): number {
    // Closing a buy means selling at bid; closing a sell means buying at ask.
    return side === "buy" ? this.bid(bidPrice) : this.ask(bidPrice);
  }

  // ------------------------------------------------------------- positions

  /** Floating P/L of one position at the given bid price. */
  positionPnl(p: Position, bidPrice: number): number {
    const exit = this.exitPrice(p.side, bidPrice);
    const delta = p.side === "buy" ? exit - p.entryPrice : p.entryPrice - exit;
    return moneyFromPriceDelta(delta, p.lots, this.symbol) - p.commission + p.swap;
  }

  /** Sum of floating P/L. */
  floatingPnl(bidPrice: number): number {
    let sum = 0;
    for (const p of this.positions) sum += this.positionPnl(p, bidPrice);
    return sum;
  }

  equity(bidPrice: number): number {
    return this.balance + this.floatingPnl(bidPrice);
  }

  /** Margin currently consumed by open positions. */
  usedMargin(bidPrice: number): number {
    let m = 0;
    for (const p of this.positions) {
      m += (p.lots * this.symbol.contractSize * bidPrice) /
        Math.max(1, this.account.leverage);
    }
    return m;
  }

  freeMargin(bidPrice: number): number {
    return this.equity(bidPrice) - this.usedMargin(bidPrice);
  }

  // ---------------------------------------------------------------- trading

  /**
   * Open a position at market.
   *
   * Netting accounts close the opposite side first (spec: "opening the opposite
   * side closes existing positions first"), then open the remainder.
   */
  open(req: OpenRequest): Position | null {
    if (this.stoppedOut) return null;
    const price = this.entryPrice(req.side, req.price);

    if (this.account.mode === "netting") {
      const opposite = this.positions.filter((p) => p.side !== req.side);
      for (const p of opposite) this.closePosition(p, req.price, req.time, "Net");
    }

    const commission = this.symbol.commissionPerLot * req.lots;
    const sl = req.slDistance > 0
      ? roundPrice(req.side === "buy" ? price - req.slDistance : price + req.slDistance, this.symbol)
      : null;
    const tp = req.tpDistance > 0
      ? roundPrice(req.side === "buy" ? price + req.tpDistance : price - req.tpDistance, this.symbol)
      : null;

    const pos: Position = {
      id: id(),
      accountId: this.account.id,
      symbol: this.symbol.name,
      side: req.side,
      lots: req.lots,
      entryPrice: price,
      entryTime: req.time,
      sl,
      tp,
      trailDistance: req.trailDistance ?? null,
      commission,
      swap: 0,
    };
    this.positions.push(pos);
    // Commission is charged on entry, so it leaves the balance immediately and
    // is not double-counted when the position closes.
    this.balance -= commission;
    return pos;
  }

  /**
   * Close all or part of a position.
   * `lots` <= 0 or >= position lots closes it fully.
   */
  closePosition(
    p: Position,
    bidPrice: number,
    time: number,
    reason: ExitReason,
    lots = 0,
  ): CloseResult | null {
    const idx = this.positions.indexOf(p);
    if (idx < 0) return null;

    const closingLots = lots > 0 && lots < p.lots ? lots : p.lots;
    const exit = this.exitPrice(p.side, bidPrice);
    const delta = p.side === "buy" ? exit - p.entryPrice : p.entryPrice - exit;
    const portion = closingLots / p.lots;
    const gross = moneyFromPriceDelta(delta, closingLots, this.symbol);
    const commissionPortion = p.commission * portion;
    const swapPortion = p.swap * portion;
    // Commission was already deducted from balance on entry, so only the gross
    // price result and swap move the balance now.
    const realised = gross + swapPortion;
    this.balance += realised;

    const trade: Trade = {
      id: id(),
      accountId: this.account.id,
      positionId: p.id,
      symbol: p.symbol,
      side: p.side,
      lots: closingLots,
      entryTime: p.entryTime,
      entryPrice: p.entryPrice,
      exitTime: time,
      exitPrice: exit,
      sl: p.sl,
      tp: p.tp,
      reason,
      pnl: gross - commissionPortion + swapPortion,
      commission: commissionPortion,
      swap: swapPortion,
      notes: "",
      tags: [],
    };
    this.trades.push(trade);

    if (closingLots >= p.lots) {
      this.positions.splice(idx, 1);
    } else {
      p.lots = Number((p.lots - closingLots).toFixed(8));
      p.commission -= commissionPortion;
      p.swap -= swapPortion;
    }
    return { trade, realised };
  }

  /** Close every open position at the given bid. */
  closeAll(bidPrice: number, time: number, reason: ExitReason = "Manual"): Trade[] {
    const out: Trade[] = [];
    for (const p of [...this.positions]) {
      const r = this.closePosition(p, bidPrice, time, reason);
      if (r) out.push(r.trade);
    }
    return out;
  }

  /**
   * Advance one bar: update trailing stops, then check SL/TP.
   *
   * Order matters and is deliberate:
   *   1. trailing stop moves first (it can only tighten);
   *   2. then SL is tested before TP on the same bar (pessimistic rule).
   *
   * Returns the trades closed on this bar.
   */
  onBar(bar: Candle): Trade[] {
    if (this.stoppedOut) return [];
    const closed: Trade[] = [];

    for (const p of [...this.positions]) {
      // --- 1. trailing stop -------------------------------------------------
      if (p.trailDistance != null && p.trailDistance > 0) {
        if (p.side === "buy") {
          const candidate = roundPrice(bar.close - p.trailDistance, this.symbol);
          if (p.sl == null || candidate > p.sl) p.sl = candidate;
        } else {
          const candidate = roundPrice(bar.close + p.trailDistance, this.symbol);
          if (p.sl == null || candidate < p.sl) p.sl = candidate;
        }
      }

      // --- 2. SL before TP --------------------------------------------------
      let hit: ExitReason | null = null;
      let hitPrice = 0;

      if (p.sl != null) {
        const slHit = p.side === "buy" ? bar.low <= p.sl : bar.high >= p.sl;
        if (slHit) {
          hit = "SL";
          // Fill at the stop, not at the bar extreme: a gap through the stop
          // fills at the open, which is the honest assumption.
          hitPrice = p.side === "buy"
            ? Math.min(p.sl, bar.open)
            : Math.max(p.sl, bar.open);
        }
      }
      if (hit == null && p.tp != null) {
        const tpHit = p.side === "buy" ? bar.high >= p.tp : bar.low <= p.tp;
        if (tpHit) {
          hit = "TP";
          hitPrice = p.side === "buy"
            ? Math.max(p.tp, bar.open)
            : Math.min(p.tp, bar.open);
        }
      }

      if (hit) {
        // hitPrice is an exit-side price already, so undo the spread the
        // exitPrice() call would otherwise re-apply by converting back to bid.
        const bidEquivalent = p.side === "buy" ? hitPrice : hitPrice - this.spread;
        const r = this.closePosition(p, bidEquivalent, bar.time, hit);
        if (r) closed.push(r.trade);
      }
    }

    // --- 3. stop-out ------------------------------------------------------
    if (this.positions.length > 0 && this.equity(bar.close) <= 0) {
      const forced = this.closeAll(bar.close, bar.time, "Stop-out");
      closed.push(...forced);
      this.stoppedOut = true;
    }
    return closed;
  }

  /** Deposit or withdraw; positive adds. */
  adjustBalance(amount: number): void {
    this.balance += amount;
  }
}
