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
    const closed = this.engine.onBar(bar);
    if (closed.length > 0) this.fileTrades(closed);
    this.emit();
    return closed;
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

  /** Reset the account and history. Used by "new session". */
  reset(account: Account = DEFAULT_ACCOUNT): void {
    this.engine = new AccountEngine({ account, symbol: this.spec });
    this.initialRisk.clear();
    this.positionTags.clear();
    this.pending = [];
    this.emit();
  }
}
