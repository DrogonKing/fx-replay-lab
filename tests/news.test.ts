import { describe, it, expect } from "vitest";
import {
  splitCsvLine, parseImpact, parseTimestamp, detectDayFirst, parseCalendarCsv,
  dedupeEvents, isBlackedOut, newsMarkers, calendarSummary,
  type CalendarEvent,
} from "../src/core/news.js";

describe("splitCsvLine", () => {
  it("splits plain fields", () => {
    expect(splitCsvLine("a,b,c")).toEqual(["a", "b", "c"]);
  });

  it("keeps commas inside quotes", () => {
    expect(splitCsvLine('"US, Non-Farm Payrolls",USD,high'))
      .toEqual(["US, Non-Farm Payrolls", "USD", "high"]);
  });

  it("unescapes doubled quotes", () => {
    expect(splitCsvLine('"He said ""hi""",x')).toEqual(['He said "hi"', "x"]);
  });

  it("trims surrounding whitespace", () => {
    expect(splitCsvLine(" a , b ")).toEqual(["a", "b"]);
  });

  it("handles empty fields", () => {
    expect(splitCsvLine("a,,c")).toEqual(["a", "", "c"]);
  });
});

describe("parseImpact", () => {
  it("reads words", () => {
    expect(parseImpact("High")).toBe("high");
    expect(parseImpact("medium")).toBe("medium");
    expect(parseImpact("LOW")).toBe("low");
  });

  it("reads star ratings", () => {
    expect(parseImpact("***")).toBe("high");
    expect(parseImpact("**")).toBe("medium");
    expect(parseImpact("*")).toBe("low");
    expect(parseImpact("*****")).toBe("high");
  });

  it("reads numbers", () => {
    expect(parseImpact("3")).toBe("high");
    expect(parseImpact("2")).toBe("medium");
    expect(parseImpact("1")).toBe("low");
  });

  it("reads verbose labels", () => {
    expect(parseImpact("High Impact Expected")).toBe("high");
    expect(parseImpact("medium volatility")).toBe("medium");
  });

  it("returns null when it cannot tell", () => {
    // guessing would mislabel a rate decision as low impact
    expect(parseImpact("")).toBeNull();
    expect(parseImpact("unknown")).toBeNull();
  });
});

describe("parseTimestamp", () => {
  it("parses ISO with a T and Z", () => {
    expect(parseTimestamp("2024-01-05T13:30:00Z"))
      .toEqual({ time: Date.UTC(2024, 0, 5, 13, 30) / 1000 });
  });

  it("parses ISO with a space and no zone as UTC", () => {
    expect(parseTimestamp("2024-01-05 13:30"))
      .toEqual({ time: Date.UTC(2024, 0, 5, 13, 30) / 1000 });
  });

  it("parses ISO seconds", () => {
    expect(parseTimestamp("2024-01-05 13:30:45"))
      .toEqual({ time: Date.UTC(2024, 0, 5, 13, 30, 45) / 1000 });
  });

  it("applies an explicit offset", () => {
    // 13:30 at +02:00 is 11:30 UTC
    expect(parseTimestamp("2024-01-05T13:30:00+02:00"))
      .toEqual({ time: Date.UTC(2024, 0, 5, 11, 30) / 1000 });
  });

  it("applies a negative offset", () => {
    // 08:30 at -05:00 is 13:30 UTC
    expect(parseTimestamp("2024-01-05T08:30:00-05:00"))
      .toEqual({ time: Date.UTC(2024, 0, 5, 13, 30) / 1000 });
  });

  it("parses slashed dates as month-first by default", () => {
    expect(parseTimestamp("01/05/2024 13:30"))
      .toEqual({ time: Date.UTC(2024, 0, 5, 13, 30) / 1000 });
  });

  it("parses slashed dates as day-first when asked", () => {
    expect(parseTimestamp("05/01/2024 13:30", true))
      .toEqual({ time: Date.UTC(2024, 0, 5, 13, 30) / 1000 });
  });

  it("rejects an impossible month instead of silently rolling over", () => {
    // 25 as a month means the file is day-first and the caller guessed wrong
    const r = parseTimestamp("25/01/2024 13:30");
    expect("error" in r).toBe(true);
    expect((r as { error: string }).error).toContain("day-first");
  });

  it("accepts epoch seconds", () => {
    expect(parseTimestamp("1704456600")).toEqual({ time: 1704456600 });
  });

  it("accepts epoch milliseconds", () => {
    expect(parseTimestamp("1704456600000")).toEqual({ time: 1704456600 });
  });

  it("rejects junk", () => {
    expect("error" in parseTimestamp("next tuesday")).toBe(true);
    expect("error" in parseTimestamp("")).toBe(true);
  });
});

describe("detectDayFirst", () => {
  it("detects a day above 12", () => {
    expect(detectDayFirst(["25/01/2024 10:00,USD,high,NFP"])).toBe(true);
  });

  it("assumes month-first when nothing proves otherwise", () => {
    expect(detectDayFirst(["01/05/2024 10:00,USD,high,NFP"])).toBe(false);
  });

  it("ignores ISO lines", () => {
    expect(detectDayFirst(["2024-01-25 10:00,USD,high,NFP"])).toBe(false);
  });
});

const SAMPLE = [
  "Date,Time,Currency,Impact,Event,Actual,Forecast,Previous",
  "2024-01-05,13:30,USD,High,Non-Farm Payrolls,216K,170K,173K",
  "2024-01-05,15:00,USD,Medium,ISM Services PMI,50.6,52.6,52.7",
  "2024-01-08,07:00,EUR,Low,Sentix Index,-15.8,-16.0,-16.8",
].join("\n");

describe("parseCalendarCsv", () => {
  it("parses a standard export", () => {
    const r = parseCalendarCsv(SAMPLE);
    expect(r.events).toHaveLength(3);
    expect(r.issues).toHaveLength(0);
    expect(r.rowsSeen).toBe(3);
  });

  it("maps the fields", () => {
    const e = parseCalendarCsv(SAMPLE).events[0]!;
    expect(e.currency).toBe("USD");
    expect(e.impact).toBe("high");
    expect(e.title).toBe("Non-Farm Payrolls");
    expect(e.time).toBe(Date.UTC(2024, 0, 5, 13, 30) / 1000);
  });

  it("sorts by time", () => {
    const r = parseCalendarCsv(
      "Date,Currency,Impact,Event\n2024-01-09 10:00,USD,low,b\n2024-01-02 10:00,USD,low,a\n",
    );
    expect(r.events.map((e) => e.title)).toEqual(["a", "b"]);
  });

  it("sets a blackout window for high impact only", () => {
    const r = parseCalendarCsv(SAMPLE);
    const high = r.events.find((e) => e.impact === "high")!;
    const med = r.events.find((e) => e.impact === "medium")!;
    expect(high.blackoutBefore).toBe(300);
    expect(high.blackoutAfter).toBe(300);
    expect(med.blackoutBefore).toBe(0);
  });

  it("honours a custom blackout", () => {
    const r = parseCalendarCsv(SAMPLE, {
      blackout: { high: { before: 900, after: 600 } },
    });
    expect(r.events[0]!.blackoutBefore).toBe(900);
    expect(r.events[0]!.blackoutAfter).toBe(600);
  });

  it("filters by impact", () => {
    const r = parseCalendarCsv(SAMPLE, { keep: ["high"] });
    expect(r.events).toHaveLength(1);
    expect(r.events[0]!.impact).toBe("high");
  });

  it("reports bad rows instead of dropping them silently", () => {
    const r = parseCalendarCsv(
      "Date,Currency,Impact,Event\nnot-a-date,USD,high,Broken\n2024-01-05 10:00,USD,low,Good\n",
    );
    expect(r.events).toHaveLength(1);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]!.line).toBe(2);
    expect(r.issues[0]!.reason).toContain("unrecognised");
  });

  it("reports an empty event name", () => {
    const r = parseCalendarCsv("Date,Currency,Impact,Event\n2024-01-05 10:00,USD,high,\n");
    expect(r.issues[0]!.reason).toContain("empty event name");
  });

  it("handles a file with no usable header", () => {
    const r = parseCalendarCsv("a,b,c\n1,2,3\n");
    expect(r.events).toHaveLength(0);
    expect(r.issues[0]!.reason).toContain("no header row");
  });

  it("accepts alternative header names", () => {
    const r = parseCalendarCsv(
      "datetime,ccy,importance,name\n2024-01-05 10:00,usd,***,CPI\n",
    );
    expect(r.events).toHaveLength(1);
    expect(r.events[0]!.title).toBe("CPI");
    expect(r.events[0]!.currency).toBe("USD");
    expect(r.events[0]!.impact).toBe("high");
  });

  it("parses quoted titles with commas", () => {
    const r = parseCalendarCsv(
      'Date,Currency,Impact,Event\n2024-01-05 10:00,USD,high,"NFP, Preliminary"\n',
    );
    expect(r.events[0]!.title).toBe("NFP, Preliminary");
  });

  it("defaults a missing impact to low rather than dropping the row", () => {
    const r = parseCalendarCsv("Date,Currency,Event\n2024-01-05 10:00,USD,Something\n");
    expect(r.events[0]!.impact).toBe("low");
  });

  it("handles CRLF line endings", () => {
    const r = parseCalendarCsv(
      "Date,Currency,Impact,Event\r\n2024-01-05 10:00,USD,high,CPI\r\n",
    );
    expect(r.events).toHaveLength(1);
  });

  it("skips blank lines without counting them as rows", () => {
    const r = parseCalendarCsv(
      "Date,Currency,Impact,Event\n\n2024-01-05 10:00,USD,high,CPI\n\n",
    );
    expect(r.rowsSeen).toBe(1);
  });
});

describe("dedupeEvents", () => {
  const e = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
    id: 1, time: 1000, currency: "USD", impact: "high", title: "CPI",
    blackoutBefore: 300, blackoutAfter: 300, ...over,
  });

  it("removes exact duplicates", () => {
    expect(dedupeEvents([e(), e()])).toHaveLength(1);
  });

  it("keeps events that differ in any key field", () => {
    expect(dedupeEvents([e(), e({ title: "NFP" })])).toHaveLength(2);
    expect(dedupeEvents([e(), e({ time: 2000 })])).toHaveLength(2);
    expect(dedupeEvents([e(), e({ currency: "EUR" })])).toHaveLength(2);
  });

  it("sorts the result", () => {
    const out = dedupeEvents([e({ time: 3000 }), e({ time: 1000, title: "A" })]);
    expect(out[0]!.time).toBe(1000);
  });
});

describe("isBlackedOut", () => {
  const ev: CalendarEvent = {
    id: 1, time: 10_000, currency: "USD", impact: "high", title: "NFP",
    blackoutBefore: 300, blackoutAfter: 300,
  };

  it("blocks inside the window", () => {
    expect(isBlackedOut(10_000, [ev], ["USD"]).blocked).toBe(true);
    expect(isBlackedOut(9_800, [ev], ["USD"]).blocked).toBe(true);
    expect(isBlackedOut(10_200, [ev], ["USD"]).blocked).toBe(true);
  });

  it("allows outside the window", () => {
    expect(isBlackedOut(9_600, [ev], ["USD"]).blocked).toBe(false);
    expect(isBlackedOut(10_500, [ev], ["USD"]).blocked).toBe(false);
  });

  it("includes the exact boundaries", () => {
    expect(isBlackedOut(9_700, [ev], ["USD"]).blocked).toBe(true);
    expect(isBlackedOut(10_300, [ev], ["USD"]).blocked).toBe(true);
  });

  it("ignores events for other currencies", () => {
    expect(isBlackedOut(10_000, [ev], ["EUR"]).blocked).toBe(false);
  });

  it("blocks everything for an ALL event", () => {
    const all = { ...ev, currency: "ALL" };
    expect(isBlackedOut(10_000, [all], ["EUR"]).blocked).toBe(true);
  });

  it("can ignore ALL events", () => {
    const all = { ...ev, currency: "ALL" };
    expect(isBlackedOut(10_000, [all], ["EUR"], false).blocked).toBe(false);
  });

  it("explains why", () => {
    const r = isBlackedOut(10_000, [ev], ["USD"]);
    expect(r.reason).toContain("NFP");
    expect(r.reason).toContain("USD");
    expect(r.secondsUntil).toBe(0);
  });

  it("reports a negative secondsUntil after the event", () => {
    expect(isBlackedOut(10_200, [ev], ["USD"]).secondsUntil).toBe(-200);
  });

  it("does not block with no events", () => {
    expect(isBlackedOut(10_000, [], ["USD"]).blocked).toBe(false);
  });
});

describe("newsMarkers", () => {
  const e = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
    id: 1, time: 1000, currency: "USD", impact: "high", title: "CPI",
    blackoutBefore: 300, blackoutAfter: 300, ...over,
  });

  it("only includes events in the window", () => {
    const m = newsMarkers([e({ time: 500 }), e({ time: 5000 })], 1000, 2000);
    expect(m).toHaveLength(0);
  });

  it("maps impact to colour and shape", () => {
    const m = newsMarkers([e({ impact: "high" })], 0, 5000);
    expect(m[0]!.color).toBe("#ef5350");
    expect(m[0]!.shape).toBe("arrowUp");
    expect(m[0]!.position).toBe("belowBar");

    const low = newsMarkers([e({ impact: "low" })], 0, 5000);
    expect(low[0]!.shape).toBe("circle");
    expect(low[0]!.position).toBe("aboveBar");
  });

  it("caps markers per bar", () => {
    const many = [e({ id: 1 }), e({ id: 2, title: "B" }), e({ id: 3, title: "C" })];
    expect(newsMarkers(many, 0, 5000)).toHaveLength(1);
    expect(newsMarkers(many, 0, 5000, { maxPerBar: 2 })).toHaveLength(2);
  });

  it("labels with currency and impact", () => {
    expect(newsMarkers([e()], 0, 5000)[0]!.text).toBe("USD H");
  });
});

describe("calendarSummary", () => {
  const e = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
    id: 1, time: 1000, currency: "USD", impact: "high", title: "CPI",
    blackoutBefore: 0, blackoutAfter: 0, ...over,
  });

  it("counts by impact", () => {
    const s = calendarSummary([
      e({ impact: "high" }), e({ impact: "medium" }), e({ impact: "low" }),
      e({ impact: "low", id: 2 }),
    ]);
    expect(s.total).toBe(4);
    expect(s.high).toBe(1);
    expect(s.medium).toBe(1);
    expect(s.low).toBe(2);
  });

  it("reports the time span", () => {
    const s = calendarSummary([e({ time: 500 }), e({ time: 9000, id: 2 })]);
    expect(s.from).toBe(500);
    expect(s.to).toBe(9000);
  });

  it("handles an empty list", () => {
    const s = calendarSummary([]);
    expect(s.total).toBe(0);
    expect(s.from).toBe(0);
    expect(s.to).toBe(0);
  });
});
