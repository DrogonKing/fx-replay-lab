import { describe, it, expect, beforeEach } from "vitest";
import { TradingSession } from "../src/renderer/trading.js";
import { resetIdsForTest } from "../src/core/account.js";

beforeEach(() => resetIdsForTest());

function session(): TradingSession {
  const s = new TradingSession("XAUUSD");
  s.setPrice(2000, 1000);
  return s;
}

describe("news blackout refuses orders", () => {
  it("refuses a market order while blocked", () => {
    const s = session();
    s.setBlackout({ blocked: true, reason: "high impact USD: NFP" });

    const r = s.open("buy", 0.1, 10, 20);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("news blackout");
    expect(r.message).toContain("NFP");
    expect(s.snapshot().positions).toHaveLength(0);
  });

  it("refuses a pending order while blocked", () => {
    const s = session();
    s.setBlackout({ blocked: true, reason: "high impact USD: CPI" });

    const r = s.placeOrder({
      side: "buy", kind: "limit", lots: 0.1, price: 1990,
      slDistance: 10, tpDistance: 20,
    });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("news blackout");
    expect(s.snapshot().pendingOrders).toHaveLength(0);
  });

  it("allows trading when not blocked", () => {
    const s = session();
    s.setBlackout({ blocked: false });
    expect(s.open("buy", 0.1, 10, 20).ok).toBe(true);
  });

  it("allows trading when cleared to null", () => {
    const s = session();
    s.setBlackout({ blocked: true, reason: "x" });
    s.setBlackout(null);
    expect(s.open("buy", 0.1, 10, 20).ok).toBe(true);
  });

  it("exposes the reason", () => {
    const s = session();
    expect(s.blackoutReason).toBeNull();
    s.setBlackout({ blocked: true, reason: "NFP at 13:30" });
    expect(s.blackoutReason).toBe("NFP at 13:30");
  });

  it("still allows CLOSING a position while blocked", () => {
    // a blackout stops new risk, it must not trap you in an open trade
    const s = session();
    s.open("buy", 0.1, 10, 20);
    s.setBlackout({ blocked: true, reason: "NFP" });

    const id = s.snapshot().positions[0]!.id;
    expect(s.closeOne(id)).toBe(true);
    expect(s.snapshot().positions).toHaveLength(0);
  });

  it("still allows closing all while blocked", () => {
    const s = session();
    s.open("buy", 0.1, 10, 20);
    s.open("buy", 0.1, 10, 20);
    s.setBlackout({ blocked: true, reason: "NFP" });
    expect(s.closeAll()).toBe(2);
  });

  it("still allows a partial close while blocked", () => {
    const s = session();
    s.open("buy", 1, 10, 20);
    s.setBlackout({ blocked: true, reason: "NFP" });
    const id = s.snapshot().positions[0]!.id;
    expect(s.closePartial(id, 0.5).ok).toBe(true);
  });
});
