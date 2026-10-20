/**
 * Trading session store.
 *
 * Wraps the shared AccountEngine so the UI can open/close positions and, crucially,
 * emits a journal entry for every closed trade. Keeping this outside the React
 * component means the engine is advanced on the replay tick even while no panel is
 * mounted, and the subscription model lets the journal react to closures without
 * polling.
 *
 * The engine is the single source of truth for money (see ADR-002); this module only
 * adapts it and remembers the *initial* stop distance, which a Trade does not keep.
 */
import { AccountEngine } from "../core/account.js";
import type { Candle, Account, SymbolSpec, Side, Position, Trade } from "../core/types.js";
import { findSymbol } from "../core/symbol.js";
import type { JournalEntry } from "../core/persist.js";
import { tradeToJournalEntry, mergeNewEntries } from "../core/trade-to-journal.js";
import {
  processBar, validateOrder, describeOrder,
  type PendingOrder, type PendingKind, type Bar,
} from "../core/orders.js";
import { constrainLevel, applyBreakEven } from "../core/position-manage.js";
import { trailPrice, planPartialClose, atrSeries } from "../core/trailing.js";

export interface SessionSnapshot {
  balance: number;
  equity: number;
  freeMargin: number;
  usedMargin: number;
  floatingPnl: number;
  positions: Position[];
  stoppedOut: boolean;
  /** every trade closed in this session, newest last */
  trades: Trade[];
  /** limit/stop/stop-limit orders waiting for a trigger */
  pendingOrders: PendingOrder[];
  /** orders that filled or were cancelled, newest last */
  orderHistory: PendingOrder[];
}

export interface PlaceOrderResult {
  ok: boolean;
  message?: string;
  order?: PendingOrder;
  /** set when an OCO pair was created */
  sibling?: PendingOrder;
}

export type SessionListener = (s: SessionSnapshot) => void;
export type JournalListener = (added: JournalEntry[]) => void;

const DEFAULT_ACCOUNT: Account = {
  id: 1, name: "Demo", currency: "USD", startingBalance: 10_000,
  leverage: 100, mode: "hedging",
};

export class TradingSession {
  private engine: AccountEngine;
  private spec: SymbolSpec;
  private symbolId: string;
  private price = 0;
  private time = 0;

  /** Initial stop distance per position id, captured at open time. */
  private initialRisk = new Map<number, number>();
  /** Tags per position id, so a trade can be filed with what the user intended. */
  private positionTags = new Map<number, string[]>();

  private listeners = new Set<SessionListener>();
  private journalListeners = new Set<JournalListener>();

  /** entries produced but not yet consumed by the journal panel */
  private pending: JournalEntry[] = [];

  /** live pending orders, evaluated once per bar */
  private orders: PendingOrder[] = [];
  private orderHistory: PendingOrder[] = [];
  private orderSeq = 0;
  /** R multiple at which every stop moves to break-even; 0 = off */
  private breakEvenR = 0;
  /** trailing mode; null = off */
  private trailMode: "distance" | "extreme" | "atr" | null = null;
  private trailValue = 0;
  private atr: number[] = [];
  /** index of the bar currently being processed, for ATR alignment */
  private barIndex = 0;

  constructor(symbolId: string, account: Account = DEFAULT_ACCOUNT) {
    this.symbolId = symbolId;
    this.spec = findSymbol(symbolId);
    this.engine = new AccountEngine({ account, symbol: this.spec });
  }

  /**
   * Floating P/L of one position, from the engine.
   *
   * Exposed so the UI never recomputes money: a second implementation drifts, and the
   * row a trader reads would disagree with the account total.
   */
  positionPnl(p: Position, bid: number): number {
    return this.engine.positionPnl(p, bid);
  }

  /** Called whenever the displayed price changes, so equity stays live. */
  setPrice(bid: number, time: number): void {
    this.price = bid;
    this.time = time;
  }

  get specRef(): SymbolSpec {
    return this.spec;
  }

  get symbol(): string {
    return this.symbolId;
  }

  subscribe(fn: SessionListener): () => void {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => { this.listeners.delete(fn); };
  }

  onJournal(fn: JournalListener): () => void {
    this.journalListeners.add(fn);
    return () => { this.journalListeners.delete(fn); };
  }

  snapshot(): SessionSnapshot {
    const bid = this.price;
    return {
      balance: this.engine.balance,
      equity: this.engine.equity(bid),
      freeMargin: this.engine.freeMargin(bid),
      usedMargin: this.engine.usedMargin(bid),
      floatingPnl: this.engine.floatingPnl(bid),
      positions: [...this.engine.positions],
      stoppedOut: this.engine.stoppedOut,
      trades: [...this.engine.trades],
      pendingOrders: [...this.orders],
      orderHistory: [...this.orderHistory],
    };
  }

  private emit(): void {
    const s = this.snapshot();
    // forEach rather than for..of: Set iteration needs downlevelIteration when the
    // target is below ES2015, and this file is compiled by both configs.
    this.listeners.forEach((fn) => fn(s));
  }

  // ------------------------------------------------------------- trading

  /**
   * Open a market position.
   *
   * `slDistance` is in price units and is stored BEFORE the engine sees it, because
   * the engine converts it to an absolute price and the original distance is what
   * the journal's R multiple needs.
   */
  open(
    side: Side,
    lots: number,
    slDistance: number,
    tpDistance: number,
    tags: string[] = [],
  ): { ok: boolean; message?: string } {
    if (this.price <= 0) return { ok: false, message: "no price yet" };
    if (lots <= 0) return { ok: false, message: "lots must be positive" };
    if (this.engine.stoppedOut) return { ok: false, message: "account stopped out" };

    // Reject an order the account cannot margin. Silently opening it would produce
    // a negative free margin and a misleading equity curve.
    const required = (lots * this.spec.contractSize * this.price) /
      Math.max(1, this.engine.account.leverage);
    if (required > this.engine.freeMargin(this.price)) {
      return {
        ok: false,
        message: `not enough margin: need ${required.toFixed(2)}, ` +
          `free ${this.engine.freeMargin(this.price).toFixed(2)}`,
      };
    }

    const pos = this.engine.open({
      side, lots, slDistance, tpDistance,
      price: this.price, time: this.time,
    });
    if (!pos) return { ok: false, message: "engine refused the order" };

    if (slDistance > 0) this.initialRisk.set(pos.id, slDistance);
    if (tags.length > 0) this.positionTags.set(pos.id, tags);
    this.emit();
    return { ok: true };
  }

  /**
   * Move a position's stop or target.
   *
   * Constrained in core: a stop may not cross the entry, so a drag cannot turn a
   * trade into a guaranteed instant loss.
   */
  setLevel(
    positionId: number,
    kind: "sl" | "tp",
    price: number,
  ): { ok: boolean; message?: string } {
    const pos = this.engine.positions.find((p) => p.id === positionId);
    if (!pos) return { ok: false, message: "position not found" };

    const res = constrainLevel(pos, kind, price, this.spec.pipSize / 2);
    if (res.price === null) return { ok: false, message: res.reason };

    if (kind === "sl") pos.sl = res.price;
    else pos.tp = res.price;
    this.emit();
    return { ok: true };
  }

  /**
   * Move every stop to break-even once it is `triggerR` in profit.
   *
   * Called from onBar. The commission is passed through because "break even" must
   * recover the entry cost too: stopping at the raw entry leaves the trade slightly
   * negative.
   */
  private autoBreakEven(): void {
    if (this.breakEvenR <= 0) return;
    for (const p of this.engine.positions) {
      const next = applyBreakEven(
        p, this.price, this.breakEvenR,
        p.commission, p.lots, this.spec.contractSize,
      );
      if (next === null) continue;
      // applyBreakEven only ever tightens, but guard anyway: a stop must never move
      // backwards on a trade that is already working
      if (p.sl !== null) {
        const isBuy = p.side === "buy";
        if (isBuy && next <= p.sl) continue;
        if (!isBuy && next >= p.sl) continue;
      }
      p.sl = next;
    }
  }

  /** 0 disables automatic break-even. */
  setBreakEvenTrigger(r: number): void {
    this.breakEvenR = Math.max(0, r);
  }

  /** 0 disables trailing. */
  setTrailing(mode: "off" | "distance" | "extreme" | "atr", value: number): void {
    this.trailMode = mode === "off" ? null : mode;
    this.trailValue = Math.max(0, value);
    this.emit();
  }

  /**
   * Close part of a position.
   *
   * Refuses a size that would leave a remainder off the lot step: rounding up closes
   * more than asked, rounding down leaves a position the user believes is gone.
   */
  closePartial(positionId: number, lots: number): { ok: boolean; message?: string } {
    const pos = this.engine.positions.find((p) => p.id === positionId);
    if (!pos) return { ok: false, message: "position not found" };

    const plan = planPartialClose(pos.lots, lots, this.spec.lotStep);
    if (!plan.valid) return { ok: false, message: plan.reason };

    const r = this.engine.closePosition(pos, this.price, this.time, "Partial", plan.lots);
    if (!r) return { ok: false, message: "engine refused the close" };
    this.fileTrades([r.trade]);
    this.emit();
    return { ok: true };
  }

  /**
   * Apply the trailing stop to every position, once per bar.
   *
   * Runs BEFORE the SL check so a trail tightened by this bar can protect it. The trail
   * is computed from the SAME bar being processed; using the next bar's close would let
   * a stop move on information the trade did not have.
   */
  private applyTrailing(bar: Bar, atrIndex: number): void {
    if (this.trailMode === null || this.trailValue <= 0) return;
    for (const p of this.engine.positions) {
      const next = trailPrice({
        side: p.side,
        sl: p.sl,
        entryPrice: p.entryPrice,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        config: {
          mode: this.trailMode,
          value: this.trailValue,
          atr: this.atr,
          atrIndex,
        },
        round: (price) => Math.round(price * 10 ** this.spec.digits) / 10 ** this.spec.digits,
      });
      if (next !== null) p.sl = next;
    }
  }

  /** Feed the ATR series used by ATR trailing. Called when the bar series changes. */
  setAtrSeries(high: number[], low: number[], close: number[]): void {
    this.atr = atrSeries(high, low, close, 14);
  }

  closeAll(): number {
    if (this.engine.positions.length === 0) return 0;
    const closed = this.engine.closeAll(this.price, this.time, "Manual");
    this.fileTrades(closed);
    this.emit();
    return closed.length;
  }

  closeOne(positionId: number): boolean {
    const pos = this.engine.positions.find((p) => p.id === positionId);
    if (!pos) return false;
    const r = this.engine.closePosition(pos, this.price, this.time, "Manual");
    if (!r) return false;
    this.fileTrades([r.trade]);
    this.emit();
    return true;
  }

  // ------------------------------------------------------------- orders

  /**
   * Place a pending order.
   *
   * Validation happens here rather than in the UI so the same rules apply whatever
   * calls it, and a limit on the wrong side of the market is refused instead of
   * silently becoming an instant fill.
   */
  placeOrder(req: {
    side: Side;
    kind: PendingKind;
    lots: number;
    price: number;
    limitPrice?: number;
    slDistance: number;
    tpDistance: number;
    tags?: string[];
    /** join this OCO group instead of creating one */
    ocoGroup?: string;
    /** create an OCO pair: this order plus a sibling on the other side */
    ocoWith?: { side: Side; kind: PendingKind; price: number };
  }): PlaceOrderResult {
    if (this.price <= 0) return { ok: false, message: "no price yet" };

    const err = validateOrder(
      {
        side: req.side, kind: req.kind, lots: req.lots,
        price: req.price, limitPrice: req.limitPrice,
      },
      this.price,
      { minLot: this.spec.lotMin, maxLot: this.spec.lotMax },
    );
    if (err) return { ok: false, message: err };

    const group = req.ocoWith ? `oco_${++this.orderSeq}` : req.ocoGroup;

    const make = (o: {
      side: Side; kind: PendingKind; price: number; limitPrice?: number;
    }): PendingOrder => ({
      id: `ord_${Date.now()}_${++this.orderSeq}`,
      side: o.side,
      kind: o.kind,
      lots: req.lots,
      price: o.price,
      limitPrice: o.limitPrice,
      slDistance: req.slDistance,
      tpDistance: req.tpDistance,
      createdAt: this.time,
      ocoGroup: group,
      status: "pending",
      tags: req.tags ?? [],
    });

    const main = make({
      side: req.side, kind: req.kind, price: req.price, limitPrice: req.limitPrice,
    });

    if (req.ocoWith) {
      const siblingErr = validateOrder(
        {
          side: req.ocoWith.side, kind: req.ocoWith.kind,
          lots: req.lots, price: req.ocoWith.price,
        },
        this.price,
        { minLot: this.spec.lotMin, maxLot: this.spec.lotMax },
      );
      if (siblingErr) return { ok: false, message: `OCO sibling: ${siblingErr}` };
      const sibling = make({
        side: req.ocoWith.side, kind: req.ocoWith.kind, price: req.ocoWith.price,
      });
      this.orders.push(main, sibling);
      this.emit();
      return {
        ok: true, order: main, sibling,
        message: `OCO pair placed (group ${group})`,
      };
    }

    this.orders.push(main);
    this.emit();
    return { ok: true, order: main };
  }

  cancelOrder(id: string): boolean {
    const idx = this.orders.findIndex((o) => o.id === id);
    if (idx < 0) return false;
    const [o] = this.orders.splice(idx, 1);
    this.orderHistory.push({ ...o!, status: "cancelled", cancelReason: "user" });
    this.emit();
    return true;
  }

  cancelAllOrders(): number {
    const n = this.orders.length;
    for (const o of this.orders) {
      this.orderHistory.push({ ...o, status: "cancelled", cancelReason: "user" });
    }
    this.orders = [];
    if (n > 0) this.emit();
    return n;
  }

  /**
   * Advance the engine one bar so SL/TP and trailing stops fire.
   *
   * Called by the replay tick. Any trade the engine closes here is filed to the
   * journal immediately: a stop-out discovered later, when the user next opens the
   * journal tab, would be filed with the wrong timestamp and no tags.
   */
  onBar(bar: Candle, barIndex?: number): Trade[] {
    this.price = bar.close;
    this.time = bar.time;
    if (barIndex !== undefined) this.barIndex = barIndex;
    else this.barIndex++;

    // Pending orders are evaluated BEFORE the engine's SL/TP pass. A limit that
    // fills on this bar is a position that existed for (part of) this bar, so its
    // stop must be testable on the same bar rather than a bar later — otherwise
    // every entry gets a free bar of protection it did not have.
    this.processOrders(bar as Bar);

    // Break-even runs BEFORE the SL/TP pass: it is a one-off jump to the entry, and if
    // price has already reached the trigger on this bar the stop should be there when
    // the same bar is tested.
    this.autoBreakEven();

    const closed = this.engine.onBar(bar);
    if (closed.length > 0) this.fileTrades(closed);

    // Trailing runs AFTER the SL/TP pass, deliberately. A trail derived from this bar's
    // close cannot be tested against this bar: the low that would have hit it happened
    // BEFORE the close that set it. Applying it in the same bar closed winning trades
    // for a loss — entry 2000.2, bar high 2030/low 1999/close 2025 gave a stop of 2015,
    // which the same bar's low of 1999 "hit", exiting at 2000 for -2.30 on a trade that
    // had touched 2030. Setting it AFTER means it protects the NEXT bar, which is the
    // only causally sound order.
    this.applyTrailing(bar as Bar, this.barIndex);

    this.emit();
    return closed;
  }

  /** Match the book against a bar and open positions for whatever filled. */
  private processOrders(bar: Bar): void {
    if (this.orders.length === 0) return;

    const r = processBar(this.orders, bar);

    for (const o of [...r.filled, ...r.cancelled]) {
      this.orderHistory.push(o);
    }
    this.orders = r.remaining;

    for (const fill of r.fills) {
      const o = fill.order;
      // The engine prices from the current BID and applies the spread itself, so
      // convert the fill price back to a bid-equivalent: a buy fills at ask, so its
      // bid equivalent is price - spread.
      const bidEquivalent = o.side === "buy"
        ? fill.price - this.engine.spread
        : fill.price;

      const pos = this.engine.open({
        side: o.side,
        lots: o.lots,
        slDistance: o.slDistance,
        tpDistance: o.tpDistance,
        price: bidEquivalent,
        time: bar.time,
      });
      if (!pos) continue;

      if (o.slDistance > 0) this.initialRisk.set(pos.id, o.slDistance);
      const tags = [...(o.tags ?? []), `${o.kind}-fill`];
      if (tags.length > 0) this.positionTags.set(pos.id, tags);
    }
  }

  private fileTrades(trades: readonly Trade[]): void {
    if (trades.length === 0) return;
    let seq = 0;
    const entries = trades.map((t) => {
      const stopDistance = this.initialRisk.get(t.positionId);
      const tags = this.positionTags.get(t.positionId) ?? [];
      return tradeToJournalEntry(
        t,
        { stopDistance, contractSize: this.spec.contractSize, tags },
        () => `t_${t.exitTime}_${t.id}_${seq++}`,
      );
    });

    // dedupe against anything already pending, so a replayed bar cannot file twice
    const { merged, added } = mergeNewEntries(this.pending, entries);
    this.pending = merged;
    if (added > 0) {
      const fresh = merged.slice(merged.length - added);
      this.journalListeners.forEach((fn) => fn(fresh));
    }

    // risk bookkeeping only matters while the position is open
    for (const t of trades) {
      this.initialRisk.delete(t.positionId);
      this.positionTags.delete(t.positionId);
    }
  }

  /** Hand over every entry produced so far and clear the buffer. */
  takePending(): JournalEntry[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }

  /** Reset the account, the order book and all history. Used by "new session". */
  reset(account: Account = DEFAULT_ACCOUNT): void {
    this.engine = new AccountEngine({ account, symbol: this.spec });
    this.initialRisk.clear();
    this.positionTags.clear();
    this.pending = [];
    // The order book must go too: a stale limit left over from the previous session
    // would fire against the fresh account the moment replay resumes.
    this.orders = [];
    this.orderHistory = [];
    this.emit();
  }
}
