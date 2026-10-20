/**
 * Pending order book: limit, stop, stop-limit and OCO.
 *
 * Pure logic, no engine. Kept separate from AccountEngine because order matching is
 * a different concern from money accounting, and because the trigger rules are the
 * part most likely to be subtly wrong — a limit that fills when it should not is a
 * silent backtest lie, so every rule here is unit-tested.
 *
 * Vocabulary, from the trading side:
 *   BUY  LIMIT fills at or BELOW the limit price  (you want it cheaper)
 *   BUY  STOP  fills at or ABOVE the stop price   (you want confirmation of a break)
 *   SELL LIMIT fills at or ABOVE the limit price  (you want to sell higher)
 *   SELL STOP  fills at or BELOW the stop price   (you want out on a break down)
 *
 * Getting those four backwards is the classic bug, so the table is the spec.
 */
import type { OrderType, Side } from "./types.js";

export type PendingKind = Extract<OrderType, "limit" | "stop"> | "stop-limit";

export interface PendingOrder {
  id: string;
  side: Side;
  kind: PendingKind;
  lots: number;
  /** the trigger price: limit price, or stop price */
  price: number;
  /** stop-limit only: the worst price accepted once triggered */
  limitPrice?: number;
  slDistance: number;
  tpDistance: number;
  createdAt: number;
  /** OCO group: when one order in a group fills, the rest are cancelled */
  ocoGroup?: string;
  status: "pending" | "filled" | "cancelled" | "triggered";
  /** for stop-limit: has the stop been touched yet */
  triggered?: boolean;
  /** why it left the book */
  cancelReason?: string;
  tags?: string[];
}

export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface FillResult {
  filled: PendingOrder[];
  cancelled: PendingOrder[];
  /** orders still pending after this bar */
  remaining: PendingOrder[];
  /** the price each fill should execute at */
  fills: Array<{ order: PendingOrder; price: number; reason: "trigger" | "gap" }>;
}

/**
 * Should a limit order fill on this bar, and at what price?
 *
 * A limit fills at the limit price or BETTER. If the bar GAPS through the limit
 * (open beyond it), the fill happens at the open — that is the honest assumption,
 * and it is the same rule the engine already uses for stops gapping.
 */
export function limitFill(
  side: Side, limitPrice: number, bar: Bar,
): { price: number; reason: "trigger" | "gap" } | null {
  if (side === "buy") {
    // buy limit: needs price to come DOWN to the limit
    if (bar.open <= limitPrice) return { price: bar.open, reason: "gap" };
    if (bar.low <= limitPrice) return { price: limitPrice, reason: "trigger" };
    return null;
  }
  // sell limit: needs price to come UP to the limit
  if (bar.open >= limitPrice) return { price: bar.open, reason: "gap" };
  if (bar.high >= limitPrice) return { price: limitPrice, reason: "trigger" };
  return null;
}

/**
 * Should a stop order trigger on this bar, and at what price?
 *
 * A stop becomes a market order: it fills at the stop, or WORSE if the bar gaps
 * past it. Slippage here is real and ignoring it flatters every breakout strategy.
 */
export function stopFill(
  side: Side, stopPrice: number, bar: Bar,
): { price: number; reason: "trigger" | "gap" } | null {
  if (side === "buy") {
    // buy stop: needs price to rise THROUGH the stop
    if (bar.open >= stopPrice) return { price: bar.open, reason: "gap" };
    if (bar.high >= stopPrice) return { price: stopPrice, reason: "trigger" };
    return null;
  }
  // sell stop: needs price to fall through the stop
  if (bar.open <= stopPrice) return { price: bar.open, reason: "gap" };
  if (bar.low <= stopPrice) return { price: stopPrice, reason: "trigger" };
  return null;
}

/** Has the stop leg of a stop-limit been touched (arming the limit)? */
export function stopTriggered(side: Side, stopPrice: number, bar: Bar): boolean {
  return stopFill(side, stopPrice, bar) !== null;
}

/**
 * Evaluate the whole book against one bar.
 *
 * Order of work per bar, and why:
 *   1. trigger stop-limit orders whose stop was touched;
 *   2. fill anything now ffillable (limits, stops, armed stop-limits);
 *   3. cancel the OCO siblings of everything that filled.
 *
 * A single bar can both trigger and fill a stop-limit (price passes through both
 * levels), which is why the trigger step runs first within the same bar.
 */
export function processBar(orders: readonly PendingOrder[], bar: Bar): FillResult {
  const filled: PendingOrder[] = [];
  const cancelled: PendingOrder[] = [];
  const fills: FillResult["fills"] = [];
  const stillPending: PendingOrder[] = [];

  // Groups that have already fired on this bar. Checked inside the loop, not after
  // it: with both legs touched by one bar, cancelling afterwards would have filled
  // both and opened two opposing positions — precisely what OCO exists to prevent.
  const firedGroups = new Set<string>();

  for (const o of orders) {
    if (o.status !== "pending") continue;

    // a sibling filled earlier in this same bar: this one is already dead
    if (o.ocoGroup && firedGroups.has(o.ocoGroup)) {
      cancelled.push({ ...o, status: "cancelled", cancelReason: "OCO sibling filled" });
      continue;
    }

    // --- stop-limit: arm it when the stop is touched -----------------------
    if (o.kind === "stop-limit" && !o.triggered) {
      const trigger = stopFill(o.side, o.price, bar);
      if (!trigger) {
        stillPending.push(o);
        continue;
      }

      // The order became a live limit at the trigger price, NOT at the bar's open.
      // Using limitFill() here was wrong for buy stop-limits: its limit sits above
      // the market while price rises through it, so it read the bar's open as a
      // favourable gap and filled far below where the market actually was.
      const lim = o.limitPrice ?? o.price;
      const acceptable = o.side === "buy"
        ? trigger.price <= lim
        : trigger.price >= lim;

      if (acceptable) {
        const done: PendingOrder = { ...o, triggered: true, status: "filled" };
        filled.push(done);
        fills.push({ order: done, price: trigger.price, reason: trigger.reason });
        if (o.ocoGroup) firedGroups.add(o.ocoGroup);
      } else {
        // gapped through the limit: armed but unfillable at an acceptable price
        stillPending.push({ ...o, triggered: true });
      }
      continue;
    }

    // --- stop-limit already armed: only the limit leg can fill -------------
    if (o.kind === "stop-limit" && o.triggered) {
      const lim = o.limitPrice ?? o.price;
      const f = limitFill(o.side, lim, bar);
      if (f) {
        const done: PendingOrder = { ...o, status: "filled" };
        filled.push(done);
        fills.push({ order: done, price: f.price, reason: f.reason });
        if (o.ocoGroup) firedGroups.add(o.ocoGroup);
      } else {
        stillPending.push(o);
      }
      continue;
    }

    // --- plain limit / stop ------------------------------------------------
    const f = o.kind === "limit"
      ? limitFill(o.side, o.price, bar)
      : stopFill(o.side, o.price, bar);

    if (f) {
      const done: PendingOrder = { ...o, status: "filled" };
      filled.push(done);
      fills.push({ order: done, price: f.price, reason: f.reason });
      if (o.ocoGroup) firedGroups.add(o.ocoGroup);
    } else {
      stillPending.push(o);
    }
  }

  // --- OCO: belt and braces for any sibling that reached the book ----------
  const remaining = stillPending.filter((o) => {
    if (o.ocoGroup && firedGroups.has(o.ocoGroup)) {
      cancelled.push({ ...o, status: "cancelled", cancelReason: "OCO sibling filled" });
      return false;
    }
    return true;
  });

  return { filled, cancelled, remaining, fills };
}

/** Validate an order before it enters the book. Returns an error message or null. */
export function validateOrder(
  o: Pick<PendingOrder, "side" | "kind" | "lots" | "price" | "limitPrice">,
  /** current bid, so a limit on the wrong side of the market can be refused */
  bid: number,
  limits: { minLot: number; maxLot: number },
): string | null {
  if (!Number.isFinite(o.lots) || o.lots <= 0) return "lots must be positive";
  if (o.lots < limits.minLot) return `lots below the minimum (${limits.minLot})`;
  if (o.lots > limits.maxLot) return `lots above the maximum (${limits.maxLot})`;
  if (!Number.isFinite(o.price) || o.price <= 0) return "price must be positive";

  if (o.kind === "limit") {
    // A buy limit ABOVE the market would fill instantly, which is a market order
    // the user did not ask for. Refusing is clearer than silently converting.
    if (o.side === "buy" && o.price > bid) {
      return `buy limit ${o.price} is above the market (${bid}) — it would fill immediately; use a market order or a lower limit`;
    }
    if (o.side === "sell" && o.price < bid) {
      return `sell limit ${o.price} is below the market (${bid}) — it would fill immediately`;
    }
  } else if (o.kind === "stop") {
    if (o.side === "buy" && o.price < bid) {
      return `buy stop ${o.price} is below the market (${bid}) — it would trigger immediately`;
    }
    if (o.side === "sell" && o.price > bid) {
      return `sell stop ${o.price} is above the market (${bid}) — it would trigger immediately`;
    }
  } else {
    if (o.limitPrice === undefined || !Number.isFinite(o.limitPrice)) {
      return "stop-limit needs a limit price";
    }
    if (o.side === "buy" && o.limitPrice < o.price) {
      return "a buy stop-limit needs its limit at or above the stop";
    }
    if (o.side === "sell" && o.limitPrice > o.price) {
      return "a sell stop-limit needs its limit at or below the stop";
    }
  }
  return null;
}

/** Human label, used by the UI and the journal. */
export function describeOrder(o: PendingOrder): string {
  const kind = o.kind === "stop-limit" ? "stop-limit" : o.kind;
  const limit = o.limitPrice !== undefined ? ` limit ${o.limitPrice}` : "";
  return `${o.side} ${kind} ${o.lots} @ ${o.price}${limit}`;
}
