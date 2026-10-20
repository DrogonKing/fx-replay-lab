import { describe, it, expect } from "vitest";
import {
  serialiseDrawings, parseDrawings, serialiseJournal, parseJournal,
  workspaceKey, SCHEMA_VERSION,
} from "../src/core/persist.js";
import type { Drawing, DrawingKind, Point } from "../src/core/drawings.js";
import type { JournalEntry } from "../src/core/persist.js";

const P = (time: number, price: number): Point => ({ time, price });

function d(over: Partial<Drawing> = {}): Drawing {
  return {
    id: "a1", kind: "trendline", points: [P(0, 100), P(1000, 200)],
    color: "#f0b90b", width: 2, ...over,
  };
}

function j(over: Partial<JournalEntry> = {}): JournalEntry {
  return {
    id: "j1", symbol: "XAUUSD", side: "buy", lots: 0.1,
    entryTime: 1000, exitTime: 2000, entryPrice: 2000, exitPrice: 2010,
    pnl: 100, risk: 50, tags: ["breakout"], notes: "", ...over,
  };
}

describe("workspaceKey", () => {
  it("separates symbol and timeframe", () => {
    expect(workspaceKey("XAUUSD", "M5")).toBe("XAUUSD::M5");
    // a trend line on M5 means nothing on D1, so the keys must differ
    expect(workspaceKey("XAUUSD", "M5")).not.toBe(workspaceKey("XAUUSD", "D1"));
    expect(workspaceKey("EURUSD", "M5")).not.toBe(workspaceKey("XAUUSD", "M5"));
  });
});

describe("drawings round trip", () => {
  it("survives serialise -> JSON -> parse unchanged", () => {
    const original = [
      d(),
      d({ id: "b2", kind: "hline", points: [P(500, 1990)] }),
      d({ id: "c3", kind: "xabcd", points: [P(0, 1), P(1, 2), P(2, 3), P(3, 4), P(4, 5)] }),
    ];
    const wire = serialiseDrawings(original);
    const json = JSON.parse(JSON.stringify(wire));
    const back = parseDrawings(json);

    expect(back.rejected).toEqual([]);
    expect(back.value).toHaveLength(3);
    expect(back.value[0]).toEqual(original[0]);
    expect(back.value[2]!.points).toEqual(original[2]!.points);
  });

  it("keeps optional fields when present", () => {
    const original = [
      d({ id: "t1", kind: "text", points: [P(0, 100)], text: "entry zone" }),
      d({ id: "f1", kind: "fib-retracement", levels: [0.5, 0.618] }),
      d({ id: "l1", locked: true, dashed: true }),
    ];
    const back = parseDrawings(JSON.parse(JSON.stringify(serialiseDrawings(original))));
    expect(back.rejected).toEqual([]);
    expect(back.value[0]!.text).toBe("entry zone");
    expect(back.value[1]!.levels).toEqual([0.5, 0.618]);
    expect(back.value[2]!.locked).toBe(true);
    expect(back.value[2]!.dashed).toBe(true);
  });

  it("omits optional fields rather than writing undefined", () => {
    const wire = serialiseDrawings([d()]);
    const raw = wire.drawings[0]!;
    expect("text" in raw).toBe(false);
    expect("levels" in raw).toBe(false);
    // JSON.stringify drops undefined, but the object should not carry the key at all
    expect(JSON.parse(JSON.stringify(wire)).drawings[0]).toEqual({
      id: "a1", kind: "trendline", points: [{ t: 0, p: 100 }, { t: 1000, p: 200 }],
      color: "#f0b90b", width: 2,
    });
  });

  it("preserves every kind in the union", () => {
    const kinds: DrawingKind[] = [
      "trendline", "hline", "vline", "ray", "pitchfork", "rectangle", "ellipse",
      "fib-retracement", "fib-channel", "gann-fan", "xabcd", "elliott-impulse",
      "long-position", "measure", "text", "balloon", "zoom-in",
    ];
    const original = kinds.map((kind, i) => d({ id: `k${i}`, kind }));
    const back = parseDrawings(JSON.parse(JSON.stringify(serialiseDrawings(original))));
    expect(back.value.map((x) => x.kind)).toEqual(kinds);
  });

  it("does not lose precision on large epoch times or prices", () => {
    const big = d({ points: [P(1_767_225_600, 2073.4499999999998), P(1_767_312_000, 1234.567890123)] });
    const back = parseDrawings(JSON.parse(JSON.stringify(serialiseDrawings([big]))));
    expect(back.value[0]!.points[0]!.time).toBe(1_767_225_600);
    expect(back.value[0]!.points[1]!.price).toBe(1234.567890123);
  });
});

describe("drawings: corrupt input is dropped, not fatal", () => {
  const good = d();

  it("rejects a payload that is not an object", () => {
    expect(parseDrawings(null).value).toEqual([]);
    expect(parseDrawings("nope").rejected[0]).toContain("not a drawings object");
    expect(parseDrawings({}).rejected[0]).toContain("not a drawings object");
  });

  it("drops one bad row but keeps the rest", () => {
    const input = {
      version: 1,
      drawings: [
        { id: "ok", kind: "hline", points: [{ t: 0, p: 100 }], color: "#fff", width: 2 },
        { id: "bad", kind: "not-a-real-tool", points: [{ t: 0, p: 100 }], color: "#fff", width: 2 },
        { id: "ok2", kind: "trendline", points: [{ t: 0, p: 1 }, { t: 1, p: 2 }], color: "#fff", width: 2 },
      ],
    };
    const r = parseDrawings(input);
    expect(r.value.map((x) => x.id)).toEqual(["ok", "ok2"]);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]).toContain("unknown kind");
  });

  it("rejects a drawing with no points", () => {
    const r = parseDrawings({ drawings: [{ id: "x", kind: "hline", points: [] }] });
    expect(r.value).toEqual([]);
    expect(r.rejected[0]).toContain("no points");
  });

  it("rejects non-finite coordinates", () => {
    // JSON cannot carry NaN/Infinity, but a hand-edited file or a bug can
    const r = parseDrawings({ drawings: [{ id: "x", kind: "hline", points: [{ t: 0, p: null }] }] });
    expect(r.value).toEqual([]);
    expect(r.rejected[0]).toContain("non-finite");
  });

  it("rejects a missing id", () => {
    const r = parseDrawings({ drawings: [{ kind: "hline", points: [{ t: 0, p: 1 }] }] });
    expect(r.rejected[0]).toContain("missing id");
  });

  it("substitutes defaults for a missing colour or width", () => {
    const r = parseDrawings({ drawings: [{ id: "x", kind: "hline", points: [{ t: 0, p: 1 }] }] });
    expect(r.value[0]!.color).toBe("#f0b90b");
    expect(r.value[0]!.width).toBe(2);
  });

  it("keeps a valid drawing alongside a rejected one", () => {
    const r = parseDrawings({
      drawings: [
        JSON.parse(JSON.stringify(serialiseDrawings([good]).drawings[0]!)),
        "not an object",
      ],
    });
    expect(r.value).toHaveLength(1);
    expect(r.rejected).toHaveLength(1);
  });
});

describe("journal round trip", () => {
  it("survives a round trip", () => {
    const original = [j(), j({ id: "j2", side: "sell", pnl: -50, tags: ["news", "fade"] })];
    const back = parseJournal(JSON.parse(JSON.stringify(serialiseJournal(original))));
    expect(back.rejected).toEqual([]);
    expect(back.value).toEqual(original);
  });

  it("rejects an invalid side instead of guessing", () => {
    // guessing "buy" would flip a loss into a win in the tag analytics
    const r = parseJournal({
      entries: [{
        id: "x", symbol: "XAUUSD", side: "long", lots: 1, entryTime: 0, exitTime: 1,
        entryPrice: 1, exitPrice: 1, pnl: -10, risk: 5, tags: [], notes: "",
      }],
    });
    expect(r.value).toEqual([]);
    expect(r.rejected[0]).toContain("invalid side");
  });

  it("rejects non-finite numbers", () => {
    const r = parseJournal({
      entries: [{
        id: "x", symbol: "XAUUSD", side: "buy", lots: 1, entryTime: 0, exitTime: 1,
        entryPrice: 1, exitPrice: 1, pnl: null, risk: 5, tags: [], notes: "",
      }],
    });
    expect(r.rejected[0]).toContain("non-finite pnl");
  });

  it("defaults missing tags and notes", () => {
    const r = parseJournal({
      entries: [{
        id: "x", symbol: "XAUUSD", side: "buy", lots: 1, entryTime: 0, exitTime: 1,
        entryPrice: 1, exitPrice: 1, pnl: 10, risk: 5,
      }],
    });
    expect(r.value[0]!.tags).toEqual([]);
    expect(r.value[0]!.notes).toBe("");
  });

  it("filters non-string tags", () => {
    const r = parseJournal({
      entries: [{
        id: "x", symbol: "S", side: "buy", lots: 1, entryTime: 0, exitTime: 1,
        entryPrice: 1, exitPrice: 1, pnl: 1, risk: 1, tags: ["ok", 5, null, "fine"], notes: "",
      }],
    });
    expect(r.value[0]!.tags).toEqual(["ok", "fine"]);
  });

  it("rejects a payload that is not a journal", () => {
    expect(parseJournal({}).rejected[0]).toContain("not a journal object");
  });
});

describe("schema version", () => {
  it("is written so a future migration can detect old data", () => {
    expect(serialiseDrawings([]).version).toBe(SCHEMA_VERSION);
    expect(serialiseJournal([]).version).toBe(SCHEMA_VERSION);
  });
});
