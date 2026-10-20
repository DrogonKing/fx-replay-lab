/**
 * Language context.
 *
 * Provides the active language, its direction and a bound `t()`. The direction is applied
 * to `<html dir>` so the whole document flips: no per-component RTL CSS. Components use
 * logical properties (`margin-inline-start`) so one stylesheet serves both directions.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { dirOf, pickLang, t as translate, type Lang } from "../core/i18n.js";

interface Ctx {
  lang: Lang;
  dir: "ltr" | "rtl";
  setLang: (l: Lang) => void;
  /** translate a key, with optional interpolation */
  t: (key: string, vars?: Record<string, string | number>) => string;
}

const LanguageContext = createContext<Ctx | null>(null);

const STORAGE_KEY = "fxlab.lang";

export function LanguageProvider({ children }: { children: React.ReactNode }): JSX.Element {
  const [lang, setLangState] = useState<Lang>(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(STORAGE_KEY);
    } catch {
      // private mode / disabled storage: fall back to the browser preference
    }
    return pickLang(stored, navigator.languages ?? [navigator.language]);
  });

  const dir = dirOf(lang);

  // Flip the document. Also set the attribute the CSS keys off, and keep the scrollbar
  // on the correct side by letting the browser do it rather than by hand.
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = dir;
  }, [lang, dir]);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      window.localStorage.setItem(STORAGE_KEY, l);
    } catch {
      // the choice simply will not survive a restart
    }
  }, []);

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => translate(lang, key, vars),
    [lang],
  );

  const value = useMemo<Ctx>(() => ({ lang, dir, setLang, t }), [lang, dir, setLang, t]);

  return (
    <LanguageContext.Provider value={value}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useI18n(): Ctx {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error("useI18n must be used inside LanguageProvider");
  return ctx;
}
