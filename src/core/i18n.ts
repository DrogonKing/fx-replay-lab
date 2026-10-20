/**
 * Internationalisation: message catalogue, interpolation and direction.
 *
 * Pure. Kept out of React so the catalogue can be unit-tested and so a missing key is
 * caught by a test instead of rendering an empty button in production.
 *
 * Persian is the only non-English locale for now. Numbers stay in Latin digits on
 * purpose: prices, lot sizes and P/L are read alongside broker statements and charts,
 * and Persian-Indic digits would make `1991.71` unsearchable and un-copyable.
 */

export type Lang = "en" | "fa";

export type Dir = "ltr" | "rtl";

export interface Locale {
  lang: Lang;
  /** writing direction for the document */
  dir: Dir;
  label: string;
}

export const LOCALES: readonly Locale[] = [
  { lang: "en", dir: "ltr", label: "English" },
  { lang: "fa", dir: "rtl", label: "فارسی" },
];

export function dirOf(lang: Lang): Dir {
  return lang === "fa" ? "rtl" : "ltr";
}

/**
 * The message catalogue.
 *
 * Keys are namespaced by surface (`tab.*`, `trade.*`, ...) so a missing key points at
 * where it belongs. Every key must exist in every locale: `missingKeys()` exists to
 * assert that in a test, because a half-translated UI is worse than an untranslated one.
 */
export const MESSAGES: Record<Lang, Record<string, string>> = {
  en: {
    "app.name": "FX Replay Lab",
    "app.offline": "OFFLINE",
    "app.live": "LIVE",
    "app.play": "▶ Play",
    "app.pause": "⏸ Pause",
    "app.step": "⏭ Step",
    "app.speed": "speed",
    "app.custom": "custom",
    "app.tf": "TF",
    "app.tz": "TZ",
    "app.language": "Language",

    "tab.data": "data",
    "tab.trade": "trade",
    "tab.news": "news",
    "tab.sessions": "sessions",
    "tab.indicators": "indicators",
    "tab.strategy": "strategy",
    "tab.journal": "journal",

    "trade.title": "Trade",
    "trade.type": "type",
    "trade.market": "market",
    "trade.limit": "limit",
    "trade.stop": "stop",
    "trade.stopLimit": "stop-limit",
    "trade.lots": "lots",
    "trade.sl": "SL (pts)",
    "trade.tp": "TP (pts)",
    "trade.tags": "tags",
    "trade.trigger": "trigger",
    "trade.oco": "OCO bracket",
    "trade.bid": "bid",
    "trade.balance": "balance",
    "trade.equity": "equity",
    "trade.floating": "floating",
    "trade.margin": "margin",
    "trade.riskReward": "risk / reward",
    "trade.buy": "Buy",
    "trade.sell": "Sell",
    "trade.open": "Open",
    "trade.pending": "Pending",
    "trade.closed": "Closed",
    "trade.closeAll": "Close all",
    "trade.cancelAll": "Cancel all orders",
    "trade.trail": "trail",
    "trade.breakEven": "auto break-even at",
    "trade.entry": "entry",
    "trade.side": "side",
    "trade.lotsShort": "lots",
    "trade.entryPrice": "entry",
    "trade.pnl": "P/L",
    "trade.why": "why",
    "trade.order": "order",
    "trade.price": "price",
    "trade.status": "status",
    "trade.waiting": "waiting",
    "trade.armed": "armed",
    "trade.stoppedOut": "Account stopped out — equity reached zero and every position was force-closed. Trading is halted.",
    "trade.dragHint": "Drag the SL / TP lines on the chart to move them. A stop cannot cross the entry — the drag is refused and the reason appears under the chart.",
    "trade.blackout": "Trading paused for news — {reason}. Orders are refused until the window passes.",
    "trade.filedNotice": "Every closed trade is filed to the JOURNAL automatically, tagged with its exit reason.",
    "trade.beHint": "(stop moves to entry; 0 = off)",
    "trade.ordersSummary": "Orders so far: {filled} filled, {cancelled} cancelled",
    "trade.ocoCancelled": " (OCO cancelled the sibling)",
    "trade.off": "off",
    "trade.trailClose": "close",
    "trade.trailExtreme": "high/low",
    "trade.trailAtr": "ATR",

    "news.title": "Calendar",
    "news.import": "Import CSV…",
    "news.dayFirst": "day-first dates",
    "news.pausePlusMinus": "pause ±",
    "news.onHighImpact": "min on high impact",
    "news.events": "events",
    "news.split": "high / med / low",
    "news.open": "Trading open for {currency}",
    "news.paused": "TRADING PAUSED — {reason}",
    "news.upcoming": "Upcoming",
    "news.when": "when",
    "news.ccy": "ccy",
    "news.event": "event",
    "news.imp": "imp",
    "news.imported": "{events} events from {rows} rows",
    "news.skipped": " · {count} rows skipped",
    "news.rowsSkipped": "{count} rows skipped",
    "news.line": "line {line}: {reason}",
    "news.empty": "No calendar loaded. Import a CSV with Date, Time, Currency, Impact and Event columns (most providers export this shape). Until then, trading is never paused for news.",
    "news.noneUpcoming": "No events at or after the replay time. Import a calendar covering this period.",
    "news.high": "high",
    "news.medium": "medium",
    "news.low": "low",

    "sessions.title": "Sessions",
    "sessions.showOnChart": "shade sessions on the chart",
    "sessions.hint": "Bands are drawn in each city's local time, so they shift with daylight saving. London and New York overlap in the most liquid window of the day.",
    "sessions.bySession": "By session",
    "sessions.attribution": "Grouped by the session the trade was OPENED in. A trade inside the London/New York overlap counts as London, so the buckets add up to the total.",
    "sessions.noTrades": "No trades yet — the breakdown appears once the journal has entries.",

    "journal.title": "Journal",
    "journal.sample": "+ Sample",
    "journal.export": "⬇ Export CSV",
    "journal.clearSamples": "✕ Clear samples",
    "journal.trades": "trades",
    "journal.netPnl": "net P/L",
    "journal.winRate": "win rate",
    "journal.expectancy": "expectancy",
    "journal.avgR": "avg R",
    "journal.bestWorstR": "best / worst R",
    "journal.byTag": "BY TAG",
    "journal.byMonth": "BY MONTH",
    "journal.rows": "ROWS",
    "journal.tag": "tag",
    "journal.n": "n",
    "journal.net": "net",
    "journal.winPct": "win%",
    "journal.month": "month",
    "journal.symbol": "symbol",
    "journal.rMultiple": "R",
    "journal.empty": "No trades recorded yet.",
    "journal.sampleWarning": "Sample rows are tagged 'demo' and ARE included in the statistics. Clear them before reviewing real performance.",

    "common.save": "Save",
    "common.cancel": "Cancel",
    "common.close": "Close",
    "common.delete": "Delete",
    "common.reload": "Reload",
  },

  fa: {
    "app.name": "FX Replay Lab",
    "app.offline": "آفلاین",
    "app.live": "زنده",
    "app.play": "▶ پخش",
    "app.pause": "⏸ توقف",
    "app.step": "⏭ گام",
    "app.speed": "سرعت",
    "app.custom": "دلخواه",
    "app.tf": "تایم‌فریم",
    "app.tz": "منطقهٔ زمانی",
    "app.language": "زبان",

    "tab.data": "داده",
    "tab.trade": "معامله",
    "tab.news": "اخبار",
    "tab.sessions": "سشن‌ها",
    "tab.indicators": "اندیکاتور",
    "tab.strategy": "استراتژی",
    "tab.journal": "دفتر",

    "trade.title": "معامله",
    "trade.type": "نوع",
    "trade.market": "بازار",
    "trade.limit": "لیمیت",
    "trade.stop": "استاپ",
    "trade.stopLimit": "استاپ-لیمیت",
    "trade.lots": "حجم",
    "trade.sl": "حد ضرر (پوینت)",
    "trade.tp": "حد سود (پوینت)",
    "trade.tags": "برچسب‌ها",
    "trade.trigger": "تریگر",
    "trade.oco": "جفت OCO",
    "trade.bid": "قیمت",
    "trade.balance": "موجودی",
    "trade.equity": "ارزش خالص",
    "trade.floating": "سود شناور",
    "trade.margin": "مارجین",
    "trade.riskReward": "ریسک / ریوارد",
    "trade.buy": "خرید",
    "trade.sell": "فروش",
    "trade.open": "باز",
    "trade.pending": "در انتظار",
    "trade.closed": "بسته‌شده",
    "trade.closeAll": "بستن همه",
    "trade.cancelAll": "لغو همهٔ سفارش‌ها",
    "trade.trail": "دنبال‌کننده",
    "trade.breakEven": "ریسک‌صفر خودکار در",
    "trade.entry": "ورود",
    "trade.side": "جهت",
    "trade.lotsShort": "حجم",
    "trade.entryPrice": "ورود",
    "trade.pnl": "سود/زیان",
    "trade.why": "دلیل",
    "trade.order": "سفارش",
    "trade.price": "قیمت",
    "trade.status": "وضعیت",
    "trade.waiting": "منتظر",
    "trade.armed": "مسلح",
    "trade.stoppedOut": "حساب صفر شد — ارزش خالص به صفر رسید و همهٔ پوزیشن‌ها بسته شدند. معامله متوقف است.",
    "trade.dragHint": "خطوط حد ضرر و حد سود را روی چارت بکش. حد ضرر نمی‌تواند از قیمت ورود عبور کند — کشیدن رد می‌شود و دلیلش زیر چارت می‌آید.",
    "trade.blackout": "معامله برای خبر متوقف شد — {reason}. سفارش‌ها تا پایان پنجره رد می‌شوند.",
    "trade.filedNotice": "هر معاملهٔ بسته‌شده خودکار در دفتر ثبت می‌شود، با برچسب دلیل خروج.",
    "trade.beHint": "(حد ضرر به نقطهٔ ورود می‌رود؛ ۰ = خاموش)",
    "trade.ordersSummary": "سفارش‌ها تا اینجا: {filled} پر شده، {cancelled} لغو شده",
    "trade.ocoCancelled": " (OCO خواهر را لغو کرد)",
    "trade.off": "خاموش",
    "trade.trailClose": "کلوز",
    "trade.trailExtreme": "سقف/کف",
    "trade.trailAtr": "ATR",

    "news.title": "تقویم",
    "news.import": "ایمپورت CSV…",
    "news.dayFirst": "تاریخ روز-اول",
    "news.pausePlusMinus": "توقف ±",
    "news.onHighImpact": "دقیقه روی خبر مهم",
    "news.events": "رویداد",
    "news.split": "مهم / متوسط / کم",
    "news.open": "معامله برای {currency} آزاد است",
    "news.paused": "معامله متوقف — {reason}",
    "news.upcoming": "پیش‌رو",
    "news.when": "زمان",
    "news.ccy": "ارز",
    "news.event": "رویداد",
    "news.imp": "اهمیت",
    "news.imported": "{events} رویداد از {rows} ردیف",
    "news.skipped": " · {count} ردیف رد شد",
    "news.rowsSkipped": "{count} ردیف رد شد",
    "news.line": "خط {line}: {reason}",
    "news.empty": "تقویمی بارگذاری نشده. یک CSV با ستون‌های تاریخ، ساعت، ارز، اهمیت و رویداد ایمپورت کن (بیشتر سایت‌ها همین شکل را می‌دهند). تا آن موقع معامله هرگز برای خبر متوقف نمی‌شود.",
    "news.noneUpcoming": "رویدادی در زمان ریپلی یا بعد از آن نیست. تقویمی ایمپورت کن که این بازه را پوشش دهد.",
    "news.high": "مهم",
    "news.medium": "متوسط",
    "news.low": "کم",

    "sessions.title": "سشن‌ها",
    "sessions.showOnChart": "سایهٔ سشن‌ها روی چارت",
    "sessions.hint": "باندها با ساعت محلی هر شهر رسم می‌شوند، پس با تغییر ساعت تابستانی جابه‌جا می‌شوند. لندن و نیویورک در پرحجم‌ترین پنجرهٔ روز هم‌پوشانی دارند.",
    "sessions.bySession": "بر اساس سشن",
    "sessions.attribution": "بر اساس سشنی که معامله در آن باز شده. معاملهٔ داخل هم‌پوشانی لندن/نیویورک به لندن نسبت داده می‌شود تا جمع ستون‌ها با کل برابر بماند.",
    "sessions.noTrades": "هنوز معامله‌ای نیست — جدول وقتی دفتر ردیف داشته باشد ظاهر می‌شود.",

    "journal.title": "دفتر معاملات",
    "journal.sample": "+ نمونه",
    "journal.export": "⬇ خروجی CSV",
    "journal.clearSamples": "✕ پاک کردن نمونه‌ها",
    "journal.trades": "معاملات",
    "journal.netPnl": "سود خالص",
    "journal.winRate": "نرخ برد",
    "journal.expectancy": "انتظار",
    "journal.avgR": "میانگین R",
    "journal.bestWorstR": "بهترین / بدترین R",
    "journal.byTag": "بر اساس برچسب",
    "journal.byMonth": "بر اساس ماه",
    "journal.rows": "ردیف‌ها",
    "journal.tag": "برچسب",
    "journal.n": "تعداد",
    "journal.net": "خالص",
    "journal.winPct": "برد٪",
    "journal.month": "ماه",
    "journal.symbol": "نماد",
    "journal.rMultiple": "R",
    "journal.empty": "هنوز معامله‌ای ثبت نشده.",
    "journal.sampleWarning": "ردیف‌های نمونه با برچسب «demo» هستند و در آمار حساب می‌شوند. قبل از بررسی عملکرد واقعی پاکشان کن.",

    "common.save": "ذخیره",
    "common.cancel": "انصراف",
    "common.close": "بستن",
    "common.delete": "حذف",
    "common.reload": "بارگذاری مجدد",
  },
};

export type MessageKey = keyof typeof MESSAGES.en;

/**
 * Look up a message, interpolating `{placeholders}`.
 *
 * A missing key returns the key itself rather than an empty string: an empty button is
 * invisible and unreportable, whereas `trade.buy` on screen is an obvious bug report.
 */
export function t(
  lang: Lang,
  key: string,
  vars?: Record<string, string | number>,
): string {
  const table = MESSAGES[lang] ?? MESSAGES.en;
  const template = table[key] ?? MESSAGES.en[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const v = vars[name];
    return v === undefined ? whole : String(v);
  });
}

/** Keys present in `en` but missing from `lang`. */
export function missingKeys(lang: Lang): string[] {
  if (lang === "en") return [];
  const base = Object.keys(MESSAGES.en);
  const other = MESSAGES[lang];
  return base.filter((k) => other[k] === undefined || other[k] === "");
}

/** Keys in `lang` that no longer exist in `en` (stale translations). */
export function extraKeys(lang: Lang): string[] {
  if (lang === "en") return [];
  const base = new Set(Object.keys(MESSAGES.en));
  return Object.keys(MESSAGES[lang]).filter((k) => !base.has(k));
}

/**
 * Format a number for display.
 *
 * Latin digits for every locale, deliberately: prices and P/L are compared against
 * broker statements and copied into other tools, and Persian-Indic digits would break
 * both. The locale only changes the direction of the surrounding text.
 */
export function fmtNum(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return "—";
  return value.toFixed(digits);
}

/** Signed number, for P/L (always shows + or -). */
export function fmtSigned(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return "—";
  const s = value.toFixed(digits);
  return value >= 0 ? `+${s}` : s;
}

/** Locale-aware date for the news table; the digits stay Latin. */
export function fmtDate(epochSeconds: number, withYear = false): string {
  if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) return "—";
  const iso = new Date(epochSeconds * 1000).toISOString();
  return withYear ? iso.slice(0, 16).replace("T", " ") : iso.slice(5, 16).replace("T", " ");
}

/**
 * Choose the initial language.
 *
 * A stored choice wins. Otherwise Persian if the browser prefers it, so a Persian user
 * is not greeted in English. Falling back to "en" keeps the default predictable.
 */
export function pickLang(stored: string | null, browserLangs: readonly string[]): Lang {
  if (stored === "fa" || stored === "en") return stored;
  for (const l of browserLangs) {
    if (l.toLowerCase().startsWith("fa")) return "fa";
    if (l.toLowerCase().startsWith("en")) return "en";
  }
  return "en";
}
