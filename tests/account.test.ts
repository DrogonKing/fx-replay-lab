import { describe, it, expect, beforeEach } from "vitest";
import { AccountEngine, resetIdsForTest } from "../src/core/account.js";
import { findSymbol } from "../src/core/symbol.js";
import type { Account, Candle } from "../src/core/types.js";

const GOLD = findSymbol("XAUUSD"); // contract 100, spread 0.2, commission 3/lot

function mkAccount(over: Partial<Account> = {}): Account {
  return {
    id: 1,
    name: "demo",
    currency: "USD",
    startingBalance: 10_000,
    leverage: 100,
    mode: "hedging",
    ...over,
  };
}

function bar(o: number, h: number, l: number, c: number, t = 1_700_000_000): Candle {
  return { time: t, open: o, high: h, low: l, close: c, volume: 0 };
}

function engine(over: Partial<Account> = {}, spread?: number): AccountEngine {
  return new AccountEngine({
    account: mkAccount(over),
    symbol: GOLD,
    ...(spread !== undefined ? { spread } : {}),
  });
}

beforeEach(() => resetIdsForTest());

describe("pricing and fills", () => {
  it("buys at ask (price + spread) and sells at bid", () => {
    const e = engine();
    expect(e.ask(2000)).toBe(2000.2);
    expect(e.bid(2000)).toBe(2000);
    const buy = e.open({ side: "buy", lots: 1, slDistance: 0, tpDistance: 0, price: 2000, time: 1 });
    expect(buy!.entryPrice).toBe(2000.2);
    const sell = e.open({ side: "sell", lots: 1, slDistance: 0, tpDistance: 0, price: 2000, time: 1 });
    expect(sell!.entryPrice).toBe(2000);
  });

  it("charges commission on entry, immediately", () => {
    const e = engine();
    const start = e.balance;
    e.open({ side: "buy", lots: 2, slDistance: 0, tpDistance: 0, price: 2000, time: 1 });
    // 2 lots * $3/lot = $6
    expect(e.balance).toBe(start - 6);
  });

  it("computes floating P/L with the exit side of the spread", () => {
    const e = engine();
    const p = e.open({ side: "buy", lots: 1, slDistance: 0, tpDistance: 0, price: 2000, time: 1 })!;
    // entry 2000.2; closing at bid 2001 pays (2001 - 2000.2) * 100 * 1 = 80
    // minus the 3 commission already charged: reported pnl is 77
    expect(e.positionPnl(p, 2001)).toBeCloseTo(77, 9);
  });

  it("does not double-count commission when a trade closes", () => {
    const e = engine();
    const p = e.open({ side: "buy", lots: 1, slDistance: 0, tpDistance: 0, price: 2000, time: 1 })!;
    const balAfterEntry = e.balance; // 10000 - 3
    const r = e.closePosition(p, 2001, 2, "Manual")!;
    // gross = 80, no extra commission from balance
    expect(e.balance).toBeCloseTo(balAfterEntry + 80, 9);
    // the journal entry reports net of commission
    expect(r.trade.pnl).toBeCloseTo(77, 9);
    expect(r.trade.commission).toBe(3);
  });
});

describe("SL / TP behaviour", () => {
  it("sets SL and TP at the right side of the entry", () => {
    const e = engine();
    const buy = e.open({ side: "buy", lots: 1, slDistance: 5, tpDistance: 10, price: 2000, time: 1 })!;
    expect(buy.sl).toBe(1995.2);
    expect(buy.tp).toBe(2010.2);
    const sell = e.open({ side: "sell", lots: 1, slDistance: 5, tpDistance: 10, price: 2000, time: 1 })!;
    expect(sell.sl).toBe(2005);
    expect(sell.tp).toBe(1990);
  });

  it("closes a buy on SL when the low touches it", () => {
    const e = engine();
    e.open({ side: "buy", lots: 1, slDistance: 5, tpDistance: 10, price: 2000, time: 1 });
    const closed = e.onBar(bar(2000, 2001, 1994, 1996));
    expect(closed).toHaveLength(1);
    expect(closed[0]!.reason).toBe("SL");
    expect(closed[0]!.exitPrice).toBeCloseTo(1995.2, 5);
  });

  it("closes a buy on TP when the high touches it", () => {
    const e = engine();
    e.open({ side: "buy", lots: 1, slDistance: 5, tpDistance: 10, price: 2000, time: 1 });
    const closed = e.onBar(bar(2000, 2015, 1999, 2012));
    expect(closed).toHaveLength(1);
    expect(closed[0]!.reason).toBe("TP");
  });

  it("SL wins when both are inside the same bar", () => {
    const e = engine();
    e.open({ side: "buy", lots: 1, slDistance: 5, tpDistance: 10, price: 2000, time: 1 });
    // high 2015 > tp 2010.2, low 1994 < sl 1995.2 -> must be SL
    const closed = e.onBar(bar(2000, 2015, 1994, 2000));
    expect(closed).toHaveLength(1);
    expect(closed[0]!.reason).toBe("SL");
  });

  it("fills a gap-through stop at the open, not the stop price", () => {
    const e = engine();
    e.open({ side: "buy", lots: 1, slDistance: 5, tpDistance: 0, price: 2000, time: 1 });
    // bars gaps down: opens at 1980, well below the 1995.2 stop
    const closed = e.onBar(bar(1980, 1982, 1978, 1980));
    expect(closed[0]!.reason).toBe("SL");
    // bid equivalent of 1980 = 1980 (sell side), so exit is 1980
    expect(closed[0]!.exitPrice).toBeCloseTo(1980, 5);
  });

  it("does not trigger on a bar that merely touches the entry", () => {
    const e = engine();
    e.open({ side: "buy", lots: 1, slDistance: 10, tpDistance: 10, price: 2000, time: 1 });
    const closed = e.onBar(bar(2000.2, 2003, 1999, 2001));
    expect(closed).toHaveLength(0);
    expect(e.positions).toHaveLength(1);
  });
});

describe("trailing stop", () => {
  it("only moves in the profitable direction", () => {
    const e = engine();
    const p = e.open({
      side: "buy", lots: 1, slDistance: 20, tpDistance: 0,
      price: 2000, time: 1, trailDistance: 5,
    })!;
    expect(p.sl).toBe(1980.2);
    e.onBar(bar(2000, 2010, 1999, 2008));
    // close 2008 - 5 = 2003 > 1980.2 -> moved up
    expect(p.sl).toBeCloseTo(2003, 5);
    e.onBar(bar(2008, 2009, 1995, 1996));
    // close 1996 - 5 = 1991 < 2003 -> must NOT move down
    expect(p.sl).toBeCloseTo(2003, 5);
  });

  it("never loosens an existing hard stop", () => {
    const e = engine();
    const p = e.open({
      side: "sell", lots: 1, slDistance: 5, tpDistance: 0,
      price: 2000, time: 1, trailDistance: 50,
    })!;
    expect(p.sl).toBe(2005);
    e.onBar(bar(2000, 2001, 1995, 1996));
    // candidate = 1996 + 50 = 2046, worse than 2005 -> unchanged
    expect(p.sl).toBe(2005);
  });
});

describe("partial close", () => {
  it("closes half and leaves the rest open", () => {
    const e = engine();
    const p = e.open({ side: "buy", lots: 2, slDistance: 0, tpDistance: 0, price: 2000, time: 1 })!;
    const r = e.closePosition(p, 2010, 2, "Partial", 1)!;
    expect(r.trade.lots).toBe(1);
    expect(r.trade.reason).toBe("Partial");
    expect(e.positions).toHaveLength(1);
    expect(e.positions[0]!.lots).toBeCloseTo(1, 8);
    // commission split proportionally
    expect(r.trade.commission).toBeCloseTo(3, 9);
    expect(e.positions[0]!.commission).toBeCloseTo(3, 9);
  });

  it("treats a partial of the full size as a full close", () => {
    const e = engine();
    const p = e.open({ side: "buy", lots: 1, slDistance: 0, tpDistance: 0, price: 2000, time: 1 })!;
    e.closePosition(p, 2005, 2, "Partial", 1);
    expect(e.positions).toHaveLength(0);
  });
});

describe("hedging vs netting", () => {
  it("hedging keeps opposite positions alive", () => {
    const e = engine({ mode: "hedging" });
    e.open({ side: "buy", lots: 1, slDistance: 0, tpDistance: 0, price: 2000, time: 1 });
    e.open({ side: "sell", lots: 1, slDistance: 0, tpDistance: 0, price: 2000, time: 1 });
    expect(e.positions).toHaveLength(2);
  });

  it("netting closes the opposite side first", () => {
    const e = engine({ mode: "netting" });
    e.open({ side: "buy", lots: 1, slDistance: 0, tpDistance: 0, price: 2000, time: 1 });
    expect(e.positions).toHaveLength(1);
    e.open({ side: "sell", lots: 1, slDistance: 0, tpDistance: 0, price: 2000, time: 2 });
    // the buy was closed as 'Net', and only the new sell remains
    expect(e.positions).toHaveLength(1);
    expect(e.positions[0]!.side).toBe("sell");
    expect(e.trades).toHaveLength(1);
    expect(e.trades[0]!.reason).toBe("Net");
  });
});

describe("equity, margin and stop-out", () => {
  it("equity = balance + floating", () => {
    const e = engine();
    e.open({ side: "buy", lots: 1, slDistance: 0, tpDistance: 0, price: 2000, time: 1 });
    // balance 9997; at bid 2005 the position is worth (2005-2000.2)*100 - 3 = 477
    expect(e.equity(2005)).toBeCloseTo(9997 + 477, 6);
  });

  it("computes used margin from notional / leverage", () => {
    const e = engine();
    e.open({ side: "buy", lots: 1, slDistance: 0, tpDistance: 0, price: 2000, time: 1 });
    // 1 * 100 * 2000 / 100 = 2000
    expect(e.usedMargin(2000)).toBeCloseTo(2000, 6);
  });

  it("forces a stop-out when equity reaches zero and pauses trading", () => {
    const e = engine({ startingBalance: 1000 });
    e.open({ side: "buy", lots: 5, slDistance: 0, tpDistance: 0, price: 2000, time: 1 });
    // 5 lots * 100 = $500 per 1.00 move; a drop to 1990 loses ~$5000
    const closed = e.onBar(bar(2000, 2001, 1989, 1990));
    expect(closed.length).toBeGreaterThan(0);
    expect(closed[closed.length - 1]!.reason).toBe("Stop-out");
    expect(e.stoppedOut).toBe(true);
    expect(e.positions).toHaveLength(0);
    // further opens are refused
    expect(e.open({ side: "buy", lots: 1, slDistance: 0, tpDistance: 0, price: 1990, time: 3 }))
      .toBeNull();
  });
});

describe("sell side symmetry", () => {
  it("profiting on a sell when price falls", () => {
    const e = engine();
    const p = e.open({ side: "sell", lots: 1, slDistance: 0, tpDistance: 0, price: 2000, time: 1 })!;
    // entry 2000 (bid); exit at ask of 1990 = 1990.2 -> (2000 - 1990.2) * 100 = 980
    expect(e.positionPnl(p, 1990)).toBeCloseTo(980 - 3, 6);
  });

  it("hits TP on a sell when the low reaches it", () => {
    const e = engine();
    e.open({ side: "sell", lots: 1, slDistance: 5, tpDistance: 10, price: 2000, time: 1 });
    const closed = e.onBar(bar(2000, 2001, 1988, 1990));
    expect(closed[0]!.reason).toBe("TP");
  });
});
