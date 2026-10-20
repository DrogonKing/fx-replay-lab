import { describe, it, expect } from "vitest";
import {
  detectDelimiter, detectLayout, parseDateTimeParts, parseTimestampField,
  parseCsv, medianSpacingMinutes,
} from "../src/core/csv.js";

describe("detectDelimiter", () => {
  it("recognises comma, semicolon and tab", () => {
    expect(detectDelimiter("a,b,c")).toBe(",");
    expect(detectDelimiter("a;b;c")).toBe(";");
    expect(detectDelimiter("a\tb\tc")).toBe("\t");
  });
  it("defaults to comma when there is no delimiter", () => {
    expect(detectDelimiter("single")).toBe(",");
  });
});

describe("detectLayout", () => {
  it("detects MT4/MT5 date+time exports", () => {
    expect(detectLayout(["2024.01.02", "10:00", "2000", "2001", "1999", "2000"])).toBe("datetime-split");
    expect(detectLayout(["2024-01-02", "10:00:00", "2000", "2001", "1999", "2000"])).toBe("datetime-split");
  });
  it("detects epoch and ISO timestamp layouts", () => {
    expect(detectLayout(["1704153600", "2000", "2001", "1999", "2000"])).toBe("timestamp");
    expect(detectLayout(["1704153600000", "2000", "2001", "1999", "2000"])).toBe("timestamp");
    expect(detectLayout(["2024-01-02T10:00:00Z", "2000", "2001", "1999", "2000"])).toBe("timestamp");
  });
});

describe("parseDateTimeParts", () => {
  it("parses dotted, dashed and slashed dates", () => {
    const want = Date.UTC(2024, 0, 2, 10, 0, 0) / 1000;
    expect(parseDateTimeParts("2024.01.02", "10:00", 0)).toBe(want);
    expect(parseDateTimeParts("2024-01-02", "10:00", 0)).toBe(want);
    expect(parseDateTimeParts("2024/01/02", "10:00:00", 0)).toBe(want);
  });

  it("applies the CSV UTC offset", () => {
    // 10:00 in UTC+2 == 08:00 UTC
    expect(parseDateTimeParts("2024.01.02", "10:00", 2))
      .toBe(Date.UTC(2024, 0, 2, 8, 0, 0) / 1000);
    // 10:00 in UTC-5 == 15:00 UTC
    expect(parseDateTimeParts("2024.01.02", "10:00", -5))
      .toBe(Date.UTC(2024, 0, 2, 15, 0, 0) / 1000);
  });

  it("rejects impossible dates and times", () => {
    expect(parseDateTimeParts("2024.13.02", "10:00", 0)).toBeNull();
    expect(parseDateTimeParts("2024.01.02", "25:00", 0)).toBeNull();
    expect(parseDateTimeParts("garbage", "10:00", 0)).toBeNull();
    expect(parseDateTimeParts("2024.01.02", "notatime", 0)).toBeNull();
  });

  it("treats an empty time as midnight", () => {
    expect(parseDateTimeParts("2024.01.02", "", 0))
      .toBe(Date.UTC(2024, 0, 2, 0, 0, 0) / 1000);
  });
});

describe("parseTimestampField", () => {
  it("handles epoch seconds", () => {
    expect(parseTimestampField("1704153600", 0)).toBe(1704153600);
  });
  it("handles epoch milliseconds", () => {
    expect(parseTimestampField("1704153600000", 0)).toBe(1704153600);
  });
  it("handles ISO with and without a zone", () => {
    expect(parseTimestampField("2024-01-02T10:00:00Z", 0)).toBe(Date.UTC(2024, 0, 2, 10) / 1000);
    expect(parseTimestampField("2024-01-02 10:00:00", 0)).toBe(Date.UTC(2024, 0, 2, 10) / 1000);
    // an explicit zone must NOT be shifted by the CSV offset
    expect(parseTimestampField("2024-01-02T10:00:00Z", 5)).toBe(Date.UTC(2024, 0, 2, 10) / 1000);
    // a naive ISO string is shifted
    expect(parseTimestampField("2024-01-02 10:00:00", 2)).toBe(Date.UTC(2024, 0, 2, 8) / 1000);
  });
  it("rejects implausible or unparseable values", () => {
    expect(parseTimestampField("42", 0)).toBeNull();
    expect(parseTimestampField("hello", 0)).toBeNull();
    expect(parseTimestampField("", 0)).toBeNull();
  });
});

describe("parseCsv - MT4/MT5 layout", () => {
  const mt4 = [
    "Date,Time,Open,High,Low,Close,Volume",
    "2024.01.02,10:00,2000.00,2001.50,1999.50,2001.00,10",
    "2024.01.02,10:01,2001.00,2002.50,2000.50,2002.00,12",
    "2024.01.02,10:02,2002.00,2003.50,2001.50,2003.00,8",
  ].join("\n");

  it("skips the header and parses every row", () => {
    const r = parseCsv(mt4);
    expect(r.skippedHeader).toBe(true);
    expect(r.candles).toHaveLength(3);
    expect(r.layout).toBe("datetime-split");
    expect(r.delimiter).toBe(",");
    expect(r.candles[0]).toEqual({
      time: Date.UTC(2024, 0, 2, 10, 0, 0) / 1000,
      open: 2000, high: 2001.5, low: 1999.5, close: 2001, volume: 10,
    });
  });

  it("detects 1-minute spacing", () => {
    expect(parseCsv(mt4).detectedMinutes).toBe(1);
  });

  it("handles semicolon-delimited exports (common in EU locales)", () => {
    const semi = mt4.replace(/,/g, ";");
    const r = parseCsv(semi);
    expect(r.delimiter).toBe(";");
    expect(r.candles).toHaveLength(3);
  });

  it("works without a header", () => {
    const noHeader = mt4.split("\n").slice(1).join("\n");
    const r = parseCsv(noHeader);
    expect(r.skippedHeader).toBe(false);
    expect(r.candles).toHaveLength(3);
  });
});

describe("parseCsv - timestamp layout", () => {
  it("parses epoch seconds with no time column", () => {
    const csv = [
      "1704153600,2000,2001,1999,2000",
      "1704153660,2000,2002,1999,2001",
    ].join("\n");
    const r = parseCsv(csv);
    expect(r.layout).toBe("timestamp");
    expect(r.candles).toHaveLength(2);
    expect(r.candles[0]!.time).toBe(1704153600);
    expect(r.candles[0]!.volume).toBe(0); // no volume column
  });

  it("applies the UTC offset to the timestamp layout too", () => {
    const csv = "1704153600,2000,2001,1999,2000";
    const r = parseCsv(csv, { utcOffsetHours: 2 });
    expect(r.candles[0]!.time).toBe(1704153600 - 7200);
  });
});

describe("parseCsv - data quality", () => {
  it("rejects rows with non-numeric OHLC instead of coercing to 0", () => {
    const csv = [
      "2024.01.02,10:00,2000,2001,1999,2000",
      "2024.01.02,10:01,BAD,2001,1999,2000",
      "2024.01.02,10:02,2000,2001,1999,2000",
    ].join("\n");
    const r = parseCsv(csv, { hasHeader: false });
    expect(r.candles).toHaveLength(2);
    expect(r.rowsRejected).toBe(1);
    expect(r.rejectedExamples[0]).toContain("BAD");
  });

  it("rejects impossible OHLC geometry (high below low)", () => {
    const csv = "2024.01.02,10:00,2000,1990,2001,2000";
    const r = parseCsv(csv, { hasHeader: false });
    expect(r.candles).toHaveLength(0);
    expect(r.rowsRejected).toBe(1);
  });

  it("rejects a bar whose high is below its close", () => {
    const csv = "2024.01.02,10:00,2000,2000,1999,2010";
    expect(parseCsv(csv, { hasHeader: false }).candles).toHaveLength(0);
  });

  it("sorts newest-first exports into ascending time", () => {
    const csv = [
      "2024.01.02,10:02,2002,2003,2001,2002",
      "2024.01.02,10:00,2000,2001,1999,2000",
      "2024.01.02,10:01,2001,2002,2000,2001",
    ].join("\n");
    const r = parseCsv(csv, { hasHeader: false });
    expect(r.candles.map((c) => c.time)).toEqual([
      Date.UTC(2024, 0, 2, 10, 0) / 1000,
      Date.UTC(2024, 0, 2, 10, 1) / 1000,
      Date.UTC(2024, 0, 2, 10, 2) / 1000,
    ]);
  });

  it("ignores a UTF-8 BOM and blank lines", () => {
    const csv = "\uFEFF2024.01.02,10:00,2000,2001,1999,2000\n\n\n";
    const r = parseCsv(csv, { hasHeader: false });
    expect(r.candles).toHaveLength(1);
  });

  it("throws a clear error on empty input", () => {
    expect(() => parseCsv("   \n  ")).toThrow(/empty/);
  });
});

describe("medianSpacingMinutes", () => {
  it("ignores weekend-sized gaps", () => {
    const c = (t: number) => ({ time: t, open: 1, high: 2, low: 0, close: 1, volume: 0 });
    const bars = [c(0), c(300), c(600), c(86_400 + 600), c(86_400 + 900)];
    expect(medianSpacingMinutes(bars)).toBe(5);
  });
});
