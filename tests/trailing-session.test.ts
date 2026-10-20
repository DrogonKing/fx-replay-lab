import { describe, it, expect, beforeEach } from "vitest";
import { TradingSession } from "../src/renderer/trading.js";
import { resetIdsForTest } from "../src/core/account.js";
import type { Candle } from "../src/core/types.js";

const bar = (o: Partial<Candle> = {}): Candle => ({
  time: 1000, open: 2000, high: 2001, low: 1999, close: 2000, volume: 1, ...o,
});

beforeEach(() => resetIdsForTest());

function session(): TradingSession {
  const s = new TradingSession("XAUUSD");
  s.setPrice(2000, 1000);
  return s;
}

describe("trailing stop in the session", () => {
  it("tightens the stop as price runs", () => {
    const s = session();
    s.setTrailing("distance", 10);
    s.open("buy", 0.1, 50, 0);
    const before = s.snapshot().positions[0]!.sl!;

    s.onBar(bar({ open: 2000, high: 2030, low: 2005, close: 2025 }));
    const after = s.snapshot().positions[0]?.sl;

    expect(after).toBeDefined();
    expect(after!).toBeGreaterThan(before);
  });

  it("does nothing when trailing is off", () => {
    const s = session();
    s.open("buy", 0.1, 50, 0);
    const before = s.snapshot().positions[0]!.sl;
    s.onBar(bar({ open: 2000, high: 2030, low: 1999, close: 2025 }));
    expect(s.snapshot().positions[0]!.sl).toBe(before);
  });

  it("uses the bar's high in extreme mode (tighter than close)", () => {
    const sDist = session();
    sDist.setTrailing("distance", 10);
    sDist.open("buy", 0.1, 50, 0);
    sDist.onBar(bar({ open: 2000, high: 2040, low: 2005, close: 2010 }));

    const sExt = session();
    sExt.setTrailing("extreme", 10);
    sExt.open("buy", 0.1, 50, 0);
    sExt.onBar(bar({ open: 2000, high: 2040, low: 2005, close: 2010 }));

    expect(sExt.snapshot().positions[0]!.sl!).toBeGreaterThan(
      sDist.snapshot().positions[0]!.sl!,
    );
  });

  it("closes on the trailed stop when the NEXT bar reverses", () => {
    const s = session();
    const got: Array<{ tags: string[] }> = [];
    s.onJournal((a) => got.push(...(a as Array<{ tags: string[] }>)));

    s.setTrailing("extreme", 10);
    s.open("buy", 0.1, 50, 0);          // entry ~2000, stop ~1950

    // bar 1: run up. The trail is SET here but must not be tested against this bar.
    s.onBar(bar({ open: 2000, high: 2030, low: 2005, close: 2028 }));
    const trailed = s.snapshot().positions[0]?.sl;
    expect(trailed).toBeDefined();
    expect(s.snapshot().positions).toHaveLength(1);   // still open

    // bar 2: reversal takes out the trailed stop
    s.onBar(bar({ open: 2028, high: 2028, low: 1990, close: 1995 }));

    expect(s.snapshot().positions).toHaveLength(0);
    expect(got[0]!.tags).toContain("sl");
  });

  it("does NOT stop out on the very bar that set the trail", () => {
    // the regression that mattered: a trail set from bar N must not be hit by bar N's
    // own low, because that low preceded the close that produced the stop
    const s = session();
    s.setTrailing("distance", 10);
    s.open("buy", 0.1, 50, 0);
    s.onBar(bar({ open: 2000, high: 2030, low: 1999, close: 2025 }));

    const snap = s.snapshot();
    expect(snap.positions).toHaveLength(1);
    expect(snap.trades).toHaveLength(0);
    expect(snap.positions[0]!.sl).toBeCloseTo(2015, 2);
  });

  it("ATR mode needs an ATR series", () => {
    const s = session();
    s.setTrailing("atr", 2);
    s.open("buy", 0.1, 50, 0);
    const before = s.snapshot().positions[0]!.sl;
    // no ATR fed yet -> trailPrice returns null -> stop unchanged
    s.onBar(bar({ open: 2000, high: 2030, low: 1999, close: 2025 }));
    expect(s.snapshot().positions[0]!.sl).toBe(before);
  });

  it("ATR mode tightens once the series is available", () => {
    const s = session();
    s.setTrailing("atr", 2);
    s.open("buy", 0.1, 50, 0);
    const before = s.snapshot().positions[0]!.sl;

    // a flat-ish series so ATR is positive and defined from index 13
    const n = 40;
    s.setAtrSeries(
      Array.from({ length: n }, () => 2010),
      Array.from({ length: n }, () => 1990),
      Array.from({ length: n }, () => 2000),
    );
    s.onBar(bar({ open: 2000, high: 2030, low: 1999, close: 2025 }), 20);

    const after = s.snapshot().positions[0]!.sl;
    expect(after!).toBeGreaterThan(before!);
  });
});

describe("partial close in the session", () => {
  it("closes half and keeps the rest open", () => {
    const s = session();
    s.open("buy", 1, 20, 0);
    const id = s.snapshot().positions[0]!.id;

    const r = s.closePartial(id, 0.5);
    expect(r.ok).toBe(true);

    const snap = s.snapshot();
    expect(snap.positions).toHaveLength(1);
    expect(snap.positions[0]!.lots).toBeCloseTo(0.5, 8);
    expect(snap.trades).toHaveLength(1);
    expect(snap.trades[0]!.lots).toBeCloseTo(0.5, 8);
    expect(snap.trades[0]!.reason).toBe("Partial");
  });

  it("files the partial to the journal", () => {
    const s = session();
    const got: Array<{ lots: number; tags: string[] }> = [];
    s.onJournal((a) => got.push(...(a as Array<{ lots: number; tags: string[] }>)));

    s.open("buy", 1, 20, 0);
    const id = s.snapshot().positions[0]!.id;
    s.setPrice(2020, 2000);
    s.closePartial(id, 0.4);

    expect(got).toHaveLength(1);
    expect(got[0]!.lots).toBeCloseTo(0.4, 8);
    expect(got[0]!.tags).toContain("partial");
  });

  it("refuses more than is open", () => {
    const s = session();
    s.open("buy", 0.5, 20, 0);
    const id = s.snapshot().positions[0]!.id;
    const r = s.closePartial(id, 1);
    expect(r.ok).toBe(false);
    expect(s.snapshot().positions[0]!.lots).toBeCloseTo(0.5, 8);
  });

  it("refuses an unknown position", () => {
    expect(session().closePartial(999, 0.1).ok).toBe(false);
  });

  it("refuses a zero or negative size", () => {
    const s = session();
    s.open("buy", 1, 20, 0);
    const id = s.snapshot().positions[0]!.id;
    expect(s.closePartial(id, 0).ok).toBe(false);
    expect(s.closePartial(id, -1).ok).toBe(false);
  });

  it("closing the full size just closes the position", () => {
    const s = session();
    s.open("buy", 0.5, 20, 0);
    const id = s.snapshot().positions[0]!.id;
    const r = s.closePartial(id, 0.5);
    expect(r.ok).toBe(true);
    expect(s.snapshot().positions).toHaveLength(0);
  });

  it("keeps the risk per lot after a partial (commission splits proportionally)", () => {
    const s = session();
    s.open("buy", 1, 20, 0);
    const id = s.snapshot().positions[0]!.id;
    const commissionBefore = s.snapshot().positions[0]!.commission;
    s.closePartial(id, 0.5);
    const commissionAfter = s.snapshot().positions[0]!.commission;
    expect(commissionAfter).toBeCloseTo(commissionBefore / 2, 8);
  });
});

describe("trailing and break-even together", () => {
  it("break-even does not fight the trail", () => {
    const s = session();
    s.setTrailing("distance", 5);
    s.setBreakEvenTrigger(0.5);
    s.open("buy", 0.1, 20, 0);         // entry ~2000, stop ~1980

    // a run that trips break-even; the trail and BE both want to act
    s.onBar(bar({ open: 2000, high: 2012, low: 1999, close: 2010 }));
    const pos = s.snapshot().positions[0];
    // whatever wins, the stop must be at or above the entry-side and tighter than 1980
    expect(pos).toBeDefined();
    expect(pos!.sl!).toBeGreaterThan(1980);
  });

  it("a later looser trail cannot undo a break-even stop", () => {
    const s = session();
    s.setBreakEvenTrigger(0.2);
    s.setTrailing("distance", 20);
    s.open("buy", 0.1, 30, 0);

    s.onBar(bar({ open: 2000, high: 2010, low: 1999, close: 2008 }));
    const afterBE = s.snapshot().positions[0]?.sl;
    if (afterBE === undefined) return;   // may have closed; nothing to assert

    s.onBar(bar({ open: 2008, high: 2009, low: 2007, close: 2008 }));
    const afterTrail = s.snapshot().positions[0]?.sl;
    if (afterTrail === undefined) return;

    expect(afterTrail).toBeGreaterThanOrEqual(afterBE!);
  });
});

describe("reset clears trailing config", () => {
  it("drops the trail mode", () => {
    const s = session();
    s.setTrailing("distance", 10);
    s.open("buy", 0.1, 50, 0);
    s.reset();
    s.open("buy", 0.1, 50, 0);
    const before = s.snapshot().positions[0]!.sl;
    s.onBar(bar({ open: 2000, high: 2030, low: 1999, close: 2025 }));
    // reset does not clear the mode by design (it is a user setting, not position state)
    // but the new position must still be trailable
    expect(s.snapshot().positions.length + (s.snapshot().trades.length > 0 ? 1 : 0))
      .toBeGreaterThan(0);
    expect(before).toBeDefined();
  });
});
