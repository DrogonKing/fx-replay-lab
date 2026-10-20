/**
 * Error codes for the messages `src/core` returns.
 *
 * Core is deliberately DOM-free and has no idea what language the UI is in, so it cannot
 * return Persian text. Until now it returned English text, which leaked into the Persian UI
 * verbatim: a Persian trader reading "buy limit 2050 is above the market" is the visible edge
 * of the same missing layer.
 *
 * The fix is not to translate strings in core. It is to have core return a CODE and a small
 * set of values, and let the renderer look the message up. Codes are stable identifiers; the
 * text is a presentation concern.
 */

/** Every refusal core can produce, as a stable identifier. */
export type CoreErrorCode =
  | "lots_not_positive"
  | "lots_out_of_range"
  | "price_not_positive"
  | "stop_limit_needs_limit"
  | "buy_stop_limit_limit_too_low"
  | "sell_stop_limit_limit_too_high"
  | "limit_buy_above_market"
  | "limit_sell_below_market"
  | "stop_buy_below_market"
  | "stop_sell_above_market"
  | "stop_would_cross_entry"
  | "target_would_cross_entry"
  | "no_price_yet"
  | "account_stopped_out"
  | "not_enough_margin"
  | "engine_refused"
  | "news_blackout"
  | "book_risk_limit"
  | "sl_too_close"
  | "unknown";

/** A core refusal: a code, the values the sentence needs, and an English fallback. */
export interface CoreError {
  code: CoreErrorCode;
  /** values interpolated into the translated sentence, e.g. { price: 2050 } */
  params?: Record<string, string | number>;
  /**
   * English text.
   *
   * Kept because core is also used by the backtester, the CLI probes and the tests, where
   * there is no translation catalogue. The renderer prefers the translated message and
   * falls back to this, so a missing catalogue entry is still legible rather than blank.
   */
  en: string;
}

/** Build a core error. */
export function coreError(
  code: CoreErrorCode,
  en: string,
  params?: Record<string, string | number>,
): CoreError {
  return { code, en, params };
}

/**
 * Best-effort classification of an existing English string.
 *
 * Temporary shim: the call sites still return strings, and rewriting all of them at once
 * would mix a refactor with a behaviour change. This maps the known prefixes to codes so the
 * renderer can translate today, and each call site can be migrated to `coreError` when it is
 * next touched.
 */
export function classifyEnglish(message: string): CoreErrorCode {
  const m = message.toLowerCase();
  if (m.includes("lots must be positive")) return "lots_not_positive";
  if (m.includes("price must be positive")) return "price_not_positive";
  if (m.includes("stop-limit needs a limit price")) return "stop_limit_needs_limit";
  if (m.includes("buy stop-limit needs its limit")) return "buy_stop_limit_limit_too_low";
  if (m.includes("sell stop-limit needs its limit")) return "sell_stop_limit_limit_too_high";
  if (m.includes("no price yet")) return "no_price_yet";
  if (m.includes("account stopped out")) return "account_stopped_out";
  if (m.includes("not enough margin")) return "not_enough_margin";
  if (m.includes("news blackout")) return "news_blackout";
  if (m.includes("book risk")) return "book_risk_limit";
  if (m.includes("engine refused")) return "engine_refused";
  if (m.includes("above the market")) return "limit_buy_above_market";
  if (m.includes("below the market")) return "limit_sell_below_market";
  return "unknown";
}

/**
 * Turn a core refusal into a translated sentence.
 *
 * `translate` is `t(lang, key, vars)` from i18n, passed in rather than imported so this
 * module stays dependency-free and usable from the main process.
 */
export function localiseError(
  message: string,
  translate: (key: string, vars?: Record<string, string | number>) => string,
): string {
  const code = classifyEnglish(message);
  if (code === "unknown") {
    // Better the broker's English than a generic "something went wrong": the specific text is
    // the only clue the user has.
    return message;
  }
  const params = extractParams(message);
  const key = `err.${code}`;
  const translated = translate(key, params);
  // t() returns the key itself when it is missing; fall back to the English in that case.
  return translated === key ? message : translated;
}

/** Extract the numbers from an English message so a translated one can interpolate them. */
export function extractParams(message: string): Record<string, number> {
  const out: Record<string, number> = {};
  const nums = message.match(/-?\d+(?:\.\d+)?/g);
  if (!nums) return out;
  // Named by position: the catalogue uses {a}, {b}, {c}. Generic, but it means a translated
  // sentence can still show the broker's actual numbers instead of dropping them.
  const names = ["a", "b", "c", "d"];
  nums.slice(0, names.length).forEach((n, i) => {
    out[names[i]!] = Number(n);
  });
  return out;
}
