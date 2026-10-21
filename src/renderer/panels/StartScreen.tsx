/**
 * The start screen: live, or replay the past.
 *
 * Shown on first launch and whenever the user switches mode. It exists because the two modes
 * are genuinely different things and the difference is not guessable from a toolbar: one moves
 * on its own, the other only when you step it.
 *
 * The availability line under the year picker is the important part. A user who picks 2019 at
 * 5 minutes must be told the provider only has 60 days — before the download, not after it
 * returns nothing.
 */
import React, { useMemo, useState } from "react";
import { useI18n } from "../i18n-context.js";
import {
  availability, selectableYears, type SessionMode, type Availability,
} from "../../core/session-mode.js";

export interface StartChoice {
  mode: SessionMode;
  symbol: string;
  intervalMinutes: number;
  /** replay only: the epoch second to start from */
  from?: number;
  /** replay only: load from the provider, or ask for a file. Live has no source. */
  source?: "provider" | "file";
}

export interface StartScreenProps {
  symbols: Array<{ id: string; label: string }>;
  onStart: (choice: StartChoice) => void;
  onImport: () => void;
  /** called when the user asks for a file instead of a download */
  initial?: SessionMode;
}

const INTERVALS: Array<{ minutes: number; label: string }> = [
  { minutes: 1, label: "1m" },
  { minutes: 5, label: "5m" },
  { minutes: 15, label: "15m" },
  { minutes: 30, label: "30m" },
  { minutes: 60, label: "1H" },
  { minutes: 1440, label: "1D" },
];

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function StartScreen({
  symbols, onStart, onImport, initial = "replay",
}: StartScreenProps): JSX.Element {
  const { t } = useI18n();
  const [mode, setMode] = useState<SessionMode>(initial);
  const [symbol, setSymbol] = useState(symbols[0]?.id ?? "GC=F");
  const [intervalMinutes, setIntervalMinutes] = useState(5);
  const [year, setYear] = useState(() => new Date().getUTCFullYear());
  const [month, setMonth] = useState(0);

  const now = Math.floor(Date.now() / 1000);
  const years = useMemo(() => selectableYears(intervalMinutes, now), [intervalMinutes, now]);

  // The picked year/month can fall outside the offered range after an interval change, which
  // would silently request a window the provider refuses.
  const safeYear = years.includes(year) ? year : years[0] ?? year;

  const from = Math.floor(Date.UTC(safeYear, month, 1) / 1000);
  const avail: Availability = useMemo(
    () => availability(intervalMinutes, from, now),
    [intervalMinutes, from, now],
  );

  const canDownload = mode === "live" || avail.verdict === "ok" || avail.verdict === "clamped";

  return (
    <div className="start-screen" data-panel="start">
      <div className="start-card">
        <h1 className="start-title">{t("start.title")}</h1>
        <p className="start-sub">{t("start.sub")}</p>

        <div className="start-modes">
          <button
            data-mode="live"
            className={mode === "live" ? "start-mode on" : "start-mode"}
            onClick={() => setMode("live")}
          >
            <b>{t("start.live")}</b>
            <span>{t("start.liveHint")}</span>
          </button>
          <button
            data-mode="replay"
            className={mode === "replay" ? "start-mode on" : "start-mode"}
            onClick={() => setMode("replay")}
          >
            <b>{t("start.replay")}</b>
            <span>{t("start.replayHint")}</span>
          </button>
        </div>

        <label className="start-field">
          {t("start.symbol")}
          <select
            data-field="start-symbol"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
          >
            {symbols.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>

        <div className="start-field">
          {t("start.interval")}
          <div className="start-intervals">
            {INTERVALS.map((iv) => (
              <button
                key={iv.minutes}
                data-interval={iv.minutes}
                className={intervalMinutes === iv.minutes ? "si on" : "si"}
                onClick={() => setIntervalMinutes(iv.minutes)}
              >{iv.label}</button>
            ))}
          </div>
        </div>

        {mode === "replay" && (
          <>
            <div className="start-field">
              {t("start.period")}
              <div className="start-period">
                <select
                  data-field="start-year"
                  value={safeYear}
                  onChange={(e) => setYear(Number(e.target.value))}
                >
                  {years.map((y) => <option key={y} value={y}>{y}</option>)}
                </select>
                <select
                  data-field="start-month"
                  value={month}
                  onChange={(e) => setMonth(Number(e.target.value))}
                >
                  {MONTHS.map((m, i) => <option key={m} value={i}>{m}</option>)}
                </select>
              </div>
            </div>

            {/* The honest limit, stated before the download rather than after it fails. */}
            <p
              className={
                avail.verdict === "ok" ? "start-avail"
                  : avail.verdict === "clamped" ? "start-avail warn"
                    : "start-avail bad"
              }
              data-note="start-availability"
              data-verdict={avail.verdict}
            >
              {avail.message}
            </p>
          </>
        )}

        <div className="start-actions">
          <button
            className="primary"
            data-action="start-go"
            // exposed for tests: an unobservable disabled state made a smoke test flaky, because
            // the only way to know was to click and hope
            data-ready={canDownload ? "yes" : "no"}
            disabled={!canDownload}
            onClick={() => onStart({
              mode,
              symbol,
              intervalMinutes,
              ...(mode === "replay" ? { from, source: "provider" as const } : {}),
            })}
          >
            {mode === "live" ? t("start.goLive") : t("start.goReplay")}
          </button>
          <button data-action="start-file" onClick={onImport}>
            {t("start.fromFile")}
          </button>
        </div>

        {!canDownload && (
          <p className="msg" data-note="start-blocked">{t("start.blocked")}</p>
        )}

        <p className="start-foot">{t("start.foot")}</p>
      </div>
    </div>
  );
}
