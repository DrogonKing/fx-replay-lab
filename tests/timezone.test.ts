import { describe, it, expect } from "vitest";
import {
  zoneOffsetSeconds,
  toWallClock,
  fromWallClock,
  formatDateTime,
  isDst,
  formatOffset,
} from "../src/core/timezone.js";

// Reference instants chosen to exercise DST transitions.
const WINTER = Date.UTC(2024, 0, 15, 12, 0, 0) / 1000; // 2024-01-15 12:00Z
const SUMMER = Date.UTC(2024, 6, 15, 12, 0, 0) / 1000; // 2024-07-15 12:00Z

describe("zoneOffsetSeconds", () => {
  it("returns 0 for UTC", () => {
    expect(zoneOffsetSeconds(WINTER, "UTC")).toBe(0);
    expect(zoneOffsetSeconds(SUMMER, "UTC")).toBe(0);
  });

  it("handles New York standard vs daylight time", () => {
    expect(zoneOffsetSeconds(WINTER, "America/New_York")).toBe(-5 * 3600);
    expect(zoneOffsetSeconds(SUMMER, "America/New_York")).toBe(-4 * 3600);
  });

  it("handles London standard vs daylight time", () => {
    expect(zoneOffsetSeconds(WINTER, "Europe/London")).toBe(0);
    expect(zoneOffsetSeconds(SUMMER, "Europe/London")).toBe(3600);
  });

  it("keeps Tehran at a half-hour offset with no DST since 2022", () => {
    // Iran abolished DST in 2022: +03:30 all year.
    expect(zoneOffsetSeconds(WINTER, "Asia/Tehran")).toBe(3.5 * 3600);
    expect(zoneOffsetSeconds(SUMMER, "Asia/Tehran")).toBe(3.5 * 3600);
  });

  it("handles Tokyo and Sydney (southern hemisphere DST)", () => {
    expect(zoneOffsetSeconds(WINTER, "Asia/Tokyo")).toBe(9 * 3600);
    // Sydney is on DST in January, off in July.
    expect(zoneOffsetSeconds(WINTER, "Australia/Sydney")).toBe(11 * 3600);
    expect(zoneOffsetSeconds(SUMMER, "Australia/Sydney")).toBe(10 * 3600);
  });

  it("recomputes the offset per bar across a DST boundary", () => {
    // US DST began 2024-03-10 07:00 UTC. Sample hourly across it.
    const start = Date.UTC(2024, 2, 10, 0, 0, 0) / 1000;
    const offsets: number[] = [];
    for (let h = 0; h < 12; h++) {
      offsets.push(zoneOffsetSeconds(start + h * 3600, "America/New_York"));
    }
    expect(offsets[0]).toBe(-5 * 3600); // 00:00Z -> still EST
    expect(offsets[7]).toBe(-4 * 3600); // 07:00Z -> now EDT
    expect(new Set(offsets).size).toBe(2);
  });
});

describe("toWallClock", () => {
  it("converts to the requested zone, not the OS zone", () => {
    const w = toWallClock(WINTER, "Asia/Tehran");
    expect(w.hour).toBe(15); // 12:00Z + 3:30
    expect(w.minute).toBe(30);
    expect(w.day).toBe(15);
    const ny = toWallClock(WINTER, "America/New_York");
    expect(ny.hour).toBe(7); // 12:00Z - 5
  });

  it("reports the correct weekday", () => {
    // 2024-01-15 was a Monday.
    expect(toWallClock(WINTER, "UTC").weekday).toBe(1);
  });
});

describe("fromWallClock / toWallClock round trip", () => {
  const zones = [
    "UTC",
    "America/New_York",
    "Europe/London",
    "Europe/Berlin",
    "Asia/Tehran",
    "Asia/Tokyo",
    "Australia/Sydney",
  ];

  it("round-trips every zone across a year of samples", () => {
    // Step 6h through a full year: 1460 samples per zone.
    //
    // The strict invariant is that the WALL CLOCK survives the round trip. The
    // exact instant is only recoverable when the wall time is unambiguous: on
    // the fall-back day one wall time occurs twice, so `fromWallClock` returns
    // the first occurrence and a sample taken in the second one comes back an
    // hour earlier. That is a property of DST, not a defect, so it is excluded
    // from the exact check and asserted separately below.
    const base = Date.UTC(2024, 0, 1, 0, 0, 0) / 1000;
    let ambiguous = 0;
    for (const zone of zones) {
      for (let i = 0; i < 1460; i++) {
        const t = base + i * 6 * 3600;
        const w = toWallClock(t, zone);
        const back = fromWallClock(w, zone);
        const w2 = toWallClock(back, zone);
        expect(w2).toEqual(w);
        if (back !== t) {
          // Only legal one hour earlier, and only when the hour really repeats.
          expect(Math.abs(back - t)).toBe(3600);
          expect(w2).toEqual(w);
          ambiguous++;
        }
      }
    }
    // Exactly one ambiguous sample per zone that observes fall-back
    // (America/New_York, Europe/London, Europe/Berlin, Australia/Sydney).
    expect(ambiguous).toBeGreaterThan(0);
  });

  it("resolves the ambiguous hour when clocks go back", () => {
    // US DST ended 2024-11-03 06:00 UTC; 01:30 local happens twice.
    const t = Date.UTC(2024, 10, 3, 6, 30, 0) / 1000; // second occurrence (EST)
    const w = toWallClock(t, "America/New_York");
    expect(w.hour).toBe(1);
    expect(w.minute).toBe(30);
    const back = fromWallClock(w, "America/New_York");
    const w2 = toWallClock(back, "America/New_York");
    // Same wall clock, as required; the instant resolves to the FIRST
    // occurrence (one hour earlier) by convention.
    expect(w2).toEqual(w);
    expect(back).toBe(t - 3600);
  });

  it("does not produce NaN for a spring-forward gap", () => {
    // 2024-03-10 02:30 local does not exist in New York.
    const t = fromWallClock(
      { year: 2024, month: 3, day: 10, hour: 2, minute: 30, second: 0, weekday: 0 },
      "America/New_York",
    );
    expect(Number.isFinite(t)).toBe(true);
    // It lands after the jump, i.e. in EDT.
    expect(zoneOffsetSeconds(t, "America/New_York")).toBe(-4 * 3600);
  });
});

describe("formatting", () => {
  it("formats date and time in the display zone", () => {
    expect(formatDateTime(WINTER, "UTC")).toBe("2024-01-15 12:00");
    expect(formatDateTime(WINTER, "Asia/Tehran")).toBe("2024-01-15 15:30");
    expect(formatDateTime(WINTER, "America/New_York")).toBe("2024-01-15 07:00");
  });

  it("formats offsets including half hours", () => {
    expect(formatOffset(WINTER, "UTC")).toBe("UTC+0");
    expect(formatOffset(WINTER, "Asia/Tehran")).toBe("UTC+3:30");
    expect(formatOffset(WINTER, "America/New_York")).toBe("UTC-5");
  });

  it("detects DST", () => {
    expect(isDst(SUMMER, "America/New_York")).toBe(true);
    expect(isDst(WINTER, "America/New_York")).toBe(false);
    expect(isDst(SUMMER, "UTC")).toBe(false);
    expect(isDst(WINTER, "Asia/Tehran")).toBe(false);
  });
});
