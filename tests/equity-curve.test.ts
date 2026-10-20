import { describe, it, expect } from "vitest";
import {
  summariseCurve, downsampleCurve, fromBacktestEquity, fromTrades, describeCurve,
  type CurvePoint,
} from "../src/core/equity-curve.js";

const pt = (time: number, equity: number): CurvePoint => ({ time, equity, balance: equity });

describe("summariseCurve", () => {
  it("is empty for an empty curve", () => {
    expect(summariseCurve([]).points).toBe(0);
  });

  it("has no drawdown on a monotonic rise", () => {
    const s = summariseCurve([pt(1, 100), pt(2, 200), pt(3, 300)]);
    expect(s.peak).toBe(300);
    expect(s.worstDrawdown).toBe(0);
    expect(s.losing).toBe(false);
  });

  it("measures drawdown against the running PEAK, not the start", () => {
    // 100 -> 300 -> 240: the drop is 60 from a peak of 300 = 20%
    const s = summariseCurve([pt(1, 100), pt(2, 300), pt(3, 240)]);
    expect(s.peak).toBe(300);
    expect(s.worstDrawdown).toBe(60);
    expect(s.worstDrawdownPercent).toBeCloseTo(20, 6);
  });

  it("understates nothing when the account is up overall", () => {
    // started at 100, ended at 500, but dropped 200 from a 700 peak = 28.6%
    // measuring from the start would have said 0
    const s = summariseCurve([pt(1, 100), pt(2, 700), pt(3, 500)]);
    expect(s.worstDrawdownPercent).toBeCloseTo((200 / 700) * 100, 6);
    expect(s.losing).toBe(false);
  });

  it("reports the current drawdown separately from the worst", () => {
    // worst was 50%, now recovered to -10%
    const s = summariseCurve([pt(1, 100), pt(2, 200), pt(3, 100), pt(4, 180)]);
    expect(s.worstDrawdownPercent).toBeCloseTo(50, 6);
    expect(s.currentDrawdownPercent).toBeCloseTo(10, 6);
  });

  it("flags a losing curve", () => {
    expect(summariseCurve([pt(1, 500), pt(2, 400)]).losing).toBe(true);
  });

  it("handles a zero peak without dividing by zero", () => {
    const s = summariseCurve([pt(1, 0), pt(2, 0)]);
    expect(Number.isFinite(s.worstDrawdownPercent)).toBe(true);
    expect(s.worstDrawdownPercent).toBe(0);
  });

  it("keeps the first and last timestamps", () => {
    const s = summariseCurve([pt(10, 100), pt(20, 200)]);
    expect(s.start).toBe(10);
    expect(s.end).toBe(20);
  });
});

describe("downsampleCurve", () => {
  it("returns the input unchanged when it fits", () => {
    const pts = [pt(1, 100), pt(2, 200)];
    expect(downsampleCurve(pts, 100)).toHaveLength(2);
  });

  it("reduces a large curve to roughly the cap", () => {
    const pts = Array.from({ length: 5000 }, (_, i) => pt(i, 1000 + i));
    const out = downsampleCurve(pts, 200);
    expect(out.length).toBeLessThanOrEqual(260);
    expect(out.length).toBeGreaterThan(50);
  });

  it("KEEPS a one-bar crash, which uniform sampling would hide", () => {
    // 1000 points flat, one bar at 500
    const pts = Array.from({ length: 1000 }, (_, i) => pt(i, i === 500 ? 500 : 1000));
    const out = downsampleCurve(pts, 50);
    const lowest = Math.min(...out.map((p) => p.equity));
    expect(lowest).toBe(500);
  });

  it("keeps a one-bar spike", () => {
    const pts = Array.from({ length: 1000 }, (_, i) => pt(i, i === 500 ? 2000 : 1000));
    const out = downsampleCurve(pts, 50);
    expect(Math.max(...out.map((p) => p.equity))).toBe(2000);
  });

  it("never goes backwards in time", () => {
    const pts = Array.from({ length: 900 }, (_, i) => pt(i, 1000 + Math.sin(i) * 100));
    const out = downsampleCurve(pts, 100);
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!.time).toBeGreaterThanOrEqual(out[i - 1]!.time);
    }
  });

  it("always keeps the first and last point", () => {
    const pts = Array.from({ length: 900 }, (_, i) => pt(i, 1000 + i));
    const out = downsampleCurve(pts, 100);
    expect(out[0]!.time).toBe(0);
    expect(out[out.length - 1]!.time).toBe(899);
  });
});

describe("fromBacktestEquity", () => {
  it("maps to the curve shape with balance equal to equity", () => {
    const out = fromBacktestEquity([{ time: 5, equity: 1234 }]);
    expect(out[0]).toEqual({ time: 5, equity: 1234, balance: 1234 });
  });
});

describe("fromTrades", () => {
  it("starts at the opening balance when there are no trades", () => {
    const out = fromTrades(10_000, []);
    expect(out).toHaveLength(1);
    expect(out[0]!.equity).toBe(10_000);
  });

  it("steps the balance by each trade's pnl", () => {
    const out = fromTrades(10_000, [
      { exitTime: 100, pnl: 100 },
      { exitTime: 200, pnl: -50 },
    ]);
    expect(out.map((p) => p.equity)).toEqual([10_000, 10_100, 10_050]);
  });

  it("sorts by exit time, so a chart is never out of order", () => {
    const out = fromTrades(1000, [
      { exitTime: 300, pnl: 10 },
      { exitTime: 100, pnl: 5 },
    ]);
    expect(out.map((p) => p.time)).toEqual([100, 100, 300]);
    expect(out[out.length - 1]!.equity).toBe(1015);
  });

  it("accumulates to the same total regardless of order", () => {
    const a = fromTrades(1000, [{ exitTime: 1, pnl: 5 }, { exitTime: 2, pnl: 10 }]);
    const b = fromTrades(1000, [{ exitTime: 2, pnl: 10 }, { exitTime: 1, pnl: 5 }]);
    expect(a[a.length - 1]!.equity).toBe(b[b.length - 1]!.equity);
  });
});

describe("describeCurve", () => {
  it("says so when there is nothing", () => {
    expect(describeCurve(summariseCurve([]))).toBe("no trades yet");
  });

  it("mentions the drawdown when there is one", () => {
    const s = summariseCurve([pt(1, 100), pt(2, 200), pt(3, 100)]);
    expect(describeCurve(s)).toContain("max DD");
    expect(describeCurve(s)).toContain("50.0%");
  });

  it("omits drawdown when there is none", () => {
    const s = summariseCurve([pt(1, 100), pt(2, 200)]);
    expect(describeCurve(s)).not.toContain("DD");
  });
});
