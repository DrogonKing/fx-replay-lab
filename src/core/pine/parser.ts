/**
 * Recursive-descent parser for the Pine subset.
 *
 * Pine is indentation-sensitive, so a pre-pass converts indentation into
 * explicit INDENT/DEDENT markers; the parser then treats blocks uniformly
 * everywhere (if/for/while/switch/function bodies).
 */
import { tokenize, type Token, PineSyntaxError } from "./lexer.js";
import type {
  Node, Program, Block, Call, ExprStmt, VarDecl,
} from "./ast.js";

type PToken = Token;

/** Convert newline+indent into INDENT/DEDENT tokens. */
function withIndentation(tokens: Token[]): PToken[] {
  const out: PToken[] = [];
  // stack of indentation widths
  const stack: number[] = [0];
  let atLineStart = true;
  let pendingWidth = 0;
  let pendingLine = 1;
  let pendingCol = 1;
  let lineHasToken = false;

  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!;

    if (t.type === "comment") {
      // a comment-only line should not open a block
      continue;
    }

    if (t.type === "newline") {
      if (lineHasToken) out.push(t);
      atLineStart = true;
      pendingWidth = 0;
      lineHasToken = false;
      continue;
    }

    if (t.type === "eof") {
      while (stack.length > 1) {
        stack.pop();
        out.push({ type: "dedent" as unknown as Token["type"], value: "", line: t.line, col: 1 });
      }
      out.push(t);
      break;
    }

    if (atLineStart) {
      // measure the indentation of the first real token by its column
      pendingWidth = t.col - 1;
      pendingLine = t.line;
      pendingCol = t.col;
      const top = stack[stack.length - 1]!;
      if (pendingWidth > top) {
        stack.push(pendingWidth);
        out.push({ type: "indent" as unknown as Token["type"], value: "", line: pendingLine, col: pendingCol });
      } else if (pendingWidth < top) {
        while (stack.length > 1 && stack[stack.length - 1]! > pendingWidth) {
          stack.pop();
          out.push({ type: "dedent" as unknown as Token["type"], value: "", line: pendingLine, col: pendingCol });
        }
      }
      atLineStart = false;
    }

    out.push(t);
    lineHasToken = true;
  }
  return out;
}

export class Parser {
  private pos = 0;
  /** monotonic counter for stable call-site ids (see ast.Call.id) */
  private callSeq = 0;
  constructor(private tokens: PToken[]) {}

  private peek(offset = 0): PToken | undefined {
    return this.tokens[this.pos + offset];
  }
  private at(type: string, value?: string): boolean {
    const t = this.peek();
    if (!t) return false;
    if (String(t.type) !== type) return false;
    return value === undefined || t.value === value;
  }
  private next(): PToken {
    const t = this.peek();
    if (!t) throw new PineSyntaxError("unexpected end of input", 0, 0);
    this.pos++;
    return t;
  }
  private expect(type: string, value?: string): PToken {
    const t = this.peek();
    if (!t || String(t.type) !== type || (value !== undefined && t.value !== value)) {
      const got = t ? `${String(t.type)} ${JSON.stringify(t.value)}` : "end of input";
      throw new PineSyntaxError(
        `expected ${type}${value ? ` ${JSON.stringify(value)}` : ""}, got ${got}`,
        t?.line ?? 0,
        t?.col ?? 0,
      );
    }
    return this.next();
  }
  private skipNewlines(): void {
    while (this.at("newline")) this.next();
  }

  // ------------------------------------------------------------- program
  parseProgram(): Program {
    this.skipNewlines();
    const version = 5;
    let scriptKind: Program["scriptKind"] = "unknown";
    const headerArgs: Record<string, Node> = {};

    // //@version=N appears as a comment, which tokenize() keeps; find it first.
    while (this.at("ident") || this.at("keyword")) {
      const t = this.peek()!;
      if (t.value === "indicator" || t.value === "strategy") {
        scriptKind = t.value;
        this.next();
        this.expect("punct", "(");
        const { positional, named } = this.parseArgs(")");
        Object.assign(headerArgs, named);
        // Pine's first positional argument of indicator()/strategy() is the
        // title. Surfacing it as `title` avoids every caller having to know that.
        if (positional.length > 0 && headerArgs["title"] === undefined) {
          headerArgs["title"] = positional[0]!;
        }
        this.expect("punct", ")");
        this.skipNewlines();
        break;
      }
      break;
    }

    const statements: Node[] = [];
    this.skipNewlines();
    while (!this.at("eof")) {
      const st = this.parseStatement();
      if (st) statements.push(st);
      this.skipNewlines();
    }
    return { version, scriptKind, headerArgs, statements };
  }

  // ----------------------------------------------------------- statements
  private parseStatement(): Node | null {
    this.skipNewlines();
    const t = this.peek();
    if (!t) return null;
    if (String(t.type) === "dedent") { this.next(); return null; }
    if (String(t.type) === "indent") { this.next(); return this.parseStatement(); }

    // if / for / while / switch
    if (t.type === "keyword" && t.value === "if") return this.parseIf();
    if (t.type === "keyword" && t.value === "for") return this.parseFor();
    if (t.type === "keyword" && t.value === "while") return this.parseWhile();
    if (t.type === "keyword" && t.value === "switch") return this.parseSwitch();

    // var / varip declaration
    if (t.type === "keyword" && (t.value === "var" || t.value === "varip")) {
      this.next();
      const name = this.expect("ident").value;
      let value: Node | null = null;
      if (this.at("op", "=")) {
        this.next();
        value = this.parseExpr();
      }
      const decl: VarDecl = {
        kind: "vardecl", name,
        storage: t.value as "var" | "varip",
        value,
      };
      this.consumeLineEnd();
      return decl;
    }

    // function declaration: name(params) => body
    if (t.type === "ident" && this.peek(1)?.type === "punct" && this.peek(1)?.value === "(") {
      const save = this.pos;
      this.next();
      this.next();
      const params: string[] = [];
      let ok = true;
      if (!this.at("punct", ")")) {
        for (;;) {
          const p = this.peek();
          if (!p || p.type !== "ident") { ok = false; break; }
          params.push(this.next().value);
          if (this.at("punct", ",")) { this.next(); continue; }
          break;
        }
      }
      if (ok && this.at("punct", ")")) {
        this.next();
        if (this.at("op", "=>")) {
          this.next();
          const body = this.parseBlockOrInline();
          return { kind: "func", name: t.value, params, body };
        }
      }
      this.pos = save;   // not a function declaration after all
    }

    // assignment or bare expression
    const expr = this.parseExpr();
    if (this.at("op", "=") || this.at("op", ":=")) {
      const op = this.next().value as "=" | ":=";
      const value = this.parseExpr();
      if (expr.kind !== "ident") {
        throw new PineSyntaxError("assignment target must be a name", t.line, t.col);
      }
      const a: Node = { kind: "assign", name: expr.name, op, value };
      this.consumeLineEnd();
      return a;
    }

    const es: ExprStmt = { kind: "expr", expr };
    // tuple destructuring: [a, b] = ...
    this.consumeLineEnd();
    return es;
  }

  private consumeLineEnd(): void {
    if (this.at("newline")) this.next();
  }

  private parseBlockOrInline(): Block {
    if (this.at("newline")) {
      this.next();
      this.skipNewlines();
      if (String(this.peek()?.type) === "indent") {
        this.next();
        const statements: Node[] = [];
        for (;;) {
          this.skipNewlines();
          const p = this.peek();
          if (!p || String(p.type) === "dedent") { this.next(); break; }
          if (p.type === "eof") break;
          const st = this.parseStatement();
          if (st) statements.push(st);
        }
        return { kind: "block", statements };
      }
      // single statement on the following line
      const st = this.parseStatement();
      return { kind: "block", statements: st ? [st] : [] };
    }
    // inline: same line
    const st = this.parseStatement();
    return { kind: "block", statements: st ? [st] : [] };
  }

  private parseIf(): Node {
    this.expect("keyword", "if");
    const cond = this.parseExpr();
    const then = this.parseBlockOrInline();

    const elifs: Array<{ cond: Node; then: Block }> = [];
    let elseBlock: Block | null = null;

    for (;;) {
      this.skipNewlines();
      if (this.at("keyword", "else")) {
        this.next();
        if (this.at("keyword", "if")) {
          this.next();
          const c = this.parseExpr();
          const b = this.parseBlockOrInline();
          elifs.push({ cond: c, then: b });
          continue;
        }
        elseBlock = this.parseBlockOrInline();
      }
      break;
    }
    return { kind: "if", cond, then, elifs, else: elseBlock };
  }

  private parseFor(): Node {
    this.expect("keyword", "for");
    const varName = this.expect("ident").value;
    this.expect("op", "=");
    const from = this.parseExpr();
    if (this.at("keyword", "to")) this.next();
    else throw new PineSyntaxError("expected 'to' in for loop", this.peek()?.line ?? 0, this.peek()?.col ?? 0);
    const to = this.parseExpr();
    let step: Node | null = null;
    if (this.at("keyword", "by")) {
      this.next();
      step = this.parseExpr();
    }
    const body = this.parseBlockOrInline();
    return { kind: "for", varName, from, to, step, body };
  }

  private parseWhile(): Node {
    this.expect("keyword", "while");
    const cond = this.parseExpr();
    const body = this.parseBlockOrInline();
    return { kind: "while", cond, body };
  }

  private parseSwitch(): Node {
    this.expect("keyword", "switch");
    let subject: Node | null = null;
    if (!this.at("newline")) subject = this.parseExpr();
    this.skipNewlines();
    if (String(this.peek()?.type) === "indent") this.next();
    const cases: Array<{ match: Node | null; result: Node }> = [];
    for (;;) {
      this.skipNewlines();
      const p = this.peek();
      if (!p || String(p.type) === "dedent" || p.type === "eof") {
        if (String(p?.type) === "dedent") this.next();
        break;
      }
      if (this.at("op", "=>")) {
        this.next();
        const result = this.parseExpr();
        cases.push({ match: null, result });     // default arm
        this.consumeLineEnd();
        continue;
      }

      // Pine allows a subjectless comparison in a switch arm:
      //     switch close
      //         > 100 => 1
      // The arm then means "subject > 100". Parsing it as a normal expression
      // fails because '>' is a binary operator with no left operand, so it is
      // rebuilt here against the switch subject.
      const head = this.peek();
      const isComparisonArm =
        head !== undefined && head.type === "op" &&
        [">", "<", ">=", "<=", "==", "!="].includes(head.value);

      let match: Node;
      if (isComparisonArm) {
        const op = this.next().value;
        const right = this.parseExpr();
        if (subject === null) {
          throw new PineSyntaxError(
            "comparison arm in switch requires a subject",
            head.line, head.col,
          );
        }
        match = { kind: "binary", op, left: subject, right };
      } else {
        match = this.parseExpr();
      }

      this.expect("op", "=>");
      const result = this.parseExpr();
      cases.push({ match, result });
      this.consumeLineEnd();
    }
    return { kind: "switch", subject, cases };
  }

  // ---------------------------------------------------------- expressions
  parseExpr(): Node {
    return this.parseTernary();
  }

  private parseTernary(): Node {
    const cond = this.parseOr();
    if (this.at("op", "?")) {
      this.next();
      const then = this.parseExpr();
      this.expect("op", ":");
      const els = this.parseExpr();
      return { kind: "ternary", cond, then, else: els };
    }
    return cond;
  }

  private parseOr(): Node {
    let left = this.parseAnd();
    while (this.at("keyword", "or")) {
      this.next();
      const right = this.parseAnd();
      left = { kind: "binary", op: "or", left, right };
    }
    return left;
  }

  private parseAnd(): Node {
    let left = this.parseEquality();
    while (this.at("keyword", "and")) {
      this.next();
      const right = this.parseEquality();
      left = { kind: "binary", op: "and", left, right };
    }
    return left;
  }

  private parseEquality(): Node {
    let left = this.parseComparison();
    for (;;) {
      if (this.at("op", "==") || this.at("op", "!=")) {
        const op = this.next().value;
        const right = this.parseComparison();
        left = { kind: "binary", op, left, right };
        continue;
      }
      return left;
    }
  }

  private parseComparison(): Node {
    let left = this.parseAdditive();
    for (;;) {
      const t = this.peek();
      if (t && t.type === "op" && [">", "<", ">=", "<="].includes(t.value)) {
        const op = this.next().value;
        const right = this.parseAdditive();
        left = { kind: "binary", op, left, right };
        continue;
      }
      return left;
    }
  }

  private parseAdditive(): Node {
    let left = this.parseMultiplicative();
    for (;;) {
      const t = this.peek();
      if (t && t.type === "op" && (t.value === "+" || t.value === "-")) {
        const op = this.next().value;
        const right = this.parseMultiplicative();
        left = { kind: "binary", op, left, right };
        continue;
      }
      return left;
    }
  }

  private parseMultiplicative(): Node {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t && t.type === "op" && (t.value === "*" || t.value === "/" || t.value === "%")) {
        const op = this.next().value;
        const right = this.parseUnary();
        left = { kind: "binary", op, left, right };
        continue;
      }
      return left;
    }
  }

  private parseUnary(): Node {
    const t = this.peek();
    const isUnary =
      (t?.type === "op" && (t.value === "-" || t.value === "!")) ||
      (t?.type === "keyword" && t.value === "not");
    if (isUnary) {
      const raw = this.next().value;
      const op = raw === "not" ? "!" : raw;
      const operand = this.parseUnary();
      return { kind: "unary", op, operand };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Node {
    let node = this.parsePrimary();
    for (;;) {
      if (this.at("punct", "[")) {
        this.next();
        const offset = this.parseExpr();
        this.expect("punct", "]");
        node = { kind: "index", target: node, offset };
        continue;
      }
      if (this.at("punct", ".")) {
        this.next();
        const prop = this.expect("ident").value;
        node = { kind: "member", object: node, property: prop };
        continue;
      }
      return node;
    }
  }

  private parsePrimary(): Node {
    const t = this.peek();
    if (!t) throw new PineSyntaxError("unexpected end of input", 0, 0);

    if (t.type === "number") {
      this.next();
      return { kind: "number", value: Number(t.value) };
    }
    if (t.type === "string") {
      this.next();
      return { kind: "string", value: t.value };
    }
    if (t.type === "bool") {
      this.next();
      return { kind: "bool", value: t.value === "true" };
    }
    if (t.type === "keyword" && t.value === "na") {
      this.next();
      return { kind: "na" };
    }
    // Pine treats `switch` and `if` as expressions, so they may appear on the
    // right-hand side of an assignment or inside a call argument.
    if (t.type === "keyword" && t.value === "switch") {
      return this.parseSwitch();
    }
    if (t.type === "keyword" && t.value === "if") {
      return this.parseIf();
    }
    if (t.type === "punct" && t.value === "(") {
      this.next();
      const e = this.parseExpr();
      this.expect("punct", ")");
      return e;
    }
    if (t.type === "punct" && t.value === "[") {
      // tuple literal
      this.next();
      const items: Node[] = [];
      if (!this.at("punct", "]")) {
        for (;;) {
          items.push(this.parseExpr());
          if (this.at("punct", ",")) { this.next(); continue; }
          break;
        }
      }
      this.expect("punct", "]");
      return { kind: "tuple", items };
    }
    if (t.type === "ident" || t.type === "keyword") {
      // dotted callee or member chain
      let name = t.value;
      this.next();
      while (this.at("punct", ".")) {
        this.next();
        const prop = this.expect("ident").value;
        name = `${name}.${prop}`;
      }
      if (this.at("punct", "(")) {
        this.next();
        const { positional, named } = this.parseArgs(")");
        this.expect("punct", ")");
        const call: Call = {
          kind: "call", callee: name, args: positional, named, id: this.callSeq++,
        };
        return call;
      }
      return { kind: "ident", name };
    }

    throw new PineSyntaxError(
      `unexpected token ${String(t.type)} ${JSON.stringify(t.value)}`,
      t.line, t.col,
    );
  }

  private parseArgs(close: string): { positional: Node[]; named: Record<string, Node> } {
    const positional: Node[] = [];
    const named: Record<string, Node> = {};
    if (this.at("punct", close)) return { positional, named };
    for (;;) {
      // named argument: ident = expr
      const t = this.peek();
      if (t && t.type === "ident" && this.peek(1)?.type === "op" && this.peek(1)?.value === "=") {
        const key = this.next().value;
        this.next();                      // '='
        named[key] = this.parseExpr();
      } else {
        positional.push(this.parseExpr());
      }
      if (this.at("punct", ",")) { this.next(); continue; }
      break;
    }
    return { positional, named };
  }

  private parseNamedArgs(close: string): Record<string, Node> {
    return this.parseArgs(close).named;
  }
}

export interface ParseOutput {
  program: Program;
  errors: string[];
}

/** Parse source, returning the program plus any header errors. */
export function parsePine(src: string): Program {
  const raw = tokenize(src);
  const tokens = withIndentation(raw);
  const p = new Parser(tokens);
  return p.parseProgram();
}

/** Extract //@version=N from the raw source (it is a comment to the lexer). */
export function detectVersion(src: string): number {
  const m = /\/\/\s*@version\s*=\s*(\d+)/.exec(src);
  return m ? Number(m[1]) : 5;
}
