/**
 * User-defined symbols.
 *
 * The shipped list is hardcoded, which is fine for the majors and useless for anything else:
 * a broker's contract size, lot step or spread for an exotic, an index CFD or a crypto pair
 * is not in this repo and cannot be guessed. This lets the user add one.
 *
 * Validation is strict and refuses rather than repairing: a symbol with a wrong contract size
 * silently multiplies every P&L by that factor, and nothing downstream can detect it.
 */
import type { SymbolSpec } from "./types.js";
import { DEFAULT_SYMBOLS } from "./symbol.js";

/** Merge user symbols over the defaults, user first so a custom overrides a built-in. */
export function mergeSymbols(custom: readonly SymbolSpec[]): SymbolSpec[] {
  const byName = new Map<string, SymbolSpec>();
  for (const s of DEFAULT_SYMBOLS) byName.set(s.name.toUpperCase(), s);
  // a user symbol with the same name REPLACES the built-in: that is the whole point of being
  // able to add one (to correct a contract size, say)
  for (const s of custom) byName.set(s.name.toUpperCase(), s);
  return Array.from(byName.values());
}

export interface SymbolCheck {
  ok: boolean;
  /** field name -> reason */
  errors: Record<string, string>;
}

const isPos = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/**
 * Validate a candidate symbol.
 *
 * Every rule here exists because getting it wrong produces plausible, wrong money:
 *   - contractSize wrong scales every P&L by that factor;
 *   - lotStep that does not divide into lotMax makes the largest size unreachable;
 *   - digits < 0 or a non-integer digits breaks every price round;
 *   - a name with a space breaks the workspace key, which is `symbol::timeframe`.
 */
export function validateSymbol(sym: Partial<SymbolSpec>, existing: readonly string[] = []): SymbolCheck {
  const errors: Record<string, string> = {};

  const name = typeof sym.name === "string" ? sym.name.trim() : "";
  if (name === "") errors.name = "a name is required";
  else if (!/^[A-Za-z0-9._=-]{1,20}$/.test(name)) {
    errors.name = "letters, digits, dot, dash, underscore or = only, up to 20 characters";
  } else if (existing.some((e) => e.toUpperCase() === name.toUpperCase())) {
    errors.name = "a symbol with this name already exists";
  }

  if (!isPos(sym.digits) || !Number.isInteger(sym.digits) || sym.digits > 8) {
    errors.digits = "price decimals must be a whole number from 1 to 8";
  }
  if (!isPos(sym.pipSize)) errors.pipSize = "pip size must be positive";
  if (!isPos(sym.contractSize)) errors.contractSize = "contract size must be positive";
  if (!isPos(sym.lotMin)) errors.lotMin = "minimum lot must be positive";
  if (!isPos(sym.lotMax)) errors.lotMax = "maximum lot must be positive";
  if (!isPos(sym.lotStep)) errors.lotStep = "lot step must be positive";

  if (isPos(sym.lotMin) && isPos(sym.lotMax) && sym.lotMin > sym.lotMax) {
    errors.lotMin = "minimum lot is larger than the maximum";
  }
  if (isPos(sym.lotStep) && isPos(sym.lotMax)) {
    // the step must reach the max, or the largest size is not orderable
    const steps = sym.lotMax / sym.lotStep;
    if (Math.abs(steps - Math.round(steps)) > 1e-9) {
      errors.lotStep = `lot step does not divide the maximum lot (${sym.lotMax} / ${sym.lotStep})`;
    }
  }
  if (isPos(sym.spread) === false && sym.spread !== 0) {
    errors.spread = "spread must be zero or positive";
  }
  if (!isPos(sym.commissionPerLot) && sym.commissionPerLot !== 0) {
    errors.commissionPerLot = "commission must be zero or positive";
  }

  return { ok: Object.keys(errors).length === 0, errors };
}

/** Build a spec from form strings, reporting what could not be read. */
export function specFromForm(
  form: Record<string, string>,
): { spec: SymbolSpec | null; check: SymbolCheck } {
  const num = (k: string, fallback = NaN): number => {
    const raw = (form[k] ?? "").trim();
    if (raw === "") return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  };

  const digits = num("digits", 2);
  const candidate: SymbolSpec = {
    name: (form.name ?? "").trim().toUpperCase(),
    digits,
    // a pip is one point unless the user says otherwise: for a 5-digit pair that is wrong by
    // 10x for display purposes, so the caller is expected to pass it
    pipSize: num("pipSize", Math.pow(10, -digits)),
    contractSize: num("contractSize", 100),
    lotMin: num("lotMin", 0.01),
    lotMax: num("lotMax", 100),
    lotStep: num("lotStep", 0.01),
    spread: num("spread", 0),
    spreadMode: "fixed",
    commissionPerLot: num("commissionPerLot", 0),
    swapLong: num("swapLong", 0),
    swapShort: num("swapShort", 0),
    leverage: num("leverage", 100),
    quoteCurrency: (form.quoteCurrency ?? "USD").trim().toUpperCase(),
    profitCurrencyIsAccount: form.profitCurrencyIsAccount !== "false",
  };

  const check = validateSymbol(candidate);
  return { spec: check.ok ? candidate : null, check };
}

/** Serialise for storage. Plain objects only, so JSON is enough. */
export function serialiseSymbols(symbols: readonly SymbolSpec[]): SymbolSpec[] {
  return symbols.map((s) => ({ ...s }));
}

/** Parse stored symbols, dropping (and reporting) any that no longer validate. */
export function parseSymbols(raw: unknown): { value: SymbolSpec[]; rejected: string[] } {
  if (!Array.isArray(raw)) {
    return { value: [], rejected: raw === null || raw === undefined ? [] : ["stored symbols are not a list"] };
  }
  const value: SymbolSpec[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();

  raw.forEach((item, i) => {
    if (typeof item !== "object" || item === null) {
      rejected.push(`symbol ${i}: not an object`);
      return;
    }
    const sym = item as Partial<SymbolSpec>;
    const key = typeof sym.name === "string" ? sym.name.toUpperCase() : "";
    const check = validateSymbol(sym, Array.from(seen));
    if (!check.ok) {
      rejected.push(`symbol ${i} (${key || "?"}): ${Object.values(check.errors).join("; ")}`);
      return;
    }
    seen.add(key);
    value.push({ ...(sym as SymbolSpec), name: key });
  });

  return { value, rejected };
}

/** A one-line description for the list. */
export function describeSymbol(s: SymbolSpec): string {
  return `${s.name} · ${s.digits} digits · ${s.contractSize}/lot · spread ${s.spread}`;
}
