import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCsv, parseTimestampField } from "../src/core/csv.js";
import {
  mapHeaders, checkMap, rowFromMap, auditCandles, describeQuality,
  MAPPABLE, type ColumnMap,
} from "../src/core/csv-map.js";
import type { Candle } from "../src/core/types.js";

describe("mapHeaders", () => {
  it("maps a plain OHLCV header", () => {
    const m = mapHeaders(["Date", "Open", "High", "Low", "Close", "Volume"]);
    expect(m.time).toBe(0);
    expect(m.open).toBe(1);
    expect(m.high).toBe(2);
    expect(m.low).toBe(3);
    expect(m.close).toBe(4);
    expect(m.volume).toBe(5);
    expect(m.timeOfDay).toBe(-1);
  });

  it("maps an MT4/MT5 export with separate date and time", () => {
    const m = mapHeaders(["Date", "Time", "Open", "High", "Low", "Close", "Volume"]);
    expect(m.time).toBe(0);
    expect(m.timeOfDay).toBe(1);
    expect(m.open).toBe(2);
    expect(checkMap(m).split).toBe(true);
  });

  it("prefers a 'date' column as the timestamp even when 'time' comes first", () => {
    // a header order of Time,Date would otherwise bind the clock as the timestamp
    const m = mapHeaders(["Time", "Date", "Open", "High", "Low", "Close"]);
    expect(m.time).toBe(1);
    expect(m.timeOfDay).toBe(0);
  });

  it("uses a 'time' column as the timestamp when there is no date column", () => {
    const m = mapHeaders(["Time", "Open", "High", "Low", "Close"]);
    expect(m.time).toBe(0);
    expect(m.timeOfDay).toBe(-1);
  });

  it("treats 'datetime' as a single timestamp", () => {
    const m = mapHeaders(["datetime", "open", "high", "low", "close"]);
    expect(m.time).toBe(0);
    expect(m.timeOfDay).toBe(-1);
  });

  it("ignores case, spacing and punctuation", () => {
    const m = mapHeaders(["  DATE_TIME  ", "Open Price", "HIGH", "low.", "Closing"]);
    expect(m.time).toBe(0);
    expect(m.open).toBe(1);
    expect(m.high).toBe(2);
    expect(m.low).toBe(3);
    expect(m.close).toBe(4);
  });

  it("finds the close under 'last' or 'price'", () => {
    expect(mapHeaders(["t", "o", "h", "l", "last"]).close).toBe(4);
    expect(mapHeaders(["t", "o", "h", "l", "price"]).close).toBe(4);
  });

  it("finds a tick volume column", () => {
    expect(mapHeaders(["Date", "Open", "High", "Low", "Close", "TickVol"]).volume).toBe(5);
  });

  it("leaves volume at -1 when the file has none", () => {
    const m = mapHeaders(["Date", "Open", "High", "Low", "Close"]);
    expect(m.volume).toBe(-1);
    expect(checkMap(m).ok).toBe(true);
  });

  it("handles a symbol column in the middle without shifting the rest", () => {
    // a broker export with the instrument repeated on every row
    const m = mapHeaders(["Date", "Time", "Symbol", "Open", "High", "Low", "Close"]);
    expect(m.time).toBe(0);
    expect(m.timeOfDay).toBe(1);
    expect(m.open).toBe(3);
    expect(m.high).toBe(4);
    expect(m.low).toBe(5);
    expect(m.close).toBe(6);
  });

  it("does not treat the same column as both timestamp and clock", () => {
    const m = mapHeaders(["Time", "Open", "High", "Low", "Close"]);
    expect(m.time).toBe(0);
    expect(m.timeOfDay).not.toBe(0);
  });

  it("reports what is missing for an unmappable header", () => {
    const c = checkMap(mapHeaders(["foo", "bar"]));
    expect(c.ok).toBe(false);
    expect(c.missing).toContain("time");
    expect(c.missing).toContain("close");
  });

  it("lists every mappable field", () => {
    expect(MAPPABLE).toEqual(["time", "timeOfDay", "open", "high", "low", "close", "volume"]);
  });
});

describe("rowFromMap", () => {
  const MAP: ColumnMap = {
    time: 0, timeOfDay: 1, open: 2, high: 3, low: 4, close: 5, volume: 6,
  };
  // Accepts the separators the real importer accepts: 2024.01.02, 2024-01-02, 2024/01/02.
  const parse = (d: string, t?: string): number | null => {
    const m = /^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})$/.exec(d.trim());
    if (!m) return null;
    const clock = (t ?? "00:00").trim();
    const cm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(clock);
    if (!cm) return null;
    const ms = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +cm[1]!, +cm[2]!, +(cm[3] ?? 0));
    return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
  };
  const row = ["2024.01.02", "10:00", "2000.5", "2002.0", "1999.5", "2001.0", "150"];

  it("builds a candle from a split date/time row", () => {
    const c = rowFromMap(row, MAP, parse)!;
    expect(c.open).toBe(2000.5);
    expect(c.high).toBe(2002);
    expect(c.low).toBe(1999.5);
    expect(c.close).toBe(2001);
    expect(c.volume).toBe(150);
    expect(c.time).toBeGreaterThan(0);
  });

  it("returns null for an unparseable time rather than throwing", () => {
    expect(rowFromMap(["nonsense", "10:00", "1", "2", "0.5", "1.5"], MAP, parse)).toBeNull();
  });

  it("returns null for a non-numeric price", () => {
    expect(rowFromMap(["2024.01.02", "10:00", "abc", "2", "0.5", "1.5"], MAP, parse)).toBeNull();
  });

  it("rejects a corrupt bar whose high is below its low", () => {
    expect(rowFromMap(["2024.01.02", "10:00", "2", "1", "3", "2"], MAP, parse)).toBeNull();
  });

  it("rejects a bar whose close is outside its range", () => {
    expect(rowFromMap(["2024.01.02", "10:00", "2", "3", "1", "9"], MAP, parse)).toBeNull();
  });

  it("defaults volume to zero when the column is absent", () => {
    const noVol: ColumnMap = { ...MAP, volume: -1 };
    expect(rowFromMap(row, noVol, parse)!.volume).toBe(0);
  });

  it("accepts a single timestamp column", () => {
    const single: ColumnMap = { ...MAP, timeOfDay: -1 };
    const r = ["2024.01.02", "", "2000", "2001", "1999", "2000.5", "10"];
    const c = rowFromMap(r, single, (d) => parse(d))!;
    expect(c.close).toBe(2000.5);
  });

  it("strips thousands separators from numbers", () => {
    const r = ["2024.01.02", "10:00", "2,000.5", "2,002", "1,999", "2,001", "1,500"];
    expect(rowFromMap(r, MAP, parse)!.open).toBe(2000.5);
  });

  it("tolerates a short row with a missing volume", () => {
    const r = ["2024.01.02", "10:00", "2000", "2001", "1999", "2000.5"];
    expect(rowFromMap(r, MAP, parse)!.volume).toBe(0);
  });
});

describe("auditCandles", () => {
  const bar = (time: number, o = 100, h = 101, l = 99, c = 100, v = 10): Candle =>
    ({ time, open: o, high: h, low: l, close: c, volume: v });

  it("is clean for a tidy series", () => {
    // ranges must VARY: 20 identical bars means every bar sits inside the previous one, which
    // is a real inside-bar signal, not a clean file
    const series = Array.from({ length: 20 }, (_, i) => bar(
      1_700_000_000 + i * 300,
      100 + i, 110 + i, 90 + i, 105 + i,
    ));
    const r = auditCandles(series, 300);
    expect(r.bars).toBe(20);
    expect(r.clean).toBe(true);
    expect(r.spacing).toBe(300);
  });

  it("counts duplicate timestamps as HIGH severity", () => {
    const series = [bar(1000), bar(1300), bar(1300), bar(1600)];
    const r = auditCandles(series, 300);
    const dup = r.issues.find((i) => i.kind === "duplicate_time");
    expect(dup?.count).toBe(1);
    expect(dup?.severity).toBe("high");
    expect(r.clean).toBe(false);
  });

  it("counts out-of-order rows", () => {
    const series = [bar(1300), bar(1000), bar(1600)];
    const r = auditCandles(series, 300);
    expect(r.issues.find((i) => i.kind === "out_of_order")?.count).toBeGreaterThan(0);
  });

  it("counts non-positive prices as HIGH severity", () => {
    const series = [bar(1000), bar(1300, 0, 1, 0, 0.5)];
    const r = auditCandles(series, 300);
    expect(r.issues.find((i) => i.kind === "non_positive_price")?.severity).toBe("high");
  });

  it("does NOT flag a normal FX weekend gap", () => {
    // Friday 21:00 -> Sunday 21:00 is ~2 days, normal
    const friday = 1_700_000_000;
    const series = [bar(friday), bar(friday + 300), bar(friday + 2 * 86_400)];
    const r = auditCandles(series, 300);
    expect(r.issues.find((i) => i.kind === "gap")).toBeUndefined();
  });

  it("does flag a multi-day hole", () => {
    const t = 1_700_000_000;
    const series = [bar(t), bar(t + 300), bar(t + 30 * 86_400)];
    const r = auditCandles(series, 300);
    expect(r.issues.find((i) => i.kind === "gap")?.count).toBeGreaterThan(0);
  });

  it("does not report zero volume when NO bar has volume", () => {
    // a CSV with no volume column is normal, not a data fault
    const series = Array.from({ length: 10 }, (_, i) => bar(1000 + i * 300, 100, 101, 99, 100, 0));
    const r = auditCandles(series, 300);
    expect(r.issues.find((i) => i.kind === "zero_volume")).toBeUndefined();
  });

  it("reports zero volume when only SOME bars lack it", () => {
    const series = [bar(1000, 100, 101, 99, 100, 10), bar(1300, 100, 101, 99, 100, 0)];
    const r = auditCandles(series, 300);
    expect(r.issues.find((i) => i.kind === "zero_volume")?.count).toBe(1);
  });

  it("flags an all-flat series as high severity", () => {
    // O=H=L=C on every bar means the file is not real OHLC
    const series = Array.from({ length: 10 }, (_, i) => bar(1000 + i * 300, 100, 100, 100, 100));
    const r = auditCandles(series, 300);
    expect(r.issues.find((i) => i.kind === "identical_bars")?.severity).toBe("high");
  });

  it("derives the spacing when none is given", () => {
    const series = Array.from({ length: 10 }, (_, i) => bar(1000 + i * 900));
    expect(auditCandles(series).spacing).toBe(900);
  });

  it("reports the covered range", () => {
    const series = [bar(5000), bar(5300), bar(5600)];
    const r = auditCandles(series, 300);
    expect(r.from).toBe(5000);
    expect(r.to).toBe(5600);
  });

  it("is empty for an empty series", () => {
    const r = auditCandles([]);
    expect(r.bars).toBe(0);
    expect(r.clean).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it("sorts issues by severity, worst first", () => {
    const series = [bar(1300), bar(1000), bar(1300, 0, 1, 0, 0.5)];
    const r = auditCandles(series, 300);
    expect(r.issues[0]!.severity).toBe("high");
  });

  it("gives concrete examples, not just counts", () => {
    const series = [bar(1000), bar(1000)];
    const r = auditCandles(series, 300);
    expect(r.issues.find((i) => i.kind === "duplicate_time")!.examples[0]).toContain("1970");
  });
});

describe("a real messy broker export", () => {
  const path = join(__dirname, "fixtures", "broker-messy.csv");
  const text = readFileSync(path, "utf8");
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim() !== "");
  const delim = ";";
  const headers = lines[0]!.split(delim).map((h) => h.trim());
  const rows = lines.slice(1).map((l) => l.split(delim).map((c) => c.trim()));

  it("is REJECTED by the automatic importer, which is why mapping exists", () => {
    // the columns are symbol-first with volume before the close, so the layout detector has
    // nothing to bind: every row is refused
    const auto = parseCsv(text);
    expect(auto.candles).toHaveLength(0);
    expect(auto.rowsRejected).toBe(rows.length);
  });

  it("maps its headers to the right fields", () => {
    const m = mapHeaders(headers);
    expect(m.time).toBe(1);        // DateTime
    expect(m.open).toBe(5);        // Open
    expect(m.high).toBe(4);        // High
    expect(m.low).toBe(3);         // Low
    expect(m.close).toBe(6);       // Last
    expect(m.volume).toBe(2);      // Qty
    expect(m.timeOfDay).toBe(-1);  // the clock is inside DateTime
    expect(checkMap(m).ok).toBe(true);
  });

  it("imports every row once mapped, with the correct prices", () => {
    const m = mapHeaders(headers);
    // THE REAL PARSER, not a hand-rolled one. The first version of this test supplied its own
    // date parser, so it passed while the app's path failed: parseTimestampField did not
    // accept "2024.01.02 10:00" at all.
    const parse = (raw: string): number | null => parseTimestampField(raw, 0);
    const candles = rows
      .map((r) => rowFromMap(r, m, parse))
      .filter((c): c is NonNullable<typeof c> => c !== null);

    expect(candles).toHaveLength(rows.length);
    expect(candles[0]!.open).toBe(2000.5);
    expect(candles[0]!.high).toBe(2002);
    expect(candles[0]!.low).toBe(1999.5);
    expect(candles[0]!.close).toBe(2001);
    expect(candles[0]!.volume).toBe(120);
  });

  it("passes the quality audit: the data itself was always fine", () => {
    const m = mapHeaders(headers);
    const parse = (raw: string): number | null => parseTimestampField(raw, 0);
    const candles = rows
      .map((r) => rowFromMap(r, m, parse))
      .filter((c): c is NonNullable<typeof c> => c !== null)
      .sort((a, b) => a.time - b.time);
    const audit = auditCandles(candles);
    expect(audit.spacing).toBe(300);
    expect(audit.issues.find((i) => i.severity === "high")).toBeUndefined();
  });
});

describe("describeQuality", () => {
  const bar = (time: number): Candle =>
    ({ time, open: 100, high: 101, low: 99, close: 100, volume: 10 });

  it("says so when nothing was read", () => {
    expect(describeQuality(auditCandles([]))).toEqual(["no bars were read"]);
    expect(describeQuality(auditCandles([]), "fa")).toEqual(["هیچ کندلی خوانده نشد"]);
  });

  it("says clean when clean", () => {
    const series = Array.from({ length: 10 }, (_, i) => bar(1000 + i * 300));
    expect(describeQuality(auditCandles(series, 300))[0]).toContain("inside bars");
  });

  it("describes issues in Persian too", () => {
    const r = auditCandles([bar(1000), bar(1000)], 300);
    const fa = describeQuality(r, "fa");
    expect(fa[0]).toContain("تکراری");
  });

  it("includes an example when one exists", () => {
    const r = auditCandles([bar(1000), bar(1000)], 300);
    expect(describeQuality(r)[0]).toContain("(");
  });
});
