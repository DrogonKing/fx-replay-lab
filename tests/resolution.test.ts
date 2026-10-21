import { describe, it, expect } from "vitest";
import {
  detectSpacingSeconds, detectTimeframe, framesAtOrAbove, canAggregate, explainUnavailable,
} from "../src/core/resolution.js";
import type { CandleSeries, Timeframe } from "../src/core/types.js";

/** Build a series with a fixed bar spacing, optionally with gaps. */
function series(spacingSec: number, count: number, gapsEvery = 0): CandleSeries {
  const time = new Float64Array(count);
  let t = Date.UTC(2024, 0, 2) / 1000;
  for (let i = 0; i < count; i++) {
    time[i] = t;
    t += spacingSec;
    // a weekend-style gap keeps the MODE at the normal spacing
    if (gapsEvery > 0 && i > 0 && i % gapsEvery === 0) t += 2 * 86400;
  }
  const flat = new Float64Array(count).fill(1);
  return {
    time, open: flat, high: flat, low: flat, close: flat, volume: flat, length: count,
  };
}

const M1: Timeframe = { label: "M1", minutes: 1, kind: "minute" };
const M5: Timeframe = { label: "M5", minutes: 5, kind: "minute" };
const M15: Timeframe = { label: "M15", minutes: 15, kind: "minute" };
const H1: Timeframe = { label: "H1", minutes: 60, kind: "minute" };
const D1: Timeframe = { label: "D1", minutes: 0, kind: "day" };
const W1: Timeframe = { label: "W1", minutes: 0, kind: "week" };

describe("detectSpacingSeconds", () => {
  it("finds a 1-minute spacing", () => {
    expect(detectSpacingSeconds(series(60, 500))).toBe(60);
  });

  it("finds a 5-minute spacing", () => {
    expect(detectSpacingSeconds(series(300, 500))).toBe(300);
  });

  it("finds an hourly spacing", () => {
    expect(detectSpacingSeconds(series(3600, 200))).toBe(3600);
  });

  it("uses the MODE, so weekend gaps do not drag it up", () => {
    // an average would be way above 60 here
    expect(detectSpacingSeconds(series(60, 2000, 100))).toBe(60);
  });

  it("returns null when there are too few bars to tell", () => {
    expect(detectSpacingSeconds(series(60, 2))).toBeNull();
  });

  it("returns null for an empty series", () => {
    expect(detectSpacingSeconds(series(60, 0))).toBeNull();
  });

  it("stays correct on a huge series, because it samples", () => {
    expect(detectSpacingSeconds(series(300, 40_000))).toBe(300);
  });

  it("ignores duplicate timestamps", () => {
    const s = series(60, 100);
    s.time[50] = s.time[49]!; // a duplicate must not become the mode
    expect(detectSpacingSeconds(s)).toBe(60);
  });
});

describe("detectTimeframe", () => {
  it("maps a spacing to a preset frame", () => {
    expect(detectTimeframe(series(60, 500))?.label).toBe("M1");
    expect(detectTimeframe(series(300, 500))?.label).toBe("M5");
    expect(detectTimeframe(series(900, 500))?.label).toBe("M15");
    expect(detectTimeframe(series(3600, 500))?.label).toBe("H1");
  });

  it("recognises daily and weekly", () => {
    expect(detectTimeframe(series(86400, 100))?.kind).toBe("day");
    expect(detectTimeframe(series(7 * 86400, 50))?.kind).toBe("week");
  });

  it("returns a real frame for an unusual spacing, not null", () => {
    const tf = detectTimeframe(series(7 * 60, 500));
    expect(tf?.minutes).toBe(7);
    expect(tf?.label).toBe("7m");
  });

  it("returns null when it cannot tell", () => {
    expect(detectTimeframe(series(60, 2))).toBeNull();
  });
});

describe("canAggregate", () => {
  it("allows a higher frame", () => {
    expect(canAggregate(M1, M5)).toBe(true);
    expect(canAggregate(M5, H1)).toBe(true);
    expect(canAggregate(M1, D1)).toBe(true);
  });

  it("allows the same frame", () => {
    expect(canAggregate(M5, M5)).toBe(true);
  });

  it("REFUSES a lower frame, which would be a lie", () => {
    // 5m bars cannot become 1m bars
    expect(canAggregate(M5, M1)).toBe(false);
    expect(canAggregate(H1, M5)).toBe(false);
  });

  it("refuses a minute frame from a daily base", () => {
    expect(canAggregate(D1, M5)).toBe(false);
  });

  it("allows week from day", () => {
    expect(canAggregate(D1, W1)).toBe(true);
  });

  it("allows a custom 7m base to build 15m", () => {
    expect(canAggregate({ label: "7m", minutes: 7, kind: "minute" }, M15)).toBe(true);
  });

  it("refuses 7m from 15m", () => {
    expect(canAggregate(M15, { label: "7m", minutes: 7, kind: "minute" })).toBe(false);
  });
});

describe("framesAtOrAbove", () => {
  it("drops frames below the base", () => {
    const frames = framesAtOrAbove(M15).map((f) => f.label);
    expect(frames).not.toContain("M1");
    expect(frames).not.toContain("M5");
    expect(frames).toContain("M15");
    expect(frames).toContain("H1");
    expect(frames).toContain("D1");
  });

  it("keeps everything for a 1-minute base", () => {
    expect(framesAtOrAbove(M1).map((f) => f.label)).toEqual(
      ["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1"],
    );
  });

  it("INCLUDES a custom base that is not a preset", () => {
    const custom: Timeframe = { label: "7m", minutes: 7, kind: "minute" };
    const frames = framesAtOrAbove(custom).map((f) => f.label);
    expect(frames).toContain("7m");
    expect(frames).toContain("M15");
  });

  it("only offers day and week for a daily base", () => {
    expect(framesAtOrAbove(D1).map((f) => f.label)).toEqual(["D1", "W1"]);
  });

  it("offers the presets when the base is unknown", () => {
    expect(framesAtOrAbove(null)).toHaveLength(8);
  });
});

describe("explainUnavailable", () => {
  it("names the base and the requirement", () => {
    const msg = explainUnavailable(M5, M1);
    expect(msg).toContain("M1");
    expect(msg).toContain("M5");
  });

  it("says to load data when the base is unknown", () => {
    expect(explainUnavailable(null, M1)).toContain("load some data");
  });
});
