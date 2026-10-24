/**
 * Paper-trading cost overrides on the session (Soft4FX-style spread + commission).
 *
 * The core math (spread pricing, commission on entry) is already tested in
 * costs-engine.test.ts; these tests only pin the SESSION wiring: the overrides
 * reach the engine, setCosts refuses while anything is open, and a flat-book
 * costs change preserves the balance and the history.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { TradingSession } from "../src/renderer/trading.js";
import { resetIdsForTest } from "../src/core/account.js";

const SYMBOL = "XAUUSD"; // digits 2, point 0.01, contract 100

beforeEach(() => {
  resetIdsForTest();
});

describe("cost overrides reach the engine", () => {
  it("prices a buy at the overridden ask and charges the overridden commission", () => {
    const s = new TradingSession(SYMBOL, undefined, {
      spreadPoints: 30, commissionPerLot: 7,
    });
    s.setPrice(2000, 1000);
    const r = s.open("buy", 0.1, 10, 20);
    expect(r.ok).toBe(true);

    const snap = s.snapshot();
    const pos = snap.positions[0]!;
    // ask = bid + 30 points * 0.01 = 2000.30
    expect(pos.entryPrice).toBeCloseTo(2000.3, 8);
    // commission leaves the balance on entry: 7 per lot * 0.1 lots
    expect(pos.commission).toBeCloseTo(0.7, 8);
    expect(snap.balance).toBeCloseTo(10_000 - 0.7, 8);
  });

  it("exposes the effective spread and the account leverage for the ticket preview", () => {
    const s = new TradingSession(SYMBOL, {
      id: 1, name: "Paper", currency: "USD", startingBalance: 5_000,
      leverage: 500, mode: "hedging",
    }, { spreadPoints: 25, commissionPerLot: 0 });
    expect(s.spread).toBeCloseTo(0.25, 8);
    expect(s.accountLeverage).toBe(500);
  });
});

describe("setCosts", () => {
  it("refuses while a position is open, naming what to do", () => {
    const s = new TradingSession(SYMBOL);
    s.setPrice(2000, 1000);
    s.open("buy", 0.1, 10, 20);
    const r = s.setCosts({ spreadPoints: 10, commissionPerLot: 0 });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("close open positions");
  });

  it("refuses while a pending order waits", () => {
    const s = new TradingSession(SYMBOL);
    s.setPrice(2000, 1000);
    const r = s.placeOrder({
      side: "buy", kind: "limit", lots: 0.1, price: 1990,
      slDistance: 5, tpDistance: 10,
    });
    expect(r.ok).toBe(true);
    expect(s.setCosts({ spreadPoints: 10, commissionPerLot: 0 }).ok).toBe(false);
  });

  it("preserves the balance and history on a flat book, and prices the next order", () => {
    const s = new TradingSession(SYMBOL);
    s.setPrice(2000, 1000);
    s.open("buy", 0.1, 10, 20);
    s.setPrice(2010, 2000);
    s.closeAll();
    const before = s.snapshot();

    const r = s.setCosts({ spreadPoints: 10, commissionPerLot: 0 });
    expect(r.ok).toBe(true);

    const after = s.snapshot();
    expect(after.balance).toBe(before.balance);
    expect(after.trades).toHaveLength(before.trades.length);

    // the NEXT order is priced with the new spread and no commission
    s.setPrice(2000, 3000);
    expect(s.open("buy", 0.1, 10, 20).ok).toBe(true);
    const pos = s.snapshot().positions[0]!;
    expect(pos.entryPrice).toBeCloseTo(2000.1, 8);
    expect(pos.commission).toBe(0);
  });

  it("reset() adopts given costs and keeps them across a bare reset", () => {
    const s = new TradingSession(SYMBOL);
    s.reset(undefined, { spreadPoints: 40, commissionPerLot: 2 });
    s.setPrice(2000, 1000);
    s.open("buy", 0.1, 10, 20);
    expect(s.snapshot().positions[0]!.entryPrice).toBeCloseTo(2000.4, 8);

    s.reset(); // no costs argument: the overrides survive the new session
    expect(s.spread).toBeCloseTo(0.4, 8);
  });
});
