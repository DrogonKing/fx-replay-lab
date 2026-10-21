import { describe, it, expect } from "vitest";
import { finestFor, INTRADAY_LIMIT_DAYS } from "../src/core/session-mode.js";

const now = Date.UTC(2026, 9, 21) / 1000;
const daysAgo = (d: number): number => now - d * 86400;

describe("finestFor", () => {
  it("picks 1m for a window inside 1m retention (7 days)", () => {
    expect(finestFor(daysAgo(3), now)).toBe(1);
    expect(finestFor(daysAgo(7), now)).toBe(1);
  });

  it("picks 5m once 1m can no longer cover it", () => {
    // 8 days is past 1m's 7-day retention, inside 5m's 60
    expect(finestFor(daysAgo(8), now)).toBe(5);
    expect(finestFor(daysAgo(60), now)).toBe(5);
  });

  it("picks 1H for a window past 60 days", () => {
    expect(finestFor(daysAgo(61), now)).toBe(60);
    expect(finestFor(daysAgo(365), now)).toBe(60);
  });

  it("picks daily when nothing intraday covers it", () => {
    // 1H covers 730 days; three years does not fit
    expect(finestFor(daysAgo(800), now)).toBe(1440);
  });

  it("picks the FINEST, not merely an adequate one", () => {
    // several intervals could cover 30 days; 5m is the finest of them, so 5m wins over 15m
    const r = finestFor(daysAgo(30), now);
    expect(r).toBe(5);
    expect(r).toBeLessThan(15);
  });

  it("never returns an interval whose own limit is shorter than the window", () => {
    for (const windowDays of [1, 5, 10, 30, 90, 400, 900, 5000]) {
      const minutes = finestFor(daysAgo(windowDays), now);
      const limit = INTRADAY_LIMIT_DAYS[minutes];
      expect(limit, `${minutes}m cannot cover ${windowDays} days`).toBeDefined();
      expect(limit!).toBeGreaterThanOrEqual(windowDays);
    }
  });

  it("handles a window of zero or a future date without dividing by zero", () => {
    expect(finestFor(now, now)).toBe(1);
    expect(finestFor(now + 86400, now)).toBe(1);
  });
});
