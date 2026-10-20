import { describe, it, expect } from "vitest";
import {
  LOCALES, dirOf, MESSAGES, t, missingKeys, extraKeys, fmtNum, fmtSigned,
  fmtDate, pickLang, type Lang,
} from "../src/core/i18n.js";

const ALL: Lang[] = ["en", "fa"];

describe("locale table", () => {
  it("declares direction per locale", () => {
    expect(dirOf("en")).toBe("ltr");
    expect(dirOf("fa")).toBe("rtl");
  });

  it("lists both locales with labels", () => {
    expect(LOCALES.map((l) => l.lang)).toEqual(["en", "fa"]);
    expect(LOCALES.every((l) => l.label.length > 0)).toBe(true);
  });
});

describe("catalogue completeness", () => {
  it("has no missing keys in any locale", () => {
    // a half-translated UI is worse than an untranslated one: an empty button is
    // invisible, so this must fail loudly
    for (const lang of ALL) {
      expect(missingKeys(lang), `missing in ${lang}`).toEqual([]);
    }
  });

  it("has no stale keys", () => {
    for (const lang of ALL) {
      expect(extraKeys(lang), `stale in ${lang}`).toEqual([]);
    }
  });

  it("covers every rail tab the UI renders", () => {
    // The bug this catches: adding a tab to App.tsx without adding `tab.<id>` renders the
    // raw key "tab.sessions" in the UI. Catalogue completeness alone cannot see that,
    // because the key never existed in English either.
    const tabs = ["data", "trade", "news", "sessions", "indicators", "strategy", "journal"];
    for (const tab of tabs) {
      for (const lang of ALL) {
        expect(MESSAGES[lang][`tab.${tab}`], `${lang} tab.${tab}`).toBeTruthy();
      }
    }
  });

  it("covers every session impact and trail mode label", () => {
    const keys = [
      "trade.off", "trade.trailClose", "trade.trailExtreme", "trade.trailAtr",
      "news.high", "news.medium", "news.low",
      "sessions.title", "sessions.showOnChart", "sessions.bySession",
    ];
    for (const key of keys) {
      for (const lang of ALL) {
        expect(MESSAGES[lang][key], `${lang} ${key}`).toBeTruthy();
      }
    }
  });

  it("covers the equity curve and chart type labels", () => {
    const keys = [
      "tab.equity", "equity.title", "equity.netPnl", "equity.peak",
      "equity.maxDd", "equity.nowDd", "equity.empty",
      "app.chartType", "app.candles", "app.bars", "app.line", "app.area",
      "app.logScale", "app.logScaleHint",
    ];
    for (const key of keys) {
      for (const lang of ALL) {
        expect(MESSAGES[lang][key], `${lang} ${key}`).toBeTruthy();
      }
    }
  });

  it("has no empty values", () => {
    for (const lang of ALL) {
      for (const [k, v] of Object.entries(MESSAGES[lang])) {
        expect(v.length, `${lang}.${k} is empty`).toBeGreaterThan(0);
      }
    }
  });

  it("keeps placeholders consistent across locales", () => {
    // a translation that drops {reason} renders a sentence with no explanation
    const placeholders = (s: string): string[] => {
      const out: string[] = [];
      const re = /\{(\w+)\}/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(s)) !== null) out.push(m[1]!);
      return out.sort();
    };

    for (const [key, enValue] of Object.entries(MESSAGES.en)) {
      const enVars = placeholders(enValue);
      for (const lang of ALL) {
        if (lang === "en") continue;
        const other = MESSAGES[lang][key]!;
        expect(placeholders(other), `${lang}.${key} placeholders`).toEqual(enVars);
      }
    }
  });
});

describe("t interpolation", () => {
  it("returns a plain message", () => {
    expect(t("en", "trade.buy")).toBe("Buy");
    expect(t("fa", "trade.buy")).toBe("خرید");
  });

  it("interpolates one placeholder", () => {
    expect(t("en", "news.open", { currency: "USD" })).toBe("Trading open for USD");
  });

  it("interpolates several", () => {
    expect(t("en", "trade.ordersSummary", { filled: 2, cancelled: 1 }))
      .toBe("Orders so far: 2 filled, 1 cancelled");
  });

  it("leaves unknown placeholders visible instead of printing undefined", () => {
    expect(t("en", "news.open", {})).toBe("Trading open for {currency}");
  });

  it("returns the key when it is missing, not an empty string", () => {
    // an empty button is invisible and unreportable
    expect(t("en", "does.not.exist")).toBe("does.not.exist");
    expect(t("fa", "does.not.exist")).toBe("does.not.exist");
  });

  it("falls back to English for a locale with no table", () => {
    expect(t("de" as Lang, "trade.buy")).toBe("Buy");
  });

  it("translates the blackout sentence with the reason", () => {
    expect(t("fa", "news.paused", { reason: "NFP" })).toContain("NFP");
    expect(t("fa", "news.paused", { reason: "NFP" })).toContain("متوقف");
  });
});

describe("fmtNum", () => {
  it("uses two decimals by default", () => {
    expect(fmtNum(1991.7)).toBe("1991.70");
  });

  it("honours the digit count", () => {
    expect(fmtNum(1.23456, 5)).toBe("1.23456");
  });

  it("returns an em dash for non-finite values", () => {
    expect(fmtNum(NaN)).toBe("—");
    expect(fmtNum(Infinity)).toBe("—");
  });

  it("keeps LATIN digits — prices must match broker statements", () => {
    // a Persian-locale price in Persian-Indic digits cannot be searched or pasted
    expect(fmtNum(1991.71)).toMatch(/^[0-9.]+$/);
  });
});

describe("fmtSigned", () => {
  it("adds a plus for profit", () => {
    expect(fmtSigned(42)).toBe("+42.00");
  });

  it("keeps the minus for loss", () => {
    expect(fmtSigned(-42)).toBe("-42.00");
  });

  it("shows +0.00 for zero", () => {
    expect(fmtSigned(0)).toBe("+0.00");
  });
});

describe("fmtDate", () => {
  it("formats without a year by default", () => {
    // 2024-01-05 13:30 UTC
    expect(fmtDate(Date.UTC(2024, 0, 5, 13, 30) / 1000)).toBe("01-05 13:30");
  });

  it("can include the year", () => {
    expect(fmtDate(Date.UTC(2024, 0, 5, 13, 30) / 1000, true)).toBe("2024-01-05 13:30");
  });

  it("returns an em dash for invalid input", () => {
    expect(fmtDate(0)).toBe("—");
    expect(fmtDate(NaN)).toBe("—");
  });
});

describe("pickLang", () => {
  it("prefers the stored choice", () => {
    expect(pickLang("fa", ["en-US"])).toBe("fa");
    expect(pickLang("en", ["fa-IR"])).toBe("en");
  });

  it("uses the browser preference when nothing is stored", () => {
    expect(pickLang(null, ["fa-IR", "en-US"])).toBe("fa");
    expect(pickLang(null, ["en-GB"])).toBe("en");
  });

  it("skips unrelated languages to find a supported one", () => {
    expect(pickLang(null, ["de-DE", "fa-IR"])).toBe("fa");
  });

  it("defaults to English with no signal", () => {
    expect(pickLang(null, [])).toBe("en");
    expect(pickLang(null, ["de-DE"])).toBe("en");
  });

  it("ignores a stored value that is not a supported locale", () => {
    expect(pickLang("de", ["fa-IR"])).toBe("fa");
  });
});
