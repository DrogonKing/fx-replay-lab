import { describe, it, expect } from "vitest";
import {
  sma, ema, rma, rsi, bollinger, wma, atr, macd, stochastic,
  crossover, crossunder, highestHigh, lowestLow, smaOfClose,
} from "../src/core/indicators.js";
import { seriesFromCandles } from "../src/core/series.js";
import type { Candle } from "../src/core/types.js";

describe("SMA", () => {
  it("computes a rolling mean and leaves NaN before it is ready", () => {
    const v = [1, 2, 3, 4, 5];
    const out = sma(v, 3);
    expect(Number.isNaN(out[0]!)).toBe(true);
    expect(Number.isNaN(out[1]!)).toBe(true);
    expect(out[2]).toBeCloseTo(2, 12);
    expect(out[3]).toBeCloseTo(3, 12);
    expect(out[4]).toBeCloseTo(4, 12);
  });

  it("matches a hand-computed value on a longer series", () => {
    const v = Array.from({ length: 100 }, (_, i) => i + 1);
    const out = sma(v, 10);
    // window 91..100 -> mean 95.5
    expect(out[99]).toBeCloseTo(95.5, 12);
  });

  it("handles period 1 and empty input", () => {
    expect(Array.from(sma([3, 4], 1))).toEqual([3, 4]);
    expect(sma([], 5).length).toBe(0);
  });
});

describe("EMA", () => {
  it("seeds with the SMA of the first period", () => {
    const v = [1, 2, 3, 4, 5, 6];
    const out = ema(v, 3);
    expect(out[2]).toBeCloseTo(2, 12);          // SMA(1,2,3)
    const k = 2 / 4;
    expect(out[3]).toBeCloseTo(4 * k + 2 * (1 - k), 12);
  });

  it("converges to a constant series", () => {
    const v = Array.from({ length: 200 }, () => 42);
    const out = ema(v, 20);
    expect(out[199]).toBeCloseTo(42, 10);
  });

  it("is NaN until the period is filled", () => {
    const out = ema([1, 2], 5);
    expect(Array.from(out).every((x) => Number.isNaN(x))).toBe(true);
  });
});

describe("RMA (Wilder)", () => {
  it("smooths recursively", () => {
    const v = Array.from({ length: 30 }, (_, i) => i + 1);
    const out = rma(v, 5);
    expect(out[4]).toBeCloseTo(3, 12);
    // next = (3*4 + 6)/5 = 3.6
    expect(out[5]).toBeCloseTo(3.6, 12);
  });
});

describe("RSI", () => {
  function bars(closes: number[]): Candle[] {
    return closes.map((c, i) => ({
      time: 1_700_000_000 + i * 60, open: c, high: c + 1, low: c - 1, close: c, volume: 0,
    }));
  }

  it("returns 100 on a monotonically rising series", () => {
    const s = seriesFromCandles(bars(Array.from({ length: 40 }, (_, i) => 100 + i)));
    const r = rsi(s, 14);
    expect(r[39]).toBeCloseTo(100, 6);
  });

  it("returns 0 on a monotonically falling series", () => {
    const s = seriesFromCandles(bars(Array.from({ length: 40 }, (_, i) => 100 - i)));
    const r = rsi(s, 14);
    expect(r[39]).toBeCloseTo(0, 6);
  });

  it("returns 50 on a flat series instead of NaN", () => {
    const s = seriesFromCandles(bars(Array.from({ length: 40 }, () => 100)));
    const r = rsi(s, 14);
    expect(r[39]).toBe(50);
    expect(Number.isNaN(r[39]!)).toBe(false);
  });

  it("stays within [0,100] on random-ish data", () => {
    const closes: number[] = [];
    let p = 100;
    let seed = 7;
    for (let i = 0; i < 500; i++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      p += ((seed / 2147483648) - 0.5) * 2;
      closes.push(p);
    }
    const s = seriesFromCandles(bars(closes));
    const r = rsi(s, 14);
    for (const v of r) {
      if (!Number.isNaN(v)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });

  it("is NaN before the period is filled", () => {
    const s = seriesFromCandles(bars(Array.from({ length: 10 }, (_, i) => 100 + i)));
    const r = rsi(s, 14);
    expect(Array.from(r).every((x) => Number.isNaN(x))).toBe(true);
  });
});

describe("Bollinger Bands", () => {
  function bars(closes: number[]): Candle[] {
    return closes.map((c, i) => ({
      time: 1_700_000_000 + i * 60, open: c, high: c, low: c, close: c, volume: 0,
    }));
  }

  it("middle equals the SMA", () => {
    const closes = Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i / 3) * 5);
    const s = seriesFromCandles(bars(closes));
    const b = bollinger(s, 20, 2);
    const m = sma(s.close, 20);
    for (let i = 19; i < 50; i++) expect(b.middle[i]).toBeCloseTo(m[i]!, 10);
  });

  it("bands are symmetric around the middle", () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 + (i % 7));
    const s = seriesFromCandles(bars(closes));
    const b = bollinger(s, 20, 2);
    const i = 39;
    expect(b.upper[i]! - b.middle[i]!).toBeCloseTo(b.middle[i]! - b.lower[i]!, 10);
  });

  it("uses population deviation, not sample", () => {
    // closes 1..20: population sd = sqrt(33.25) = 5.766281297335398
    const closes = Array.from({ length: 20 }, (_, i) => i + 1);
    const s = seriesFromCandles(bars(closes));
    const b = bollinger(s, 20, 2);
    const expectedSd = Math.sqrt(33.25);
    expect(b.upper[19]!).toBeCloseTo(10.5 + 2 * expectedSd, 9);
  });

  it("collapses to the mean on a flat series (zero variance)", () => {
    const s = seriesFromCandles(bars(Array.from({ length: 30 }, () => 50)));
    const b = bollinger(s, 20, 2);
    expect(b.upper[29]).toBeCloseTo(50, 10);
    expect(b.lower[29]).toBeCloseTo(50, 10);
  });
});

describe("WMA", () => {
  it("weights recent values more", () => {
    const out = wma([1, 2, 3], 3);
    // (1*1 + 2*2 + 3*3) / 6 = 14/6
    expect(out[2]).toBeCloseTo(14 / 6, 12);
  });
});

describe("ATR", () => {
  function bars(n: number): Candle[] {
    return Array.from({ length: n }, (_, i) => ({
      time: 1_700_000_000 + i * 60,
      open: 100, high: 102, low: 98, close: 100, volume: 0,
    }));
  }

  it("computes true range including gaps", () => {
    const s = seriesFromCandles([
      { time: 0, open: 100, high: 101, low: 99, close: 100, volume: 0 },
      // gap up: TR = max(2, |105-100|, |103-100|) = 5
      { time: 60, open: 104, high: 105, low: 103, close: 104, volume: 0 },
    ]);
    const a = atr(s, 1);
    expect(a[0]).toBeCloseTo(2, 10);
    expect(a[1]).toBeCloseTo(5, 10);
  });

  it("smooths with Wilder over a constant-range series", () => {
    const a = atr(seriesFromCandles(bars(60)), 14);
    // every TR is 4, so ATR converges to 4
    expect(a[59]).toBeCloseTo(4, 9);
  });
});

describe("MACD", () => {
  function bars(closes: number[]): Candle[] {
    return closes.map((c, i) => ({
      time: 1_700_000_000 + i * 60, open: c, high: c, low: c, close: c, volume: 0,
    }));
  }

  it("macd = ema(fast) - ema(slow)", () => {
    const closes = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 10) * 10);
    const s = seriesFromCandles(bars(closes));
    const m = macd(s, 12, 26, 9);
    const ef = ema(s.close, 12);
    const es = ema(s.close, 26);
    expect(m.macd[199]!).toBeCloseTo(ef[199]! - es[199]!, 9);
  });

  it("histogram = macd - signal", () => {
    const closes = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 7) * 8);
    const s = seriesFromCandles(bars(closes));
    const m = macd(s, 12, 26, 9);
    expect(m.histogram[199]!).toBeCloseTo(m.macd[199]! - m.signal[199]!, 9);
  });

  it("is flat on a constant series", () => {
    const s = seriesFromCandles(bars(Array.from({ length: 150 }, () => 77)));
    const m = macd(s);
    expect(m.macd[149]!).toBeCloseTo(0, 9);
    expect(m.histogram[149]!).toBeCloseTo(0, 9);
  });
});

describe("Stochastic", () => {
  it("returns 100 at the top of the range and 0 at the bottom", () => {
    const mk = (c: number, i: number) => ({
      time: 1_700_000_000 + i * 60, open: c, high: c, low: c, close: c, volume: 0,
    });
    // Flat bars at 10, then a bar closing at the top of the window (20).
    // rawK = 100 for that bar; with smooth=1 the %K passes through unchanged.
    const s = seriesFromCandles([10, 10, 10, 20].map((c, i) => mk(c, i)));
    const st = stochastic(s, 3, 3, 1);
    expect(st.k[3]).toBeCloseTo(100, 9);
  });

  it("guards against a zero range (flat market)", () => {
    const flat = Array.from({ length: 20 }, (_, i) => ({
      time: i * 60, open: 5, high: 5, low: 5, close: 5, volume: 0,
    }));
    // smooth=1 so %K is rawK, which must be 50 on a zero-range window.
    const st = stochastic(seriesFromCandles(flat), 5, 3, 1);
    expect(st.k[19]).toBe(50);
  });

  it("smooths %K with the smooth parameter", () => {
    // rawK becomes 100 at the last bar; smooth=1 keeps it, smooth=3 averages.
    const mk = (c: number, i: number) => ({
      time: 1_700_000_000 + i * 60, open: c, high: c, low: c, close: c, volume: 0,
    });
    const bars = [10, 10, 10, 10, 10, 20].map((c, i) => mk(c, i));
    const raw = stochastic(seriesFromCandles(bars), 3, 3, 1);
    const smoothed = stochastic(seriesFromCandles(bars), 3, 3, 3);
    expect(raw.k[5]).toBeCloseTo(100, 9);
    // mean of the last three rawK values, some of which are 0/50
    expect(smoothed.k[5]!).toBeLessThan(100);
    expect(Number.isNaN(smoothed.k[5]!)).toBe(false);
  });
});

describe("crossover / crossunder", () => {
  it("detects a cross above and below", () => {
    // a:    1  2  3  4  3  2
    // b:    2  2  2  2  2  2
    // i=1: a0=1<=2, a1=2>2? false -> no cross up
    // i=2: a0=2<=2, a1=3>2 -> cross UP
    // i=4: a0=4>=2, a1=3<2? false -> no cross down
    // i=5: a0=3>=2, a1=2<2? false -> still no cross down (touch, not through)
    const a = Float64Array.from([1, 2, 3, 4, 3, 2]);
    const b = Float64Array.from([2, 2, 2, 2, 2, 2]);
    expect(crossover(a, b, 1)).toBe(false);
    expect(crossover(a, b, 2)).toBe(true);
    expect(crossunder(a, b, 4)).toBe(false);
    expect(crossunder(a, b, 5)).toBe(false);
    // a genuine cross down needs a strictly-lower value than b:
    expect(crossunder(Float64Array.from([4, 1]), Float64Array.from([2, 2]), 1)).toBe(true);
  });

  it("never fires on NaN inputs", () => {
    const a = Float64Array.from([Number.NaN, 3]);
    const b = Float64Array.from([2, 2]);
    expect(crossover(a, b, 1)).toBe(false);
  });
});

describe("highestHigh / lowestLow", () => {
  const s = seriesFromCandles([
    { time: 0, open: 5, high: 10, low: 1, close: 5, volume: 0 },
    { time: 60, open: 5, high: 12, low: 2, close: 5, volume: 0 },
    { time: 120, open: 5, high: 8, low: 0.5, close: 5, volume: 0 },
  ]);
  it("looks back the requested window only", () => {
    expect(highestHigh(s, 2, 2)).toBe(12);
    expect(highestHigh(s, 2, 1)).toBe(8);
    expect(lowestLow(s, 2, 2)).toBe(0.5);
    expect(lowestLow(s, 2, 3)).toBe(0.5);
  });
});

describe("smaOfClose", () => {
  it("delegates to close prices", () => {
    const s = seriesFromCandles([
      { time: 0, open: 0, high: 0, low: 0, close: 10, volume: 0 },
      { time: 60, open: 0, high: 0, low: 0, close: 20, volume: 0 },
    ]);
    expect(smaOfClose(s, 2)[1]).toBeCloseTo(15, 12);
  });
});
