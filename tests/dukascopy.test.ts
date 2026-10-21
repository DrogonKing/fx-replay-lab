import { describe, it, expect } from "vitest";
import {
  dukascopyUrl, tickUrls, pointScale, decodeCandles, barsToCandles,
  daysBetween, dayKey, emptyProgress, progressFraction, describeProgress,
} from "../src/core/dukascopy.js";

/** Build one 24-byte record exactly as Dukascopy writes it. */
function record(
  offset: number, open: number, close: number, low: number, high: number, volume: number,
): Uint8Array {
  const b = new Uint8Array(24);
  const v = new DataView(b.buffer);
  v.setUint32(0, offset, false);
  v.setUint32(4, open, false);
  v.setUint32(8, close, false);
  v.setUint32(12, low, false);
  v.setUint32(16, high, false);
  v.setFloat32(20, volume, false);
  return b;
}

function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.length * 24);
  parts.forEach((p, i) => out.set(p, i * 24));
  return out;
}

describe("dukascopyUrl", () => {
  it("ZERO-INDEXES the month, which is the easiest way to break a downloader", () => {
    // 2010/00/04 is 4 January 2010, not February
    expect(dukascopyUrl("GBPUSD", 2010, 1, 4)).toBe(
      "https://datafeed.dukascopy.com/datafeed/GBPUSD/2010/00/04/BID_candles_min_1.bi5",
    );
  });

  it("maps December to month 11", () => {
    expect(dukascopyUrl("EURUSD", 2024, 12, 31)).toContain("/2024/11/31/");
  });

  it("pads single-digit days", () => {
    expect(dukascopyUrl("EURUSD", 2024, 1, 5)).toContain("/00/05/");
  });

  it("uses the candles path for candles", () => {
    expect(dukascopyUrl("EURUSD", 2024, 1, 2)).toContain("BID_candles_min_1.bi5");
  });
});

describe("tickUrls", () => {
  it("returns 24 hourly files, because ticks are one file per hour", () => {
    const urls = tickUrls("EURUSD", 2024, 1, 2);
    expect(urls).toHaveLength(24);
    expect(urls[0]).toContain("/00h_ticks.bi5");
    expect(urls[23]).toContain("/23h_ticks.bi5");
  });

  it("uses the zero-indexed month", () => {
    expect(tickUrls("EURUSD", 2024, 3, 1)[0]).toContain("/2024/02/01/");
  });
});

describe("pointScale", () => {
  it("uses 1e5 for a normal FX pair", () => {
    expect(pointScale("EURUSD")).toBe(1e5);
    expect(pointScale("GBPUSD")).toBe(1e5);
  });

  it("uses 1e3 for a JPY pair, which quotes with fewer decimals", () => {
    expect(pointScale("USDJPY")).toBe(1e3);
    expect(pointScale("GBPJPY")).toBe(1e3);
  });

  it("uses 1e3 for metals", () => {
    expect(pointScale("XAUUSD")).toBe(1e3);
    expect(pointScale("XAGUSD")).toBe(1e3);
  });

  it("uses 1e1 for crypto", () => {
    expect(pointScale("BTCUSD")).toBe(1e1);
  });
});

describe("decodeCandles", () => {
  it("decodes open, CLOSE, LOW, HIGH in that order", () => {
    // the trap: the order is not OHLC. Reading them as float32 gives zeros.
    const raw = join([record(0, 110366, 110374, 110366, 110376, 12.5)]);
    const bars = decodeCandles(raw, 1e5);
    expect(bars).toHaveLength(1);
    expect(bars[0]!.open).toBeCloseTo(1.10366, 5);
    expect(bars[0]!.close).toBeCloseTo(1.10374, 5);
    expect(bars[0]!.low).toBeCloseTo(1.10366, 5);
    expect(bars[0]!.high).toBeCloseTo(1.10376, 5);
    expect(bars[0]!.volume).toBeCloseTo(12.5, 1);
  });

  it("keeps the second offset", () => {
    const raw = join([record(60, 110371, 110375, 110368, 110375, 1)]);
    expect(decodeCandles(raw, 1e5)[0]!.offset).toBe(60);
  });

  it("DROPS minutes with no ticks instead of emitting a zero price", () => {
    // a weekend minute has open = 0. Keeping it would put a fake 100% drop in the account.
    const raw = join([
      record(0, 110366, 110374, 110366, 110376, 1),
      record(60, 0, 0, 0, 0, 0),
      record(120, 110374, 110374, 110371, 110375, 1),
    ]);
    const bars = decodeCandles(raw, 1e5);
    expect(bars).toHaveLength(2);
    expect(bars.map((b) => b.offset)).toEqual([0, 120]);
  });

  it("ignores a trailing partial record", () => {
    const raw = new Uint8Array(30); // 1 full record + 6 stray bytes
    expect(decodeCandles(raw, 1e5)).toHaveLength(0); // open is 0, so dropped anyway
    const withData = join([record(0, 110366, 110374, 110366, 110376, 1)]);
    const padded = new Uint8Array(withData.length + 6);
    padded.set(withData);
    expect(decodeCandles(padded, 1e5)).toHaveLength(1);
  });

  it("handles a full day of 1440 records", () => {
    const parts: Uint8Array[] = [];
    for (let i = 0; i < 1440; i++) {
      parts.push(record(i * 60, 110000 + i, 110001 + i, 109999 + i, 110002 + i, 1));
    }
    const bars = decodeCandles(join(parts), 1e5);
    expect(bars).toHaveLength(1440);
    expect(bars[1439]!.offset).toBe(86340);
  });

  it("returns nothing for an empty buffer", () => {
    expect(decodeCandles(new Uint8Array(0), 1e5)).toEqual([]);
  });

  it("scales a JPY pair correctly", () => {
    const raw = join([record(0, 157234, 157240, 157230, 157245, 1)]);
    const bars = decodeCandles(raw, pointScale("USDJPY"));
    expect(bars[0]!.open).toBeCloseTo(157.234, 3);
  });
});

describe("barsToCandles", () => {
  it("adds the day's midnight to each offset", () => {
    const midnight = Date.UTC(2024, 0, 2) / 1000;
    const out = barsToCandles(
      [{ offset: 60, open: 1, close: 2, low: 0.5, high: 2.5, volume: 1 }],
      2024, 1, 2,
    );
    expect(out[0]!.time).toBe(midnight + 60);
  });

  it("keeps OHLC in the right fields", () => {
    const out = barsToCandles(
      [{ offset: 0, open: 1.1, close: 1.2, low: 1.0, high: 1.3, volume: 5 }],
      2024, 1, 2,
    );
    expect(out[0]).toMatchObject({ open: 1.1, close: 1.2, low: 1.0, high: 1.3 });
  });
});

describe("daysBetween", () => {
  const at = (y: number, m: number, d: number): number => Date.UTC(y, m - 1, d) / 1000;

  it("covers every day inclusive", () => {
    const days = daysBetween(at(2024, 1, 1), at(2024, 1, 5));
    expect(days).toHaveLength(5);
    expect(days[0]).toEqual({ y: 2024, m: 1, d: 1 });
    expect(days[4]).toEqual({ y: 2024, m: 1, d: 5 });
  });

  it("is one day for a single-day range", () => {
    expect(daysBetween(at(2024, 1, 2), at(2024, 1, 2))).toHaveLength(1);
  });

  it("crosses a month boundary", () => {
    const days = daysBetween(at(2024, 1, 30), at(2024, 2, 2));
    expect(days.map((d) => `${d.m}-${d.d}`)).toEqual(["1-30", "1-31", "2-1", "2-2"]);
  });

  it("handles a leap day", () => {
    expect(daysBetween(at(2024, 2, 28), at(2024, 3, 1))).toHaveLength(3);
    expect(daysBetween(at(2023, 2, 28), at(2023, 3, 1))).toHaveLength(2);
  });

  it("counts a full year as 365 or 366", () => {
    expect(daysBetween(at(2023, 1, 1), at(2023, 12, 31))).toHaveLength(365);
    expect(daysBetween(at(2024, 1, 1), at(2024, 12, 31))).toHaveLength(366);
  });

  it("INCLUDES weekends, because Dukascopy serves them as flat bars", () => {
    // 2024-01-06 was a Saturday
    const days = daysBetween(at(2024, 1, 5), at(2024, 1, 8));
    expect(days).toHaveLength(4);
  });
});

describe("dayKey", () => {
  it("pads to a sortable form", () => {
    expect(dayKey(2024, 1, 5)).toBe("2024-01-05");
    expect(dayKey(2024, 12, 31)).toBe("2024-12-31");
  });

  it("sorts chronologically as a string", () => {
    const keys = [dayKey(2024, 12, 1), dayKey(2024, 1, 9), dayKey(2024, 1, 10)];
    expect([...keys].sort()).toEqual(["2024-01-09", "2024-01-10", "2024-12-01"]);
  });
});

describe("progress", () => {
  it("starts at zero", () => {
    const p = emptyProgress(100);
    expect(p.done).toBe(0);
    expect(p.total).toBe(100);
    expect(progressFraction(p)).toBe(0);
  });

  it("reports a fraction, capped at 1", () => {
    expect(progressFraction({ ...emptyProgress(4), done: 1 })).toBe(0.25);
    expect(progressFraction({ ...emptyProgress(4), done: 9 })).toBe(1);
  });

  it("does not divide by zero", () => {
    expect(progressFraction(emptyProgress(0))).toBe(0);
  });

  it("summarises the run", () => {
    const s = describeProgress({
      done: 50, total: 100, empty: 2, failed: 1, bars: 72000, failures: [],
    });
    expect(s).toContain("50%");
    expect(s).toContain("72,000 bars");
    expect(s).toContain("2 empty");
    expect(s).toContain("1 failed");
  });

  it("omits the noise when everything is clean", () => {
    const s = describeProgress({
      done: 1, total: 1, empty: 0, failed: 0, bars: 1440, failures: [],
    });
    expect(s).not.toContain("empty");
    expect(s).not.toContain("failed");
  });
});
