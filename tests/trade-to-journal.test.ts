import { describe, it, expect } from "vitest";
import {
  tradeToJournalEntry, tradeIdentity, mergeNewEntries, type RiskInfo,
} from "../src/core/trade-to-journal.js";
import type { Trade } from "../src/core/types.js";
import type { JournalEntry } from "../src/core/persist.js";

function t(over: Partial<Trade> = {}): Trade {
  return {
    id: 1, accountId: 1, positionId: 1, symbol: "XAUUSD", side: "buy", lots: 0.1,
    entryTime: 1000, entryPrice: 2000, exitTime: 2000, exitPrice: 2010,
    sl: 1990, tp: 2030, reason: "TP", pnl: 100, commission: -3, swap: 0,
    notes: "", tags: [], ...over,
  };
}

const risk = (over: Partial<RiskInfo> = {}): RiskInfo => ({
  stopDistance: 10, contractSize: 100, ...over,
});

let n = 0;
const id = (): string => `e${++n}`;

describe("tradeToJournalEntry", () => {
  it("maps the core fields straight across", () => {
    const e = tradeToJournalEntry(t(), risk(), id);
    expect(e.symbol).toBe("XAUUSD");
    expect(e.side).toBe("buy");
    expect(e.lots).toBe(0.1);
    expect(e.entryTime).toBe(1000);
    expect(e.exitTime).toBe(2000);
    expect(e.entryPrice).toBe(2000);
    expect(e.exitPrice).toBe(2010);
    expect(e.pnl).toBe(100);
  });

  it("computes money at risk from the stop distance", () => {
    // 10 price units * 0.1 lots * 100 contract = $100
    const e = tradeToJournalEntry(t(), risk(), id);
    expect(e.risk).toBeCloseTo(100, 9);
    // and the R multiple comes out at 1.0 for a $100 win risking $100
    expect(e.pnl / e.risk).toBeCloseTo(1, 9);
  });

  it("scales risk with lots and contract size", () => {
    const e = tradeToJournalEntry(
      t({ lots: 0.5 }), risk({ stopDistance: 20, contractSize: 100 }), id,
    );
    // 20 * 0.5 * 100 = 1000
    expect(e.risk).toBeCloseTo(1000, 9);
  });

  it("records risk 0 when the stop distance is unknown", () => {
    // inventing an R here would be worse than showing nothing
    const e = tradeToJournalEntry(t(), risk({ stopDistance: undefined }), id);
    expect(e.risk).toBe(0);
  });

  it("records risk 0 for a zero stop distance", () => {
    expect(tradeToJournalEntry(t(), risk({ stopDistance: 0 }), id).risk).toBe(0);
  });

  it("tags the exit reason automatically", () => {
    expect(tradeToJournalEntry(t({ reason: "SL" }), risk(), id).tags).toContain("sl");
    expect(tradeToJournalEntry(t({ reason: "TP" }), risk(), id).tags).toContain("tp");
    expect(tradeToJournalEntry(t({ reason: "Stop-out" }), risk(), id).tags).toContain("stop-out");
    expect(tradeToJournalEntry(t({ reason: "Manual" }), risk(), id).tags).toContain("manual");
  });

  it("keeps user tags alongside the reason tag", () => {
    const e = tradeToJournalEntry(t({ reason: "TP" }), risk({ tags: ["breakout", "ny"] }), id);
    expect(e.tags).toEqual(["tp", "breakout", "ny"]);
  });

  it("prefers the supplied notes, then the trade's own", () => {
    expect(tradeToJournalEntry(t({ notes: "from trade" }), risk(), id).notes).toBe("from trade");
    expect(tradeToJournalEntry(t({ notes: "from trade" }), risk({ notes: "override" }), id).notes)
      .toBe("override");
  });

  it("works for a losing short", () => {
    const e = tradeToJournalEntry(
      t({ side: "sell", exitPrice: 2020, pnl: -100, reason: "SL" }),
      risk(), id,
    );
    expect(e.side).toBe("sell");
    expect(e.pnl).toBe(-100);
    expect(e.pnl / e.risk).toBeCloseTo(-1, 9);
  });
});

describe("tradeIdentity", () => {
  it("is stable for the same trade", () => {
    const a = tradeIdentity(t());
    const b = tradeIdentity(t());
    expect(a).toBe(b);
  });

  it("differs when any component differs", () => {
    const base = tradeIdentity(t());
    expect(tradeIdentity(t({ symbol: "EURUSD" }))).not.toBe(base);
    expect(tradeIdentity(t({ side: "sell" }))).not.toBe(base);
    expect(tradeIdentity(t({ lots: 0.2 }))).not.toBe(base);
    expect(tradeIdentity(t({ entryTime: 999 }))).not.toBe(base);
    expect(tradeIdentity(t({ exitTime: 2001 }))).not.toBe(base);
  });

  it("ignores the session-scoped numeric id", () => {
    // the engine restarts its counter each run, so two DIFFERENT trades can both be
    // id 1; identity must not depend on it
    expect(tradeIdentity(t({ id: 1 }))).toBe(tradeIdentity(t({ id: 99 })));
  });
});

describe("mergeNewEntries", () => {
  const e = (over: Partial<JournalEntry> = {}): JournalEntry => ({
    id: "x", symbol: "XAUUSD", side: "buy", lots: 0.1, entryTime: 1000,
    exitTime: 2000, entryPrice: 2000, exitPrice: 2010, pnl: 100, risk: 100,
    tags: [], notes: "", ...over,
  });

  it("adds entries that are not present", () => {
    const r = mergeNewEntries([], [e(), e({ exitTime: 3000 })]);
    expect(r.added).toBe(2);
    expect(r.merged).toHaveLength(2);
  });

  it("skips duplicates so a re-run does not double-count", () => {
    const first = mergeNewEntries([], [e()]);
    const second = mergeNewEntries(first.merged, [e()]);
    expect(second.added).toBe(0);
    expect(second.merged).toHaveLength(1);
  });

  it("keeps the existing entry when a duplicate arrives", () => {
    const existing = [e({ id: "keep-me", notes: "edited by hand" })];
    const r = mergeNewEntries(existing, [e({ id: "new" })]);
    expect(r.merged[0]!.id).toBe("keep-me");
    expect(r.merged[0]!.notes).toBe("edited by hand");
  });

  it("adds only the new ones from a mixed batch", () => {
    const existing = [e()];
    const r = mergeNewEntries(existing, [e(), e({ exitTime: 4000 })]);
    expect(r.added).toBe(1);
    expect(r.merged).toHaveLength(2);
  });

  it("does not mutate the input array", () => {
    const existing = [e()];
    const before = existing.length;
    mergeNewEntries(existing, [e({ exitTime: 5000 })]);
    expect(existing).toHaveLength(before);
  });

  it("handles an empty batch", () => {
    const r = mergeNewEntries([e()], []);
    expect(r.added).toBe(0);
    expect(r.merged).toHaveLength(1);
  });
});
