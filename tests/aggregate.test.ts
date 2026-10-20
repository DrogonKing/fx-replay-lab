import { describe, it, expect } from "vitest";
import {
  aggregate,
  aggregateForming,
  detectBaseTimeframeMinutes,
  parseTimeframeLabel,
  TIMEFRAMES,
} from "../src/core/aggregate.js";
import { seriesFromCandles } from "../src/core/series.js";
import type { Candle } from "../src/core/types.js";

const T0 = Date.UTC(2024, 0, 2, 0, 0, 0) / 1000; // 2024-01-02 00:00Z (a Tuesday)

/** n consecutive 1-minute bars starting at T0. */
function m1(n: number, opts: { price?: number; skipWeekend?: boolean } = {}): Candle[] {
  const out: Candle[] = [];
  let price = opts.price ?? 2000;
  for (let i = 0; i < n; i++) {
    const o = price;
    const c = price + 1;
    out.push({
      time: T0 + i * 60,
      open: o,
      high: c + 0.5,
      low: o - 0.5,
      close: c,
      volume: 1,
    });
    price = c;
  }
  return out;
}

describe("parseTimeframeLabel", () => {
  it("parses presets", () => {
    expect(parseTimeframeLabel("M15")?.minutes).toBe(15);
    expect(parseTimeframeLabel("H4")?.minutes).toBe(240);
    expect(parseTimeframeLabel("D1")?.kind).toBe("day");
    expect(parseTimeframeLabel("W1")?.kind).toBe("week");
  });

  it("parses arbitrary minute counts", () => {
    expect(parseTimeframeLabel("7")).toEqual({ label: "7m", minutes: 7, kind: "minute" });
    expect(parseTimeframeLabel("90")?.minutes).toBe(90);
  });

  it("rejects nonsense", () => {
    expect(parseTimeframeLabel("abc")).toBeNull();
    expect(parseTimeframeLabel("0")).toBeNull();
  });
});

describe("minute aggregation", () => {
  it("aggregates 1m into 5m with correct OHLC", () => {
    const base = seriesFromCandles(m1(30));
    const m5 = TIMEFRAMES.find((t) => t.label === "M5")!;
    const a = aggregate(base, m5);
    expect(a.length).toBe(6);
    // first bucket: bars 0..4, open = bar0.open, close = bar4.close,
    // high = max, low = min
    expect(a.open[0]).toBe(2000);
    expect(a.close[0]).toBe(2005);
    expect(a.high[0]).toBe(2005.5);
    expect(a.low[0]).toBe(1999.5);
    expect(a.volume[0]).toBe(5);
  });

  it("anchors buckets to the epoch, so a bar never straddles a boundary", () => {
    const base = seriesFromCandles(m1(20));
    const m15 = TIMEFRAMES.find((t) => t.label === "M15")!;
    const a = aggregate(base, m15);
    for (const t of a.time) {
      expect(t % (15 * 60)).toBe(0);
    }
  });

  it("supports a 7-minute frame without approximating", () => {
    // Buckets are anchored to the epoch, so 70 consecutive minutes can span 11
    // seven-minute buckets rather than 10: T0 (2024-01-02 00:00Z) is 240s into a
    // bucket, so the first bucket is partial and the last one starts at minute
    // 63. That is the documented behaviour -- every resulting bar still covers
    // exactly 7 minutes of chart time and each bucket boundary is epoch-aligned.
    const base = seriesFromCandles(m1(70));
    const tf = parseTimeframeLabel("7")!;
    const a = aggregate(base, tf);
    const step = 7 * 60;
    for (let i = 1; i < a.length; i++) {
      expect(a.time[i]! - a.time[i - 1]!).toBe(step);
    }
    for (const t of a.time) expect(t % step).toBe(0);
    const expected = Math.floor((T0 + 69 * 60) / step) - Math.floor(T0 / step) + 1;
    expect(a.length).toBe(expected);
    expect(a.length).toBe(11);
  });

  it("does not invent bars for gaps", () => {
    const bars = m1(5);
    bars.push({ ...bars[4]!, time: bars[4]!.time + 3600 }); // 1h hole
    const base = seriesFromCandles(bars);
    const m15 = TIMEFRAMES.find((t) => t.label === "M15")!;
    const a = aggregate(base, m15);
    // 5 bars fill one 15m bucket (00:00-00:04) and the jump lands in 01:00
    expect(a.length).toBe(2);
  });

  it("sums volume across the bucket", () => {
    const base = seriesFromCandles(m1(10));
    const h1 = TIMEFRAMES.find((t) => t.label === "H1")!;
    expect(aggregate(base, h1).volume[0]).toBe(10);
  });
});

describe("day aggregation with session anchoring", () => {
  /** hourly bars across 3 days starting 2024-01-02 00:00Z */
  function hourly(n: number): Candle[] {
    const out: Candle[] = [];
    for (let i = 0; i < n; i++) {
      out.push({
        time: T0 + i * 3600,
        open: 2000 + i, high: 2001 + i, low: 1999 + i, close: 2000.5 + i,
        volume: 1,
      });
    }
    return out;
  }

  it("splits days at 17:00 New York, not at UTC midnight", () => {
    // 17:00 New York in January = 22:00 UTC.
    const base = seriesFromCandles(hourly(72)); // 3 days of hours
    const d1 = TIMEFRAMES.find((t) => t.label === "D1")!;
    const a = aggregate(base, d1, { anchorZone: "America/New_York", sessionOpenHour: 17 });

    // The first day bucket must break at 22:00 UTC: bars 00..21 belong to
    // the session that started the previous afternoon.
    const times = Array.from(a.time);
    expect(times.length).toBeGreaterThanOrEqual(2);
    // Find the bar index where a new day starts, and confirm it is 22:00Z.
    const firstBarOfSecondDay = a.time[1]!;
    const utcHour = new Date(firstBarOfSecondDay * 1000).getUTCHours();
    expect(utcHour).toBe(22);
  });

  it("shifts the anchor when New York is on DST", () => {
    // July: 17:00 New York = 21:00 UTC.
    const summer = Date.UTC(2024, 6, 2, 0, 0, 0) / 1000;
    const bars: Candle[] = [];
    for (let i = 0; i < 72; i++) {
      bars.push({
        time: summer + i * 3600,
        open: 2000, high: 2001, low: 1999, close: 2000, volume: 1,
      });
    }
    const d1 = TIMEFRAMES.find((t) => t.label === "D1")!;
    const a = aggregate(seriesFromCandles(bars), d1, {
      anchorZone: "America/New_York", sessionOpenHour: 17,
    });
    const utcHour = new Date(a.time[1]! * 1000).getUTCHours();
    expect(utcHour).toBe(21);
  });

  it("aggregates a week from daily data", () => {
    const base = seriesFromCandles(hourly(24 * 8));
    const w1 = TIMEFRAMES.find((t) => t.label === "W1")!;
    const a = aggregate(base, w1, { anchorZone: "UTC", sessionOpenHour: 0 });
    expect(a.length).toBeGreaterThanOrEqual(1);
    expect(a.length).toBeLessThanOrEqual(2);
  });
});

describe("aggregateForming (live replay bar)", () => {
  it("returns the forming bar growing as base bars arrive", () => {
    const base = seriesFromCandles(m1(30));
    const m5 = TIMEFRAMES.find((t) => t.label === "M5")!;
    // reveal 12 bars -> 2 closed 5m bars (10 bars) + 1 forming from bars 10..11
    const f = aggregateForming(base, 12, m5);
    expect(f.length).toBe(3);
    const last = f.length - 1;
    expect(f.time[last]).toBe(T0 + 10 * 60);
    // bars 10 and 11 form this bucket: open from bar10, close from bar11
    expect(f.open[last]).toBe(2010);
    expect(f.close[last]).toBe(2012);
    expect(f.high[last]).toBe(2012.5);
    expect(f.low[last]).toBe(2009.5);
    expect(f.volume[last]).toBe(2);
  });

  it("grows the forming bar's high/low as more bars appear", () => {
    const base = seriesFromCandles(m1(30));
    const m5 = TIMEFRAMES.find((t) => t.label === "M5")!;
    const at11 = aggregateForming(base, 11, m5);
    const at13 = aggregateForming(base, 13, m5);
    const i1 = at11.length - 1;
    const i3 = at13.length - 1;
    expect(at13.high[i3]!).toBeGreaterThan(at11.high[i1]!);
    expect(at13.volume[i3]!).toBeGreaterThan(at11.volume[i1]!);
  });

  it("matches the closed aggregate for a bucket that is exactly complete", () => {
    const base = seriesFromCandles(m1(30));
    const m5 = TIMEFRAMES.find((t) => t.label === "M5")!;
    // Reveal exactly 10 bars: two complete 5m buckets, nothing partial.
    const revealed = aggregateForming(base, 10, m5);
    const closed = aggregate(seriesFromCandles(m1(10)), m5);
    // Both must describe the same two buckets with identical OHLCV.
    expect(revealed.length).toBe(closed.length);
    expect(Array.from(revealed.time)).toEqual(Array.from(closed.time));
    expect(Array.from(revealed.open)).toEqual(Array.from(closed.open));
    expect(Array.from(revealed.high)).toEqual(Array.from(closed.high));
    expect(Array.from(revealed.low)).toEqual(Array.from(closed.low));
    expect(Array.from(revealed.close)).toEqual(Array.from(closed.close));
    expect(Array.from(revealed.volume)).toEqual(Array.from(closed.volume));
  });
});

describe("detectBaseTimeframeMinutes", () => {
  it("detects 1m, 5m and 15m spacing", () => {
    expect(detectBaseTimeframeMinutes(seriesFromCandles(m1(100)))).toBe(1);
    const five: Candle[] = [];
    for (let i = 0; i < 100; i++) {
      five.push({ time: T0 + i * 300, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 });
    }
    expect(detectBaseTimeframeMinutes(seriesFromCandles(five))).toBe(5);
  });

  it("ignores weekend gaps when taking the median", () => {
    const bars: Candle[] = [];
    let t = T0;
    for (let i = 0; i < 200; i++) {
      if (i === 100) t += 2 * 86400; // weekend jump
      bars.push({ time: t, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 });
      t += 60;
    }
    expect(detectBaseTimeframeMinutes(seriesFromCandles(bars))).toBe(1);
  });

  it("returns 0 for empty or single-bar input", () => {
    expect(detectBaseTimeframeMinutes(seriesFromCandles([]))).toBe(0);
    expect(detectBaseTimeframeMinutes(seriesFromCandles(m1(1)))).toBe(0);
  });
});

describe("performance", () => {
  it("aggregates 500k M1 bars into H1 quickly", () => {
    const n = 500_000;
    const time = new Float64Array(n);
    const open = new Float64Array(n);
    const high = new Float64Array(n);
    const low = new Float64Array(n);
    const close = new Float64Array(n);
    const volume = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      time[i] = T0 + i * 60;
      open[i] = 2000 + (i % 100) * 0.01;
      high[i] = open[i]! + 0.5;
      low[i] = open[i]! - 0.5;
      close[i] = open[i]! + 0.2;
      volume[i] = 1;
    }
    const base = { time, open, high, low, close, volume, length: n };
    const h1 = TIMEFRAMES.find((t) => t.label === "H1")!;
    const t0 = performance.now();
    const a = aggregate(base, h1);
    const ms = performance.now() - t0;
    expect(a.length).toBe(Math.ceil(n / 60));
    // Generous bound for a 2-core box; the point is that it is not quadratic.
    expect(ms).toBeLessThan(2000);
  });
});
