/**
 * Stop-out must be recoverable, and must not fire on a healthy account.
 *
 * Reading account.ts: open() returns null once stoppedOut is true and onBar() returns early, so the
 * flag is permanent. But a stop-out is a MARGIN event, not bankruptcy: a real terminal lets you
 * deposit and continue. A deposit that leaves the account locked is a dead end the user cannot see.
 */
import { AccountEngine } from "../src/core/account.js";
import { findSymbol } from "../src/core/symbol.js";
import type { Account, Candle } from "../src/core/types.js";

const GOLD = findSymbol("XAUUSD");
const BAR: Candle = { time: 10, open: 2000, high: 2001, low: 1999, close: 2000, volume: 0 };

function engine(balance = 10_000): AccountEngine {
  const account: Account = {
    id: 1, name: "t", currency: "USD", startingBalance: balance,
    leverage: 100, mode: "hedging",
  };
  return new AccountEngine({ account, symbol: GOLD });
}

describe("stop-out behaviour", () => {
  it("a deposit clears the stop-out so trading can resume", () => {
    const e = engine();
    // force a stop-out: huge position, catastrophic price
    e.open({ side: "buy", lots: 5, slDistance: 0, tpDistance: 0, price: 2000, time: 1 });
    e.onBar({ ...BAR, low: 1000, close: 1000 });
    expect(e.stoppedOut).toBe(true);

    // a real terminal accepts a deposit after a margin stop-out
    e.adjustBalance(50_000);
    expect(e.stoppedOut).toBe(false);
    const pos = e.open({ side: "buy", lots: 0.1, slDistance: 0, tpDistance: 0, price: 2000, time: 20 });
    expect(pos).not.toBeNull();
  });

  it("a withdrawal does not un-stop a stopped account", () => {
    const e = engine();
    e.open({ side: "buy", lots: 5, slDistance: 0, tpDistance: 0, price: 2000, time: 1 });
    e.onBar({ ...BAR, low: 1000, close: 1000 });
    expect(e.stoppedOut).toBe(true);
    e.adjustBalance(-100);
    expect(e.stoppedOut).toBe(true);
  });
});
