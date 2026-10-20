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

  constructor(symbolId: string, account: Account = DEFAULT_ACCOUNT) {
    this.symbolId = symbolId;
    this.spec = findSymbol(symbolId);
    this.engine = new AccountEngine({ account, symbol: this.spec });
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
  onBar(bar: Candle): Trade[] {
    this.price = bar.close;
    this.time = bar.time;

    // Pending orders are evaluated BEFORE the engine's SL/TP pass. A limit that
    // fills on this bar is a position that existed for (part of) this bar, so its
    // stop must be testable on the same bar rather than a bar later — otherwise
    // every entry gets a free bar of protection it did not have.
    this.processOrders(bar as Bar);

    const closed = this.engine.onBar(bar);
    if (closed.length > 0) this.fileTrades(closed);
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
