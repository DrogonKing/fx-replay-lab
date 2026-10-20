/**
 * AST for the supported Pine subset.
 * Kept deliberately small and explicit so the compatibility table can be
 * generated from it rather than hand-maintained.
 */

export type Node =
  | NumberLit | StringLit | BoolLit | NaLit | Ident
  | Tuple | Call | Member | Index | Unary | Binary | Ternary
  | Assign | VarDecl | IfStmt | ForStmt | WhileStmt | SwitchStmt
  | FuncDecl | ExprStmt | Block;

export interface NumberLit { kind: "number"; value: number }
export interface StringLit { kind: "string"; value: string }
export interface BoolLit { kind: "bool"; value: boolean }
export interface NaLit { kind: "na" }
export interface Ident { kind: "ident"; name: string }
export interface Tuple { kind: "tuple"; items: Node[] }
/**
 * `ta.sma(close, 14)` -> callee "ta.sma"
 *
 * `id` is a stable per-parse call-site identifier. It exists so stateful
 * functions (crossover/crossunder) can remember their own previous-bar inputs
 * without keying on the bar index, which would make the previous value
 * unreachable on every bar.
 */
export interface Call {
  kind: "call";
  callee: string;
  args: Node[];
  named: Record<string, Node>;
  id?: number;
}
export interface Member { kind: "member"; object: string | Node; property: string }
export interface Index { kind: "index"; target: Node; offset: Node }
export interface Unary { kind: "unary"; op: string; operand: Node }
export interface Binary { kind: "binary"; op: string; left: Node; right: Node }
export interface Ternary { kind: "ternary"; cond: Node; then: Node; else: Node }
export interface Assign { kind: "assign"; name: string; op: "=" | ":="; value: Node }
export interface VarDecl {
  kind: "vardecl";
  name: string;
  /** "var" persists across bars, "varip" within a bar as well (treated same here) */
  storage: "var" | "varip" | null;
  value: Node | null;
}
export interface IfStmt { kind: "if"; cond: Node; then: Block; elifs: Array<{ cond: Node; then: Block }>; else: Block | null }
export interface ForStmt { kind: "for"; varName: string; from: Node; to: Node; step: Node | null; body: Block }
export interface WhileStmt { kind: "while"; cond: Node; body: Block }
export interface SwitchStmt {
  kind: "switch";
  subject: Node | null;
  cases: Array<{ match: Node | null; result: Node }>;
}
export interface FuncDecl { kind: "func"; name: string; params: string[]; body: Block }
export interface ExprStmt { kind: "expr"; expr: Node }
export interface Block { kind: "block"; statements: Node[] }

/** Result of parsing one script. */
export interface Program {
  version: number;
  /** indicator(...) or strategy(...) */
  scriptKind: "indicator" | "strategy" | "unknown";
  headerArgs: Record<string, Node>;
  statements: Node[];
}
