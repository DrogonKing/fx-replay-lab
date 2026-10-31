/**
 * Modify — changing a live position or a resting order.
 *
 * WHY THIS MODULE EXISTS. The rest of the trade lifecycle is already here: `orders.ts` fills resting orders and
 * `position-manage.ts` handles partial closes and trailing. What was missing is the middle of the story a trader
 * actually performs - after a fill, moving the stop, taking the target in, extending the target, or re-pricing a
 * resting order. Without it, a replay can only enter and exit, which is not how a position is managed.
 *
 * THE RULES ARE THE EXCHANGE'S, NOT THIS FILE'S. A modify is a request: it can be refused, and every refusal here
 * carries a reason rather than a silent no-change. That mirrors the server-side behaviour these operations model, and
 * it is what makes the module testable - a refusal is as much a result as an acceptance.
 *
 * BROKER CONSTRAINTS THAT ARE ENFORCED
 *
 *   - a stop must sit on the losing side of the current price, or the position is already closed at market
 *   - for a BUY, stop below price and target above; for a SELL, the reverse. Xenon/MT5 reject the other way round.
 *   - the stop cannot be placed so close that the spread alone would trigger it (minimum distance)
 *   - a resting order is re-priced only while it is still pending; a filled one is a position
 *   - lots cannot be changed through a modify; that is a partial close or an add, both separate operations
 *
 * WHAT IS DELIBERATELY NOT HERE: any notion of "invalid" based on P/L. Moving a stop into loss is legal, common
 * (it is what a wider stop is), and refusing it would be this file inventing a rule the market does not have.
 */

import type { Position, Order, Side } from "./types";

/** The smallest distance a stop may sit from the current price. In MT5 this is the SYMBOL's "stops level". */
export interface ModifyLimits {
  /** minimum distance between the current price and a stop or target, in price units */
  stopsLevel: number;
  /** minimum distance between a resting order's price and the market */
  freezeLevel: number;
}

export const DEFAULT_LIMITS: ModifyLimits = { stopsLevel: 0, freezeLevel: 0 };

export type ModifyRefusal =
  | "not-found"
  | "order-not-pending"
  | "wrong-side-of-market"
  | "too-close-to-market"
  | "non-positive-lots"
  | "price-not-finite"
  | "nothing-to-change";

export type ModifyResult =
  | { ok: true; position?: Position; order?: Order; changed: string[] }
  | { ok: false; reason: ModifyRefusal; detail: string };

/** Which side of the current price a stop and a target belong on. */
export function stopIsValid(side: Side, stop: number, price: number): boolean {
  return side === "buy" ? stop < price : stop > price;
}

export function targetIsValid(side: Side, target: number, price: number): boolean {
  return side === "buy" ? target > price : target < price;
}

function finite(...xs: (number | null | undefined)[]): boolean {
  return xs.every((x) => x === null || x === undefined || Number.isFinite(x));
}

/**
 * Change the stop and/or target of an open position.
 *
 * `null` CLEARS a level, `undefined` leaves it alone - the distinction matters, because "remove the stop" and "do not
 * touch the stop" are different instructions and collapsing them would make one of them impossible to express.
 */
export function modifyPosition(
  position: Position,
  changes: { sl?: number | null; tp?: number | null; price: number },
  limits: ModifyLimits = DEFAULT_LIMITS,
): ModifyResult {
  const { price } = changes;
  if (!Number.isFinite(price) || price <= 0) {
    return { ok: false, reason: "price-not-finite", detail: "no current price was supplied" };
  }
  if (!finite(changes.sl, changes.tp)) {
    return { ok: false, reason: "price-not-finite", detail: "a stop or target was not a finite number" };
  }

  const changed: string[] = [];
  const next: Position = { ...position };

  if (changes.sl !== undefined) {
    if (changes.sl === null) {
      next.sl = null;
      changed.push("sl cleared");
    } else {
      /**
       * THE SIDE CHECK IS THE ONE THAT MATTERS. A buy with its stop above the market is not a stop, it is an immediate
       * close - and accepting it would silently end the position on the next tick while reporting a successful modify.
       */
      if (!stopIsValid(position.side, changes.sl, price)) {
        return {
          ok: false,
          reason: "wrong-side-of-market",
          detail: `a ${position.side} stop must sit ${
            position.side === "buy" ? "below" : "above"
          } ${price}, not ${changes.sl}`,
        };
      }
      if (Math.abs(price - changes.sl) < limits.stopsLevel) {
        return {
          ok: false,
          reason: "too-close-to-market",
          detail: `the stop is ${Math.abs(price - changes.sl).toFixed(5)} from the market; the symbol requires ${limits.stopsLevel}`,
        };
      }
      next.sl = changes.sl;
      changed.push(`sl ${position.sl ?? "none"} -> ${changes.sl}`);
    }
  }

  if (changes.tp !== undefined) {
    if (changes.tp === null) {
      next.tp = null;
      changed.push("tp cleared");
    } else {
      if (!targetIsValid(position.side, changes.tp, price)) {
        return {
          ok: false,
          reason: "wrong-side-of-market",
          detail: `a ${position.side} target must sit ${
            position.side === "buy" ? "above" : "below"
          } ${price}, not ${changes.tp}`,
        };
      }
      if (Math.abs(changes.tp - price) < limits.stopsLevel) {
        return {
          ok: false,
          reason: "too-close-to-market",
          detail: `the target is ${Math.abs(changes.tp - price).toFixed(5)} from the market; the symbol requires ${limits.stopsLevel}`,
        };
      }
      next.tp = changes.tp;
      changed.push(`tp ${position.tp ?? "none"} -> ${changes.tp}`);
    }
  }

  if (!changed.length) {
    return { ok: false, reason: "nothing-to-change", detail: "no stop or target was supplied" };
  }
  return { ok: true, position: next, changed };
}

/**
 * Re-price a resting order.
 *
 * A filled order is a position, and its price is history - so this refuses rather than pretending. `lots` is
 * deliberately absent: changing size is a cancel-and-replace, which is a different operation with different
 * consequences (a new ticket, a new queue position).
 */
export function modifyOrder(
  order: Order,
  changes: { price?: number; slDistance?: number; tpDistance?: number },
  limits: ModifyLimits = DEFAULT_LIMITS,
  currentPrice?: number,
): ModifyResult {
  if (order.status !== "pending") {
    return {
      ok: false,
      reason: "order-not-pending",
      detail: `this order is ${order.status}; a filled order is a position and has no price to change`,
    };
  }
  if (order.type === "market") {
    return { ok: false, reason: "order-not-pending", detail: "a market order does not rest and cannot be re-priced" };
  }
  if (!finite(changes.price, changes.slDistance, changes.tpDistance)) {
    return { ok: false, reason: "price-not-finite", detail: "a price or distance was not a finite number" };
  }
  if (changes.slDistance !== undefined && changes.slDistance < 0) {
    return { ok: false, reason: "non-positive-lots", detail: "a stop distance cannot be negative" };
  }

  const changed: string[] = [];
  const next: Order = { ...order };

  if (changes.price !== undefined) {
    if (currentPrice !== undefined) {
      if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
        return { ok: false, reason: "price-not-finite", detail: "no usable current price" };
      }
      // A limit must stay on the favourable side and a stop on the adverse side, relative to the market. Crossing over
      // would make it the other kind of order, which MT5 rejects rather than converting.
      const mustBeBelow = order.type === "limit" ? order.side === "buy" : order.side === "sell";
      const ok = mustBeBelow ? changes.price < currentPrice : changes.price > currentPrice;
      if (!ok) {
        return {
          ok: false,
          reason: "wrong-side-of-market",
          detail: `a ${order.side} ${order.type} must sit ${mustBeBelow ? "below" : "above"} ${currentPrice}`,
        };
      }
      if (Math.abs(changes.price - currentPrice) < limits.freezeLevel) {
        return {
          ok: false,
          reason: "too-close-to-market",
          detail: `the price is inside the symbol's freeze level of ${limits.freezeLevel}`,
        };
      }
    }
    next.price = changes.price;
    changed.push(`price ${order.price ?? "none"} -> ${changes.price}`);
  }
  if (changes.slDistance !== undefined) {
    next.slDistance = changes.slDistance;
    changed.push(`slDistance ${order.slDistance} -> ${changes.slDistance}`);
  }
  if (changes.tpDistance !== undefined) {
    next.tpDistance = changes.tpDistance;
    changed.push(`tpDistance ${order.tpDistance} -> ${changes.tpDistance}`);
  }

  if (!changed.length) {
    return { ok: false, reason: "nothing-to-change", detail: "no price or distance was supplied" };
  }
  return { ok: true, order: next, changed };
}

/** A one-line description for a journal or an audit row. */
export function describeModify(result: ModifyResult, what: "position" | "order", ref: number): string {
  if (!result.ok) return `modify ${what} #${ref} refused: ${result.detail}`;
  return `modify ${what} #${ref}: ${result.changed.join(", ")}`;
}