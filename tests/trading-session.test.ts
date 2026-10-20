import { describe, it, expect, beforeEach } from "vitest";
import { TradingSession } from "../src/renderer/trading.js";
import { resetIdsForTest } from "../src/core/account.js";
import type { Candle } from "../src/core/types.js";

function bar(over: Partial<Candle> = {}): Candle {
  return {
    time: 1000, open: 2000, high: 2001, low: 1999, close: 2000, volume: 1, ...over,
  };
}

const SYMBOL = "XAUUSD";

beforeEach(() => {
  resetIdsForTest();
});

describe("opening positions", () => {
  it("refuses before a price is known", () => {
    const s = new TradingSession(SYMBOL);
    const r = s.open("buy", 0.1, 10, 20);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("no price");
  });

  it("opens a position once a price is set", () => {
    const s = new TradingSession(SYMBOL);
    s.setPrice(2000, 1000);
    const r = s.open("buy", 0.1, 10, 20);
    expect(r.ok).toBe(true);
    expect(s.snapshot().positions).toHaveLength(1);
  });

  it("refuses a non-positive lot size", () => {
    const s = new TradingSession(SYMBOL);
    s.setPrice(2000, 1000);
    expect(s.open("buy", 0, 10, 20).message).toContain("lots must be positive");
    expect(s.open("buy", -1, 10, 20).ok).toBe(false);
  });

  it("refuses an order the account cannot margin", () => {
    const s = new TradingSession(SYMBOL);
    s.setPrice(2000, 1000);
    // 10 lots of gold at 2000 with 1:100 leverage needs 200,000 margin
    const r = s.open("buy", 10, 10, 20);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("not enough margin");
    expect(s.snapshot().positions).toHaveLength(0);
  });

  it("charges commission on entry", () => {
    const s = new TradingSession(SYMBOL);
    s.setPrice(2000, 1000);
    const before = s.snapshot().balance;
    s.open("buy", 0.1, 10, 20);
    expect(s.snapshot().balance).toBeLessThan(before);
  });
});

describe("closing positions files a journal entry", () => {
  it("emits one entry when a position is closed manually", () => {
    const s = new TradingSession(SYMBOL);
    s.setPrice(2000, 1000);
    const got: unknown[] = [];
    s.onJournal((added) => got.push(...added));

    s.open("buy", 0.1, 10, 20);
    s.setPrice(2010, 2000);
    const n = s.closeAll();

    expect(n).toBe(1);
    expect(got).toHaveLength(1);
    const e = got[0] as { symbol: string; side: string; pnl: number; risk: number; tags: string[] };
    expect(e.symbol).toBe(SYMBOL);
    expect(e.side).toBe("buy");
    expect(e.pnl).toBeGreaterThan(0);
    // 10 price units * 0.1 lots * 100 contract = 100 money at risk
    expect(e.risk).toBeCloseTo(100, 6);
    expect(e.tags).toContain("manual");
  });

  it("records risk 0 when the position was opened without a stop", () => {
    const s = new TradingSession(SYMBOL);
    s.setPrice(2000, 1000);
    const got: Array<{ risk: number }> = [];
    s.onJournal((a) => got.push(...(a as Array<{ risk: number }>)));
    s.open("buy", 0.1, 0, 0);
    s.setPrice(2010, 2000);
    s.closeAll();
    expect(got[0]!.risk).toBe(0);
  });

  it("files the initial stop distance, not the fill price", () => {
    // the Trade records where the stop ended up; R needs the distance at entry
    const s = new TradingSession(SYMBOL);
    s.setPrice(2000, 1000);
    const got: Array<{ risk: number; pnl: number }> = [];
    s.onJournal((a) => got.push(...(a as Array<{ risk: number; pnl: number }>)));
    s.open("buy", 0.2, 15, 30);
    s.setPrice(1950, 2000);           // a 50-point loss, stop was at 15
    s.closeAll();
    expect(got[0]!.risk).toBeCloseTo(15 * 0.2 * 100, 6);
  });

  it("keeps the tags the user supplied at entry", () => {
    const s = new TradingSession(SYMBOL);
    s.setPrice(2000, 1000);
    const got: Array<{ tags: string[] }> = [];
    s.onJournal((a) => got.push(...(a as Array<{ tags: string[] }>)));
    s.open("buy", 0.1, 10, 20, ["breakout", "ny-open"]);
    s.closeAll();
    expect(got[0]!.tags).toEqual(["manual", "breakout", "ny-open"]);
  });

  it("closes a single position by id", () => {
    const s = new TradingSession(SYMBOL);
    s.setPrice(2000, 1000);
    s.open("buy", 0.1, 10, 20);
    s.open("buy", 0.1, 10, 20);
    const id = s.snapshot().positions[0]!.id;
    expect(s.closeOne(id)).toBe(true);
    expect(s.snapshot().positions).toHaveLength(1);
    expect(s.closeOne(9999)).toBe(false);
  });
});

describe("SL and TP fire on the bar and are filed", () => {
  it("closes on a stop-loss touch and tags it sl", () => {
    const s = new TradingSession(SYMBOL);
    s.setPrice(2000, 1000);
    const got: Array<{ tags: string[]; pnl: number }> = [];
    s.onJournal((a) => got.push(...(a as Array<{ tags: string[]; pnl: number }>)));

    s.open("buy", 0.1, 10, 20);       // stop ~1990, target ~2010
    const closed = s.onBar(bar({ open: 2000, high: 2000, low: 1985, close: 1990 }));

    expect(closed).toHaveLength(1);
    expect(closed[0]!.reason).toBe("SL");
    expect(got[0]!.tags).toContain("sl");
    expect(got[0]!.pnl).toBeLessThan(0);
  });

  it("closes on a target touch and tags it tp", () => {
    const s = new TradingSession(SYMBOL);
    s.setPrice(2000, 1000);
    const got: Array<{ tags: string[]; pnl: number }> = [];
    s.onJournal((a) => got.push(...(a as Array<{ tags: string[]; pnl: number }>)));

    s.open("buy", 0.1, 10, 20);
    const closed = s.onBar(bar({ open: 2000, high: 2025, low: 1998, close: 2020 }));

    expect(closed[0]!.reason).toBe("TP");
    expect(got[0]!.tags).toContain("tp");
    expect(got[0]!.pnl).toBeGreaterThan(0);
  });

  it("files nothing when the bar touches neither", () => {
    const s = new TradingSession(SYMBOL);
    s.setPrice(2000, 1000);
    const got: unknown[] = [];
    s.onJournal((a) => got.push(...a));
    s.open("buy", 0.1, 10, 20);
    s.onBar(bar({ high: 2002, low: 1999, close: 2001 }));
    expect(got).toHaveLength(0);
    expect(s.snapshot().positions).toHaveLength(1);
  });

  it("does not file the same trade twice if the bar repeats", () => {
    const s = new TradingSession(SYMBOL);
    s.setPrice(2000, 1000);
    const got: unknown[] = [];
    s.onJournal((a) => got.push(...a));
    s.open("buy", 0.1, 10, 20);
    const b = bar({ low: 1985, close: 1990 });
    s.onBar(b);
    s.onBar(b);           // replaying the same bar must not duplicate the entry
    expect(got).toHaveLength(1);
  });
});

describe("pending buffer", () => {
  it("hands entries over once and clears", () => {
    const s = new TradingSession(SYMBOL);
    s.setPrice(2000, 1000);
    s.open("buy", 0.1, 10, 20);
    s.closeAll();

    expect(s.takePending()).toHaveLength(1);
    expect(s.takePending()).toHaveLength(0);
  });
});

describe("stop-out", () => {
  it("halts trading once equity reaches zero", () => {
    // small account so a big adverse move wipes it out
    const s = new TradingSession(SYMBOL, {
      id: 1, name: "Tiny", currency: "USD", startingBalance: 500,
      leverage: 100, mode: "hedging",
    });
    s.setPrice(2000, 1000);
    // 0.2 lots fits the margin (400 of 500) and is worth $20/point, so a 25-point
    // drop consumes the whole balance. A larger size would be refused by the margin
    // check before it could ever be stopped out.
    const opened = s.open("buy", 0.2, 0, 0);
    expect(opened.ok).toBe(true);
    s.onBar(bar({ open: 2000, high: 2000, low: 1960, close: 1960 }));
    const snap = s.snapshot();
    expect(snap.stoppedOut).toBe(true);
    expect(s.open("buy", 0.1, 10, 20).message).toContain("stopped out");
  });
});

describe("snapshot", () => {
  it("reports live equity including floating P/L", () => {
    const s = new TradingSession(SYMBOL);
    s.setPrice(2000, 1000);
    s.open("buy", 0.1, 10, 20);
    s.setPrice(2010, 2000);
    const snap = s.snapshot();
    expect(snap.floatingPnl).toBeGreaterThan(0);
    expect(snap.equity).toBeCloseTo(snap.balance + snap.floatingPnl, 6);
    expect(snap.usedMargin).toBeGreaterThan(0);
  });

  it("notifies subscribers on change", () => {
    const s = new TradingSession(SYMBOL);
    let calls = 0;
    const off = s.subscribe(() => { calls++; });
    expect(calls).toBe(1);            // immediate snapshot
    s.setPrice(2000, 1000);
    s.open("buy", 0.1, 10, 20);
    expect(calls).toBeGreaterThan(1);
    off();
    const before = calls;
    s.open("buy", 0.1, 10, 20);
    expect(calls).toBe(before);
  });
});

describe("reset", () => {
  it("clears positions, trades and pending entries", () => {
    const s = new TradingSession(SYMBOL);
    s.setPrice(2000, 1000);
    s.open("buy", 0.1, 10, 20);
    s.closeAll();
    s.reset();
    const snap = s.snapshot();
    expect(snap.positions).toHaveLength(0);
    expect(snap.trades).toHaveLength(0);
    expect(snap.balance).toBe(10_000);
    expect(s.takePending()).toHaveLength(0);
  });
});
