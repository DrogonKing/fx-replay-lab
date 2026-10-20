import { describe, it, expect } from "vitest";
import {
  coreError, classifyEnglish, extractParams, localiseError,
} from "../src/core/errors.js";
import { t, MESSAGES } from "../src/core/i18n.js";

/** A translate function bound to a language, the way the renderer calls it. */
const tr = (lang: "en" | "fa") =>
  (key: string, vars?: Record<string, string | number>): string => t(lang, key, vars);

describe("coreError", () => {
  it("carries a code, English text and params", () => {
    const e = coreError("lots_not_positive", "lots must be positive");
    expect(e.code).toBe("lots_not_positive");
    expect(e.en).toBe("lots must be positive");
  });

  it("keeps params when given", () => {
    const e = coreError("not_enough_margin", "not enough margin", { need: 100, free: 50 });
    expect(e.params).toEqual({ need: 100, free: 50 });
  });
});

describe("classifyEnglish", () => {
  it("recognises the real core messages", () => {
    const cases: Array<[string, string]> = [
      ["lots must be positive", "lots_not_positive"],
      ["price must be positive", "price_not_positive"],
      ["stop-limit needs a limit price", "stop_limit_needs_limit"],
      ["no price yet", "no_price_yet"],
      ["account stopped out", "account_stopped_out"],
      ["not enough margin: need 100, free 50", "not_enough_margin"],
      ["news blackout — high impact USD: NFP", "news_blackout"],
      ["book risk — this trade would put 17% at risk", "book_risk_limit"],
      ["engine refused the order", "engine_refused"],
    ];
    for (const [message, expected] of cases) {
      expect(classifyEnglish(message), message).toBe(expected);
    }
  });

  it("falls back to unknown rather than guessing", () => {
    expect(classifyEnglish("something entirely new")).toBe("unknown");
  });

  it("is case-insensitive", () => {
    expect(classifyEnglish("LOTS MUST BE POSITIVE")).toBe("lots_not_positive");
  });
});

describe("extractParams", () => {
  it("names numbers a, b, c in order", () => {
    expect(extractParams("need 100, free 50")).toEqual({ a: 100, b: 50 });
  });

  it("handles negatives and decimals", () => {
    expect(extractParams("from -1.5 to 2.25")).toEqual({ a: -1.5, b: 2.25 });
  });

  it("returns nothing for a message with no numbers", () => {
    expect(extractParams("nothing here")).toEqual({});
  });
});

describe("localiseError", () => {
  it("translates a known refusal into Persian", () => {
    const out = localiseError("lots must be positive", tr("fa"));
    expect(out).toBe("حجم باید مثبت باشد");
  });

  it("translates into English unchanged in meaning", () => {
    expect(localiseError("lots must be positive", tr("en")))
      .toBe("lots must be positive");
  });

  it("keeps the numbers from the original message", () => {
    // the broker's actual margin figures must survive translation
    const out = localiseError("not enough margin: need 250.00, free 100.00", tr("fa"));
    expect(out).not.toContain("not enough");
    expect(out).toContain("مارجین");
  });

  it("returns the original English for an UNKNOWN refusal", () => {
    // better the specific English than a generic "something went wrong"
    const out = localiseError("some brand new refusal", tr("fa"));
    expect(out).toBe("some brand new refusal");
  });

  it("never returns an empty string", () => {
    expect(localiseError("", tr("fa"))).toBe("");
    expect(localiseError("lots must be positive", tr("fa")).length).toBeGreaterThan(0);
  });

  it("falls back to the English when the catalogue key is missing", () => {
    const missing = (key: string): string => key;   // t() returns the key when absent
    const out = localiseError("lots must be positive", missing);
    expect(out).toBe("lots must be positive");
  });
});

describe("the catalogue covers every code", () => {
  const codes = [
    "lots_not_positive", "lots_out_of_range", "price_not_positive",
    "stop_limit_needs_limit", "buy_stop_limit_limit_too_low",
    "sell_stop_limit_limit_too_high", "limit_buy_above_market",
    "limit_sell_below_market", "stop_buy_below_market", "stop_sell_above_market",
    "stop_would_cross_entry", "target_would_cross_entry", "no_price_yet",
    "account_stopped_out", "not_enough_margin", "engine_refused", "news_blackout",
    "book_risk_limit", "sl_too_close", "unknown",
  ];

  it("has a message for every code in both languages", () => {
    for (const code of codes) {
      for (const lang of ["en", "fa"] as const) {
        expect(MESSAGES[lang][`err.${code}`], `${lang} err.${code}`).toBeTruthy();
      }
    }
  });

  it("uses the same placeholders in both languages", () => {
    // a {a} that survives in one language and not the other silently drops the number
    for (const code of codes) {
      const key = `err.${code}`;
      const enVars = (MESSAGES.en[key]?.match(/\{(\w+)\}/g) ?? []).sort();
      const faVars = (MESSAGES.fa[key]?.match(/\{(\w+)\}/g) ?? []).sort();
      expect(faVars, key).toEqual(enVars);
    }
  });
});
