import { describe, it, expect } from "vitest";
import { tokenize, PineSyntaxError } from "../src/core/pine/lexer.js";
import { parsePine, detectVersion } from "../src/core/pine/parser.js";

describe("lexer", () => {
  it("tokenizes numbers, strings, identifiers and operators", () => {
    const t = tokenize('x := ta.sma(close, 14) + 1.5e-3 * "hi"');
    const vals = t.map((x) => x.value);
    expect(vals).toContain("x");
    expect(vals).toContain(":=");
    expect(vals).toContain("ta.sma");
    expect(vals).toContain("14");
    expect(vals).toContain("1.5e-3");
    expect(vals).toContain("hi");
  });

  it("keeps comments as tokens so @version survives", () => {
    const t = tokenize("//@version=5\nx = 1");
    expect(t.some((x) => x.type === "comment" && x.value.includes("@version=5"))).toBe(true);
  });

  it("throws a positioned error on an unterminated string", () => {
    try {
      tokenize('x = "abc');
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PineSyntaxError);
      const err = e as PineSyntaxError;
      expect(err.line).toBe(1);
      expect(err.message).toMatch(/unterminated string/);
    }
  });

  it("rejects an unexpected character with line and column", () => {
    try {
      tokenize("x = 1 § 2");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as PineSyntaxError).message).toMatch(/line 1, col 7/);
    }
  });
});

describe("detectVersion", () => {
  it("reads @version and defaults to 5", () => {
    expect(detectVersion("//@version=5\nx=1")).toBe(5);
    expect(detectVersion("x=1")).toBe(5);
    expect(detectVersion("//@version=4")).toBe(4);
  });
});

describe("parser - header", () => {
  it("recognises indicator() and its named args", () => {
    const p = parsePine('//@version=5\nindicator("My RSI", overlay=false)\nplot(1)');
    expect(p.scriptKind).toBe("indicator");
    expect(Object.keys(p.headerArgs)).toContain("title");
    expect(Object.keys(p.headerArgs)).toContain("overlay");
  });

  it("recognises strategy()", () => {
    const p = parsePine('//@version=5\nstrategy("S", overlay=true)\nplot(1)');
    expect(p.scriptKind).toBe("strategy");
  });
});

describe("parser - statements", () => {
  it("parses assignment and reassignment distinctly", () => {
    const p = parsePine("//@version=5\nindicator(\"x\")\nx = 1\nx := 2");
    const assigns = p.statements.filter((s) => s.kind === "assign");
    expect(assigns).toHaveLength(2);
    const [a, b] = assigns as Array<{ op: string }>;
    expect(a!.op).toBe("=");
    expect(b!.op).toBe(":=");
  });

  it("parses var declarations with and without a value", () => {
    const p = parsePine("//@version=5\nindicator(\"x\")\nvar count = 0\nvarip last = na");
    const decls = p.statements.filter((s) => s.kind === "vardecl");
    expect(decls).toHaveLength(2);
    expect((decls[0] as { storage: string }).storage).toBe("var");
    expect((decls[1] as { storage: string }).storage).toBe("varip");
  });

  it("parses if / else if / else blocks by indentation", () => {
    const src = [
      "//@version=5", 'indicator("x")',
      "if close > open",
      "    up := up + 1",
      "else if close < open",
      "    down := down + 1",
      "else",
      "    flat := flat + 1",
    ].join("\n");
    const p = parsePine(src);
    const iff = p.statements.find((s) => s.kind === "if");
    expect(iff).toBeDefined();
    const node = iff as { elifs: unknown[]; else: unknown };
    expect(node.elifs).toHaveLength(1);
    expect(node.else).not.toBeNull();
  });

  it("parses a for loop with step", () => {
    const src = [
      "//@version=5", 'indicator("x")',
      "sum = 0",
      "for i = 0 to 10 by 2",
      "    sum := sum + i",
    ].join("\n");
    const p = parsePine(src);
    const loop = p.statements.find((s) => s.kind === "for") as { varName: string; step: unknown };
    expect(loop.varName).toBe("i");
    expect(loop.step).not.toBeNull();
  });

  it("parses a user function with a => body", () => {
    const src = [
      "//@version=5", 'indicator("x")',
      "f(x, y) =>",
      "    x + y",
      "plot(f(1, 2))",
    ].join("\n");
    const p = parsePine(src);
    const fn = p.statements.find((s) => s.kind === "func") as { name: string; params: string[] };
    expect(fn.name).toBe("f");
    expect(fn.params).toEqual(["x", "y"]);
  });

  it("parses switch with cases and a default", () => {
    const src = [
      "//@version=5", 'indicator("x")',
      "v = switch close",
      "    > 100 => 1",
      "    < 50 => -1",
      "    => 0",
    ].join("\n");
    const p = parsePine(src);
    const st = p.statements.find((s) => s.kind === "assign") as { value: { kind: string } };
    expect(st.value.kind).toBe("switch");
  });

  it("parses the history operator and nested calls", () => {
    const p = parsePine("//@version=5\nindicator(\"x\")\nplot(ta.sma(close, 14)[1])");
    const st = p.statements.find((s) => s.kind === "expr") as { expr: { kind: string } };
    expect(st.expr.kind).toBe("call");
  });

  it("parses a ternary", () => {
    const p = parsePine("//@version=5\nindicator(\"x\")\nv = close > open ? 1 : 0");
    const st = p.statements.find((s) => s.kind === "assign") as { value: { kind: string } };
    expect(st.value.kind).toBe("ternary");
  });

  it("respects operator precedence (and binds tighter than or)", () => {
    const p = parsePine("//@version=5\nindicator(\"x\")\nv = true or false and true");
    const st = p.statements.find((s) => s.kind === "assign") as {
      value: { kind: string; op: string; right: { op: string } };
    };
    expect(st.value.op).toBe("or");
    expect(st.value.right.op).toBe("and");
  });

  it("applies * before +", () => {
    const p = parsePine("//@version=5\nindicator(\"x\")\nv = 1 + 2 * 3");
    const st = p.statements.find((s) => s.kind === "assign") as { value: { op: string } };
    expect(st.value.op).toBe("+");
  });

  it("raises a positioned error on a malformed statement", () => {
    try {
      parsePine("//@version=5\nindicator(\"x\")\nv = = 3");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PineSyntaxError);
      expect((e as PineSyntaxError).line).toBeGreaterThan(0);
    }
  });
});
