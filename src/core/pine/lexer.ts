/**
 * Pine Script lexer for the documented subset (//@version=5).
 *
 * Scope note, stated plainly: this is an INTERPRETER for a defined subset, not a
 * Pine clone. `docs/PINE-COMPATIBILITY.md` lists exactly what runs. Anything
 * outside it must raise a precise error at a known line/column -- silently
 * ignoring an unsupported construct would produce a chart that looks right and
 * is wrong, which is the worst possible outcome for a trading tool.
 */

export type TokenType =
  | "number" | "string" | "bool" | "ident" | "keyword"
  | "op" | "punct" | "newline" | "comment" | "eof";

export interface Token {
  type: TokenType;
  value: string;
  line: number;
  col: number;
}

export class PineSyntaxError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly col: number,
  ) {
    super(`${message} (line ${line}, col ${col})`);
    this.name = "PineSyntaxError";
  }
}

const KEYWORDS = new Set([
  "if", "else", "for", "while", "to", "by", "switch", "var", "varip",
  "and", "or", "not", "true", "false", "na", "import", "export",
  "break", "continue", "return",
]);

const OPS = [
  ":=", "==", "!=", ">=", "<=", "+=", "-=", "*=", "/=", "%=",
  "=>", "?", ">", "<", "+", "-", "*", "/", "%", "=", "!", ":",
];

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;

  const push = (type: TokenType, value: string, l: number, c: number): void => {
    tokens.push({ type, value, line: l, col: c });
  };

  while (i < src.length) {
    const ch = src[i]!;

    // newlines carry meaning in Pine (statement separators)
    if (ch === "\n") {
      push("newline", "\n", line, col);
      i++;
      line++;
      col = 1;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      i++;
      col++;
      continue;
    }

    // comments: // ... and //@version=
    if (ch === "/" && src[i + 1] === "/") {
      const startCol = col;
      let j = i;
      while (j < src.length && src[j] !== "\n") j++;
      push("comment", src.slice(i, j), line, startCol);
      col += j - i;
      i = j;
      continue;
    }

    // strings: "..." and '...'
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const startCol = col;
      const startLine = line;
      let j = i + 1;
      let out = "";
      while (j < src.length && src[j] !== quote) {
        if (src[j] === "\\" && j + 1 < src.length) {
          const esc = src[j + 1]!;
          out += esc === "n" ? "\n" : esc === "t" ? "\t" : esc;
          j += 2;
          continue;
        }
        if (src[j] === "\n") break;   // unterminated
        out += src[j];
        j++;
      }
      if (src[j] !== quote) {
        throw new PineSyntaxError("unterminated string", startLine, startCol);
      }
      push("string", out, startLine, startCol);
      col += j - i + 1;
      i = j + 1;
      continue;
    }

    // numbers (incl. 1e-3 and .5)
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const startCol = col;
      let j = i;
      while (j < src.length && /[0-9._]/.test(src[j]!)) j++;
      if (src[j] === "e" || src[j] === "E") {
        j++;
        if (src[j] === "+" || src[j] === "-") j++;
        while (j < src.length && /[0-9]/.test(src[j]!)) j++;
      }
      push("number", src.slice(i, j), line, startCol);
      col += j - i;
      i = j;
      continue;
    }

    // identifiers / keywords; Pine allows dots in namespaces (ta.sma)
    if (/[A-Za-z_]/.test(ch)) {
      const startCol = col;
      let j = i;
      while (j < src.length && /[A-Za-z0-9_.]/.test(src[j]!)) j++;
      const word = src.slice(i, j);
      if (word === "true" || word === "false") push("bool", word, line, startCol);
      else if (KEYWORDS.has(word)) push("keyword", word, line, startCol);
      else push("ident", word, line, startCol);
      col += j - i;
      i = j;
      continue;
    }

    // operators, longest match first
    let matched = false;
    for (const op of OPS) {
      if (src.startsWith(op, i)) {
        push("op", op, line, col);
        i += op.length;
        col += op.length;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // punctuation
    if ("()[]{},;".includes(ch)) {
      push("punct", ch, line, col);
      i++;
      col++;
      continue;
    }

    throw new PineSyntaxError(`unexpected character ${JSON.stringify(ch)}`, line, col);
  }

  push("eof", "", line, col);
  return tokens;
}

/** Strip comments and blank lines; used by the header scanner. */
export function significant(tokens: readonly Token[]): Token[] {
  return tokens.filter((t) => t.type !== "comment");
}
