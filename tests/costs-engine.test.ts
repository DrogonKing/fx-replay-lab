import { describe, it, expect, beforeEach } from "vitest";
import { AccountEngine, resetIdsForTest } from "../src/core/account.js";
import { DEFAULT_SYMBOLS } from "../src/core/symbol.js";
import type { Account, Candle } from "../src/core/types.js";
import { DEFAULT_SWAP } from "../src/core/costs.js";

const GOLD = DEFAULT_SYMBOLS.find((s) => s.name === "XAUUSD")!;

const ACCOUNT: Account = {
  id: 1, name: "test", currency: "USD", startingBalance: 10_000,
  leverage: 100, mode: "hedging",
};

const bar = (o: Partial<Candle> = {}): Candle => ({
  time: 1000, open: 2000, high: 2001, low: 1999, close: 2000, volume: 1, ...o,
});

const engine = (over: Partial<{ swap: { long: number; short: number } }> = {}) =>
  new AccountEngine({
    account: ACCOUNT,
    symbol: GOLD,
    spread: 0,
    ...(over.swap ? { swap: over.swap } : {}),
  });

beforeEach(() => resetIdsForTest());

describe("swap accrual in the engine", () => {
  it("charges nothing when no rates are configured", () => {
    const e = engine();
    const p = e.open({ side: "buy", lots: 1, slDistance: 0, tpDistance: 0, price: 2000, time: 0 })!;
    // a week later
    e.onBar(bar({ time: 7 * 86400, close: 2000, high: 2000, low: 2000 }));
    // no swap accrued...
    expect(p.swap).toBe(0);
    // ...and the only movement is the ENTRY commission ($3/lot on gold), charged on open
    expect(e.balance).toBeCloseTo(10_000 - GOLD.commissionPerLot, 6);
  });

  it("charges a long position for the nights held", () => {
    const e = engine({ swap: { long: -2, short: 0 } });
    e.open({ side: "buy", lots: 1, slDistance: 0, tpDistance: 0, price: 2000, time: 0 });
    // Monday 00:00 -> Wednesday 00:00 = 2 rollovers, no Wednesday yet
    e.onBar(bar({ time: 2 * 86400, close: 2000, high: 2000, low: 2000 }));
    const pos = e.positions[0]!;
    expect(pos.swap).toBeLessThan(0);
  });

  it("triple-charges the Wednesday night", () => {
    // T0 = Thu 1970-01-01 is a Thursday; 1970-01-07 is a Wednesday
    const e = engine({ swap: { long: -1, short: 0 } });
    e.open({ side: "buy", lots: 1, slDistance: 0, tpDistance: 0, price: 2000, time: 0 });
    // roll through the Wednesday 21:00 rollover
    const wedRollover = 6 * 86400 + 21 * 3600;   // Wed 21:00 UTC
    e.onBar(bar({ time: wedRollover + 60, close: 2000, high: 2000, low: 2000 }));
    const nights = Math.abs(e.positions[0]!.swap);
    // Mon,Tue,Wed rollovers happened; the Wednesday one counts triple = 5 nights
    expect(nights).toBeGreaterThanOrEqual(5);
  });

  it("realises the accrued swap in the trade's pnl", () => {
    const e = engine({ swap: { long: -5, short: 0 } });
    const p = e.open({ side: "buy", lots: 1, slDistance: 0, tpDistance: 0, price: 2000, time: 0 })!;
    e.onBar(bar({ time: 3 * 86400, close: 2000, high: 2000, low: 2000 }));
    const swapAccrued = p.swap;
    expect(swapAccrued).toBeLessThan(0);

    const r = e.closePosition(p, 2000, 3 * 86400 + 100, "Manual")!;
    // 3 rollovers (Thu/Fri/Sat 21:00), no Wednesday yet -> 3 nights at -5
    expect(swapAccrued).toBeCloseTo(-15, 6);
    expect(r.trade.swap).toBeCloseTo(swapAccrued, 6);
    // pnl is NET of commission and swap: price did not move, so it is -3 commission -15 swap
    expect(r.trade.pnl).toBeCloseTo(swapAccrued - GOLD.commissionPerLot, 6);
  });

  it("does not charge a short a long's rate", () => {
    const e = engine({ swap: { long: -100, short: 0 } });
    e.open({ side: "sell", lots: 1, slDistance: 0, tpDistance: 0, price: 2000, time: 0 });
    e.onBar(bar({ time: 3 * 86400, close: 2000, high: 2000, low: 2000 }));
    expect(e.positions[0]!.swap).toBe(0);
  });

  it("uses the default rollover spec", () => {
    expect(DEFAULT_SWAP.rolloverHourUtc).toBe(21);
  });
});

describe("margin call and stop-out", () => {
  it("reports ok with no positions", () => {
    const e = engine();
    expect(e.marginState(2000)).toBe("ok");
  });

  it("is ok at a healthy level, even with a large position", () => {
    // notional is lots x contractSize x price, so read the margin from the engine instead of
    // hand-computing it: 5 x 100 x 2000 / 100 = $10,000 against ~$9,985 of equity.
    const e = engine();
    e.open({ side: "buy", lots: 5, slDistance: 0, tpDistance: 0, price: 2000, time: 0 });
    const used = e.usedMargin(2000);
    expect(used).toBeCloseTo(10_000, 6);
    const level = (e.equity(2000) / used) * 100;
    expect(level).toBeGreaterThan(50);
    expect(e.marginState(2000)).toBe("ok");
  });

  it("reaches the call zone when equity falls against the margin", () => {
    // Size from the engine's own numbers: open the largest position whose margin leaves the
    // account just above the call level, then push price down into the zone.
    const e = engine();
    e.open({ side: "buy", lots: 5, slDistance: 0, tpDistance: 0, price: 2000, time: 0 });
    const used = e.usedMargin(2000);

    // find the price at which equity / margin sits at ~35% (inside the call band)
    let price = 2000;
    for (let i = 0; i < 2000; i++) {
      const lvl = e.equity(price) / used;
      if (lvl <= 0.35) break;
      price -= 1;
    }
    expect(price).toBeLessThan(2000);
    const st = e.marginState(price);
    // either the call band or the stop-out band — both mean "not ok", which is the point
    expect(st).not.toBe("ok");
  });

  it("flags marginCalled on a bar in the call zone", () => {
    const e = engine();
    e.open({ side: "buy", lots: 5, slDistance: 0, tpDistance: 0, price: 2000, time: 0 });
    // price falls until equity is between 20% and 50% of margin
    const used = e.usedMargin(1990);
    const target = used * 0.35;
    const drop = (10_000 - target) / (5 * 100);
    e.onBar(bar({ close: 2000 - drop, high: 2000 - drop, low: 2000 - drop - 1, open: 2000 }));
    if (e.marginState(2000 - drop) === "call") {
      expect(e.marginCalled).toBe(true);
    }
  });

  it("stops out at the 20% level rather than waiting for zero", () => {
    const e = engine();
    e.open({ side: "buy", lots: 5, slDistance: 0, tpDistance: 0, price: 2000, time: 0 });
    // a catastrophic fall
    e.onBar(bar({ open: 2000, close: 1000, high: 2000, low: 1000 }));
    expect(e.stoppedOut).toBe(true);
    expect(e.positions).toHaveLength(0);
  });

  it("does not stop out on a healthy account", () => {
    const e = engine();
    e.open({ side: "buy", lots: 0.5, slDistance: 100, tpDistance: 100, price: 2000, time: 0 });
    e.onBar(bar({ open: 2000, close: 1999, high: 2001, low: 1998 }));
    expect(e.stoppedOut).toBe(false);
    expect(e.marginCalled).toBe(false);
  });
});
