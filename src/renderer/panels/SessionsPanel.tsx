/**
 * Sessions panel: toggle the chart washes and show per-session journal statistics.
 *
 * The statistics are the part that earns its place: a wash that only colours the chart is
 * decoration, but "you lose money in Tokyo and make it in London" changes behaviour.
 */
import React from "react";
import { SESSIONS, sessionStats, sessionLabel, type SessionName } from "../../core/sessions.js";
import { useI18n } from "../i18n-context.js";

interface Props {
  show: boolean;
  onShow: (v: boolean) => void;
  active: SessionName[];
  onActive: (v: SessionName[]) => void;
  /** journal entries, for the per-session breakdown */
  trades: ReadonlyArray<{ entryTime: number; pnl: number; symbol: string }>;
}

export function SessionsPanel({
  show, onShow, active, onActive, trades,
}: Props): JSX.Element {
  const { t } = useI18n();

  const toggle = (name: SessionName): void => {
    onActive(active.includes(name) ? active.filter((n) => n !== name) : [...active, name]);
  };

  const stats = sessionStats(trades);
  const total = trades.length;

  return (
    <div className="sessions-panel">
      <h3>{t("sessions.title")}</h3>

      <label className="checkbox-row">
        <input type="checkbox" checked={show} onChange={(e) => onShow(e.target.checked)} />
        {t("sessions.showOnChart")}
      </label>

      <div className="session-list">
        {SESSIONS.map((s) => (
          <label key={s.name} className="session-row">
            <input
              type="checkbox"
              checked={active.includes(s.name)}
              onChange={() => toggle(s.name)}
            />
            <span className="swatch" style={{ background: s.colour }} />
            <span className="session-name">{sessionLabel(s.name)}</span>
            <span className="session-hours">
              {String(s.openHour % 24).padStart(2, "0")}:00–
              {String(s.closeHour % 24).padStart(2, "0")}:00
            </span>
          </label>
        ))}
      </div>

      <p className="msg">{t("sessions.hint")}</p>

      {total > 0 && (
        <>
          <h3>{t("sessions.bySession")}</h3>
          <table className="grid sessions-table">
            <thead>
              <tr>
                <th>{t("journal.tag")}</th>
                <th>{t("journal.n")}</th>
                <th>{t("journal.net")}</th>
                <th>{t("journal.winPct")}</th>
              </tr>
            </thead>
            <tbody>
              {stats.map((row) => (
                <tr key={row.session}>
                  <td>
                    <span
                      className="swatch"
                      style={{
                        background: row.session === "off"
                          ? "#4a4a4a"
                          : SESSIONS.find((s) => s.name === row.session)?.colour ?? "#4a4a4a",
                      }}
                    />
                    {sessionLabel(row.session)}
                  </td>
                  <td>{row.count}</td>
                  <td className={row.netPnl >= 0 ? "up" : "down"}>
                    {row.netPnl.toFixed(0)}
                  </td>
                  <td>{row.winRate.toFixed(0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="msg">
            {t("sessions.attribution")}
          </p>
        </>
      )}

      {total === 0 && <p className="msg">{t("sessions.noTrades")}</p>}
    </div>
  );
}
