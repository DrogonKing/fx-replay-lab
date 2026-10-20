import { describe, it, expect } from "vitest";
import { parsePine } from "../src/core/pine/parser.js";
import { runPine } from "../src/core/pine/runtime.js";
import { seriesFromCandles } from "../src/core/series.js";
import { sma, rsi, ema } from "../src/core/indicators.js";
import type { Candle, CandleSeries } from "../src/core/types.js";

function series(closes: number[]): CandleSeries {
  return seriesFromCandles(closes.map((c, i) => ({
    time: 1_700_000_000 + i * 60,
    open: i > 0 ? closes[i - 1]! : c,
    high: c + 1,
    low: c - 1,
    close: c,
    volume: 100 + i,
  })) as Candle[]);
}

function run(src: string, closes: number[], opts?: { maxLoopIterations?: number }) {
  const program = parsePine(src);
  return { program, result: runPine(series(closes), program, opts) };
}

const RISING = Array.from({ length: 60 }, (_, i) => 100 + i);
const ZIGZAG = Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i / 5) * 10);

describe("classic scripts run without errors", () => {
  it("a SMA plot matches the core indicator exactly", () => {
    const src = [
      "//@version=5",
      'indicator("SMA test", overlay=true)',
      "m = ta.sma(close, 20)",
      'plot(m, title="MA")',
    ].join("\n");
    const { result } = run(src, RISING);
    expect(result.errors).toEqual([]);
    const plot = result.plots.find((p) => p.title === "MA")!;
    expect(plot).toBeDefined();
    const expected = sma(series(RISING).close, 20);
    for (let i = 20; i < RISING.length; i++) {
      expect(plot.values[i]!).toBeCloseTo(expected[i]!, 9);
    }
  });

  it("an RSI script reproduces the core RSI", () => {
    const src = [
      "//@version=5",
      'indicator("RSI", overlay=false)',
      "r = ta.rsi(close, 14)",
      'plot(r, title="RSI")',
    ].join("\n");
    const { result } = run(src, ZIGZAG);
    expect(result.errors).toEqual([]);
    const plot = result.plots[0]!;
    const expected = rsi(series(ZIGZAG), 14);
    for (let i = 20; i < ZIGZAG.length; i++) {
      expect(plot.values[i]!).toBeCloseTo(expected[i]!, 9);
    }
  });

  it("an EMA crossover script produces shapes on crossings", () => {
    const src = [
      "//@version=5",
      'indicator("Cross", overlay=true)',
      "f = ta.ema(close, 5)",
      "s = ta.ema(close, 20)",
      "up = ta.crossover(f, s)",
      'plotshape(up, title="Up", style=shape.triangleup, text="BUY")',
      'plot(f, title="fast")',
      "plot(s, title=\"slow\")",
    ].join("\n");
    const { result } = run(src, ZIGZAG);
    expect(result.errors).toEqual([]);
    expect(result.shapes.length).toBeGreaterThan(0);
    expect(result.shapes.filter((s) => s.text === "BUY").length).toBeGreaterThan(0);
  });

  it("a Bollinger script runs", () => {
    const src = [
      "//@version=5",
      'indicator("BB", overlay=true)',
      "m = ta.bb(close, 20, 2)",
      'plot(m, title="mid")',
    ].join("\n");
    const { result } = run(src, ZIGZAG);
    expect(result.errors).toEqual([]);
    expect(result.plots[0]!.values.some((v) => !Number.isNaN(v))).toBe(true);
  });

  it("a Supertrend-style script with var state runs", () => {
    const src = [
      "//@version=5",
      'indicator("ST", overlay=true)',
      "var float trend = na",
      "a = ta.atr(10)",
      "up = close > ta.sma(close, 20)",
      "trend := up ? close - a : close + a",
      'plot(trend, title="trend")',
    ].join("\n");
    const { result } = run(src, ZIGZAG);
    expect(result.errors).toEqual([]);
    expect(result.plots[0]!.values.some((v) => !Number.isNaN(v))).toBe(true);
  });
});

describe("series semantics", () => {
  it("the history operator [] reads previous bar values", () => {
    const src = [
      "//@version=5",
      'indicator("hist", overlay=false)',
      "c = close",
      "prev = c[1]",
      'plot(prev, title="prev")',
    ].join("\n");
    const { result } = run(src, RISING);
    expect(result.errors).toEqual([]);
    const plot = result.plots[0]!;
    // bar 5's prev must equal bar 4's close
    expect(plot.values[5]!).toBeCloseTo(RISING[4]!, 9);
  });

  it("var persists across bars", () => {
    const src = [
      "//@version=5",
      'indicator("counter", overlay=false)',
      "var count = 0",
      "count := count + 1",
      'plot(count, title="n")',
    ].join("\n");
    const { result } = run(src, RISING.slice(0, 10));
    expect(result.errors).toEqual([]);
    const plot = result.plots[0]!;
    // counter must accumulate, ending at 10
    expect(plot.values[9]!).toBe(10);
  });
});

describe("control flow", () => {
  it("if / else if / else picks the right branch", () => {
    const src = [
      "//@version=5",
      'indicator("branches", overlay=false)',
      "v = 0",
      "if close > open",
      "    v := 1",
      "else if close < open",
      "    v := -1",
      "else",
      "    v := 0",
      'plot(v, title="dir")',
    ].join("\n");
    const { result } = run(src, RISING);
    expect(result.errors).toEqual([]);
    expect(result.plots[0]!.values[5]!).toBe(1);
  });

  it("for loops accumulate", () => {
    const src = [
      "//@version=5",
      'indicator("f", overlay=false)',
      "total = 0",
      "for i = 1 to 4",
      "    total := total + i",
      'plot(total, title="sum")',
    ].join("\n");
    const { result } = run(src, RISING.slice(0, 5));
    expect(result.errors).toEqual([]);
    expect(result.plots[0]!.values[4]!).toBe(10);
  });

  it("a runaway while loop is stopped, not left hanging", () => {
    const src = [
      "//@version@version=5".replace("//@version@version=5", "//@version=5"),
      'indicator("bad", overlay=false)',
      "x = 0",
      "while x >= 0",
      "    x := x + 1",
      'plot(x, title="x")',
    ].join("\n");
    const { result } = run(src, RISING.slice(0, 3), { maxLoopIterations: 100 });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatch(/while loop exceeded/);
  });

  it("switch with comparison arms selects by subject", () => {
    const src = [
      "//@version=5",
      'indicator("sw", overlay=false)',
      "v = switch close",
      "    > 115 => 2",
      "    > 105 => 1",
      "    => 0",
      'plot(v, title="bucket")',
    ].join("\n");
    const { result } = run(src, RISING);
    expect(result.errors).toEqual([]);
    const plot = result.plots[0]!;
    expect(plot.values[3]!).toBe(0);    // 103
    expect(plot.values[8]!).toBe(1);    // 108
    expect(plot.values[20]!).toBe(2);   // 120
  });

  it("user functions are callable and pure", () => {
    const src = [
      "//@version=5",
      'indicator("fn", overlay=false)',
      "double(x) =>",
      "    x * 2",
      "v = double(close)",
      'plot(v, title="dbl")',
    ].join("\n");
    const { result } = run(src, RISING.slice(0, 5));
    expect(result.errors).toEqual([]);
    expect(result.plots[0]!.values[2]!).toBeCloseTo(RISING[2]! * 2, 9);
  });
});

describe("strategy execution", () => {
  it("emits entry and exit orders", () => {
    const src = [
      "//@version=5",
      'strategy("s", overlay=true)',
      "f = ta.ema(close, 5)",
      "s = ta.ema(close, 20)",
      "if ta.crossover(f, s)",
      '    strategy.entry("long", strategy.long)',
      "if ta.crossunder(f, s)",
      '    strategy.close("long")',
    ].join("\n");
    const { result } = run(src, ZIGZAG);
    expect(result.errors).toEqual([]);
    expect(result.orders.filter((o) => o.action === "entry").length).toBeGreaterThan(0);
    expect(result.orders.filter((o) => o.action === "close").length).toBeGreaterThan(0);
    expect(result.orders[0]!.direction).toBe("long");
  });
});

describe("error reporting", () => {
  it("reports an unsupported function precisely instead of ignoring it", () => {
    const src = [
      "//@version=5",
      'indicator("bad", overlay=false)',
      "v = ta.notARealThing(close, 14)",
      'plot(v, title="x")',
    ].join("\n");
    const { result } = run(src, RISING.slice(0, 5));
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatch(/unsupported ta\.notARealThing/);
  });

  it("caps stored errors so a broken script does not flood", () => {
    const src = [
      "//@version=5",
      'indicator("bad", overlay=false)',
      "v = ta.nope(close, 1)",
      "plot(v)",
    ].join("\n");
    const { result } = run(src, RISING);
    expect(result.errors.length).toBeLessThanOrEqual(20);
  });

  it("declares inputs so the UI can build a settings dialog", () => {
    const src = [
      "//@version=5",
      'indicator("in", overlay=false)',
      'len = input.int(14, title="Length")',
      "r = ta.rsi(close, len)",
      'plot(r, title="RSI")',
    ].join("\n");
    const { result } = run(src, ZIGZAG);
    expect(result.errors).toEqual([]);
    expect(result.inputs).toHaveLength(1);
    expect(result.inputs[0]!.title).toBe("Length");
    expect(result.inputs[0]!.defval).toBe(14);
  });
});

describe("no look-ahead", () => {
  it("ta.* at bar i only uses data up to bar i", () => {
    // Truncate the series and confirm the value at bar 30 is identical, which
    // proves the indicator is not peeking at later bars.
    const full = series(ZIGZAG);
    const cut = series(ZIGZAG.slice(0, 31));
    const src = [
      "//@version=5",
      'indicator("x", overlay=false)',
      "v = ta.sma(close, 10)",
      'plot(v, title="m")',
    ].join("\n");

    const program = parsePine(src);
    const a = runPine(full, program);
    const b = runPine(cut, program);
    expect(a.plots[0]!.values[30]!).toBeCloseTo(b.plots[0]!.values[30]!, 12);
  });
});
