import { describe, it, expect } from "vitest";
import {
  INTRADAY_LIMIT_DAYS, availability, effectiveFrom, mergeBars, newBarIndices,
  parseModeState, DEFAULT_MODE_STATE, shouldAdvanceAccount, describeMode,
  selectableYears, mergeSeries,
} from "../src/core/session-mode.js";
import type { Candle } from "../src/core/types.js";

const NOW = Date.UTC(2026, 9, 21, 12) / 1000;
const day = 86400;
const bar = (time: number, close = 100): Candle =>
  ({ time, open: close, high: close, low: close, close, volume: 1 });

describe("INTRADAY_LIMIT_DAYS", () => {
  it("reflects the real provider limits, not preferences", () => {
    expect(INTRADAY_LIMIT_DAYS[1]).toBe(7);
    expect(INTRADAY_LIMIT_DAYS[5]).toBe(60);
    expect(INTRADAY_LIMIT_DAYS[60]).toBe(730);
  });

  it("gives daily data a long history", () => {
    expect(INTRADAY_LIMIT_DAYS[1440]!).toBeGreaterThan(10000);
  });
});

describe("availability", () => {
  it("is ok inside the window", () => {
    const a = availability(5, NOW - 30 * day, NOW);
    expect(a.verdict).toBe("ok");
    expect(a.clampedFrom).toBeUndefined();
  });

  it("is ok exactly at the boundary", () => {
    expect(availability(5, NOW - 60 * day, NOW).verdict).toBe("ok");
  });

  it("CLAMPS 5-minute data requested from 2019", () => {
    // this is the case that used to look like a broken download
    const a = availability(5, Date.UTC(2019, 0, 1) / 1000, NOW);
    expect(a.verdict).toBe("clamped");
    expect(a.clampedFrom).toBe(NOW - 60 * day);
    expect(a.message).toContain("60 days");
  });

  it("names the date the replay will actually start", () => {
    const a = availability(5, Date.UTC(2019, 0, 1) / 1000, NOW);
    expect(a.message).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("says a file is needed when the interval keeps almost nothing", () => {
    // 1-minute data keeps 7 days, so a 2019 request has nothing left to clamp to
    const a = availability(1, Date.UTC(2019, 0, 1) / 1000, NOW);
    expect(a.verdict).toBe("needs-file");
  });

  it("rejects an interval the provider does not offer", () => {
    const a = availability(7, NOW - day, NOW);
    expect(a.verdict).toBe("unsupported-interval");
    expect(a.message).toContain("7-minute");
  });

  it("serves daily data back to 2019", () => {
    expect(availability(1440, Date.UTC(2019, 0, 1) / 1000, NOW).verdict).toBe("ok");
  });

  it("serves hourly data back two years but not five", () => {
    expect(availability(60, NOW - 700 * day, NOW).verdict).toBe("ok");
    expect(availability(60, NOW - 900 * day, NOW).verdict).toBe("clamped");
  });

  it("does not claim clamped when nothing survives", () => {
    // clamping to a date in the future would be worse than refusing
    const a = availability(5, NOW - 100 * day, NOW);
    expect(a.verdict).toBe("clamped");
    expect(a.clampedFrom!).toBeLessThan(NOW);
  });
});

describe("effectiveFrom", () => {
  it("returns the request when nothing is clamped", () => {
    const a = availability(5, NOW - 10 * day, NOW);
    expect(effectiveFrom(NOW - 10 * day, a)).toBe(NOW - 10 * day);
  });

  it("returns the clamp when clamped", () => {
    const req = Date.UTC(2019, 0, 1) / 1000;
    const a = availability(5, req, NOW);
    expect(effectiveFrom(req, a)).toBe(a.clampedFrom);
  });

  it("never moves the request forward when it is already newer than the clamp", () => {
    const req = NOW - 5 * day;
    const a = { verdict: "clamped" as const, clampedFrom: NOW - 60 * day, limitDays: 60, message: "" };
    expect(effectiveFrom(req, a)).toBe(req);
  });
});

describe("mergeBars", () => {
  it("takes the incoming series when nothing is held", () => {
    expect(mergeBars([], [bar(1), bar(2)])).toHaveLength(2);
  });

  it("keeps what is held when nothing arrives", () => {
    expect(mergeBars([bar(1)], [])).toHaveLength(1);
  });

  it("appends genuinely new bars", () => {
    const out = mergeBars([bar(1), bar(2)], [bar(2), bar(3)]);
    expect(out.map((b) => b.time)).toEqual([1, 2, 3]);
  });

  it("REPLACES the forming bar instead of appending it", () => {
    // the last bar of a live feed is still forming; its close changes every poll
    const out = mergeBars([bar(1, 100)], [bar(1, 105)]);
    expect(out).toHaveLength(1);
    expect(out[0]!.close).toBe(105);
  });

  it("does not duplicate the overlap on a repeated poll", () => {
    // duplicating would make the account process the same bar twice: double commission and
    // double swap
    const held = [bar(1), bar(2), bar(3)];
    const polled = [bar(2), bar(3)];
    expect(mergeBars(held, polled)).toHaveLength(3);
  });

  it("does not let a poll rewrite older bars", () => {
    const out = mergeBars([bar(1, 100), bar(2, 100)], [bar(1, 999)]);
    expect(out[0]!.close).toBe(100);
  });

  it("is idempotent", () => {
    const held = [bar(1), bar(2)];
    const once = mergeBars(held, [bar(2), bar(3)]);
    const twice = mergeBars(once, [bar(2), bar(3)]);
    expect(twice.map((b) => b.time)).toEqual(once.map((b) => b.time));
  });
});

describe("mergeSeries", () => {
  const series = (
    times: number[], closes: number[] = times.map(() => 100),
  ): { time: Float64Array; open: Float64Array; high: Float64Array; low: Float64Array;
       close: Float64Array; volume: Float64Array } => ({
    time: Float64Array.from(times),
    open: Float64Array.from(closes),
    high: Float64Array.from(closes),
    low: Float64Array.from(closes),
    close: Float64Array.from(closes),
    volume: Float64Array.from(times.map(() => 1)),
  });

  it("takes the incoming series when nothing is held", () => {
    const out = mergeSeries(series([]), series([1, 2]));
    expect(Array.from(out.time)).toEqual([1, 2]);
  });

  it("keeps what is held when nothing arrives", () => {
    const held = series([1, 2]);
    expect(mergeSeries(held, series([]))).toBe(held);
  });

  it("appends genuinely new bars", () => {
    const out = mergeSeries(series([1, 2]), series([2, 3]));
    expect(Array.from(out.time)).toEqual([1, 2, 3]);
  });

  it("REPLACES the forming bar, in every field", () => {
    // a forming bar's close changes with each poll; appending would duplicate it and the
    // account would process the same bar twice
    const out = mergeSeries(series([1], [100]), series([1], [105]));
    expect(out.time.length).toBe(1);
    expect(out.close[0]).toBe(105);
    expect(out.open[0]).toBe(105);
    expect(out.high[0]).toBe(105);
    expect(out.low[0]).toBe(105);
  });

  it("does not duplicate the overlap", () => {
    const out = mergeSeries(series([1, 2, 3]), series([2, 3]));
    expect(out.time.length).toBe(3);
  });

  it("does not let a poll rewrite older bars", () => {
    const out = mergeSeries(series([1, 2], [100, 100]), series([1], [999]));
    expect(out.close[0]).toBe(100);
  });

  it("returns typed arrays, not plain arrays", () => {
    // the chart and the account index these directly
    const out = mergeSeries(series([1]), series([2]));
    expect(out.time).toBeInstanceOf(Float64Array);
    expect(out.close).toBeInstanceOf(Float64Array);
  });

  it("is idempotent", () => {
    const once = mergeSeries(series([1, 2]), series([2, 3]));
    const twice = mergeSeries(once, series([2, 3]));
    expect(Array.from(twice.time)).toEqual(Array.from(once.time));
  });

  it("KEEPS the series length field", () => {
    // CandleSeries carries a `length` alongside its arrays. Omitting it made `merged.length`
    // undefined and crashed the renderer with "cannot read properties of undefined".
    const out = mergeSeries({ ...series([1, 2]), length: 2 }, series([2, 3]));
    expect(out.length).toBe(3);
  });

  it("sets length on the first load too", () => {
    const out = mergeSeries({ ...series([]), length: 0 }, series([1, 2, 3]));
    expect(out.length).toBe(3);
  });

  it("keeps all six fields the same length", () => {
    const out = mergeSeries(series([1]), series([1, 2, 3]));
    for (const f of [out.time, out.open, out.high, out.low, out.close, out.volume]) {
      expect(f.length).toBe(out.time.length);
    }
  });
});

describe("newBarIndices", () => {
  it("lists only the indices past what was already processed", () => {
    expect(newBarIndices(3, 6)).toEqual([3, 4, 5]);
  });

  it("is empty when nothing new arrived", () => {
    expect(newBarIndices(6, 6)).toEqual([]);
  });

  it("is empty when the count went backwards", () => {
    expect(newBarIndices(9, 4)).toEqual([]);
  });

  it("starts at zero for the first load", () => {
    expect(newBarIndices(0, 2)).toEqual([0, 1]);
  });
});

describe("parseModeState", () => {
  it("defaults to replay", () => {
    expect(parseModeState(null).mode).toBe("replay");
  });

  it("accepts live", () => {
    expect(parseModeState({ mode: "live" }).mode).toBe("live");
  });

  it("rejects an unknown mode rather than trusting it", () => {
    expect(parseModeState({ mode: "casino" }).mode).toBe("replay");
  });

  it("clamps the poll interval to a sane range", () => {
    expect(parseModeState({ pollSeconds: 1 }).pollSeconds).toBe(DEFAULT_MODE_STATE.pollSeconds);
    expect(parseModeState({ pollSeconds: 9999 }).pollSeconds).toBe(DEFAULT_MODE_STATE.pollSeconds);
    expect(parseModeState({ pollSeconds: 30 }).pollSeconds).toBe(30);
  });

  it("clamps the replay speed", () => {
    expect(parseModeState({ replaySpeed: 0 }).replaySpeed).toBe(DEFAULT_MODE_STATE.replaySpeed);
    expect(parseModeState({ replaySpeed: 8 }).replaySpeed).toBe(8);
  });
});

describe("shouldAdvanceAccount", () => {
  it("advances when a newer bar arrived", () => {
    expect(shouldAdvanceAccount(100, 200, 1)).toBe(true);
  });

  it("does NOT advance for a still-forming bar", () => {
    // filling on a forming bar fills at prices that never existed, and re-charges commission
    expect(shouldAdvanceAccount(200, 200, 0)).toBe(false);
  });

  it("does not advance when nothing arrived", () => {
    expect(shouldAdvanceAccount(100, 300, 0)).toBe(false);
  });
});

describe("describeMode", () => {
  it("says orders fill on closed bars in live mode", () => {
    // the honest limitation, stated where the user can see it
    expect(describeMode("live")).toContain("closed bars");
  });

  it("describes replay", () => {
    expect(describeMode("replay")).toContain("replay");
  });
});

describe("selectableYears", () => {
  it("never offers a year the provider will refuse", () => {
    // this is the fix for "I picked 2019 and nothing loaded"
    const years = selectableYears(5, NOW);
    expect(years).not.toContain(2019);
    expect(years[0]).toBe(2026);
  });

  it("offers a long range for daily data", () => {
    const years = selectableYears(1440, NOW);
    expect(years.length).toBeGreaterThan(20);
    expect(years).toContain(2019);
  });

  it("offers only the current year for 1-minute data", () => {
    expect(selectableYears(1, NOW)).toEqual([2026]);
  });

  it("is newest first", () => {
    const y = selectableYears(60, NOW);
    expect(y[0]).toBeGreaterThan(y[y.length - 1]!);
  });

  it("has no gaps", () => {
    const y = selectableYears(60, NOW);
    for (let i = 1; i < y.length; i++) expect(y[i]!).toBe(y[i - 1]! - 1);
  });
});
