/**
 * Session loss/profit limits on the paper account (the EA's Maximum_Loss /
 * Maximum_Profit).
 *
 * limitsVerdict is the pure decision and is tested straight; the rest pins the
 * SESSION wiring: both entry paths refuse once the net crosses a limit, closing is
 * never trapped by one, and the snapshot exposes the state the UI shows.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { TradingSession, limitsVerdict } from "../src/renderer/trading.js";
import { resetIdsForTest } from "../src/core/account.js";

const SYMBOL = "XAUUSD"; // digits 2, point 0.01, contract 100, commission 3/lot

beforeEach(() => {
  resetIdsForTest();
});

describe("limitsVerdict (pure)", () => {
  const off = { maxLoss: 0, maxProfit: 0 };

  it("blocks nothing when both limits are 0, whatever the net", () => {
    expect(limitsVerdict(-10_000, off)).toEqual({ blocked: false });
    expect(limitsVerdict(+10_000, off)).toEqual({ blocked: false });
    expect(limitsVerdict(0, off)).toEqual({ blocked: false });
  });

  it("refuses on the loss side only once the net is at or past -maxLoss", () => {
    const limits = { maxLoss: 200, maxProfit: 0 };
    expect(limitsVerdict(-199.99, limits).blocked).toBe(false);
    // equality blocks: at the limit the allowed loss has already been spent
    const at = limitsVerdict(-200, limits);
    expect(at.blocked).toBe(true);
    expect(at.reason).toContain("session loss limit");
    expect(at.reason).toContain("-200.00");
    expect(at.reason).toContain("200.00");
    expect(limitsVerdict(-1_000, limits).blocked).toBe(true);
  });

  it("refuses on the profit side only once the net is at or past maxProfit", () => {
    const limits = { maxLoss: 0, maxProfit: 300 };
    expect(limitsVerdict(299.99, limits).blocked).toBe(false);
    const at = limitsVerdict(300, limits);
    expect(at.blocked).toBe(true);
    expect(at.reason).toContain("session profit target");
    expect(at.reason).toContain("300.00");
    expect(limitsVerdict(5_000, limits).blocked).toBe(true);
  });

  it("0 on one side disables only that side", () => {
    // a huge floating loss does not trigger a profit-only limit, and vice versa
    expect(limitsVerdict(-9_999, { maxLoss: 0, maxProfit: 100 }).blocked).toBe(false);
    expect(limitsVerdict(9_999, { maxLoss: 100, maxProfit: 0 }).blocked).toBe(false);
  });

  it("a neutral net never blocks, limits or not", () => {
    expect(limitsVerdict(0, { maxLoss: 1, maxProfit: 1 }).blocked).toBe(false);
  });
});

describe("session limits wiring", () => {
  it("refuses a market order once floating loss has spent the session", () => {
    const s = new TradingSession(SYMBOL);
    s.setLimits({ maxLoss: 500, maxProfit: 0 });
    s.setPrice(2000, 1000);
    expect(s.open("buy", 1, 10, 20).ok).toBe(true);
    // 1 lot entered at ask 2000.2, now 20.00 lower: -2020 floating minus 3 commission
    s.setPrice(1980, 2000);

    const r = s.open("buy", 0.1, 10, 20);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("session loss limit");
    expect(r.message).toContain("500.00");
    // the refusal names the live net, so the trader sees how far past it they are
    expect(r.message).toContain("-2023.00");
  });

  it("refuses a pending order the same way — a limit is not a way around", () => {
    const s = new TradingSession(SYMBOL);
    s.setPrice(2000, 1000);
    s.open("buy", 1, 10, 20);
    s.setPrice(1980, 2000);
    s.setLimits({ maxLoss: 500, maxProfit: 0 });

    const r = s.placeOrder({
      side: "buy", kind: "limit", lots: 0.1, price: 1990,
      slDistance: 5, tpDistance: 10,
    });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("session loss limit");
    expect(s.snapshot().pendingOrders).toHaveLength(0);
  });

  it("refuses new risk once the profit target is reached", () => {
    const s = new TradingSession(SYMBOL);
    s.setPrice(2000, 1000);
    s.setLimits({ maxLoss: 0, maxProfit: 1000 });
    s.open("buy", 1, 10, 20);
    // bid 2011 vs ask entry 2000.2: floating +1080, minus 3 commission = +1077 net
    s.setPrice(2011, 2000);

    const r = s.open("sell", 0.1, 10, 20);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("session profit target");
  });

  it("never blocks CLOSING — a limit stops new risk, it must not trap", () => {
    const s = new TradingSession(SYMBOL);
    s.setPrice(2000, 1000);
    s.open("buy", 1, 10, 20);
    s.setPrice(1980, 2000);
    s.setLimits({ maxLoss: 500, maxProfit: 0 });

    expect(s.open("buy", 0.1, 10, 20).ok).toBe(false);
    const id = s.snapshot().positions[0]!.id;
    expect(s.closeOne(id)).toBe(true);
    expect(s.snapshot().positions).toHaveLength(0);
  });

  it("measures the net against the starting balance, not the current one", () => {
    const s = new TradingSession(SYMBOL, {
      id: 1, name: "Paper", currency: "USD", startingBalance: 10_000,
      leverage: 100, mode: "hedging",
    });
    s.setPrice(2000, 1000);
    // realise a loss first: close a 1-lot buy (entered at ask 2000.2) 20.00 lower
    s.open("buy", 1, 10, 20);
    s.setPrice(1980, 2000);
    s.closeAll();

    const snap = s.snapshot();
    expect(snap.sessionNet).toBeCloseTo(-2023, 6);
    s.setLimits({ maxLoss: 1000, maxProfit: 0 });
    expect(s.open("buy", 0.1, 10, 20).ok).toBe(false);
  });

  it("exposes the limits and the net in the snapshot, and 0/0 disables", () => {
    const s = new TradingSession(SYMBOL);
    expect(s.snapshot().limits).toEqual({ maxLoss: 0, maxProfit: 0 });
    s.setPrice(2000, 1000);
    s.setLimits({ maxLoss: 250, maxProfit: 0 });
    const snap = s.snapshot();
    expect(snap.limits).toEqual({ maxLoss: 250, maxProfit: 0 });
    expect(snap.sessionNet).toBeCloseTo(0, 6);
    expect(s.open("buy", 0.1, 10, 20).ok).toBe(true);
  });
});
