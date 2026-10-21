import { describe, it, expect } from "vitest";
import {
  detectFormat, parseText, parseDukascopyDay, mergeResults, auditCandles,
  describeSpacing,
} from "../src/core/importer.js";

const head = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("detectFormat", () => {
  it("recognises a .bi5 file by extension", () => {
    expect(detectFormat("EURUSD_2024.bi5", new Uint8Array([1, 2])).format)
      .toBe("dukascopy-bi5");
  });

  it("recognises a ZIP as a HistData monthly export", () => {
    expect(detectFormat("DAT_ASCII_EURUSD_M1_202401.zip", new Uint8Array([0x50, 0x4b])).format)
      .toBe("histdata-ascii");
  });

  it("recognises HistData's semicolon rows with a joined date-time", () => {
    const d = detectFormat("x.csv", head("20240101 000000;1.10366;1.10374;1.10366;1.10376;0\n"));
    expect(d.format).toBe("histdata-ascii");
    expect(d.reason).toContain("semicolon");
  });

  it("recognises TrueFX", () => {
    const d = detectFormat("x.csv", head("EURUSD,20240101 00:00:00.123,1.10366,1.10374\n"));
    expect(d.format).toBe("truefx");
  });

  it("recognises an MT4 export by its header", () => {
    const d = detectFormat("x.csv", head("<DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\n"));
    expect(d.format).toBe("mt4-export");
  });

  it("recognises a headerless date-first file as MT4", () => {
    expect(detectFormat("x.csv", head("2024.01.02,10:00,1.1,1.2,1.0,1.15\n")).format)
      .toBe("mt4-export");
  });

  it("falls back to generic CSV", () => {
    expect(detectFormat("x.csv", head("1,2,3,4,5\n")).format).toBe("generic-csv");
  });

  it("says unknown rather than guessing", () => {
    expect(detectFormat("x.txt", head("hello world")).format).toBe("unknown");
  });

  it("checks the specific formats BEFORE the generic CSV", () => {
    // a HistData file IS a CSV; parsing it as generic would read the columns wrongly
    expect(detectFormat("x.csv", head("20240101 000000;1;2;3;4;0\n")).format)
      .not.toBe("generic-csv");
  });
});

describe("parseText — HistData", () => {
  const body = [
    "20240101 000000;1.10366;1.10374;1.10366;1.10376;0",
    "20240101 000100;1.10374;1.10380;1.10370;1.10382;5",
    "20240101 000200;1.10380;1.10385;1.10378;1.10390;3",
  ].join("\n");

  it("parses every row", () => {
    const r = parseText("histdata.csv", body);
    expect(r.candles).toHaveLength(3);
    expect(r.skipped).toBe(0);
  });

  it("reads OHLC in the right order", () => {
    const c = parseText("histdata.csv", body).candles[0]!;
    expect(c.open).toBeCloseTo(1.10366, 5);
    expect(c.high).toBeCloseTo(1.10374, 5);
    expect(c.low).toBeCloseTo(1.10366, 5);
    expect(c.close).toBeCloseTo(1.10376, 5);
  });

  it("uses UTC midnight for the first bar", () => {
    const c = parseText("histdata.csv", body).candles[0]!;
    expect(c.time).toBe(Date.UTC(2024, 0, 1) / 1000);
  });

  it("spaces bars by one minute", () => {
    const cs = parseText("histdata.csv", body).candles;
    expect(cs[1]!.time - cs[0]!.time).toBe(60);
  });

  it("keeps volume", () => {
    expect(parseText("histdata.csv", body).candles[1]!.volume).toBe(5);
  });
});

describe("parseText — MT4 export", () => {
  it("skips the header and parses rows", () => {
    const body = [
      "<DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>",
      "2024.01.02\t10:00\t1.1000\t1.1050\t1.0990\t1.1040\t42",
      "2024.01.02\t10:05\t1.1040\t1.1070\t1.1030\t1.1060\t31",
    ].join("\n");
    const r = parseText("mt4.csv", body);
    expect(r.format).toBe("mt4-export");
    expect(r.candles).toHaveLength(2);
    expect(r.candles[0]!.open).toBe(1.1);
    expect(r.candles[0]!.volume).toBe(42);
  });

  it("accepts a comma delimiter", () => {
    const body = "2024.01.02,10:00,1.1,1.2,1.0,1.15\n";
    expect(parseText("x.csv", body).candles).toHaveLength(1);
  });

  it("accepts slashes and dashes in the date", () => {
    for (const d of ["2024/01/02", "2024-01-02", "2024.01.02"]) {
      expect(parseText("x.csv", `${d},10:00,1.1,1.2,1.0,1.15\n`).candles, d).toHaveLength(1);
    }
  });

  it("treats a missing time as midnight", () => {
    const r = parseText("x.csv", "2024.01.02,1.1,1.2,1.0,1.15\n");
    expect(r.candles[0]!.time).toBe(Date.UTC(2024, 0, 2) / 1000);
  });

  it("shifts timestamps by the broker's UTC offset", () => {
    // a broker on GMT+2 would otherwise produce a chart shifted by two hours
    const utc = parseText("x.csv", "2024.01.02,10:00,1.1,1.2,1.0,1.15\n").candles[0]!.time;
    const shifted = parseText("x.csv", "2024.01.02,10:00,1.1,1.2,1.0,1.15\n", 2)
      .candles[0]!.time;
    expect(utc - shifted).toBe(7200);
  });
});

describe("parseText — robustness", () => {
  it("REJECTS a bar whose high is below its low", () => {
    const r = parseText("x.csv", "2024.01.02,10:00,1.1,0.9,1.2,1.15\n");
    expect(r.candles).toHaveLength(0);
    expect(r.skipped).toBe(1);
    expect(r.errors[0]).toContain("high < low");
  });

  it("COUNTS a corrupt row in the middle, rather than eating it as a header", () => {
    // an earlier version skipped any non-numeric line as a header, so a damaged file reported
    // zero problems — the worst kind of failure, because it looked clean
    const body = [
      "<DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>",
      "2024.01.02\t10:00\t1.1\t1.2\t1.0\t1.15",
      "CORRUPT LINE IN THE MIDDLE",
      "2024.01.02\t10:05\t1.15\t1.25\t1.1\t1.2",
    ].join("\n");
    const r = parseText("x.csv", body);
    expect(r.candles).toHaveLength(2);
    expect(r.skipped).toBe(1);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it("skips unparsable rows but keeps the good ones", () => {
    const body = [
      "2024.01.02,10:00,1.1,1.2,1.0,1.15",
      "garbage row here",
      "2024.01.02,10:05,1.15,1.25,1.1,1.2",
    ].join("\n");
    const r = parseText("x.csv", body);
    expect(r.candles).toHaveLength(2);
    expect(r.skipped).toBe(1);
  });

  it("sorts the result, so an unsorted export still works", () => {
    const body = [
      "2024.01.02,10:05,1.15,1.25,1.1,1.2",
      "2024.01.02,10:00,1.1,1.2,1.0,1.15",
    ].join("\n");
    const cs = parseText("x.csv", body).candles;
    expect(cs[0]!.time).toBeLessThan(cs[1]!.time);
  });

  it("reports the first and last bar", () => {
    const r = parseText("x.csv", "2024.01.02,10:00,1.1,1.2,1.0,1.15\n");
    expect(r.firstTime).toBe(r.lastTime);
    expect(r.firstTime).not.toBeNull();
  });

  it("handles CRLF line endings", () => {
    const body = "2024.01.02,10:00,1.1,1.2,1.0,1.15\r\n2024.01.02,10:05,1.1,1.2,1.0,1.15\r\n";
    expect(parseText("x.csv", body).candles).toHaveLength(2);
  });

  it("returns nothing for an empty file without throwing", () => {
    const r = parseText("x.csv", "");
    expect(r.candles).toEqual([]);
    expect(r.firstTime).toBeNull();
  });
});

describe("parseDukascopyDay", () => {
  it("needs the day, because the file stores offsets from midnight", () => {
    const b = new Uint8Array(24);
    const v = new DataView(b.buffer);
    v.setUint32(0, 60, false);
    v.setUint32(4, 110366, false);
    v.setUint32(8, 110374, false);
    v.setUint32(12, 110366, false);
    v.setUint32(16, 110376, false);
    v.setFloat32(20, 1, false);

    const r = parseDukascopyDay(b, "EURUSD", 2024, 1, 2);
    expect(r.candles).toHaveLength(1);
    expect(r.candles[0]!.time).toBe(Date.UTC(2024, 0, 2) / 1000 + 60);
  });
});

describe("mergeResults", () => {
  it("merges and sorts", () => {
    const a = parseText("a.csv", "2024.01.02,10:00,1.1,1.2,1.0,1.15\n");
    const b = parseText("b.csv", "2024.01.02,10:05,1.15,1.25,1.1,1.2\n");
    expect(mergeResults([b, a]).map((c) => c.open)).toEqual([1.1, 1.15]);
  });

  it("DEDUPLICATES overlapping files, later one winning", () => {
    // common when someone downloads by month AND by year
    const a = parseText("a.csv", "2024.01.02,10:00,1.1,1.2,1.0,1.15\n");
    const b = parseText("b.csv", "2024.01.02,10:00,9.9,9.9,9.9,9.9\n");
    const merged = mergeResults([a, b]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.open).toBe(9.9);
  });

  it("handles an empty list", () => {
    expect(mergeResults([])).toEqual([]);
  });
});

describe("auditCandles", () => {
  const mk = (times: number[], price = 1.1): Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }> =>
    times.map((t) => ({ time: t, open: price, high: price, low: price, close: price, volume: 1 }));

  const base = Date.UTC(2024, 0, 2) / 1000;

  it("infers the spacing", () => {
    const r = auditCandles(mk([base, base + 60, base + 120]));
    expect(r.spacingSeconds).toBe(60);
    expect(r.verdict).toBe("clean");
  });

  it("counts a gap larger than twice the spacing", () => {
    const r = auditCandles(mk([base, base + 60, base + 60 + 600]));
    expect(r.gaps).toBe(1);
    expect(r.largestGapSeconds).toBe(600);
  });

  it("FLAGS a non-positive price as suspect", () => {
    // a zero price parses fine and produces a fake 100% drop in the account
    const bad = mk([base, base + 60]);
    bad[1]!.close = 0;
    const r = auditCandles(bad);
    expect(r.badPrices).toBe(1);
    expect(r.verdict).toBe("suspect");
    expect(r.notes.join(" ")).toContain("non-positive");
  });

  it("counts duplicate timestamps", () => {
    const r = auditCandles(mk([base, base, base + 60]));
    expect(r.duplicates).toBe(1);
  });

  it("counts weekend bars and notes when there are none", () => {
    // 2024-01-06 is a Saturday
    const sat = Date.UTC(2024, 0, 6) / 1000;
    expect(auditCandles(mk([sat, sat + 60])).weekendBars).toBe(2);
    const withWeekend = auditCandles(mk([sat, sat + 60]));
    expect(withWeekend.notes.join(" ")).not.toContain("no weekend bars");
  });

  it("notes a source that filters weekends", () => {
    const mon = Date.UTC(2024, 0, 8) / 1000;
    const r = auditCandles(mk([mon, mon + 60]));
    expect(r.notes.join(" ")).toContain("no weekend bars");
  });

  it("is suspect for an empty series", () => {
    const r = auditCandles([]);
    expect(r.verdict).toBe("suspect");
    expect(r.bars).toBe(0);
  });

  it("reports first and last time", () => {
    const r = auditCandles(mk([base, base + 60]));
    expect(r.firstTime).toBe(base);
    expect(r.lastTime).toBe(base + 60);
  });
});

describe("describeSpacing", () => {
  it("names seconds, minutes, hours and days", () => {
    expect(describeSpacing(30)).toBe("30s");
    expect(describeSpacing(300)).toBe("5m");
    expect(describeSpacing(3600)).toBe("1h");
    expect(describeSpacing(86400)).toBe("1d");
  });

  it("says unknown for null", () => {
    expect(describeSpacing(null)).toBe("unknown");
  });
});
