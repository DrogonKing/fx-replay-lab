/**
 * Economic calendar panel: import a CSV, show the upcoming events, and gate trading.
 *
 * The blackout rule is the point of the whole feature: an import that only draws markers
 * is decoration. Trading is *refused* inside the window of a high-impact event for the
 * currency being traded, and the refusal says which event and how long.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  parseCalendarCsv, dedupeEvents, isBlackedOut, calendarSummary,
  type CalendarEvent, type ParseIssue,
} from "../../core/news.js";
import type { Impact } from "../../core/types.js";
import { useI18n } from "../i18n-context.js";
import { fmtDate } from "../../core/i18n.js";

interface Props {
  /** currency of the instrument being traded, e.g. "USD" */
  currency: string;
  /** epoch seconds of the replay's current bar */
  now: number;
  onEvents: (events: CalendarEvent[]) => void;
  /** true when trading should be refused; the parent disables the buttons */
  onBlackout: (check: { blocked: boolean; reason?: string }) => void;
}

const impactClass = (i: Impact): string =>
  i === "high" ? "impact-high" : i === "medium" ? "impact-med" : "impact-low";

export function NewsPanel({
  currency, now, onEvents, onBlackout,
}: Props): JSX.Element {
  const { t } = useI18n();
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [issues, setIssues] = useState<ParseIssue[]>([]);
  const [rowsSeen, setRowsSeen] = useState(0);
  const [msg, setMsg] = useState("");
  const [dayFirst, setDayFirst] = useState(false);
  const [blackoutHigh, setBlackoutHigh] = useState("5");
  const fileRef = useRef<HTMLInputElement | null>(null);
  const hydrated = useRef(false);

  // load the stored calendar once
  useEffect(() => {
    const api = (window as unknown as { fxlab?: { loadNews?: () => Promise<Array<{
      time: number; currency: string; impact: string; title: string;
    }>> } }).fxlab;
    if (!api?.loadNews) { hydrated.current = true; return; }
    void api.loadNews().then((rows) => {
      const restored: CalendarEvent[] = rows.map((r, i) => ({
        id: i + 1,
        time: r.time,
        currency: r.currency,
        impact: (r.impact as Impact) ?? "low",
        title: r.title,
        blackoutBefore: r.impact === "high" ? 300 : 0,
        blackoutAfter: r.impact === "high" ? 300 : 0,
      }));
      setEvents(restored);
      onEvents(restored);
      hydrated.current = true;
    });
  }, [onEvents]);

  // recompute the blackout as the replay advances
  useEffect(() => {
    const check = isBlackedOut(now, events, [currency]);
    onBlackout(check);
  }, [now, events, currency, onBlackout]);

  const importFile = useCallback(async (file: File) => {
    const text = await file.text();
    const before = Number(blackoutHigh) || 5;
    const r = parseCalendarCsv(text, {
      dayFirst,
      blackout: { high: { before: before * 60, after: before * 60 } },
    });
    const deduped = dedupeEvents(r.events);

    setEvents(deduped);
    setIssues(r.issues);
    setRowsSeen(r.rowsSeen);
    onEvents(deduped);

    const api = (window as unknown as { fxlab?: { saveNews?: (e: unknown[]) => Promise<number> } })
      .fxlab;
    if (api?.saveNews) void api.saveNews(deduped);

    setMsg(
      t("news.imported", { events: deduped.length, rows: r.rowsSeen }) +
      (r.issues.length > 0 ? t("news.skipped", { count: r.issues.length }) : ""),
    );
  }, [dayFirst, blackoutHigh, onEvents]);

  const summary = calendarSummary(events);
  const check = isBlackedOut(now, events, [currency]);

  // the next 12 events at or after the replay time
  const upcoming = events.filter((e) => e.time >= now - 900).slice(0, 12);

  return (
    <div className="news-panel">
      <h3>{t("news.title")}</h3>

      <div className="news-import">
        <button onClick={() => fileRef.current?.click()}>{t("news.import")}</button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void importFile(f);
            e.target.value = "";
          }}
        />
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={dayFirst}
            onChange={(e) => setDayFirst(e.target.checked)}
          />
          {t("news.dayFirst")}
          </label>
      </div>

      <label className="be-row">
        {t("news.pausePlusMinus")}
        <input
          value={blackoutHigh}
          onChange={(e) => setBlackoutHigh(e.target.value)}
          inputMode="numeric"
        />
        {t("news.onHighImpact")}
      </label>

      {msg && <p className="msg">{msg}</p>}

      {issues.length > 0 && (
        <details className="news-issues">
          <summary>{t("news.rowsSkipped", { count: issues.length })}</summary>
          <ul>
            {issues.slice(0, 8).map((i, n) => (
              <li key={n}>{t("news.line", { line: i.line, reason: i.reason })}</li>
            ))}
          </ul>
        </details>
      )}

      {events.length > 0 && (
        <>
          <div className="kv"><span>{t("news.events")}</span><b>{summary.total}</b></div>
          <div className="kv">
            <span>{t("news.split")}</span>
            <b>{summary.high} / {summary.medium} / {summary.low}</b>
          </div>

          <p className={check.blocked ? "blackout-active" : "blackout-clear"}>
            {check.blocked
              ? t("news.paused", { reason: check.reason ?? "" })
              : t("news.open", { currency })}
          </p>

          <h3>{t("news.upcoming")}</h3>
          <table className="grid news-table">
            <thead>
              <tr>
                <th>{t("news.when")}</th>
                <th>{t("news.ccy")}</th>
                <th>{t("news.event")}</th>
                <th>{t("news.imp")}</th>
              </tr>
            </thead>
            <tbody>
              {upcoming.map((e) => (
                <tr key={e.id} className={check.blocked && check.event?.id === e.id ? "row-blocked" : ""}>
                  <td>{fmtDate(e.time)}</td>
                  <td>{e.currency}</td>
                  <td className="news-title" title={e.title}>{e.title}</td>
                  <td className={impactClass(e.impact)}>{t(`news.${e.impact}`)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {upcoming.length === 0 && (
            <p className="msg">{t("news.noneUpcoming")}</p>
          )}
        </>
      )}

      {events.length === 0 && (
        <p className="msg">{t("news.empty")}</p>
      )}
    </div>
  );
}
