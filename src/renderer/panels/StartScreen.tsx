/**
 * The start screen: live, or replay the past.
 *
 * Shown on first launch and whenever the user switches mode. It exists because the two modes
 * are genuinely different things and the difference is not guessable from a toolbar: one moves
 * on its own, the other only when you step it.
 *
 * There is deliberately NO timeframe picker here. Asking for a frame before any data exists
 * forces a choice the user cannot yet judge, and it also caps them: they pick 5m and can never
 * see 1m afterwards. Instead the app loads the finest resolution the provider can serve for the
 * chosen window, and every frame above it is derived in the toolbar by aggregation. A custom
 * frame (7m, 90m, 3H) works the same way, because aggregation is arithmetic over the base bars.
 *
 * The availability line is still the important part: a mode or window the provider cannot serve
 * must be said before the load, not discovered afterwards.
 */
import React, { useMemo, useState } from "react";
import { useI18n } from "../i18n-context.js";
import {
  availability, finestFor, type SessionMode, type Availability,
} from "../../core/session-mode.js";

export interface StartChoice {
  mode: SessionMode;
  symbol: string;
  /** the resolution the app decided to load — the finest the provider can serve */
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
  initial?: SessionMode;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** How far back the replay can start, in years. The provider clamps it per resolution. */
const YEAR_SPAN = 20;

export function StartScreen({
  symbols, onStart, onImport, initial = "replay",
}: StartScreenProps): JSX.Element {
  const { t } = useI18n();
  const [mode, setMode] = useState<SessionMode>(initial);
  // The start screen does not choose an instrument any more; it reports the current one so the
  // choice object keeps its shape. The toolbar owns instrument selection.
  const symbol = symbols[0]?.id ?? "EURUSD=X";
  const [year, setYear] = useState(() => new Date().getUTCFullYear());
  const [month, setMonth] = useState(0);

  const now = Math.floor(Date.now() / 1000);
  const from = Math.floor(Date.UTC(year, month, 1) / 1000);

  // The resolution is CHOSEN, not asked: the finest one that can cover the requested window.
  // Asking the user would be asking them to solve a constraint they cannot see.
  const intervalMinutes = useMemo(
    () => finestFor(from, now),
    [from, now],
  );

  const avail: Availability = useMemo(
    () => availability(intervalMinutes, from, now),
    [intervalMinutes, from, now],
  );

  const years = useMemo(() => {
    const out: number[] = [];
    const current = new Date().getUTCFullYear();
    for (let y = current; y > current - YEAR_SPAN; y--) out.push(y);
    return out;
  }, []);

  const safeYear = years.includes(year) ? year : years[0] ?? year;

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

        {/* The instrument is NOT chosen here. It is chosen in the toolbar, where it can be
            changed at any time while the chart is up — asking on this screen meant the same
            question was answered twice, and the answer given here silently won. */}

        {mode === "replay" && (
          <div className="start-field">
            {t("start.from")}
            <div className="start-intervals">
              <select
                data-field="start-month"
                value={month}
                onChange={(e) => setMonth(Number(e.target.value))}
              >
                {MONTHS.map((m, i) => <option key={m} value={i}>{m}</option>)}
              </select>
              <select
                data-field="start-year"
                value={safeYear}
                onChange={(e) => setYear(Number(e.target.value))}
              >
                {years.map((y) => <option key={y} value={y}>{y}</option>)}
              </select>
            </div>
          </div>
        )}

        {/*
          The resolution the app is about to load, stated plainly. This is not a picker: the
          user gets every frame above it in the toolbar, so there is nothing to choose here —
          but they deserve to know what is being fetched.
        */}
        <div className="kv" data-kv="start-resolution">
          <span>{t("start.resolution")}</span>
          <b data-resolution={intervalMinutes}>
            {intervalMinutes >= 1440 ? "1D" : `${intervalMinutes}m`}
          </b>
        </div>

        {mode === "replay" && (
          <p
            className={avail.verdict === "ok" ? "msg" : "msg warn"}
            data-note="start-availability"
            data-verdict={avail.verdict}
          >
            {avail.message}
          </p>
        )}

        <p className="msg">{t("start.framesNote")}</p>

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
