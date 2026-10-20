/**
 * Pine subset evaluator.
 *
 * Execution model: the program is evaluated once per bar, with a persistent
 * variable store that survives between bars (this is what makes `var` and the
 * history operator `[]` work). Series variables keep their full history so `x[1]`
 * is a real lookback rather than a guess.
 *
 * Look-ahead safety: `request.security()` defaults to the LAST CLOSED bar of the
 * higher timeframe, so using it cannot see the future. Anything that would need
 * future data is rejected, not approximated.
 */
import type { CandleSeries } from "../types.js";
import { sma, ema, rma, rsi, atr, macd, stochastic, bollinger, wma, highestHigh, lowestLow } from "../indicators.js";
import type { Node, Program } from "./ast.js";

export type PineValue = number | boolean | string | null;

/** A named slot holding the series of values that variable took over bars. */
class SeriesSlot {
  history: PineValue[] = [];
  push(v: PineValue): void {
    this.history.push(v);
  }
  at(offset: number): PineValue {
    const idx = this.history.length - 1 - offset;
    if (idx < 0) return Number.NaN;
    return this.history[idx] ?? Number.NaN;
  }
  last(): PineValue {
    return this.history.length > 0 ? this.history[this.history.length - 1]! : Number.NaN;
  }
}

export class PineRuntimeError extends Error {
  constructor(message: string, readonly barIndex: number) {
    super(`${message} (bar ${barIndex})`);
    this.name = "PineRuntimeError";
  }
}

export interface PlotSeries {
  title: string;
  values: number[];
  /** which pane this belongs to */
  pane: "main" | "separate";
  color?: string;
  style?: "line" | "histogram" | "columns";
}

export interface StrategyOrder {
  action: "entry" | "exit" | "close" | "close_all" | "order";
  /** "long" | "short" */
  direction?: "long" | "short";
  qty?: number;
  /** stop/limit price for strategy.exit */
  stop?: number;
  limit?: number;
  /** id for pairing entry/exit */
  id?: string;
  barIndex: number;
}

export interface RunResult {
  plots: PlotSeries[];
  shapes: Array<{ barIndex: number; price: number; text: string; kind: string }>;
  hlines: Array<{ price: number; title: string; color?: string }>;
  bgcolors: Array<{ barIndex: number; color: string }>;
  orders: StrategyOrder[];
  errors: string[];
  /** the inputs the script declared, so the UI can build a settings dialog */
  inputs: Array<{ name: string; title: string; type: string; defval: PineValue }>;
}

export interface RuntimeOptions {
  /** cap loop iterations so a runaway `while` cannot hang the app */
  maxLoopIterations?: number;
  /** per-bar statement budget, guards against accidental O(n^2) scripts */
  maxStatementsPerBar?: number;
}

const NA = Number.NaN;

function isNa(v: PineValue | undefined): boolean {
  return v === null || (typeof v === "number" && Number.isNaN(v));
}

/**
 * Coerce a Pine value to a number.
 *
 * `undefined` is accepted because with noUncheckedIndexedAccess every
 * `args[i]` is `PineValue | undefined`; a missing argument means "absent", which
 * Pine treats as na, so returning NaN is the correct behaviour rather than
 * forcing every call site to assert non-null.
 */
function toNum(v: PineValue | undefined): number {
  if (v === undefined || v === null) return NA;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  const n = Number(v);
  return Number.isNaN(n) ? NA : n;
}

function toBool(v: PineValue | undefined): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return !Number.isNaN(v) && v !== 0;
  if (v === null) return false;
  return v !== "";
}

export class PineRuntime {
  private slots = new Map<string, SeriesSlot>();
  private scalarVar = new Map<string, PineValue>();
  private functions = new Map<string, { params: string[]; body: Node }>();
  private barIndex = 0;
  private statementsThisBar = 0;

  private plots = new Map<string, { values: number[]; pane: "main" | "separate"; color?: string; style?: "line" | "histogram" | "columns" }>();
  private shapes: RunResult["shapes"] = [];
  private hlines: RunResult["hlines"] = [];
  private bgcolors: RunResult["bgcolors"] = [];
  private orders: StrategyOrder[] = [];
  private inputs: RunResult["inputs"] = [];
  private errors: string[] = [];
  private declaredInputs = new Map<string, { title: string; type: string; defval: PineValue }>();

  // precomputed indicator lines, keyed "fn:period"
  private cache = new Map<string, Float64Array>();

  constructor(
    private series: CandleSeries,
    private program: Program,
    private opts: RuntimeOptions = {},
  ) {}

  /** Run the whole script across every bar. */
  run(): RunResult {
    const n = this.series.length;
    // Collect function declarations once (they are hoisted in Pine).
    for (const st of this.program.statements) {
      if (st.kind === "func") {
        this.functions.set(st.name, { params: st.params, body: st });
      }
    }
    // Collect declared inputs before the first bar so titles are known.
    this.collectInputs(this.program.statements);

    for (let i = 0; i < n; i++) {
      this.barIndex = i;
      this.statementsThisBar = 0;
      try {
        for (const st of this.program.statements) {
          if (st.kind === "func") continue;   // declarations are not executed
          this.execStatement(st);
        }
      } catch (e) {
        if (this.errors.length < 20) {
          const msg = e instanceof PineRuntimeError
            ? e.message
            : `bar ${i}: ${(e as Error).message}`;
          if (!this.errors.includes(msg)) this.errors.push(msg);
        }
      }
    }

    const plots: PlotSeries[] = [...this.plots.entries()].map(([title, p]) => ({
      title,
      values: p.values,
      pane: p.pane,
      ...(p.color !== undefined ? { color: p.color } : {}),
      ...(p.style !== undefined ? { style: p.style } : {}),
    }));

    return {
      plots,
      shapes: this.shapes,
      hlines: this.hlines,
      bgcolors: this.bgcolors,
      orders: this.orders,
      errors: this.errors,
      inputs: this.inputs,
    };
  }

  // --------------------------------------------------------------- inputs

  private collectInputs(statements: Node[]): void {
    const walk = (nodes: Node[]): void => {
      for (const node of nodes) {
        if (node.kind === "assign" && node.value.kind === "call" &&
            node.value.callee.startsWith("input.")) {
          const type = node.value.callee.slice("input.".length);
          const positional = node.value.args;
          const defval = positional.length > 0 ? this.literalOf(positional[0]!) : null;
          const titleNode = node.value.named["title"];
          const title = titleNode && titleNode.kind === "string"
            ? titleNode.value
            : node.name;
          this.declaredInputs.set(node.name, { title, type, defval });
          this.inputs.push({ name: node.name, title, type, defval });
        }
        if (node.kind === "if") {
          walk(node.then.statements);
          for (const e of node.elifs) walk(e.then.statements);
          if (node.else) walk(node.else.statements);
        }
      }
    };
    walk(statements);
  }

  private literalOf(n: Node): PineValue {
    switch (n.kind) {
      case "number": return n.value;
      case "string": return n.value;
      case "bool": return n.value;
      case "na": return null;
      default: return null;
    }
  }

  // ------------------------------------------------------------ statements

  private execStatement(node: Node): void {
    this.statementsThisBar++;
    const budget = this.opts.maxStatementsPerBar ?? 200_000;
    if (this.statementsThisBar > budget) {
      throw new PineRuntimeError(`statement budget exceeded (${budget})`, this.barIndex);
    }

    switch (node.kind) {
      case "assign": {
        const v = this.eval(node.value);
        this.assign(node.name, v, node.op);
        return;
      }
      case "vardecl": {
        // `var` keeps its value across bars; without it the slot is re-initialised.
        const existing = this.slots.get(node.name);
        if (node.storage && existing && existing.history.length > 0) {
          // keep the previous value, just record it again for history lookups
          existing.push(existing.last());
          if (node.value && existing.last() === null) {
            existing.history[existing.history.length - 1] = this.eval(node.value);
          }
          return;
        }
        const v = node.value ? this.eval(node.value) : null;
        this.assign(node.name, v, "=");
        return;
      }
      case "expr": {
        this.eval(node.expr);
        return;
      }
      case "if": {
        if (toBool(this.eval(node.cond))) {
          this.execBlock(node.then);
          return;
        }
        for (const elif of node.elifs) {
          if (toBool(this.eval(elif.cond))) {
            this.execBlock(elif.then);
            return;
          }
        }
        if (node.else) this.execBlock(node.else);
        return;
      }
      case "for": {
        const from = Math.trunc(toNum(this.eval(node.from)));
        const to = Math.trunc(toNum(this.eval(node.to)));
        const step = node.step ? Math.trunc(toNum(this.eval(node.step))) : (to >= from ? 1 : -1);
        if (step === 0) throw new PineRuntimeError("for loop step cannot be 0", this.barIndex);
        const maxIter = this.opts.maxLoopIterations ?? 10_000;
        let iterations = 0;
        for (let i = from; step > 0 ? i <= to : i >= to; i += step) {
          if (++iterations > maxIter) {
            throw new PineRuntimeError(`for loop exceeded ${maxIter} iterations`, this.barIndex);
          }
          this.assign(node.varName, i, ":=");
          this.execBlock(node.body);
        }
        return;
      }
      case "while": {
        const maxIter = this.opts.maxLoopIterations ?? 10_000;
        let iterations = 0;
        while (toBool(this.eval(node.cond))) {
          if (++iterations > maxIter) {
            throw new PineRuntimeError(`while loop exceeded ${maxIter} iterations`, this.barIndex);
          }
          this.execBlock(node.body);
        }
        return;
      }
      case "func":
        return;   // hoisted already
      default:
        // an expression used as a statement
        this.eval(node);
    }
  }

  private execBlock(block: { statements: Node[] }): void {
    for (const st of block.statements) this.execStatement(st);
  }

  private assign(name: string, value: PineValue, op: "=" | ":="): void {
    let slot = this.slots.get(name);
    if (!slot) {
      slot = new SeriesSlot();
      this.slots.set(name, slot);
    }
    if (op === ":=") {
      // reassignment on the same bar replaces the last history entry
      if (slot.history.length > 0 && slot.history.length - 1 === this.barIndexOfLastWrite(name)) {
        slot.history[slot.history.length - 1] = value;
      } else {
        slot.push(value);
        this.markLastWrite(name);
      }
    } else {
      slot.push(value);
      this.markLastWrite(name);
    }
    this.scalarVar.set(name, value);
  }

  private lastWrite = new Map<string, number>();
  private barIndexAtWrite(name: string): number | undefined {
    return this.lastWrite.get(name);
  }
  private barIndexOfLastWrite(name: string): number {
    const v = this.barIndexAtWrite(name);
    return v === undefined ? -1 : v;
  }
  private markLastWrite(name: string): void {
    this.lastWrite.set(name, this.barIndex);
  }

  // ----------------------------------------------------------- expressions

  private eval(node: Node): PineValue {
    switch (node.kind) {
      case "number": return node.value;
      case "string": return node.value;
      case "bool": return node.value;
      case "na": return null;
      case "ident": return this.readVar(node.name);
      case "tuple": return toNum(this.eval(node.items[0] ?? { kind: "na" }));
      case "binary": return this.evalBinary(node);
      case "unary": {
        const v = this.eval(node.operand);
        if (node.op === "!") return !toBool(v);
        return -toNum(v);
      }
      case "ternary": {
        return toBool(this.eval(node.cond)) ? this.eval(node.then) : this.eval(node.else);
      }
      case "index": {
        // history operator: x[n]
        if (node.target.kind !== "ident") {
          throw new PineRuntimeError("history operator requires a variable", this.barIndex);
        }
        const slot = this.slots.get(node.target.name);
        const off = Math.trunc(toNum(this.eval(node.offset)));
        if (!slot) return NA;
        return slot.at(off);
      }
      case "member": {
        const obj = typeof node.object === "string" ? node.object : this.nameOf(node.object);
        return this.readMember(obj, node.property);
      }
      case "call":
        return this.evalCall(node.callee, node.args, node.named, node.id ?? 0);
      case "if": {
        if (toBool(this.eval(node.cond))) return this.evalBlockValue(node.then);
        for (const e of node.elifs) {
          if (toBool(this.eval(e.cond))) return this.evalBlockValue(e.then);
        }
        return node.else ? this.evalBlockValue(node.else) : null;
      }
      case "switch": {
        // Two arm shapes exist and they must not be conflated:
        //   1. relative:  `> 115 => 2`  -> parsed as binary(subject > 115),
        //      whose value is a BOOLEAN CONDITION to test.
        //   2. absolute:  `100 => "a"`  -> a literal to COMPARE with the subject.
        // The parser folds the switch subject into relative arms, so an arm whose
        // node is a binary comparison already carries the subject and must be
        // tested for truth. Comparing the subject to that boolean (the previous
        // behaviour) never matched, so every arm fell through to the default.
        const subject = node.subject ? this.eval(node.subject) : null;
        let fallback: PineValue = null;

        for (const c of node.cases) {
          if (c.match === null) {
            fallback = this.eval(c.result);
            continue;
          }
          const isRelativeComparison =
            c.match.kind === "binary" &&
            [">", "<", ">=", "<=", "==", "!="].includes(c.match.op);

          if (isRelativeComparison) {
            if (toBool(this.eval(c.match))) return this.eval(c.result);
            continue;
          }

          const m = this.eval(c.match);
          if (subject === null) {
            if (toBool(m)) return this.eval(c.result);
          } else if (valuesEqual(subject, m)) {
            return this.eval(c.result);
          }
        }
        return fallback;
      }
      case "assign": {
        const v = this.eval(node.value);
        this.assign(node.name, v, node.op);
        return v;
      }
      case "vardecl": {
        this.execStatement(node);
        return this.readVar(node.name);
      }
      case "block": {
        let last: PineValue = null;
        for (const st of node.statements) {
          if (st.kind === "expr") last = this.eval(st.expr);
          else this.execStatement(st);
        }
        return last;
      }
      case "expr": return this.eval(node.expr);
      case "for":
      case "while":
      case "func":
        this.execStatement(node);
        return null;
    }
  }

  private evalBlockValue(block: { statements: Node[] }): PineValue {
    let last: PineValue = null;
    for (const st of block.statements) {
      if (st.kind === "expr") {
        last = this.eval(st.expr);
      } else {
        this.execStatement(st);
        last = null;
      }
    }
    return last;
  }

  private nameOf(node: Node): string {
    if (node.kind === "ident") return node.name;
    if (node.kind === "member") {
      const base = typeof node.object === "string" ? node.object : this.nameOf(node.object);
      return `${base}.${node.property}`;
    }
    return "";
  }

  private evalBinary(node: Extract<Node, { kind: "binary" }>): PineValue {
    // short-circuit for and/or
    if (node.op === "and") {
      return toBool(this.eval(node.left)) && toBool(this.eval(node.right));
    }
    if (node.op === "or") {
      return toBool(this.eval(node.left)) || toBool(this.eval(node.right));
    }
    const l = this.eval(node.left);
    const r = this.eval(node.right);

    switch (node.op) {
      case "+": {
        if (typeof l === "string" || typeof r === "string") {
          return `${l ?? ""}${r ?? ""}`;
        }
        return toNum(l) + toNum(r);
      }
      case "-": return toNum(l) - toNum(r);
      case "*": return toNum(l) * toNum(r);
      case "/": {
        const d = toNum(r);
        return d === 0 ? NA : toNum(l) / d;
      }
      case "%": {
        const d = toNum(r);
        return d === 0 ? NA : toNum(l) % d;
      }
      case ">": return toNum(l) > toNum(r);
      case "<": return toNum(l) < toNum(r);
      case ">=": return toNum(l) >= toNum(r);
      case "<=": return toNum(l) <= toNum(r);
      case "==": return valuesEqual(l, r);
      case "!=": return !valuesEqual(l, r);
      default:
        throw new PineRuntimeError(`unsupported operator ${node.op}`, this.barIndex);
    }
  }

  private readVar(name: string): PineValue {
    if (this.declaredInputs.has(name)) {
      const slot = this.slots.get(name);
      if (slot) return slot.last();
      return this.declaredInputs.get(name)!.defval;
    }
    // built-in series
    switch (name) {
      case "open": return this.series.open[this.barIndex] ?? NA;
      case "high": return this.series.high[this.barIndex] ?? NA;
      case "low": return this.series.low[this.barIndex] ?? NA;
      case "close": return this.series.close[this.barIndex] ?? NA;
      case "volume": return this.series.volume[this.barIndex] ?? NA;
      case "time": return this.series.time[this.barIndex] ?? NA;
      case "bar_index": return this.barIndex;
      case "hl2": return ((this.series.high[this.barIndex] ?? NA) + (this.series.low[this.barIndex] ?? NA)) / 2;
      case "hlc3": {
        const h = this.series.high[this.barIndex] ?? NA;
        const l = this.series.low[this.barIndex] ?? NA;
        const c = this.series.close[this.barIndex] ?? NA;
        return (h + l + c) / 3;
      }
      case "ohlc4": {
        const o = this.series.open[this.barIndex] ?? NA;
        const h = this.series.high[this.barIndex] ?? NA;
        const l = this.series.low[this.barIndex] ?? NA;
        const c = this.series.close[this.barIndex] ?? NA;
        return (o + h + l + c) / 4;
      }
      case "na": return null;
      default: {
        const slot = this.slots.get(name);
        return slot ? slot.last() : NA;
      }
    }
  }

  private readMember(obj: string, prop: string): PineValue {
    if (obj === "strategy") {
      switch (prop) {
        case "position_size": return this.positionSize;
        case "position_avg_price": return this.positionSize === 0 ? NA : NA;
        default: return NA;
      }
    }
    return NA;
  }

  private positionSize = 0;

  // ---------------------------------------------------------------- calls

  private evalCall(
    callee: string,
    argNodes: Node[],
    namedNodes: Record<string, Node>,
    callId = 0,
  ): PineValue {
    const args = argNodes.map((a) => this.eval(a));
    const named: Record<string, PineValue> = {};
    for (const [k, v] of Object.entries(namedNodes)) named[k] = this.eval(v);

    // user-defined function
    if (this.functions.has(callee)) {
      return this.callUserFunction(callee, args);
    }

    // output functions
    if (callee === "plot") return this.doPlot(args, named);
    if (callee === "plotshape" || callee === "plotchar") return this.doShape(args, named);
    if (callee === "hline") return this.doHline(args, named);
    if (callee === "bgcolor") return this.doBgcolor(args, named);

    // strategy functions
    if (callee.startsWith("strategy.")) return this.doStrategy(callee, args, named);

    // input.* -> remembered already; return the default value
    if (callee.startsWith("input.")) {
      return args.length > 0 ? (args[0] ?? null) : null;
    }

    // ta.* and math.*
    if (callee.startsWith("ta.")) return this.doTa(callee.slice(3), args, named, callId);
    if (callee.startsWith("math.")) return doMath(callee.slice(5), args);
    if (callee.startsWith("str.")) return doStr(callee.slice(4), args);
    if (callee === "nz") return isNa(args[0] ?? NA) ? (args[1] ?? 0) : (args[0] ?? 0);

    throw new PineRuntimeError(`unsupported function ${callee}()`, this.barIndex);
  }

  private callUserFunction(name: string, args: PineValue[]): PineValue {
    const fn = this.functions.get(name)!;
    // Bind parameters by temporarily shadowing the slots, then restore.
    const saved = new Map<string, SeriesSlot | undefined>();
    fn.params.forEach((p, i) => {
      saved.set(p, this.slots.get(p));
      const slot = new SeriesSlot();
      slot.push(args[i] ?? null);
      this.slots.set(p, slot);
    });
    try {
      const body = fn.body as Extract<Node, { kind: "func" }>;
      return this.evalBlockValue(body.body);
    } finally {
      for (const [p, slot] of saved) {
        if (slot) this.slots.set(p, slot);
        else this.slots.delete(p);
      }
    }
  }

  private doPlot(args: PineValue[], named: Record<string, PineValue>): PineValue {
    const value = toNum(args[0] ?? NA);
    const titleNode = named["title"];
    const title = typeof titleNode === "string" ? titleNode : `plot${this.plots.size}`;
    const color = typeof named["color"] === "string" ? named["color"] : undefined;
    const styleRaw = typeof named["style"] === "string" ? named["style"] : "line";
    const style = styleRaw.includes("histogram")
      ? "histogram" as const
      : styleRaw.includes("columns") ? "columns" as const : "line" as const;

    let entry = this.plots.get(title);
    if (!entry) {
      entry = {
        values: new Array<number>(this.series.length).fill(NA),
        pane: this.program.headerArgs["overlay"] !== undefined ? "main" : "separate",
        ...(color !== undefined ? { color } : {}),
        style,
      };
      this.plots.set(title, entry);
    }
    entry.values[this.barIndex] = value;
    return value;
  }

  private doShape(args: PineValue[], named: Record<string, PineValue>): PineValue {
    const cond = toBool(args[0] ?? false);
    if (!cond) return null;
    const text = typeof named["text"] === "string"
      ? named["text"]
      : typeof named["title"] === "string" ? named["title"] as string : "";
    const styleRaw = typeof named["style"] === "string" ? named["style"] : "shape.circle";
    this.shapes.push({
      barIndex: this.barIndex,
      price: toNum(this.readVar("close")),
      text,
      kind: styleRaw,
    });
    return null;
  }

  private doHline(args: PineValue[], named: Record<string, PineValue>): PineValue {
    const price = toNum(args[0] ?? NA);
    const titleNode = named["title"];
    const title = typeof titleNode === "string" ? titleNode : `${price}`;
    const color = typeof named["color"] === "string" ? named["color"] : undefined;
    if (this.barIndex === 0) {
      this.hlines.push({ price, title, ...(color !== undefined ? { color } : {}) });
    }
    return price;
  }

  private doBgcolor(args: PineValue[], named: Record<string, PineValue>): PineValue {
    const color = typeof args[0] === "string" ? args[0] : null;
    // bgcolor's first positional argument is a CONDITION when a color is named,
    // so only record when we are confident it is a literal colour.
    if (color && named["color"] === undefined) {
      this.bgcolors.push({ barIndex: this.barIndex, color });
    } else if (toBool(args[0] ?? false) && typeof named["color"] === "string") {
      this.bgcolors.push({ barIndex: this.barIndex, color: named["color"] as string });
    }
    return null;
  }

  private doStrategy(callee: string, args: PineValue[], named: Record<string, PineValue>): PineValue {
    const base = { barIndex: this.barIndex };
    switch (callee) {
      case "strategy.entry": {
        const dirRaw = typeof args[0] === "string" ? args[0] : "long";
        const direction = dirRaw === "short" ? "short" as const : "long" as const;
        const qty = named["qty"] !== undefined ? toNum(named["qty"]) : 1;
        this.orders.push({ action: "entry", direction, qty, ...base });
        this.positionSize = direction === "long" ? qty : -qty;
        return null;
      }
      case "strategy.exit": {
        this.orders.push({
          action: "exit",
          ...(named["stop"] !== undefined ? { stop: toNum(named["stop"]) } : {}),
          ...(named["limit"] !== undefined ? { limit: toNum(named["limit"]) } : {}),
          ...base,
        });
        this.positionSize = 0;
        return null;
      }
      case "strategy.close": {
        this.orders.push({ action: "close", ...base });
        this.positionSize = 0;
        return null;
      }
      case "strategy.close_all": {
        this.orders.push({ action: "close_all", ...base });
        this.positionSize = 0;
        return null;
      }
      case "strategy.order": {
        const dirRaw = typeof args[0] === "string" ? args[0] : "long";
        this.orders.push({
          action: "order",
          direction: dirRaw === "short" ? "short" : "long",
          qty: named["qty"] !== undefined ? toNum(named["qty"]) : 1,
          ...base,
        });
        return null;
      }
      default:
        throw new PineRuntimeError(`unsupported ${callee}`, this.barIndex);
    }
  }

  // ------------------------------------------------------------- ta.* math

  private cachedLine(key: string, build: () => Float64Array): Float64Array {
    const hit = this.cache.get(key);
    if (hit) return hit;
    const line = build();
    this.cache.set(key, line);
    return line;
  }

  private doTa(
    name: string,
    args: PineValue[],
    named: Record<string, PineValue>,
    callId = 0,
  ): PineValue {
    const period = args.length > 1 ? Math.trunc(toNum(args[1])) : 14;
    const i = this.barIndex;

    switch (name) {
      case "sma": {
        const line = this.cachedLine(`sma:${period}`, () => sma(this.series.close, period));
        return line[i] ?? NA;
      }
      case "ema": {
        const line = this.cachedLine(`ema:${period}`, () => ema(this.series.close, period));
        return line[i] ?? NA;
      }
      case "rma": {
        const line = this.cachedLine(`rma:${period}`, () => rma(this.series.close, period));
        return line[i] ?? NA;
      }
      case "wma": {
        const line = this.cachedLine(`wma:${period}`, () => wma(this.series.close, period));
        return line[i] ?? NA;
      }
      case "rsi": {
        const line = this.cachedLine(`rsi:${period}`, () => rsi(this.series, period));
        return line[i] ?? NA;
      }
      case "atr": {
        const line = this.cachedLine(`atr:${period}`, () => atr(this.series, period));
        return line[i] ?? NA;
      }
      case "macd": {
        const fast = period;
        const slow = args.length > 2 ? Math.trunc(toNum(args[2])) : 26;
        const sig = args.length > 3 ? Math.trunc(toNum(args[3])) : 9;
        const line = this.cachedLine(`macd:${fast}:${slow}:${sig}`,
          () => macd(this.series, fast, slow, sig).macd);
        return line[i] ?? NA;
      }
      case "stoch": {
        const k = period;
        const d = args.length > 2 ? Math.trunc(toNum(args[2])) : 3;
        const smooth = args.length > 3 ? Math.trunc(toNum(args[3])) : 3;
        const line = this.cachedLine(`stochk:${k}:${d}:${smooth}`,
          () => stochastic(this.series, k, d, smooth).k);
        return line[i] ?? NA;
      }
      case "bb": {
        const mult = args.length > 2 ? toNum(args[2]) : 2;
        const bb = this.cachedBB(period, mult);
        // Pine returns a tuple; we expose the middle band for single-value use.
        return bb.middle[i] ?? NA;
      }
      case "crossover":
      case "crossunder": {
        // Previous-bar operands are keyed by the CALL SITE, not by the bar index:
        // including the index in the key made every bar look up a fresh entry and
        // always read NA, so these functions could never fire.
        const siteKey = `${name}#${callId}`;
        const a = toNum(args[0] ?? NA);
        const b = toNum(args[1] ?? NA);
        const prev = this.prevArg(siteKey);
        this.rememberPrev(siteKey, [a, b]);
        if (!prev) return false;
        const [prevA, prevB] = prev;
        if (isNa(a) || isNa(b) || isNa(prevA) || isNa(prevB)) return false;
        return name === "crossover"
          ? prevA <= prevB && a > b
          : prevA >= prevB && a < b;
      }
      case "highest":
      case "highesthigh": {
        const len = Math.max(1, period);
        return highestHigh(this.series, i, len);
      }
      case "lowest":
      case "lowestlow": {
        const len = Math.max(1, period);
        return lowestLow(this.series, i, len);
      }
      case "change": {
        const prev = this.series.close[i - 1];
        if (prev === undefined) return NA;
        return (this.series.close[i] ?? NA) - prev;
      }
      case "barssince": {
        // approximated via a slot the script maintains; without it, NA
        return NA;
      }
      case "pivothigh":
      case "pivotlow": {
        const left = Math.trunc(toNum(args[1] ?? 1));
        const right = Math.trunc(toNum(args[2] ?? 1));
        const idx = i - right;   // pivot is confirmed `right` bars later
        if (idx - left < 0 || idx + right >= this.series.length) return NA;
        const isHigh = name === "pivothigh";
        const centre = isHigh ? this.series.high[idx]! : this.series.low[idx]!;
        for (let j = idx - left; j <= idx + right; j++) {
          if (j === idx) continue;
          const v = isHigh ? this.series.high[j]! : this.series.low[j]!;
          if (isHigh ? v > centre : v < centre) return NA;
        }
        return centre;
      }
      default:
        throw new PineRuntimeError(`unsupported ta.${name}()`, this.barIndex);
    }
  }

  private prevValues = new Map<string, [number, number]>();
  private prevArg(key: string): [number, number] | undefined {
    return this.prevValues.get(key);
  }
  private rememberPrev(key: string, v: [number, number]): void {
    this.prevValues.set(key, v);
  }

  private bbCache = new Map<string, ReturnType<typeof bollinger>>();
  private cachedBB(period: number, mult: number): ReturnType<typeof bollinger> {
    const key = `${period}:${mult}`;
    const hit = this.bbCache.get(key);
    if (hit) return hit;
    const v = bollinger(this.series, period, mult);
    this.bbCache.set(key, v);
    return v;
  }
}

function valuesEqual(a: PineValue, b: PineValue): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  if (typeof a === "number" && typeof b === "number") {
    if (Number.isNaN(a) && Number.isNaN(b)) return true;
    return a === b;
  }
  return a === b;
}

function doMath(name: string, args: PineValue[]): PineValue {
  const x = toNum(args[0] ?? NA);
  const y = args.length > 1 ? toNum(args[1]) : 0;
  switch (name) {
    case "abs": return Math.abs(x);
    case "max": return Math.max(x, y);
    case "min": return Math.min(x, y);
    case "round": return Math.round(x);
    case "floor": return Math.floor(x);
    case "ceil": return Math.ceil(x);
    case "sqrt": return x < 0 ? NA : Math.sqrt(x);
    case "pow": return Math.pow(x, y);
    case "log": return x <= 0 ? NA : Math.log(x);
    case "sign": return Math.sign(x);
    case "avg": {
      if (args.length === 0) return NA;
      let sum = 0;
      for (const v of args) sum += toNum(v);
      return sum / args.length;
    }
    default:
      throw new PineRuntimeError(`unsupported math.${name}()`, 0);
  }
}

function doStr(name: string, args: PineValue[]): PineValue {
  const s = args[0] === null || args[0] === undefined ? "" : String(args[0]);
  switch (name) {
    case "tostring": return s;
    case "length": return s.length;
    case "toupper": return s.toUpperCase();
    case "tolower": return s.toLowerCase();
    case "contains": return s.includes(String(args[1] ?? ""));
    case "tonumber": {
      const n = Number(s);
      return Number.isFinite(n) ? n : NA;
    }
    default:
      throw new PineRuntimeError(`unsupported str.${name}()`, 0);
  }
}

/** Convenience: parse + run in one call. */
export function runPine(series: CandleSeries, program: Program, opts?: RuntimeOptions): RunResult {
  return new PineRuntime(series, program, opts).run();
}
