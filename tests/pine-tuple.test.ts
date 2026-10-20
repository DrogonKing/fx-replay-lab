import { describe, it, expect } from "vitest";
import { parsePine } from "../src/core/pine/parser.js";
import { runPine } from "../src/core/pine/runtime.js";
import { seriesFromCandles } from "../src/core/series.js";
import type { Candle, CandleSeries } from "../src/core/types.js";

/** 120 bars of plausible data, enough for a 26-period window to fill. */
const CLOSES = Array.from({ length: 120 }, (_, i) => 2000 + Math.sin(i / 7) * 10 + i * 0.05);

const series = (closes: number[]): CandleSeries =>
  seriesFromCandles(closes.map((c, i) => ({
    time: 1_700_000_000 + i * 300,
    open: c - 0.5,
    high: c + 1,
    low: c - 1,
    close: c,
    volume: 100 + (i % 17),
  })) as Candle[]);

const run = (src: string) => {
  const program = parsePine(src);
  return runPine(series(CLOSES), program);
};

const wrap = (body: string): string =>
  ["//@version=5", 'indicator("t", overlay=true)', body].join("\n");

const plot = (result: ReturnType<typeof run>, title: string) =>
  result.plots.find((p) => p.title === title);

describe("tuple destructuring", () => {
  it("binds ta.bb in Pine order [middle, upper, lower]", () => {
    const result = run(wrap([
      "[mid, up, lo] = ta.bb(close, 20, 2)",
      'plot(mid, title="mid")',
      'plot(up, title="up")',
      'plot(lo, title="lo")',
    ].join("\n")));
    expect(result.errors).toEqual([]);

    const mid = plot(result, "mid")!;
    const up = plot(result, "up")!;
    const lo = plot(result, "lo")!;
    expect(mid).toBeDefined();

    const i = mid.values.findIndex((v, idx) =>
      !Number.isNaN(v) && !Number.isNaN(up.values[idx]!) && !Number.isNaN(lo.values[idx]!));
    expect(i).toBeGreaterThanOrEqual(0);
    expect(up.values[i]!).toBeGreaterThan(mid.values[i]!);
    expect(lo.values[i]!).toBeLessThan(mid.values[i]!);
  });

  it("the band has a real width, so this is not three copies of one number", () => {
    const result = run(wrap([
      "[mid, up, lo] = ta.bb(close, 20, 2)",
      'plot(up - lo, title="width")',
    ].join("\n")));
    const width = plot(result, "width")!;
    expect(width.values.some((v) => !Number.isNaN(v) && v > 0)).toBe(true);
  });

  it("binds ta.macd as [macd, signal, histogram]", () => {
    const result = run(wrap([
      "[m, sig, hist] = ta.macd(close, 12, 26, 9)",
      'plot(m, title="m")',
      'plot(sig, title="sig")',
      'plot(hist, title="hist")',
    ].join("\n")));
    expect(result.errors).toEqual([]);
    for (const title of ["m", "sig", "hist"]) {
      expect(plot(result, title), title).toBeDefined();
      expect(plot(result, title)!.values.some((v) => !Number.isNaN(v)), title).toBe(true);
    }
  });

  it("histogram equals macd minus signal", () => {
    const result = run(wrap([
      "[m, sig, hist] = ta.macd(close, 12, 26, 9)",
      'plot(m, title="m")',
      'plot(sig, title="sig")',
      'plot(hist, title="hist")',
    ].join("\n")));
    const m = plot(result, "m")!;
    const s = plot(result, "sig")!;
    const h = plot(result, "hist")!;
    const i = h.values.findIndex((v, idx) =>
      !Number.isNaN(v) && !Number.isNaN(m.values[idx]!) && !Number.isNaN(s.values[idx]!));
    expect(i).toBeGreaterThanOrEqual(0);
    expect(h.values[i]!).toBeCloseTo(m.values[i]! - s.values[i]!, 6);
  });

  it("binds ta.stoch as [k, d]", () => {
    // The signature is (source, high, low, length): the length is the FOURTH argument. This
    // test is what found that the runtime was reading `high` as the period, giving a
    // 2000-bar window that never filled and an all-NaN plot.
    const result = run(wrap([
      "[k, d] = ta.stoch(close, high, low, 14)",
      'plot(k, title="k")',
      'plot(d, title="d")',
    ].join("\n")));
    expect(result.errors).toEqual([]);
    const k = plot(result, "k")!;
    expect(k.values.some((v) => !Number.isNaN(v))).toBe(true);
    // a stochastic is a percentage: every real value must be within 0..100
    const nums = k.values.filter((v) => !Number.isNaN(v));
    expect(nums.every((v) => v >= 0 && v <= 100)).toBe(true);
  });

  it("works with := to reassign an existing name", () => {
    const result = run(wrap([
      "float mid = 0.0",
      "[m, u, l] = ta.bb(close, 20, 2)",
      "mid := m",
      'plot(mid, title="mid2")',
    ].join("\n")));
    expect(result.errors).toEqual([]);
    expect(plot(result, "mid2")!.values.some((v) => !Number.isNaN(v))).toBe(true);
  });

  it("binds NA rather than throwing when the right side is not a tuple", () => {
    const result = run(wrap([
      "[a, b] = ta.sma(close, 20)",
      'plot(a, title="a")',
    ].join("\n")));
    // a script bug must not abort the run
    expect(result.errors).toEqual([]);
  });

  it("rejects a non-name on the left side", () => {
    expect(() => parsePine(wrap("[a, 5] = ta.bb(close, 20, 2)")))
      .toThrow(/names/);
  });

  it("still plots the first value when a tuple is plotted directly", () => {
    // this shape worked before tuples existed; blanking it would break working scripts
    const result = run(wrap([
      "m = ta.bb(close, 20, 2)",
      'plot(m, title="mid")',
    ].join("\n")));
    expect(result.errors).toEqual([]);
    expect(plot(result, "mid")!.values.some((v) => !Number.isNaN(v))).toBe(true);
  });
});
