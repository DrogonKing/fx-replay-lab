import { describe, it, expect } from "vitest";
import {
  DEFAULT_STYLE, defaultStyleFor, defaultConfigFor, defaultConfigs, mergeConfigs,
  styleFor, isVisible, setConfig, resetConfigs, modifiedTools, serialiseConfigs,
  dashPattern, describeStyle,
} from "../src/core/tool-config.js";
import type { DrawingKind } from "../src/core/drawings.js";

const KINDS: DrawingKind[] = ["trendline", "rectangle", "hline", "fib-retracement", "text"];

describe("defaultStyleFor", () => {
  it("gives a filled shape a fill", () => {
    expect(defaultStyleFor("rectangle").fill).toBe(true);
    expect(defaultStyleFor("ellipse").fill).toBe(true);
  });

  it("does NOT fill a line tool", () => {
    expect(defaultStyleFor("trendline").fill).toBe(false);
  });

  it("makes a trend line thicker than a plain line", () => {
    expect(defaultStyleFor("trendline").width).toBe(2);
  });

  it("starts every tool at full opacity", () => {
    expect(defaultStyleFor("hline").opacity).toBe(1);
  });
});

describe("defaultConfigs / defaultConfigFor", () => {
  it("builds a config for every kind", () => {
    const c = defaultConfigs(KINDS);
    expect(Object.keys(c)).toHaveLength(KINDS.length);
    for (const k of KINDS) expect(c[k]).toBeDefined();
  });

  it("marks every tool as default, so nothing is stored until touched", () => {
    expect(defaultConfigFor("trendline").isDefault).toBe(true);
  });

  it("shows every tool on every timeframe by default", () => {
    expect(defaultConfigFor("trendline").timeframes).toEqual([]);
    expect(defaultConfigFor("trendline").hidden).toBe(false);
  });
});

describe("mergeConfigs", () => {
  it("returns all defaults for junk input", () => {
    const m = mergeConfigs("nonsense", KINDS);
    expect(Object.keys(m)).toHaveLength(KINDS.length);
    expect(m.trendline!.isDefault).toBe(true);
  });

  it("A NEW TOOL still appears after an update", () => {
    // a stored config from an older version has no entry for the new kind; replacing rather
    // than merging would make the new tool invisible until the user reset everything
    const stored = { trendline: { style: { color: "#ff0000" }, isDefault: false } };
    const m = mergeConfigs(stored, KINDS);
    expect(m.trendline!.style.color).toBe("#ff0000");
    expect(m.hline).toBeDefined();
    expect(m.hline!.isDefault).toBe(true);
  });

  it("keeps a stored colour", () => {
    const m = mergeConfigs({ hline: { style: { color: "#26a69a" }, isDefault: false } }, KINDS);
    expect(m.hline!.style.color).toBe("#26a69a");
  });

  it("rejects a non-hex colour rather than painting nothing", () => {
    const m = mergeConfigs({ hline: { style: { color: "red" } } }, KINDS);
    expect(m.hline!.style.color).toBe(DEFAULT_STYLE.color);
  });

  it("clamps a width outside 1..4", () => {
    expect(mergeConfigs({ hline: { style: { width: 99 } } }, KINDS).hline!.style.width).toBe(4);
    expect(mergeConfigs({ hline: { style: { width: 0 } } }, KINDS).hline!.style.width).toBe(1);
  });

  it("clamps opacity into 0..1", () => {
    expect(mergeConfigs({ hline: { style: { opacity: 5 } } }, KINDS).hline!.style.opacity).toBe(1);
    expect(mergeConfigs({ hline: { style: { opacity: -1 } } }, KINDS).hline!.style.opacity).toBe(0);
  });

  it("rejects an unknown line style", () => {
    const m = mergeConfigs({ hline: { style: { style: "wavy" } } }, KINDS);
    expect(m.hline!.style.style).toBe("solid");
  });

  it("drops non-string timeframes", () => {
    const m = mergeConfigs({ hline: { timeframes: ["M5", 7, null, "H1"] } }, KINDS);
    expect(m.hline!.timeframes).toEqual(["M5", "H1"]);
  });
});

describe("styleFor", () => {
  const cfgs = defaultConfigs(KINDS);

  it("returns the tool's configured style", () => {
    expect(styleFor(cfgs, "trendline").color).toBe(cfgs.trendline!.style.color);
  });

  it("AN EXPLICIT OVERRIDE WINS over the tool default", () => {
    // this is the precedence that makes a user's per-drawing colour stick
    const s = styleFor(cfgs, "trendline", { color: "#ff0000" });
    expect(s.color).toBe("#ff0000");
    expect(s.width).toBe(cfgs.trendline!.style.width);
  });

  it("does not mutate the stored config", () => {
    const before = cfgs.trendline!.style.color;
    styleFor(cfgs, "trendline", { color: "#123456" });
    expect(cfgs.trendline!.style.color).toBe(before);
  });

  it("falls back to the shipped default for an unknown tool", () => {
    expect(styleFor({}, "trendline").color).toBe(DEFAULT_STYLE.color);
  });
});

describe("isVisible", () => {
  const cfgs = defaultConfigs(KINDS);

  it("shows an untouched tool on every timeframe", () => {
    for (const tf of ["M1", "H4", "D1"]) {
      expect(isVisible(cfgs, "trendline", tf)).toBe(true);
    }
  });

  it("hides a hidden tool everywhere", () => {
    const c = setConfig(cfgs, "trendline", { hidden: true });
    expect(isVisible(c, "trendline", "M5")).toBe(false);
    expect(isVisible(c, "trendline", "D1")).toBe(false);
  });

  it("shows a scoped tool only on its timeframes", () => {
    const c = setConfig(cfgs, "trendline", { timeframes: ["D1", "W1"] });
    expect(isVisible(c, "trendline", "D1")).toBe(true);
    expect(isVisible(c, "trendline", "M5")).toBe(false);
  });

  it("treats an unknown tool as visible", () => {
    expect(isVisible({}, "trendline", "M5")).toBe(true);
  });
});

describe("setConfig", () => {
  const cfgs = defaultConfigs(KINDS);

  it("marks the tool as modified", () => {
    expect(setConfig(cfgs, "trendline", { style: { color: "#ff0000" } }).trendline!.isDefault)
      .toBe(false);
  });

  it("merges a partial style instead of replacing it", () => {
    const c = setConfig(cfgs, "trendline", { style: { color: "#ff0000" } });
    expect(c.trendline!.style.width).toBe(cfgs.trendline!.style.width);
  });

  it("leaves other tools untouched", () => {
    const c = setConfig(cfgs, "trendline", { style: { color: "#ff0000" } });
    expect(c.hline).toEqual(cfgs.hline);
  });

  it("can hide and scope at the same time", () => {
    const c = setConfig(cfgs, "hline", { hidden: true, timeframes: ["M1"] });
    expect(c.hline!.hidden).toBe(true);
    expect(c.hline!.timeframes).toEqual(["M1"]);
  });
});

describe("resetConfigs", () => {
  it("resets ONE tool", () => {
    let c = setConfig(defaultConfigs(KINDS), "trendline", { style: { color: "#ff0000" } });
    c = setConfig(c, "hline", { style: { color: "#00ff00" } });
    c = resetConfigs(c, KINDS, "trendline");
    expect(c.trendline!.isDefault).toBe(true);
    expect(c.hline!.isDefault).toBe(false);
  });

  it("resets ALL tools", () => {
    let c = setConfig(defaultConfigs(KINDS), "trendline", { style: { color: "#ff0000" } });
    c = resetConfigs(c, KINDS);
    expect(modifiedTools(c)).toHaveLength(0);
  });
});

describe("modifiedTools / serialiseConfigs", () => {
  it("lists only the tools the user changed", () => {
    const c = setConfig(defaultConfigs(KINDS), "hline", { style: { color: "#ff0000" } });
    expect(modifiedTools(c)).toEqual(["hline"]);
  });

  it("stores ONLY modified tools", () => {
    // storing all defaults means a future change to a default never reaches an existing user
    const c = setConfig(defaultConfigs(KINDS), "hline", { style: { color: "#ff0000" } });
    const stored = serialiseConfigs(c);
    expect(Object.keys(stored)).toEqual(["hline"]);
  });

  it("round-trips through merge", () => {
    const c = setConfig(defaultConfigs(KINDS), "hline", {
      style: { color: "#ff0000", width: 3 },
      timeframes: ["M5"],
    });
    const back = mergeConfigs(serialiseConfigs(c), KINDS);
    expect(back.hline!.style.color).toBe("#ff0000");
    expect(back.hline!.style.width).toBe(3);
    expect(back.hline!.timeframes).toEqual(["M5"]);
    expect(back.hline!.isDefault).toBe(false);
  });

  it("stores nothing when nothing changed", () => {
    expect(serialiseConfigs(defaultConfigs(KINDS))).toEqual({});
  });
});

describe("dashPattern", () => {
  it("is empty for solid, so the canvas draws a continuous line", () => {
    expect(dashPattern("solid", 2)).toEqual([]);
  });

  it("scales with the width, so a thick dashed line stays dashed", () => {
    expect(dashPattern("dashed", 1)).toEqual([5, 4]);
    expect(dashPattern("dashed", 2)).toEqual([10, 8]);
  });

  it("makes dots tighter than dashes", () => {
    const d = dashPattern("dotted", 2);
    expect(d[0]!).toBeLessThan(dashPattern("dashed", 2)[0]!);
  });
});

describe("describeStyle", () => {
  it("names the colour, width and style", () => {
    const d = describeStyle({ ...DEFAULT_STYLE, color: "#2962ff", width: 2, style: "dashed" });
    expect(d).toContain("#2962ff");
    expect(d).toContain("2px");
    expect(d).toContain("dashed");
  });

  it("mentions opacity only when it is below full", () => {
    expect(describeStyle(DEFAULT_STYLE)).not.toContain("%");
    expect(describeStyle({ ...DEFAULT_STYLE, opacity: 0.5 })).toContain("50%");
  });

  it("mentions fill when the shape has one", () => {
    expect(describeStyle({ ...DEFAULT_STYLE, fill: true, fillOpacity: 0.2 })).toContain("fill");
  });
});
