import { describe, it, expect } from "vitest";
import {
  SESSION_SCHEMA_VERSION, parseSessionState, serialiseSessionState, worthRestoring,
  describeSession, type SessionState,
} from "../src/core/session-state.js";
import type { Position, Trade } from "../src/core/types.js";
import type { PendingOrder } from "../src/core/orders.js";

const pos = (over: Partial<Position> = {}): Position => ({
  id: 1, accountId: 1, symbol: "XAUUSD", side: "buy", lots: 0.1,
  entryPrice: 2000, entryTime: 1000, sl: 1990, tp: 2020,
  trailDistance: null, commission: 0.3, swap: 0, ...over,
});

const trade = (over: Partial<Trade> = {}): Trade => ({
  id: 2, accountId: 1, positionId: 1, symbol: "XAUUSD", side: "buy", lots: 0.1,
  entryTime: 1000, entryPrice: 2000, exitTime: 2000, exitPrice: 2010,
  sl: 1990, tp: 2020, reason: "TP", pnl: 100, commission: 0.3, swap: 0,
  notes: "", tags: ["x"], ...over,
});

const order = (over: Partial<PendingOrder> = {}): PendingOrder => ({
  id: "o1", side: "buy", kind: "limit", lots: 0.1, price: 1990,
  slDistance: 10, tpDistance: 20, createdAt: 1000, status: "pending", ...over,
});

const state = (over: Partial<SessionState> = {}): SessionState => ({
  version: SESSION_SCHEMA_VERSION,
  workspace: "XAUUSD::M5",
  balance: 10_000,
  stoppedOut: false,
  positions: [],
  pendingOrders: [],
  trades: [],
  revealed: 500,
  lastBarTime: 1_700_000_000,
  startingBalance: 10_000,
  savedAt: 1_700_000_100,
  ...over,
});

describe("parseSessionState — round trip", () => {
  it("restores a session with a position, an order and a trade", () => {
    const s = state({ positions: [pos()], pendingOrders: [order()], trades: [trade()] });
    const r = parseSessionState(JSON.parse(JSON.stringify(serialiseSessionState(s))));

    expect(r.rejected).toBeNull();
    expect(r.value).not.toBeNull();
    expect(r.value!.positions).toHaveLength(1);
    expect(r.value!.positions[0]!.side).toBe("buy");
    expect(r.value!.positions[0]!.sl).toBe(1990);
    expect(r.value!.pendingOrders).toHaveLength(1);
    expect(r.value!.trades).toHaveLength(1);
    expect(r.value!.balance).toBe(10_000);
    expect(r.value!.revealed).toBe(500);
  });

  it("survives a JSON round trip without changing the numbers", () => {
    const s = state({ balance: 9889.7, positions: [pos({ lots: 0.07, commission: 0.21 })] });
    const back = parseSessionState(JSON.parse(JSON.stringify(s))).value!;
    // exactly equal, not approximately: a restored balance must not drift
    expect(back.balance).toBe(9889.7);
    expect(back.positions[0]!.lots).toBe(0.07);
    expect(back.positions[0]!.commission).toBe(0.21);
  });

  it("keeps the OCO group, so the pair still cancels after a restore", () => {
    const s = state({
      pendingOrders: [
        order({ id: "a", ocoGroup: "g1" }),
        order({ id: "b", side: "sell", kind: "stop", ocoGroup: "g1" }),
      ],
    });
    const back = parseSessionState(JSON.parse(JSON.stringify(s))).value!;
    expect(back.pendingOrders[0]!.ocoGroup).toBe("g1");
    expect(back.pendingOrders[1]!.ocoGroup).toBe("g1");
  });
});

describe("parseSessionState — rejection", () => {
  it("returns null for an empty row without an error", () => {
    expect(parseSessionState(null)).toEqual({ value: null, rejected: null });
    expect(parseSessionState(undefined)).toEqual({ value: null, rejected: null });
  });

  it("rejects a different schema version", () => {
    const r = parseSessionState({ ...state(), version: 99 });
    expect(r.value).toBeNull();
    expect(r.rejected).toContain("schema version");
  });

  it("returns null quietly when the workspace is different", () => {
    // not corruption: a stored session for another symbol simply does not apply here
    const r = parseSessionState(state({ workspace: "EURUSD::M15" }), {
      workspace: "XAUUSD::M5",
    });
    expect(r.value).toBeNull();
    expect(r.rejected).toBeNull();
  });

  it("accepts a matching workspace", () => {
    const r = parseSessionState(state(), { workspace: "XAUUSD::M5" });
    expect(r.value).not.toBeNull();
  });

  it("rejects a session with no workspace key", () => {
    const r = parseSessionState({ ...state(), workspace: undefined });
    expect(r.rejected).toContain("workspace");
  });

  it("rejects a negative balance", () => {
    const r = parseSessionState(state({ balance: -5 }));
    expect(r.rejected).toContain("balance");
  });

  it("rejects a corrupt position instead of dropping it", () => {
    // dropping it would leave a balance that no longer explains the positions
    const r = parseSessionState(state({
      positions: [pos(), pos({ id: 2, side: "sideways" as "buy" })],
    }));
    expect(r.value).toBeNull();
    expect(r.rejected).toContain("corrupt");
    expect(r.rejected).toContain("bad side");
  });

  it("rejects a position with zero lots", () => {
    const r = parseSessionState(state({ positions: [pos({ lots: 0 })] }));
    expect(r.rejected).toContain("bad lots");
  });

  it("rejects a position with no entry price", () => {
    const r = parseSessionState(state({ positions: [pos({ entryPrice: 0 })] }));
    expect(r.rejected).toContain("bad entry price");
  });

  it("rejects a non-numeric stop", () => {
    const r = parseSessionState(state({
      positions: [{ ...pos(), sl: "tight" as unknown as number }],
    }));
    expect(r.rejected).toContain("bad stop");
  });

  it("accepts a position with no stop or target", () => {
    const r = parseSessionState(state({ positions: [pos({ sl: null, tp: null })] }));
    expect(r.value!.positions[0]!.sl).toBeNull();
    expect(r.value!.positions[0]!.tp).toBeNull();
  });

  it("rejects a corrupt pending order", () => {
    const r = parseSessionState(state({
      pendingOrders: [order({ kind: "market" as "limit" })],
    }));
    expect(r.rejected).toContain("bad kind");
  });

  it("rejects an order with an empty id", () => {
    const r = parseSessionState(state({ pendingOrders: [order({ id: "" })] }));
    expect(r.rejected).toContain("bad id");
  });

  it("rejects a corrupt trade rather than losing it", () => {
    const r = parseSessionState(state({ trades: [trade({ pnl: NaN })] }));
    expect(r.rejected).toContain("bad pnl");
  });

  it("accepts every real exit reason", () => {
    // the bug this catches: a hand-written list rejected valid trades, so a session
    // containing a Stop-out or Signal trade could not be restored
    const reasons = ["SL", "TP", "Manual", "Partial", "Net", "Signal", "Stop-out"] as const;
    for (const reason of reasons) {
      const r = parseSessionState(state({ trades: [trade({ reason })] }));
      expect(r.rejected, `reason ${reason}`).toBeNull();
      expect(r.value!.trades[0]!.reason).toBe(reason);
    }
  });

  it("rejects an unknown exit reason", () => {
    const r = parseSessionState(state({
      trades: [trade({ reason: "magic" as Trade["reason"] })],
    }));
    expect(r.rejected).toContain("bad exit reason");
  });

  it("rejects a row that is not an object", () => {
    expect(parseSessionState("nonsense").rejected).toBeTruthy();
    expect(parseSessionState(42).rejected).toBeTruthy();
  });

  it("defaults a missing starting balance to the current balance", () => {
    const r = parseSessionState({ ...state(), startingBalance: undefined });
    expect(r.value!.startingBalance).toBe(10_000);
  });

  it("clamps a negative revealed index to zero", () => {
    const r = parseSessionState(state({ revealed: -100 }));
    expect(r.value!.revealed).toBe(0);
  });

  it("floors a fractional revealed index", () => {
    const r = parseSessionState(state({ revealed: 42.9 }));
    expect(r.value!.revealed).toBe(42);
  });

  it("treats a missing stoppedOut as false", () => {
    const r = parseSessionState({ ...state(), stoppedOut: undefined });
    expect(r.value!.stoppedOut).toBe(false);
  });

  it("restores a stopped-out account as stopped out", () => {
    const r = parseSessionState(state({ stoppedOut: true, balance: 0 }));
    expect(r.value!.stoppedOut).toBe(true);
    expect(r.value!.balance).toBe(0);
  });
});

describe("serialiseSessionState", () => {
  it("stamps the current version whatever the input said", () => {
    const out = serialiseSessionState({ ...state(), version: 7 });
    expect(out.version).toBe(SESSION_SCHEMA_VERSION);
  });

  it("copies the arrays instead of aliasing them", () => {
    const p = pos();
    const s = state({ positions: [p] });
    const out = serialiseSessionState(s);
    expect(out.positions[0]).not.toBe(p);
    expect(out.positions[0]).toEqual(p);
  });
});

describe("worthRestoring", () => {
  it("is false for an untouched session", () => {
    expect(worthRestoring(state())).toBe(false);
  });

  it("is true when a position is open", () => {
    expect(worthRestoring(state({ positions: [pos()] }))).toBe(true);
  });

  it("is true when an order is pending", () => {
    expect(worthRestoring(state({ pendingOrders: [order()] }))).toBe(true);
  });

  it("is true when trades exist", () => {
    expect(worthRestoring(state({ trades: [trade()] }))).toBe(true);
  });

  it("is true when the balance moved with nothing else", () => {
    expect(worthRestoring(state({ balance: 9000 }))).toBe(true);
  });

  it("is false when the balance equals the starting balance and nothing happened", () => {
    expect(worthRestoring(state({ balance: 10_000, startingBalance: 10_000 }))).toBe(false);
  });
});

describe("describeSession", () => {
  it("describes an empty session with just the balance", () => {
    expect(describeSession(state())).toBe("balance 10000.00");
  });

  it("reports open positions, pending orders and closed trades", () => {
    const d = describeSession(state({
      balance: 9889.7, positions: [pos(), pos({ id: 2 })],
      pendingOrders: [order()], trades: [trade()],
    }));
    expect(d).toContain("9889.70");
    expect(d).toContain("2 open");
    expect(d).toContain("1 pending");
    expect(d).toContain("1 closed");
  });
});
