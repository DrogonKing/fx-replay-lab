/**
 * Session (trading-state) persistence: open positions, pending orders, balance and the
 * replay cursor, serialised so closing the app does not throw away a live trade.
 *
 * Pure. Same rule as the drawing and journal blobs (ADR-010): the database stores raw JSON
 * and this module does the ONE parse, so a malformed row is reported rather than trusted.
 *
 * What is NOT here: candles. A session references the data set by symbol + timeframe + the
 * bar index it had reached, and the caller reloads the series. Storing bars would multiply
 * the database size by a thousand for data the app can re-derive.
 */
import type { ExitReason, Position, Trade } from "./types.js";
import type { PendingOrder } from "./orders.js";

/** Bumped only when the shape changes in a way old rows cannot satisfy. */
export const SESSION_SCHEMA_VERSION = 1;

export interface SessionState {
  version: number;
  /** "symbol::timeframe", so a session is restored only into the workspace it belongs to */
  workspace: string;
  balance: number;
  stoppedOut: boolean;
  positions: Position[];
  pendingOrders: PendingOrder[];
  /** closed trades of this session, so the trade list survives a restart */
  trades: Trade[];
  /** last revealed bar index in the base series */
  revealed: number;
  /** last bar time seen, for sanity checking the restored series */
  lastBarTime: number;
  /** account settings the session was started with */
  startingBalance: number;
  /** epoch seconds, for the "restored from" line in the UI */
  savedAt: number;
}

export interface SessionParseResult {
  value: SessionState | null;
  /** why the state was rejected; null when value is present */
  rejected: string | null;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Every exit reason, spelled once.
 *
 * Written as a Record keyed by ExitReason so the compiler fails here when a new reason is
 * added to the union. An earlier version kept a hand-written array and rejected valid
 * trades: it listed "StopOut"/"Order"/"Session", which do not exist, and omitted "Net",
 * "Signal" and "Stop-out", which do — so a session containing a stop-out trade could not be
 * restored at all.
 */
const EXIT_REASON_MAP: Record<ExitReason, true> = {
  SL: true, TP: true, Manual: true, Partial: true, Net: true, Signal: true, "Stop-out": true,
};
const EXIT_REASONS = Object.keys(EXIT_REASON_MAP) as ExitReason[];

function isSide(v: unknown): v is "buy" | "sell" {
  return v === "buy" || v === "sell";
}

/**
 * Validate one position.
 *
 * Strict on the fields that move money (side, lots, entry price) and lenient on the ones
 * that only affect presentation (commission may be absent on an older row). A position with
 * a bad side or a zero lot is dropped rather than repaired: guessing what a corrupt position
 * meant is how a simulator shows a profit that never existed.
 */
/**
 * Result of validating one record.
 *
 * An explicit `ok` discriminator, NOT a structural `"reason" in parsed` check: `Trade` owns a
 * field called `reason` (its exit reason), so a structural test classified every successful
 * trade as a failure and pushed "TP" into the error list.
 */
type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };

function parsePosition(raw: unknown, index: number): Checked<Position> {
  if (typeof raw !== "object" || raw === null) return { ok: false, reason: `position ${index}: not an object` };
  const p = raw as Record<string, unknown>;

  if (!isNum(p.id)) return { ok: false, reason: `position ${index}: bad id` };
  if (!isSide(p.side)) return { ok: false, reason: `position ${index}: bad side` };
  if (!isNum(p.lots) || p.lots <= 0) return { ok: false, reason: `position ${index}: bad lots` };
  if (!isNum(p.entryPrice) || p.entryPrice <= 0) return { ok: false, reason: `position ${index}: bad entry price` };
  if (!isNum(p.entryTime)) return { ok: false, reason: `position ${index}: bad entry time` };

  const sl = p.sl === null || p.sl === undefined ? null : p.sl;
  const tp = p.tp === null || p.tp === undefined ? null : p.tp;
  if (sl !== null && !isNum(sl)) return { ok: false, reason: `position ${index}: bad stop` };
  if (tp !== null && !isNum(tp)) return { ok: false, reason: `position ${index}: bad target` };

  return { ok: true, value: {
    id: p.id,
    accountId: isNum(p.accountId) ? p.accountId : 1,
    symbol: typeof p.symbol === "string" ? p.symbol : "",
    side: p.side,
    lots: p.lots,
    entryPrice: p.entryPrice,
    entryTime: p.entryTime,
    sl: sl as number | null,
    tp: tp as number | null,
    trailDistance: isNum(p.trailDistance) ? p.trailDistance : null,
    commission: isNum(p.commission) ? p.commission : 0,
    swap: isNum(p.swap) ? p.swap : 0,
  } };
}

/**
 * Validate one pending order.
 *
 * `ocoGroup` and `trigger` are the parts that decide whether two legs cancel each other, so
 * a corrupt group id would silently break the OCO guarantee. A missing group is fine.
 */
function parsePending(raw: unknown, index: number): Checked<PendingOrder> {
  if (typeof raw !== "object" || raw === null) return { ok: false, reason: `order ${index}: not an object` };
  const o = raw as Record<string, unknown>;

  if (typeof o.id !== "string" || o.id === "") return { ok: false, reason: `order ${index}: bad id` };
  if (!isSide(o.side)) return { ok: false, reason: `order ${index}: bad side` };
  if (!isNum(o.lots) || o.lots <= 0) return { ok: false, reason: `order ${index}: bad lots` };
  if (!isNum(o.price) || o.price <= 0) return { ok: false, reason: `order ${index}: bad price` };
  const kind = o.kind;
  if (kind !== "limit" && kind !== "stop" && kind !== "stop-limit") {
    return { ok: false, reason: `order ${index}: bad kind` };
  }
  const limitPrice = o.limitPrice;
  if (limitPrice !== undefined && !isNum(limitPrice)) {
    return { ok: false, reason: `order ${index}: bad limit price` };
  }

  return { ok: true, value: {
    id: o.id,
    side: o.side,
    kind,
    lots: o.lots,
    price: o.price,
    limitPrice: limitPrice as number | undefined,
    slDistance: isNum(o.slDistance) ? o.slDistance : 0,
    tpDistance: isNum(o.tpDistance) ? o.tpDistance : 0,
    createdAt: isNum(o.createdAt) ? o.createdAt : 0,
    ocoGroup: typeof o.ocoGroup === "string" ? o.ocoGroup : undefined,
    // A restored order is always back in the book: filled and cancelled ones have already
    // left it, and their history is not what a session restore is for.
    status: "pending",
    triggered: o.triggered === true,
    tags: Array.isArray(o.tags) ? o.tags.filter((x): x is string => typeof x === "string") : [],
  } };
}

function parseTrade(raw: unknown, index: number): Checked<Trade> {
  if (typeof raw !== "object" || raw === null) return { ok: false, reason: `trade ${index}: not an object` };
  const t = raw as Record<string, unknown>;

  if (!isNum(t.id)) return { ok: false, reason: `trade ${index}: bad id` };
  if (!isSide(t.side)) return { ok: false, reason: `trade ${index}: bad side` };
  if (!isNum(t.lots) || t.lots <= 0) return { ok: false, reason: `trade ${index}: bad lots` };
  if (!isNum(t.pnl)) return { ok: false, reason: `trade ${index}: bad pnl` };
  if (!isNum(t.entryTime) || !isNum(t.exitTime)) return { ok: false, reason: `trade ${index}: bad times` };

  const reason = t.reason;
  if (typeof reason !== "string" || !EXIT_REASONS.includes(reason as ExitReason)) {
    return { ok: false, reason: `trade ${index}: bad exit reason` };
  }

  return { ok: true, value: {
    id: t.id,
    accountId: isNum(t.accountId) ? t.accountId : 1,
    positionId: isNum(t.positionId) ? t.positionId : 0,
    symbol: typeof t.symbol === "string" ? t.symbol : "",
    side: t.side,
    lots: t.lots,
    entryTime: t.entryTime,
    entryPrice: isNum(t.entryPrice) ? t.entryPrice : 0,
    exitTime: t.exitTime,
    exitPrice: isNum(t.exitPrice) ? t.exitPrice : 0,
    sl: isNum(t.sl) ? t.sl : null,
    tp: isNum(t.tp) ? t.tp : null,
    reason: reason as Trade["reason"],
    pnl: t.pnl,
    commission: isNum(t.commission) ? t.commission : 0,
    swap: isNum(t.swap) ? t.swap : 0,
    notes: typeof t.notes === "string" ? t.notes : "",
    tags: Array.isArray(t.tags) ? t.tags.filter((x): x is string => typeof x === "string") : [],
  } };
}

/**
 * Parse raw state from the database.
 *
 * A NULL row, a row from another workspace, or a version this build does not understand all
 * return `{value: null, rejected: "reason"}` — never a half-restored session. Restoring a
 * session with two of its four positions is worse than starting clean, because the balance
 * no longer explains the positions.
 */
export function parseSessionState(
  raw: unknown,
  opts: { workspace?: string } = {},
): SessionParseResult {
  if (raw === null || raw === undefined) return { value: null, rejected: null };
  if (typeof raw !== "object") return { value: null, rejected: "session row is not an object" };

  const r = raw as Record<string, unknown>;

  if (r.version !== SESSION_SCHEMA_VERSION) {
    return {
      value: null,
      rejected: `session schema version ${String(r.version)} is not ${SESSION_SCHEMA_VERSION}`,
    };
  }
  if (typeof r.workspace !== "string") {
    return { value: null, rejected: "session has no workspace key" };
  }
  if (opts.workspace !== undefined && r.workspace !== opts.workspace) {
    // not an error: the stored session belongs to a different symbol/timeframe
    return { value: null, rejected: null };
  }
  if (!isNum(r.balance) || r.balance < 0) {
    return { value: null, rejected: "session has an invalid balance" };
  }

  const positions: Position[] = [];
  const positionIssues: string[] = [];
  if (Array.isArray(r.positions)) {
    r.positions.forEach((p, i) => {
      const parsed = parsePosition(p, i);
      if (!parsed.ok) positionIssues.push(parsed.reason);
      else positions.push(parsed.value);
    });
  }
  if (positionIssues.length > 0) {
    // Refuse rather than drop: a position silently missing means the balance is a lie.
    return {
      value: null,
      rejected: `session is corrupt: ${positionIssues.join("; ")}`,
    };
  }

  const pendingOrders: PendingOrder[] = [];
  const orderIssues: string[] = [];
  if (Array.isArray(r.pendingOrders)) {
    r.pendingOrders.forEach((o, i) => {
      const parsed = parsePending(o, i);
      if (!parsed.ok) orderIssues.push(parsed.reason);
      else pendingOrders.push(parsed.value);
    });
  }
  if (orderIssues.length > 0) {
    return { value: null, rejected: `session is corrupt: ${orderIssues.join("; ")}` };
  }

  const trades: Trade[] = [];
  const tradeIssues: string[] = [];
  if (Array.isArray(r.trades)) {
    r.trades.forEach((t, i) => {
      const parsed = parseTrade(t, i);
      if (!parsed.ok) tradeIssues.push(parsed.reason);
      else trades.push(parsed.value);
    });
  }
  if (tradeIssues.length > 0) {
    return { value: null, rejected: `session is corrupt: ${tradeIssues.join("; ")}` };
  }

  return {
    value: {
      version: SESSION_SCHEMA_VERSION,
      workspace: r.workspace,
      balance: r.balance,
      stoppedOut: r.stoppedOut === true,
      positions,
      pendingOrders,
      trades,
      revealed: isNum(r.revealed) ? Math.max(0, Math.floor(r.revealed)) : 0,
      lastBarTime: isNum(r.lastBarTime) ? r.lastBarTime : 0,
      startingBalance: isNum(r.startingBalance) ? r.startingBalance : r.balance,
      savedAt: isNum(r.savedAt) ? r.savedAt : 0,
    },
    rejected: null,
  };
}

/** Serialise for storage. Always a plain object, so JSON.stringify is enough. */
export function serialiseSessionState(state: SessionState): SessionState {
  return {
    ...state,
    version: SESSION_SCHEMA_VERSION,
    positions: state.positions.map((p) => ({ ...p })),
    pendingOrders: state.pendingOrders.map((o) => ({ ...o })),
    trades: state.trades.map((t) => ({ ...t })),
  };
}

/**
 * Should a restored session be offered to the user?
 *
 * False for a session that has nothing to lose: no positions, no pending orders, no trades,
 * and the balance is untouched. Offering to restore an empty session is noise, and it makes
 * the "restore" prompt meaningless over time.
 */
export function worthRestoring(state: SessionState): boolean {
  if (state.positions.length > 0) return true;
  if (state.pendingOrders.length > 0) return true;
  if (state.trades.length > 0) return true;
  return state.balance !== state.startingBalance;
}

/** One-line description for the restore prompt. */
export function describeSession(state: SessionState): string {
  const parts: string[] = [`balance ${state.balance.toFixed(2)}`];
  if (state.positions.length > 0) parts.push(`${state.positions.length} open`);
  if (state.pendingOrders.length > 0) parts.push(`${state.pendingOrders.length} pending`);
  if (state.trades.length > 0) parts.push(`${state.trades.length} closed`);
  return parts.join(" · ");
}
