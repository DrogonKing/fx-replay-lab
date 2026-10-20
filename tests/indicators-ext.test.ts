import { describe, it, expect } from "vitest";
import {
  vwap, adx, cci, ichimoku, parabolicSar, supertrend,
  volume, volumeMa, pivotLevels, pivotSeries,
} from "../src/core/indicators-ext.js";
import { seriesFromCandles } from "../src/core/series.js";
import type { Candle } from "../src/core/types.js";

function mk(closes: number[], startTime = 1_700_000_000, step = 60): Candle[] {
  return closes.map((c, i) => ({
    time: startTime + i * step,
    open: i > 0 ? closes[i - 1]! : c,
    high: c + 1,
    low: c - 1,
    close: c,
    volume: 100 + i,
  }));
}
function bars(closes: number[]): ReturnType<typeof seriesFromCandles> {
  return seriesFromCandles(mk(closes));
}

describe("VWAP", () => {
  it("is the volume-weighted mean of typical price", () => {
    const s = seriesFromCandles([
      { time: 100, open: 10, high: 12, low: 8, close: 10, volume: 100 },  // typical 10
      { time: 200, open: 10, high: 22, low: 18, close: 20, volume: 300 },  // typical 20
    ]);
    const v = vwap(s);
    expect(v[0]).toBeCloseTo(10, 9);
    // (10*100 + 20*300) / 400 = 7000/400 = 17.5
    expect(v[1]).toBeCloseTo(17.5, 9);
  });

  it("resets on a session boundary", () => {
    const s = seriesFromCandles([
      { time: 100, open: 10, high: 10, low: 10, close: 10, volume: 100 },
      { time: 200, open: 30, high: 30, low: 30, close: 30, volume: 100 },
    ]);
    const v = vwap(s, (i) => i === 1);
    expect(v[0]).toBeCloseTo(10, 9);
    expect(v[1]).toBeCloseTo(30, 9);   // reset, not averaged with 10
  });

  it("carries the last value on zero volume instead of blanking", () => {
    const s = seriesFromCandles([
      { time: 100, open: 10, high: 10, low: 10, close: 10, volume: 100 },
      { time: 200, open: 10, high: 10, low: 10, close: 10, volume: 0 },
    ]);
    const v = vwap(s);
    expect(v[1]).toBeCloseTo(10, 9);
  });
});

describe("ADX", () => {
  it("produces DI values in [0,100] and a finite ADX on a trend", () => {
    const closes = Array.from({ length: 120 }, (_, i) => 100 + i * 0.5);
    const r = adx(bars(closes), 14);
    const last = 119;
    expect(r.plusDi[last]).toBeGreaterThan(0);
    expect(r.plusDi[last]).toBeLessThanOrEqual(100);
    expect(r.minusDi[last]).toBeCloseTo(0, 1);   // pure uptrend: no -DI
    expect(Number.isFinite(r.adx[last]!)).toBe(true);
    expect(r.adx[last]).toBeGreaterThan(50);     // strong trend
  });

  it("gives -DI dominance on a downtrend", () => {
    const closes = Array.from({ length: 120 }, (_, i) => 200 - i * 0.5);
    const r = adx(bars(closes), 14);
    const last = 119;
    expect(r.minusDi[last]).toBeGreaterThan(r.plusDi[last]!);
  });

  it("is NaN before enough bars exist", () => {
    const r = adx(bars(Array.from({ length: 10 }, (_, i) => 100 + i)), 14);
    expect(Number.isNaN(r.adx[5]!)).toBe(true);
  });
});

describe("CCI", () => {
  it("is 0 when price is constant (deviation 0, no NaN)", () => {
    const s = bars(Array.from({ length: 40 }, () => 100));
    const c = cci(s, 20);
    expect(c[39]).toBe(0);
  });

  it("is positive in an uptrend and negative in a downtrend", () => {
    const up = cci(bars(Array.from({ length: 60 }, (_, i) => 100 + i)), 20);
    const down = cci(bars(Array.from({ length: 60 }, (_, i) => 200 - i)), 20);
    expect(up[59]!).toBeGreaterThan(0);
    expect(down[59]!).toBeLessThan(0);
  });

  it("uses mean absolute deviation, so a known case matches hand math", () => {
    // typical prices 1..20, period 20 -> mean 10.5, MAD = 5, CCI = (20-10.5)/(0.015*5)
    const closes = Array.from({ length: 20 }, (_, i) => i + 1);
    // high/low are close +-1 so typical == close for these bars
    const s = seriesFromCandles(closes.map((c, i) => ({
      time: 1_700_000_000 + i * 60, open: c, high: c, low: c, close: c, volume: 1,
    })));
    const c = cci(s, 20);
    const expected = (20 - 10.5) / (0.015 * 5);
    expect(c[19]!).toBeCloseTo(expected, 6);
  });
});

describe("Ichimoku", () => {
  it("computes midpoints of the correct windows", () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + i);
    const s = bars(closes);
    const ich = ichimoku(s, 9, 26, 52);
    // tenkan at i=8: midpoint of high/low over bars 0..8
    const hi = Math.max(...closes.slice(0, 9).map((c) => c + 1));
    const lo = Math.min(...closes.slice(0, 9).map((c) => c - 1));
    expect(ich.tenkan[8]!).toBeCloseTo((hi + lo) / 2, 9);
  });

  it("displaces Senkou forward by the kijun period", () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + i);
    const s = bars(closes);
    const ich = ichimoku(s, 9, 26, 52);
    // senkouB at index i is the value computed at i-26
    const raw = ichimoku(s, 9, 26, 52);
    expect(Number.isNaN(ich.senkouB[25]!)).toBe(true);  // nothing displaced yet
    expect(Number.isNaN(ich.senkouB[52 + 26 - 1]!)).toBe(false);
    void raw;
  });

  it("plots Chikou behind price", () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + i);
    const s = bars(closes);
    const ich = ichimoku(s, 9, 26, 52);
    expect(ich.chikou[10]!).toBeCloseTo(closes[36]!, 9);
  });
});

describe("Parabolic SAR", () => {
  it("stays below price in an uptrend", () => {
    const closes = Array.from({ length: 100 }, (_, i) => 100 + i);
    const psar = parabolicSar(bars(closes));
    for (let i = 60; i < 100; i++) {
      expect(psar[i]!).toBeLessThan(closes[i]! + 1);
    }
  });

  it("flips above price in a downtrend", () => {
    const closes = Array.from({ length: 100 }, (_, i) => 200 - i);
    const psar = parabolicSar(bars(closes));
    expect(psar[99]!).toBeGreaterThan(closes[99]! - 1);
  });

  it("never produces NaN after the seed bar", () => {
    const psar = parabolicSar(bars(Array.from({ length: 50 }, (_, i) => 100 + (i % 7))));
    for (let i = 1; i < 50; i++) expect(Number.isNaN(psar[i]!)).toBe(false);
  });
});

describe("Supertrend", () => {
  it("points up in an uptrend and down in a downtrend", () => {
    const up = supertrend(bars(Array.from({ length: 120 }, (_, i) => 100 + i)), 10, 3);
    expect(up.direction[119]).toBe(1);
    const down = supertrend(bars(Array.from({ length: 120 }, (_, i) => 300 - i)), 10, 3);
    expect(down.direction[119]).toBe(-1);
  });

  it("line sits below price in an uptrend", () => {
    const closes = Array.from({ length: 120 }, (_, i) => 100 + i);
    const st = supertrend(bars(closes), 10, 3);
    expect(st.line[119]!).toBeLessThan(closes[119]!);
  });

  it("flips direction on a sharp reversal", () => {
    const closes = [
      ...Array.from({ length: 60 }, (_, i) => 100 + i),
      ...Array.from({ length: 60 }, (_, i) => 160 - i * 2),
    ];
    const st = supertrend(bars(closes), 10, 3);
    expect(st.direction[59]).toBe(1);
    expect(st.direction[119]).toBe(-1);
  });
});

describe("Volume", () => {
  it("passes volume through and averages it", () => {
    const s = bars([10, 20, 30, 40, 50]);
    expect(Array.from(volume(s))).toEqual([100, 101, 102, 103, 104]);
    const ma = volumeMa(s, 3);
    expect(ma[4]).toBeCloseTo((102 + 103 + 104) / 3, 9);
    expect(Number.isNaN(ma[1]!)).toBe(true);
  });
});

describe("Pivot points", () => {
  it("classic levels match the floor-trader formulas", () => {
    const lv = pivotLevels(110, 90, 100, "classic");
    expect(lv.pivot).toBeCloseTo(100, 9);       // (110+90+100)/3
    expect(lv.r1).toBeCloseTo(110, 9);          // 2*100-90
    expect(lv.s1).toBeCloseTo(90, 9);           // 2*100-110
    expect(lv.r2).toBeCloseTo(120, 9);          // p + range(20)
    expect(lv.s2).toBeCloseTo(80, 9);
    expect(lv.r3).toBeCloseTo(130, 9);          // 110 + 2*(100-90)
    expect(lv.s3).toBeCloseTo(70, 9);
  });

  it("fibonacci levels scale the range", () => {
    const lv = pivotLevels(110, 90, 100, "fibonacci");
    expect(lv.r1).toBeCloseTo(100 + 0.382 * 20, 9);
    expect(lv.s3).toBeCloseTo(100 - 20, 9);
  });

  it("pivotSeries uses the PREVIOUS session and never looks ahead", () => {
    // two sessions: ids 0 and 1, 3 bars each
    const closes = [10, 11, 12, 20, 21, 22];
    const s = seriesFromCandles(mk(closes));
    const ps = pivotSeries(s, (i) => (i < 3 ? 0 : 1), "classic");
    // session 0 has no previous session => NaN
    expect(Number.isNaN(ps.pivot[0]!)).toBe(true);
    expect(Number.isNaN(ps.pivot[2]!)).toBe(true);
    // session 1 pivots come from session 0: high max 13, low min 9, close 12
    const expected = (13 + 9 + 12) / 3;
    expect(ps.pivot[3]!).toBeCloseTo(expected, 9);
    expect(ps.pivot[5]!).toBeCloseTo(expected, 9);
  });
});
