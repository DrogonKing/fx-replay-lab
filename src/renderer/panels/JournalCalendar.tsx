/**
 * The R-multiple calendar.
 *
 * The journal already reported win rate and average R. Neither shows WHICH DAYS the damage
 * happened on, and whether the losses cluster — a revenge-trading spiral or a bad-news-day
 * habit is invisible in an average and obvious in a calendar.
 */
import React, { useMemo, useState } from "react";
import { useI18n } from "../i18n-context.js";
import {
  buildMonth, monthsWithTrades, bucketFor, BUCKET_COLOUR, summarise,
  monthTitle, weekdayLabels, textReport,
  type JournalEntry, type CalendarMonth,
} from "../../core/journal-calendar.js";

export interface JournalCalendarProps {
  entries: readonly JournalEntry[];
}

export function JournalCalendar({ entries }: JournalCalendarProps): JSX.Element {
  const { t } = useI18n();
  const months = useMemo(() => monthsWithTrades(entries), [entries]);
  const [selected, setSelected] = useState(0);
  const [copied, setCopied] = useState("");

  const summary = useMemo(() => summarise(entries), [entries]);

  if (months.length === 0) {
    return <p className="msg" data-panel="calendar-empty">{t("cal.empty")}</p>;
  }

  const idx = Math.min(selected, months.length - 1);
  const target = months[idx]!;
  const cal: CalendarMonth = buildMonth(entries, target.year, target.monthIndex);
  const labels = weekdayLabels();

  const copyReport = async (): Promise<void> => {
    const text = textReport(entries);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(t("cal.copied"));
    } catch {
      // clipboard permission can be refused; do not pretend it worked
      setCopied(t("cal.copyFailed"));
    }
  };

  return (
    <div className="journal-cal" data-panel="calendar">
      <div className="cal-head">
        <button
          className="mini"
          data-action="cal-prev"
          disabled={idx === 0}
          onClick={() => setSelected(idx - 1)}
        >‹</button>
        <b data-kv="cal-month">{monthTitle(cal)}</b>
        <button
          className="mini"
          data-action="cal-next"
          disabled={idx >= months.length - 1}
          onClick={() => setSelected(idx + 1)}
        >›</button>
        <span className={cal.totalR >= 0 ? "up" : "down"} data-kv="cal-total">
          {cal.totalR >= 0 ? "+" : ""}{cal.totalR.toFixed(2)}R
        </span>
      </div>

      <table className="cal-grid">
        <thead>
          <tr>{labels.map((l, i) => <th key={`${l}-${i}`}>{l}</th>)}</tr>
        </thead>
        <tbody>
          {cal.weeks.map((week, wi) => (
            <tr key={wi}>
              {week.map((day, di) => {
                if (!day) return <td key={di} className="cal-out" />;
                const bucket = bucketFor(day.r, day.trades);
                return (
                  <td
                    key={di}
                    data-day={day.date}
                    data-bucket={bucket}
                    className={`cal-day${day.trades === 0 ? " cal-idle" : ""}`}
                    style={{ background: BUCKET_COLOUR[bucket] }}
                    title={
                      day.trades === 0
                        ? t("cal.noTrades")
                        : `${day.r >= 0 ? "+" : ""}${day.r.toFixed(2)}R · ` +
                          `${day.trades} ${t("cal.trades")} · ${day.pnl.toFixed(0)}`
                    }
                  >
                    <span className="cal-num">{day.day}</span>
                    {day.trades > 0 && (
                      <span className="cal-r">{day.r >= 0 ? "+" : ""}{day.r.toFixed(1)}</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      <div className="cal-legend">
        {(["bigLoss", "loss", "flat", "win", "bigWin"] as const).map((b) => (
          <span key={b} className="cal-key">
            <i style={{ background: BUCKET_COLOUR[b] }} />
            {t(`cal.${b}`)}
          </span>
        ))}
      </div>

      <div className="kv" data-kv="cal-worst">
        <span>{t("cal.worstDay")}</span>
        <b className="down">
          {summary.worstDay
            ? `${summary.worstDay.date} ${summary.worstDay.r.toFixed(2)}R`
            : "—"}
        </b>
      </div>
      <div className="kv" data-kv="cal-streak">
        <span>{t("cal.losingStreak")}</span>
        <b className={summary.longestLosingStreak >= 3 ? "down" : ""}>
          {summary.longestLosingStreak}
        </b>
      </div>
      <div className="kv" data-kv="cal-blowups">
        <span>{t("cal.blowups")}</span>
        <b className={summary.blowupDays > 0 ? "down" : "up"}>{summary.blowupDays}</b>
      </div>

      <button data-action="copy-report" onClick={() => void copyReport()}>
        {t("cal.copyReport")}
      </button>
      {copied && <p className="msg" data-note="cal-copied">{copied}</p>}

      <p className="msg">{t("cal.note")}</p>
    </div>
  );
}
