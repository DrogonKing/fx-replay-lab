import { describe, it, expect } from "vitest";
import {
  SESSIONS, sessionDef, sessionOpenFor, sessionSpans, sessionAt, sessionAtAll,
  inOverlap, sessionStats, sessionLabel, type SessionName,
} from "../src/core/sessions.js";
import { toWallClock } from "../src/core/timezone.js";

const utc = (y: number, mo: number, d: number, h = 0, mi = 0): number =>
  Date.UTC(y, mo - 1, d, h, mi) / 1000;

describe("session definitions", () => {
  it("has all four sessions", () => {
    expect(SESSIONS.map((s) => s.name)).toEqual(["sydney", "tokyo", "london", "newyork"]);
  });

  it("defines each in its own city's local clock", () => {
    // this is the whole point: "London opens at 08:00" means London's clock
    expect(sessionDef("london").zone).toBe("Europe/London");
    expect(sessionDef("newyork").zone).toBe("America/New_York");
    expect(sessionDef("tokyo").zone).toBe("Asia/Tokyo");
    expect(sessionDef("sydney").zone).toBe("Australia/Sydney");
  });

  it("gives every session a distinct colour", () => {
    const colours = SESSIONS.map((s) => s.colour);
    expect(new Set(colours).size).toBe(colours.length);
  });
});

describe("sessionOpenFor — DST correctness", () => {
  it("opens London at 08:00 GMT in winter", () => {
    // 2024-01-15 is GMT (offset 0)
    const open = sessionOpenFor(utc(2024, 1, 15, 12), sessionDef("london"));
    expect(toWallClock(open, "Europe/London")).toMatchObject({ hour: 8, minute: 0 });
    expect(open).toBe(utc(2024, 1, 15, 8));
  });

  it("opens London at 08:00 BST in summer — i.e. 07:00 UTC", () => {
    // 2024-07-15 is BST (UTC+1), so 08:00 local is 07:00 UTC. A fixed UTC window would be
    // an hour wrong for most of the year.
    const open = sessionOpenFor(utc(2024, 7, 15, 12), sessionDef("london"));
    expect(toWallClock(open, "Europe/London")).toMatchObject({ hour: 8, minute: 0 });
    expect(open).toBe(utc(2024, 7, 15, 7));
  });

  it("opens New York at 08:00 EST in winter (13:00 UTC)", () => {
    const open = sessionOpenFor(utc(2024, 1, 15, 20), sessionDef("newyork"));
    expect(toWallClock(open, "America/New_York")).toMatchObject({ hour: 8 });
    expect(open).toBe(utc(2024, 1, 15, 13));
  });

  it("opens New York at 08:00 EDT in summer (12:00 UTC)", () => {
    const open = sessionOpenFor(utc(2024, 7, 15, 20), sessionDef("newyork"));
    expect(toWallClock(open, "America/New_York")).toMatchObject({ hour: 8 });
    expect(open).toBe(utc(2024, 7, 15, 12));
  });

  it("handles the weeks when London and New York DST disagree", () => {
    // UK switches on the last Sunday of March, the US on the second Sunday. Between
    // 2024-03-10 and 2024-03-31 the US is on EDT but the UK is still on GMT, so the
    // London/NY gap is 4 hours instead of the usual 5.
    const mar20 = utc(2024, 3, 20, 12);
    const londonOpen = sessionOpenFor(mar20, sessionDef("london"));
    const nyOpen = sessionOpenFor(mar20, sessionDef("newyork"));
    expect(toWallClock(londonOpen, "Europe/London").hour).toBe(8);
    expect(toWallClock(nyOpen, "America/New_York").hour).toBe(8);
    // London 08:00 GMT = 08:00 UTC; NY 08:00 EDT = 12:00 UTC -> the overlap starts at 12:00
    expect(londonOpen).toBe(utc(2024, 3, 20, 8));
    expect(nyOpen).toBe(utc(2024, 3, 20, 12));
  });

  it("puts Tokyo at 09:00 JST, which is 00:00 UTC, with no DST", () => {
    const winter = sessionOpenFor(utc(2024, 1, 15, 12), sessionDef("tokyo"));
    const summer = sessionOpenFor(utc(2024, 7, 15, 12), sessionDef("tokyo"));
    expect(toWallClock(winter, "Asia/Tokyo").hour).toBe(9);
    expect(toWallClock(summer, "Asia/Tokyo").hour).toBe(9);
    expect(winter).toBe(utc(2024, 1, 15, 0));
    expect(summer).toBe(utc(2024, 7, 15, 0));
  });

  it("keeps a Sydney session in the after-midnight tail attached to the day it opened", () => {
    // Sydney opens 22:00 and closes 07:00 next day. At 03:00 local we are still inside
    // the session that OPENED yesterday, so the open must be in the past.
    const inTail = sessionOpenFor(utc(2024, 6, 12, 17), sessionDef("sydney")); // 03:00 AEST
    expect(toWallClock(inTail, "Australia/Sydney")).toMatchObject({ hour: 22 });
    expect(inTail).toBeLessThan(utc(2024, 6, 12, 17));
  });
});

describe("sessionSpans", () => {
  it("returns nothing for an empty window", () => {
    expect(sessionSpans(1000, 1000)).toEqual([]);
    expect(sessionSpans(2000, 1000)).toEqual([]);
  });

  it("finds the London session overlapping a UTC midday window in winter", () => {
    // window starts at 07:00 so the 08:00 open is inside it and NOT clipped
    const spans = sessionSpans(utc(2024, 1, 15, 7), utc(2024, 1, 15, 18));
    const london = spans.filter((s) => s.name === "london");
    expect(london.length).toBe(1);
    expect(london[0]!.from).toBe(utc(2024, 1, 15, 8));
    expect(london[0]!.to).toBe(utc(2024, 1, 15, 17));
  });

  it("clips spans to the requested window", () => {
    const spans = sessionSpans(utc(2024, 1, 15, 10), utc(2024, 1, 15, 12));
    const london = spans.find((s) => s.name === "london")!;
    expect(london.from).toBe(utc(2024, 1, 15, 10));   // clipped at the window start
    expect(london.to).toBe(utc(2024, 1, 15, 12));     // clipped at the window end
  });

  it("filters to selected sessions", () => {
    const spans = sessionSpans(
      utc(2024, 1, 15, 0), utc(2024, 1, 15, 23),
      { only: ["london"] },
    );
    expect(new Set(spans.map((s) => s.name))).toEqual(new Set(["london"]));
  });

  it("spans several days", () => {
    // 15, 16 and 17 January only: the 18th's London session opens at 08:00, past the end
    const spans = sessionSpans(utc(2024, 1, 15, 0), utc(2024, 1, 18, 0), { only: ["london"] });
    expect(spans.length).toBe(3);
    expect(spans[0]!.from).toBe(utc(2024, 1, 15, 8));
    expect(spans[2]!.from).toBe(utc(2024, 1, 17, 8));
  });

  it("never returns a duplicate span", () => {
    const spans = sessionSpans(utc(2024, 1, 15, 0), utc(2024, 1, 20, 0));
    const keys = spans.map((s) => `${s.name}|${s.from}|${s.to}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("shifts the London band by an hour between winter and summer", () => {
    const winterOpen = sessionSpans(utc(2024, 1, 15, 0), utc(2024, 1, 16, 0), { only: ["london"] })[0]!;
    const summerOpen = sessionSpans(utc(2024, 7, 15, 0), utc(2024, 7, 16, 0), { only: ["london"] })[0]!;
    expect(winterOpen.from).toBe(utc(2024, 1, 15, 8));
    expect(summerOpen.from).toBe(utc(2024, 7, 15, 7));
  });
});

describe("sessionAt", () => {
  it("finds London at UTC midday in winter", () => {
    expect(sessionAt(utc(2024, 1, 15, 12))).toBe("london");
  });

  it("finds Tokyo at UTC midnight", () => {
    expect(sessionAt(utc(2024, 1, 15, 2))).toBe("tokyo");
  });

  it("prefers london inside the London/NY overlap", () => {
    // 14:00 UTC in winter is 14:00 London and 09:00 New York: both open
    expect(sessionAt(utc(2024, 1, 15, 14))).toBe("london");
  });

  it("returns null in a genuine gap", () => {
    // January: Tokyo 00:00-09:00, London 08:00-17:00, Sydney 11:00-20:00,
    // New York 13:00-22:00 UTC. The only gap is 22:00-24:00 UTC.
    expect(sessionAt(utc(2024, 1, 15, 23))).toBeNull();
  });

  it("still has New York open at 21:00 UTC in winter", () => {
    // 08:00-17:00 EST is 13:00-22:00 UTC — a window that surprises people who assume
    // "the US session ends at 21:00"
    expect(sessionAt(utc(2024, 1, 15, 21))).toBe("newyork");
  });

  it("respects the only filter", () => {
    expect(sessionAt(utc(2024, 1, 15, 12), ["tokyo"])).toBeNull();
  });
});

describe("sessionAtAll and overlap", () => {
  it("reports both sessions during the overlap", () => {
    const all = sessionAtAll(utc(2024, 1, 15, 14));
    expect(all).toContain("london");
    expect(all).toContain("newyork");
  });

  it("reports one session outside the overlap", () => {
    expect(sessionAtAll(utc(2024, 1, 15, 9))).toEqual(["london"]);
  });

  it("detects the overlap", () => {
    expect(inOverlap(utc(2024, 1, 15, 14))).toBe(true);
    expect(inOverlap(utc(2024, 1, 15, 9))).toBe(false);
  });

  it("moves the overlap an hour later in summer, but keeps it", () => {
    // summer: London 08:00 BST = 07:00 UTC; NY 08:00 EDT = 12:00 UTC, so the overlap is
    // 12:00-16:00 UTC instead of 13:00-17:00
    expect(inOverlap(utc(2024, 7, 15, 11))).toBe(false);
    expect(inOverlap(utc(2024, 7, 15, 13))).toBe(true);
  });
});

describe("sessionStats", () => {
  const t = (entryTime: number, pnl: number) => ({ entryTime, pnl });

  it("groups by entry session", () => {
    const stats = sessionStats([
      t(utc(2024, 1, 15, 12), 100),    // london
      t(utc(2024, 1, 15, 13), -50),    // london
      t(utc(2024, 1, 16, 2), 30),      // tokyo
    ]);
    const london = stats.find((s) => s.session === "london")!;
    const tokyo = stats.find((s) => s.session === "tokyo")!;
    expect(london.count).toBe(2);
    expect(london.netPnl).toBe(50);
    expect(london.winRate).toBe(50);
    expect(tokyo.count).toBe(1);
    expect(tokyo.netPnl).toBe(30);
  });

  it("puts an out-of-session trade in 'off'", () => {
    const stats = sessionStats([t(utc(2024, 1, 15, 23), 10)]);
    expect(stats[0]!.session).toBe("off");
  });

  it("orders sessions chronologically", () => {
    const stats = sessionStats([
      t(utc(2024, 1, 15, 14), 1),   // london (overlap, attributed to london)
      t(utc(2024, 1, 16, 2), 1),    // tokyo
      t(utc(2024, 1, 15, 23), 1),   // off
    ]);
    expect(stats.map((s) => s.session)).toEqual(["tokyo", "london", "off"]);
  });

  it("attributes the London/NY overlap to London, not to both", () => {
    const stats = sessionStats([t(utc(2024, 1, 15, 14), 10)]);
    expect(stats).toHaveLength(1);
    expect(stats[0]!.session).toBe("london");
  });

  it("returns an empty list for no trades", () => {
    expect(sessionStats([])).toEqual([]);
  });

  it("counts a break-even trade as not a win", () => {
    const stats = sessionStats([t(utc(2024, 1, 15, 12), 0)]);
    expect(stats[0]!.wins).toBe(0);
    expect(stats[0]!.winRate).toBe(0);
  });

  it("sums negatives correctly", () => {
    const stats = sessionStats([
      t(utc(2024, 1, 15, 12), -100),
      t(utc(2024, 1, 15, 13), -50),
    ]);
    expect(stats[0]!.netPnl).toBe(-150);
    expect(stats[0]!.winRate).toBe(0);
  });
});

describe("sessionLabel", () => {
  it("labels each session", () => {
    const names: SessionName[] = ["sydney", "tokyo", "london", "newyork"];
    expect(names.map(sessionLabel)).toEqual(["Sydney", "Tokyo", "London", "New York"]);
  });

  it("labels off-session", () => {
    expect(sessionLabel("off")).toBe("off-session");
  });
});
