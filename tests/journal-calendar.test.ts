import { describe, it, expect } from "vitest";
import {
  rMultiple, dayKey, dailyR, mondayIndex, buildMonth, monthsWithTrades,
  bucketFor, BUCKET_COLOUR, summarise, monthTitle, weekdayLabels, monthLines,
  textReport, type JournalEntry,
} from "../src/core/journal-calendar.js";

const entry = (over: Partial<JournalEntry> = {}): JournalEntry => ({
  id: "e1", symbol: "XAUUSD", side: "buy", lots: 0.1,
  entryTime: Date.UTC(2024, 0, 2, 9) / 1000,
  exitTime: Date.UTC(2024, 0, 2, 10) / 1000,
  entryPrice: 2000, exitPrice: 2001,
  pnl: 100, risk: 100, tags: [], notes: "",
  ...over,
});

const at = (y: number, m: number, d: number, h = 12): number => Date.UTC(y, m, d, h) / 1000;

describe("rMultiple", () => {
  it("divides profit by risk", () => {
    expect(rMultiple(entry({ pnl: 200, risk: 100 }))).toBe(2);
    expect(rMultiple(entry({ pnl: -50, risk: 100 }))).toBe(-0.5);
  });

  it("is ZERO when risk is zero, not Infinity", () => {
    // an R of Infinity would poison every sum and every colour bucket
    expect(rMultiple(entry({ pnl: 500, risk: 0 }))).toBe(0);
    expect(Number.isFinite(rMultiple(entry({ pnl: 500, risk: 0 })))).toBe(true);
  });

  it("is zero for negative risk", () => {
    expect(rMultiple(entry({ risk: -10 }))).toBe(0);
  });
});

describe("dayKey / mondayIndex", () => {
  it("formats a UTC date", () => {
    expect(dayKey(at(2024, 0, 2))).toBe("2024-01-02");
  });

  it("puts Monday at 0", () => {
    // 2024-01-01 was a Monday
    expect(mondayIndex(at(2024, 0, 1))).toBe(0);
    expect(mondayIndex(at(2024, 0, 2))).toBe(1);
    expect(mondayIndex(at(2024, 0, 7))).toBe(6);   // Sunday
  });

  it("does not use JS's Sunday-first index", () => {
    // JS getUTCDay() gives Sunday 0; using it shifts every calendar by a day
    const sunday = at(2024, 0, 7);
    expect(new Date(sunday * 1000).getUTCDay()).toBe(0);
    expect(mondayIndex(sunday)).toBe(6);
  });
});

describe("dailyR", () => {
  it("sums R per exit day", () => {
    const days = dailyR([
      entry({ id: "a", exitTime: at(2024, 0, 2), pnl: 100, risk: 100 }),
      entry({ id: "b", exitTime: at(2024, 0, 2, 15), pnl: -50, risk: 100 }),
      entry({ id: "c", exitTime: at(2024, 0, 3), pnl: 300, risk: 100 }),
    ]);
    expect(days.get("2024-01-02")!.r).toBeCloseTo(0.5, 6);
    expect(days.get("2024-01-03")!.r).toBeCloseTo(3, 6);
  });

  it("counts trades and wins/losses", () => {
    const days = dailyR([
      entry({ id: "a", pnl: 100, risk: 100 }),
      entry({ id: "b", pnl: 50, risk: 100 }),
      entry({ id: "c", pnl: -50, risk: 100 }),
    ]);
    const d = days.get("2024-01-02")!;
    expect(d.trades).toBe(3);
    expect(d.wins).toBe(2);
    expect(d.losses).toBe(1);
  });

  it("groups by EXIT day, so a trade carried overnight lands on the day it closed", () => {
    const days = dailyR([entry({
      entryTime: at(2024, 0, 2, 20),
      exitTime: at(2024, 0, 3, 9),
    })]);
    expect(days.has("2024-01-03")).toBe(true);
    expect(days.has("2024-01-02")).toBe(false);
  });

  it("is empty for no entries", () => {
    expect(dailyR([]).size).toBe(0);
  });
});

describe("buildMonth", () => {
  it("builds January 2024 with Monday-first weeks", () => {
    // 2024-01-01 was a Monday, so there is no leading gap
    const m = buildMonth([], 2024, 0);
    expect(m.month).toBe("2024-01");
    expect(m.weeks[0]![0]!.day).toBe(1);
  });

  it("leaves a leading gap for a month that does not start on Monday", () => {
    // 2024-02-01 was a Thursday: Mon/Tue/Wed are null
    const m = buildMonth([], 2024, 1);
    expect(m.weeks[0]![0]).toBeNull();
    expect(m.weeks[0]![1]).toBeNull();
    expect(m.weeks[0]![2]).toBeNull();
    expect(m.weeks[0]![3]!.day).toBe(1);
  });

  it("has 7 slots in every week", () => {
    const m = buildMonth([], 2024, 1);
    for (const w of m.weeks) expect(w).toHaveLength(7);
  });

  it("covers every day of the month exactly once", () => {
    const m = buildMonth([], 2024, 1);   // February 2024 has 29 days
    const days = m.weeks.flat().filter((d) => d !== null).map((d) => d!.day);
    expect(days).toHaveLength(29);
    expect(new Set(days).size).toBe(29);
    expect(Math.max(...days)).toBe(29);
  });

  it("handles a leap year", () => {
    expect(buildMonth([], 2024, 1).weeks.flat().filter(Boolean)).toHaveLength(29);
    expect(buildMonth([], 2023, 1).weeks.flat().filter(Boolean)).toHaveLength(28);
  });

  it("distinguishes a day with no trades from a day that does not exist", () => {
    // both would be zero-R if null were replaced with a zeroed day
    const m = buildMonth([], 2024, 1);
    expect(m.weeks[0]![0]).toBeNull();            // outside the month
    const realDay = m.weeks[0]![3]!;
    expect(realDay).not.toBeNull();
    expect(realDay.trades).toBe(0);               // in the month, no trades
  });

  it("attaches the day's R", () => {
    const m = buildMonth(
      [entry({ exitTime: at(2024, 0, 2), pnl: 200, risk: 100 })],
      2024, 0,
    );
    const d = m.weeks.flat().find((x) => x?.day === 2)!;
    expect(d.r).toBe(2);
    expect(d.trades).toBe(1);
  });

  it("totals the month", () => {
    const m = buildMonth([
      entry({ id: "a", exitTime: at(2024, 0, 2), pnl: 200, risk: 100 }),
      entry({ id: "b", exitTime: at(2024, 0, 3), pnl: -100, risk: 100 }),
    ], 2024, 0);
    expect(m.totalR).toBeCloseTo(1, 6);
    expect(m.trades).toBe(2);
    expect(m.tradingDays).toBe(2);
  });

  it("ignores entries from other months", () => {
    const m = buildMonth([entry({ exitTime: at(2024, 1, 5) })], 2024, 0);
    expect(m.trades).toBe(0);
  });

  it("keeps a trailing partial week", () => {
    // March 2024 ends on a Sunday, April does not
    const m = buildMonth([], 2024, 3);   // April 2024: 30 days, starts Monday
    const last = m.weeks[m.weeks.length - 1]!;
    expect(last.some((d) => d !== null)).toBe(true);
  });
});

describe("monthsWithTrades", () => {
  it("returns months oldest first", () => {
    const out = monthsWithTrades([
      entry({ id: "a", exitTime: at(2024, 2, 5) }),
      entry({ id: "b", exitTime: at(2024, 0, 5) }),
      entry({ id: "c", exitTime: at(2023, 11, 5) }),
    ]);
    expect(out).toEqual([
      { year: 2023, monthIndex: 11 },
      { year: 2024, monthIndex: 0 },
      { year: 2024, monthIndex: 2 },
    ]);
  });

  it("de-duplicates a month with many trades", () => {
    const out = monthsWithTrades([
      entry({ id: "a", exitTime: at(2024, 0, 2) }),
      entry({ id: "b", exitTime: at(2024, 0, 9) }),
      entry({ id: "c", exitTime: at(2024, 0, 20) }),
    ]);
    expect(out).toHaveLength(1);
  });

  it("is empty for no entries", () => {
    expect(monthsWithTrades([])).toEqual([]);
  });
});

describe("bucketFor", () => {
  it("is none when there were no trades", () => {
    expect(bucketFor(0, 0)).toBe("none");
  });

  it("buckets a big loss at -2R or worse", () => {
    expect(bucketFor(-2, 1)).toBe("bigLoss");
    expect(bucketFor(-3.5, 1)).toBe("bigLoss");
  });

  it("buckets a loss between -2R and -0.15R", () => {
    expect(bucketFor(-1, 1)).toBe("loss");
    expect(bucketFor(-0.5, 1)).toBe("loss");
  });

  it("buckets a scratch around zero", () => {
    expect(bucketFor(0, 1)).toBe("flat");
    expect(bucketFor(-0.1, 1)).toBe("flat");
    expect(bucketFor(0.1, 1)).toBe("flat");
  });

  it("buckets a win", () => {
    expect(bucketFor(1, 1)).toBe("win");
    expect(bucketFor(1.9, 1)).toBe("win");
  });

  it("buckets a big win at 2R or better", () => {
    expect(bucketFor(2, 1)).toBe("bigWin");
    expect(bucketFor(5, 1)).toBe("bigWin");
  });

  it("has a colour for every bucket", () => {
    for (const b of ["none", "bigLoss", "loss", "flat", "win", "bigWin"] as const) {
      expect(BUCKET_COLOUR[b]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe("summarise", () => {
  it("finds the worst and best day", () => {
    const s = summarise([
      entry({ id: "a", exitTime: at(2024, 0, 2), pnl: 300, risk: 100 }),
      entry({ id: "b", exitTime: at(2024, 0, 3), pnl: -400, risk: 100 }),
    ]);
    expect(s.bestDay!.r).toBe(3);
    expect(s.worstDay!.r).toBe(-4);
  });

  it("counts the longest losing run", () => {
    const s = summarise([
      entry({ id: "a", exitTime: at(2024, 0, 2), pnl: -100, risk: 100 }),
      entry({ id: "b", exitTime: at(2024, 0, 3), pnl: -100, risk: 100 }),
      entry({ id: "c", exitTime: at(2024, 0, 4), pnl: -100, risk: 100 }),
      entry({ id: "d", exitTime: at(2024, 0, 5), pnl: 200, risk: 100 }),
      entry({ id: "e", exitTime: at(2024, 0, 8), pnl: -100, risk: 100 }),
    ]);
    expect(s.longestLosingStreak).toBe(3);
  });

  it("resets the losing run on a winning day", () => {
    const s = summarise([
      entry({ id: "a", exitTime: at(2024, 0, 2), pnl: -100, risk: 100 }),
      entry({ id: "b", exitTime: at(2024, 0, 3), pnl: 200, risk: 100 }),
      entry({ id: "c", exitTime: at(2024, 0, 4), pnl: -100, risk: 100 }),
    ]);
    expect(s.longestLosingStreak).toBe(1);
  });

  it("counts days worse than -2R", () => {
    const s = summarise([
      entry({ id: "a", exitTime: at(2024, 0, 2), pnl: -300, risk: 100 }),
      entry({ id: "b", exitTime: at(2024, 0, 3), pnl: -100, risk: 100 }),
    ]);
    expect(s.blowupDays).toBe(1);
  });

  it("totals R across all days", () => {
    const s = summarise([
      entry({ id: "a", exitTime: at(2024, 0, 2), pnl: 200, risk: 100 }),
      entry({ id: "b", exitTime: at(2024, 0, 3), pnl: -100, risk: 100 }),
    ]);
    expect(s.totalR).toBeCloseTo(1, 6);
  });

  it("is all zero for no entries", () => {
    const s = summarise([]);
    expect(s.totalR).toBe(0);
    expect(s.days).toBe(0);
    expect(s.worstDay).toBeNull();
    expect(s.bestDay).toBeNull();
    expect(s.longestLosingStreak).toBe(0);
  });
});

describe("monthTitle / weekdayLabels / monthLines", () => {
  it("names the month in English", () => {
    expect(monthTitle(buildMonth([], 2024, 0))).toBe("January 2024");
    expect(monthTitle(buildMonth([], 2024, 11))).toBe("December 2024");
  });

  it("labels the weekdays Monday first", () => {
    expect(weekdayLabels()).toEqual(["M", "T", "W", "T", "F", "S", "S"]);
  });

  it("summarises a month in two lines", () => {
    const lines = monthLines(buildMonth([
      entry({ exitTime: at(2024, 0, 2), pnl: 200, risk: 100 }),
    ], 2024, 0));
    expect(lines[0]).toContain("January 2024");
    expect(lines[0]).toContain("+2.00R");
    expect(lines[1]).toContain("1 trades");
  });
});

describe("textReport", () => {
  it("includes the honest headline numbers", () => {
    const r = textReport([
      entry({ id: "a", exitTime: at(2024, 0, 2), pnl: 200, risk: 100, tags: ["breakout"] }),
      entry({ id: "b", exitTime: at(2024, 0, 3), pnl: -300, risk: 100 }),
    ]);
    expect(r).toContain("JOURNAL REPORT");
    expect(r).toContain("total R");
    expect(r).toContain("worst day");
    expect(r).toContain("longest losing run");
    expect(r).toContain("days worse than -2R");
  });

  it("prints a calendar grid", () => {
    const r = textReport([entry({ exitTime: at(2024, 0, 2) })]);
    expect(r).toContain("January 2024");
    expect(r).toContain("Mo Tu We Th Fr Sa Su");
  });

  it("breaks down by tag", () => {
    const r = textReport([
      entry({ id: "a", tags: ["breakout"], pnl: 200, risk: 100 }),
      entry({ id: "b", tags: ["breakout"], pnl: -100, risk: 100 }),
    ]);
    expect(r).toContain("BY TAG");
    expect(r).toContain("breakout");
    expect(r).toContain("+1.00R");
  });

  it("omits the tag section when there are no tags", () => {
    expect(textReport([entry()])).not.toContain("BY TAG");
  });

  it("is plain text, so it can be copied and diffed", () => {
    const r = textReport([entry()]);
    expect(typeof r).toBe("string");
    expect(r.split("\n").length).toBeGreaterThan(5);
  });

  it("handles an empty journal without crashing", () => {
    const r = textReport([]);
    expect(r).toContain("JOURNAL REPORT");
    expect(r).toContain("trades:");
  });
});
