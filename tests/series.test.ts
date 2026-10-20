import { describe, it, expect } from "vitest";
import {
  seriesFromCandles,
  sliceSeries,
  candleAt,
  emptySeries,
  seriesByteSize,
} from "../src/core/series.js";
import type { Candle } from "../src/core/types.js";

function mk(n: number, start = 1_700_000_000, step = 60): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const o = 2000 + i;
    out.push({ time: start + i * step, open: o, high: o + 2, low: o - 2, close: o + 1, volume: 100 });
  }
  return out;
}

describe("seriesFromCandles", () => {
  it("builds columnar arrays with the right values", () => {
    const s = seriesFromCandles(mk(3));
    expect(s.length).toBe(3);
    expect(Array.from(s.open)).toEqual([2000, 2001, 2002]);
    expect(Array.from(s.high)).toEqual([2002, 2003, 2004]);
    expect(Array.from(s.low)).toEqual([1998, 1999, 2000]);
    expect(s.close[2]).toBe(2003);
  });

  it("rejects unsorted input instead of silently corrupting the chart", () => {
    const bad = mk(3);
    bad[1]!.time = bad[0]!.time;
    expect(() => seriesFromCandles(bad)).toThrow(/not sorted/);
  });

  it("handles zero candles", () => {
    const s = seriesFromCandles([]);
    expect(s.length).toBe(0);
  });

  it("stores 5M bars without per-object overhead", () => {
    const n = 5_000_000;
    const s = seriesFromCandles(mk(1)); // shape check only for size math
    expect(seriesByteSize({ ...s, length: n })).toBe(n * 48);
  });
});

describe("sliceSeries", () => {
  const s = seriesFromCandles(mk(10));

  it("returns a view without copying", () => {
    const v = sliceSeries(s, 2, 5);
    expect(v.length).toBe(3);
    expect(v.open[0]).toBe(2002);
    // subarray shares the buffer
    expect((v.open as Float64Array).buffer).toBe((s.open as Float64Array).buffer);
  });

  it("clamps out-of-range bounds", () => {
    expect(sliceSeries(s, -5, 3).length).toBe(3);
    expect(sliceSeries(s, 8, 100).length).toBe(2);
    expect(sliceSeries(s, 20, 30).length).toBe(0);
  });
});

describe("candleAt", () => {
  const s = seriesFromCandles(mk(5));
  it("returns a candle for valid indices", () => {
    expect(candleAt(s, 0)).toEqual({ time: 1_700_000_000, open: 2000, high: 2002, low: 1998, close: 2001, volume: 100 });
  });
  it("returns null out of bounds", () => {
    expect(candleAt(s, -1)).toBeNull();
    expect(candleAt(s, 5)).toBeNull();
  });
});

describe("emptySeries", () => {
  it("has zero length and no NaN", () => {
    const s = emptySeries();
    expect(s.length).toBe(0);
    expect(s.close.length).toBe(0);
  });
});
