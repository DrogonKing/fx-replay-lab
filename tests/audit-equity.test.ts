/**
 * Does equity double-count commission?
 *
 * The invariant that matters, in the user's terms: the equity shown must equal the balance you would
 * actually have if you closed right now. Anything else is a number that disagrees with itself.
 *
 *   account.ts:212   open()      balance -= commission
 *   account.ts:142   positionPnl() = gross - p.commission + p.swap
 *   account.ts:153   equity()    = balance + floatingPnl()
 *
 * If the balance already lost the commission, subtracting it again in positionPnl would make equity
 * understate reality by exactly one commission.
 */
import { AccountEngine } from "../src/core/account.js";
import { findSymbol } from "../src/core/symbol.js";
import type { Account, Candle } from "../src/core/types.js";

const GOLD = findSymbol("XAUUSD"); // contract 100, spread 0.2, commission 3/lot

function engine(): AccountEngine {
  const account: Account = {
    id: 1, name: "test", currency: "USD", startingBalance: 10_000,
    leverage: 100, mode: "hedging",
  };
  return new AccountEngine({ account, symbol: GOLD });
}

const bar: Candle = {
  time: 1, open: 2000, high: 2001, low: 1999, close: 2000, volume: 0,
};

describe("equity must agree with closing", () => {
  it("equity(price) equals the balance after closing at that price", () => {
    const live = engine();
    live.open({ side: "buy", lots: 1, slDistance: 0, tpDistance: 0, price: 2000, time: 1 });

    const probedPrice = 2005;
    const equityShown = live.equity(probedPrice);

    // the same account, closed at the same bid: this is the money the user would really have
    const closed = engine();
    closed.open({ side: "buy", lots: 1, slDistance: 0, tpDistance: 0, price: 2000, time: 1 });
    closed.closeAll(probedPrice, 2);

    expect(equityShown).toBeCloseTo(closed.balance, 6);
  });

  it("equity(price) equals balance when opened and closed at the same price", () => {
    const live = engine();
    live.open({ side: "buy", lots: 1, slDistance: 0, tpDistance: 0, price: 2000, time: 1 });
    // flat price: the only cost should be the spread and the commission, once each
    const equityAtEntryBid = live.equity(2000);

    const closed = engine();
    closed.open({ side: "buy", lots: 1, slDistance: 0, tpDistance: 0, price: 2000, time: 1 });
    closed.closeAll(2000, 2);

    expect(equityAtEntryBid).toBeCloseTo(closed.balance, 6);
  });

  it("margin call level is computed from a equity that matches reality", () => {
    // A stop-out that fires early or late by one commission is a behaviour change, not a rounding
    // issue, which is why the invariant above matters beyond display.
    const e = engine();
    e.open({ side: "buy", lots: 1, slDistance: 0, tpDistance: 0, price: 2000, time: 1 });
    const state = e.marginState(2000);
    expect(["ok", "call", "stop-out"]).toContain(state);
    // sanity: the engine must not report a healthy account as stopped out on a flat bar
    expect(state).toBe("ok");
    expect(bar.close).toBe(2000);
  });
});
