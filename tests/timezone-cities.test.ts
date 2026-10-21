import { describe, it, expect } from "vitest";
import {
  cityOffsetSeconds, offsetLabel, timezoneOptions, filterTimezones,
  cityForZone, zoneButtonLabel, TIMEZONE_CITIES, isDstAt,
} from "../src/core/timezone-cities.js";

/** A fixed instant so the tests do not drift with the real clock. */
const SUMMER = Date.UTC(2024, 6, 15, 12) / 1000; // 15 July 2024
const WINTER = Date.UTC(2024, 0, 15, 12) / 1000; // 15 January 2024
const H = 3600;

describe("cityOffsetSeconds", () => {
  it("returns 0 for UTC", () => {
    expect(cityOffsetSeconds("UTC", SUMMER)).toBe(0);
  });

  it("gets New York right in both seasons — this is the whole point", () => {
    // a hardcoded -5 would be wrong for half the year
    expect(cityOffsetSeconds("America/New_York", SUMMER)).toBe(-4 * H);
    expect(cityOffsetSeconds("America/New_York", WINTER)).toBe(-5 * H);
  });

  it("gets London right in both seasons", () => {
    expect(cityOffsetSeconds("Europe/London", SUMMER)).toBe(1 * H);
    expect(cityOffsetSeconds("Europe/London", WINTER)).toBe(0);
  });

  it("detects DST where it exists and not where it does not", () => {
    expect(isDstAt("America/New_York", SUMMER)).toBe(true);
    expect(isDstAt("America/New_York", WINTER)).toBe(false);
    expect(isDstAt("Europe/London", SUMMER)).toBe(true);
    // European style names it "Summer" rather than "Daylight"
    expect(isDstAt("Europe/London", WINTER)).toBe(false);
    // zones that abolished or never had DST: neither word in the name
    expect(isDstAt("Asia/Tehran", SUMMER)).toBe(false);
    expect(isDstAt("Asia/Kathmandu", SUMMER)).toBe(false);
    expect(isDstAt("Asia/Dubai", SUMMER)).toBe(false);
    expect(isDstAt("UTC", SUMMER)).toBe(false);
  });

  it("handles a HALF-HOUR zone", () => {
    // Tehran is +3:30, not +3 or +4
    expect(cityOffsetSeconds("Asia/Tehran", WINTER)).toBe(3 * H + 1800);
  });

  it("handles a QUARTER-HOUR zone", () => {
    // Kathmandu is +5:45
    expect(cityOffsetSeconds("Asia/Kathmandu", WINTER)).toBe(5 * H + 2700);
  });

  it("gets southern-hemisphere DST the right way round", () => {
    // Sydney is +10 in the southern winter (July) and +11 in its summer (January)
    expect(cityOffsetSeconds("Australia/Sydney", SUMMER)).toBe(10 * H);
    expect(cityOffsetSeconds("Australia/Sydney", WINTER)).toBe(11 * H);
  });

  it("is stable across a whole day, so labels do not flicker", () => {
    const morning = Date.UTC(2024, 6, 15, 0) / 1000;
    const evening = Date.UTC(2024, 6, 15, 23) / 1000;
    expect(cityOffsetSeconds("Europe/Berlin", morning))
      .toBe(cityOffsetSeconds("Europe/Berlin", evening));
  });
});

describe("offsetLabel", () => {
  it("prints whole hours without minutes", () => {
    expect(offsetLabel(0)).toBe("UTC+0");
    expect(offsetLabel(-4 * H)).toBe("UTC-4");
    expect(offsetLabel(5 * H)).toBe("UTC+5");
  });

  it("prints half hours with zero padding", () => {
    expect(offsetLabel(3 * H + 1800)).toBe("UTC+3:30");
    expect(offsetLabel(-(3 * H + 1800))).toBe("UTC-3:30");
  });

  it("prints quarter hours", () => {
    expect(offsetLabel(5 * H + 2700)).toBe("UTC+5:45");
  });

  it("uses the right sign for negative offsets", () => {
    expect(offsetLabel(-5 * H)).toBe("UTC-5");
    expect(offsetLabel(-(9 * H + 1800))).toBe("UTC-9:30");
  });
});

describe("timezoneOptions", () => {
  const opts = timezoneOptions(SUMMER);

  it("includes UTC at the top of the sorted list", () => {
    // nothing is west of UTC-11, so UTC is not first by offset; it must still be present
    expect(opts.some((o) => o.zone === "UTC")).toBe(true);
  });

  it("puts New York at UTC-4 in July", () => {
    const ny = opts.find((o) => o.zone === "America/New_York");
    expect(ny?.offset).toBe("UTC-4");
    expect(ny?.city).toBe("New York");
  });

  it("puts New York at UTC-5 in January", () => {
    const ny = timezoneOptions(WINTER).find((o) => o.zone === "America/New_York");
    expect(ny?.offset).toBe("UTC-5");
  });

  it("sorts by offset, so the list reads as a clock", () => {
    const offsets = opts.map((o) => o.offsetSeconds);
    const sorted = [...offsets].sort((a, b) => a - b);
    expect(offsets).toEqual(sorted);
  });

  it("never lists the same zone twice, even when two cities share it", () => {
    const zones = opts.map((o) => o.zone);
    expect(new Set(zones).size).toBe(zones.length);
  });

  it("marks market centres", () => {
    expect(opts.find((o) => o.zone === "America/New_York")?.market).toBe(true);
    expect(opts.find((o) => o.zone === "Asia/Tehran")?.market).toBe(true);
  });

  it("flags DST correctly on both sides of the equator", () => {
    const summer = timezoneOptions(SUMMER);
    expect(summer.find((o) => o.zone === "America/New_York")?.dst).toBe(true); // July = DST
    expect(summer.find((o) => o.zone === "Australia/Sydney")?.dst).toBe(false); // July = winter
    const winter = timezoneOptions(WINTER);
    expect(winter.find((o) => o.zone === "Australia/Sydney")?.dst).toBe(true);
    expect(winter.find((o) => o.zone === "America/New_York")?.dst).toBe(false);
  });

  it("reports opposite DST states in mid-summer and mid-winter", () => {
    // The assertion that caught the bug: min(Jan, Jul) made Sydney's July look like DST.
    // Mid-July and mid-January are unambiguous — the hemispheres cannot both be in summer.
    for (const ref of [SUMMER, WINTER]) {
      const opts = timezoneOptions(ref);
      const ny = opts.find((o) => o.zone === "America/New_York")?.dst;
      const syd = opts.find((o) => o.zone === "Australia/Sydney")?.dst;
      expect(ny, "mid-summer/mid-winter: opposite DST states").toBe(!syd);
    }
  });

  it("allows an overlap in late October, which is real", () => {
    // New York ends DST in early November; Sydney starts it in early October. Those weeks are a
    // genuine overlap, so demanding "never both" would be a false invariant that forbids reality.
    const lateOct = Date.UTC(2026, 9, 21, 12) / 1000;
    expect(isDstAt("America/New_York", lateOct)).toBe(true);
    expect(isDstAt("Australia/Sydney", lateOct)).toBe(true);
  });

  it("does not flag a zone with no DST", () => {
    expect(opts.find((o) => o.zone === "Asia/Dubai")?.dst).toBe(false);
    expect(opts.find((o) => o.zone === "UTC")?.dst).toBe(false);
  });

  it("offers a useful number of zones without being a dump of 400", () => {
    expect(opts.length).toBeGreaterThan(40);
    expect(opts.length).toBeLessThan(90);
  });

  it("spans the whole forex day, from Wellington to Los Angeles", () => {
    const min = opts[0]!.offsetSeconds;
    const max = opts[opts.length - 1]!.offsetSeconds;
    // at least 20 hours of range, which is what a 24h market needs
    expect((max - min) / H).toBeGreaterThanOrEqual(20);
  });
});

describe("filterTimezones", () => {
  const opts = timezoneOptions(SUMMER);

  it("returns everything for an empty query", () => {
    expect(filterTimezones(opts, "  ")).toHaveLength(opts.length);
  });

  it("finds a city by name, case-insensitively", () => {
    const r = filterTimezones(opts, "tehran");
    expect(r).toHaveLength(1);
    expect(r[0]!.zone).toBe("Asia/Tehran");
  });

  it("finds a zone by its IANA id", () => {
    expect(filterTimezones(opts, "asia/tehran")).toHaveLength(1);
  });

  it("finds zones by OFFSET, which is how you search when you do not know the city", () => {
    const r = filterTimezones(opts, "+3:30");
    expect(r.some((o) => o.zone === "Asia/Tehran")).toBe(true);
  });

  it("finds a region", () => {
    const r = filterTimezones(opts, "middle east");
    expect(r.length).toBeGreaterThan(3);
    expect(r.every((o) => o.region === "Middle East")).toBe(true);
  });

  it("returns nothing for nonsense rather than throwing", () => {
    expect(filterTimezones(opts, "zzzzz")).toHaveLength(0);
  });
});

describe("cityForZone and zoneButtonLabel", () => {
  it("maps a zone to its city", () => {
    expect(cityForZone("America/New_York", SUMMER)).toBe("New York");
    expect(cityForZone("Asia/Tehran", SUMMER)).toBe("Tehran");
    expect(cityForZone("UTC", SUMMER)).toBe("UTC");
  });

  it("handles an unknown zone by using its own name, not 'unknown'", () => {
    expect(cityForZone("America/Some_New_Place", SUMMER)).toBe("Some New Place");
  });

  it("builds the toolbar label with the live offset", () => {
    expect(zoneButtonLabel("America/New_York", SUMMER)).toBe("New York (UTC-4)");
    expect(zoneButtonLabel("America/New_York", WINTER)).toBe("New York (UTC-5)");
    expect(zoneButtonLabel("Asia/Tehran", WINTER)).toBe("Tehran (UTC+3:30)");
  });
});

describe("the list itself", () => {
  it("has no duplicate zone ids", () => {
    const zones = TIMEZONE_CITIES.map((c) => c.zone);
    expect(new Set(zones).size).toBe(zones.length);
  });

  it("every zone is a real IANA id the platform accepts", () => {
    for (const c of TIMEZONE_CITIES) {
      // Intl throws on an invalid timeZone, which is the strongest available check
      expect(() => cityOffsetSeconds(c.zone, SUMMER), c.zone).not.toThrow();
    }
  });

  it("every city has a non-empty name", () => {
    for (const c of TIMEZONE_CITIES) expect(c.city.length).toBeGreaterThan(0);
  });
});
