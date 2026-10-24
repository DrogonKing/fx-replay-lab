/**
 * Full-window login overlay, shown until a session starts.
 *
 * Three ways in, matching how a terminal is actually opened:
 *   1. connect a MetaTrader account — logs the terminal in and enters LIVE with the
 *      MT feed as the live source;
 *   2. offline mode — the sample series, or bars already downloaded to this machine
 *      (listed from the MT store's catalog);
 *   3. download history — jumps straight to the sidebar's Download tab.
 *
 * The chart and the whole shell exist behind the overlay (dimmed), so choosing a path
 * feels like revealing the terminal rather than waiting for an app to boot. Field
 * names are mt-* (not the BrokerPanel's br-*): both can be in the tree at once and
 * duplicate data-field values would make selectors ambiguous.
 */
import React, { useEffect, useState } from "react";
import { useI18n } from "../i18n-context.js";
import type { Candle } from "../../core/types.js";
import { latinNum } from "../../core/format.js";

/** What mtStatus() reports about the connected terminal. */
export interface MtAccountInfo {
  account: string;
  server: string;
  company: string;
  hidden: boolean;
}

export interface LoginOverlayProps {
  onMtConnected: (info: MtAccountInfo) => void;
  /** sample data, replay mode */
  onOffline: () => void;
  /** bars from the local MT store, replay mode */
  onMtLoad: (label: string, candles: Candle[]) => void;
  /** open the sidebar's Download tab */
  onDownload: () => void;
  /** main's file picker (CSV / .bi5 / ZIP) */
  onImportFile: () => void;
}

interface LoginApi {
  bridgeConnect?: (req: {
    login: string; password: string; server: string; url?: string;
  }) => Promise<{
    ok: boolean; account?: string; error?: string;
    stage?: "start" | "login" | "done"; steps?: string[];
  }>;
  bridgeAvailability?: () => Promise<{
    available: boolean; reason: string | null; running: boolean; port: number; platform: string;
  }>;
  mtStatus?: () => Promise<{
    ok?: boolean; connected?: boolean; account?: string; server?: string;
    company?: string; hidden?: boolean; error?: string;
  }>;
  mtCatalog?: () => Promise<Array<{
    symbol: string; tf: string; source: string; count: number; from: number; to: number;
  }>>;
  mtLoadCandles?: (req: {
    symbol: string; timeframe: string; from?: number; to?: number;
  }) => Promise<Candle[]>;
}

function api(): LoginApi {
  return (globalThis as unknown as { fxlab?: LoginApi }).fxlab ?? {};
}

const day = (epoch: number): string =>
  new Date(epoch * 1000).toISOString().slice(0, 10);

export function LoginOverlay({
  onMtConnected, onOffline, onMtLoad, onDownload, onImportFile,
}: LoginOverlayProps): JSX.Element {
  const { t } = useI18n();

  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [server, setServer] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [noteKind, setNoteKind] = useState<"info" | "up" | "down">("info");
  const [steps, setSteps] = useState<string[]>([]);
  const [availability, setAvailability] = useState<{
    available: boolean; reason: string | null;
  } | null>(null);

  const [catalog, setCatalog] = useState<Array<{
    symbol: string; tf: string; source: string; count: number; from: number; to: number;
  }>>([]);
  const [loadingRow, setLoadingRow] = useState<string | null>(null);

  // Can the bundled bridge even run here? Decides whether Connect is offered.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const fn = api().bridgeAvailability;
        if (!fn) return;
        const a = await fn();
        if (alive) setAvailability({ available: a.available, reason: a.reason });
      } catch { /* an older main process: the click will report it */ }
    })();
    return () => { alive = false; };
  }, []);

  // What is already stored on this machine, so "offline" is a real choice, not just
  // the sample series.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const rows = await api().mtCatalog?.() ?? [];
        if (alive) setCatalog(rows);
      } catch { /* no store or an older build: the offline list simply stays empty */ }
    })();
    return () => { alive = false; };
  }, []);

  const loadStored = async (symbol: string, tf: string): Promise<void> => {
    const fn = api().mtLoadCandles;
    if (!fn) return;
    const key = `${symbol}-${tf}`;
    setLoadingRow(key);
    try {
      const candles = await fn({ symbol, timeframe: tf });
      if (candles.length > 0) onMtLoad(`${symbol} ${tf} (stored)`, candles);
      else {
        setNoteKind("down");
        setNote(t("login.nothingStored"));
      }
    } catch (e) {
      setNoteKind("down");
      setNote((e as Error).message);
    } finally {
      setLoadingRow(null);
    }
  };

  const doConnect = async (): Promise<void> => {
    if (!login.trim() || !password || !server.trim()) {
      setNoteKind("down");
      setNote(t("br.connectNeedAll"));
      return;
    }
    const connect = api().bridgeConnect;
    if (!connect) {
      setNoteKind("down");
      setNote(t("br.connectUnsupported"));
      return;
    }
    setBusy(true);
    setNote("");
    setSteps([]);
    try {
      const r = await connect({
        login: login.trim(), password, server: server.trim(),
      });
      setSteps(r.steps ?? []);
      if (!r.ok) {
        setNoteKind("down");
        setNote(r.error ?? t("br.connectFailed"));
        return;
      }
      // the password has done its job; it is never stored anywhere
      setPassword("");

      // Confirm against the bridge's own status, which is where the account number
      // and the hidden-terminal fact come from — not from the login form.
      const st = await api().mtStatus?.();
      if (st?.connected && st.account) {
        onMtConnected({
          account: st.account,
          server: st.server ?? server.trim(),
          company: st.company ?? "",
          hidden: st.hidden ?? false,
        });
        return;
      }
      setNoteKind("down");
      setNote(st?.error ?? t("login.mtStatusFailed"));
    } catch (e) {
      setNoteKind("down");
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-overlay" data-panel="login">
      <div className="login-card">
        <h1 className="login-title">{t("app.name")}</h1>
        <p className="login-sub">{t("login.sub")}</p>

        {/* ---- path 1: MetaTrader account ---- */}
        <section className="login-path" data-path="mt">
          <b>{t("login.mtTitle")}</b>
          <p className="msg">{t("login.mtSub")}</p>

          {availability && !availability.available && (
            <p className="msg down" data-note="login-br-unavailable">{availability.reason}</p>
          )}

          <label className="field">
            {t("br.login")}
            <input
              data-field="mt-login"
              value={login}
              dir="ltr"
              inputMode="numeric"
              placeholder="12345678"
              onChange={(e) => setLogin(e.target.value)}
            />
          </label>
          <label className="field">
            {t("br.password")}
            <input
              data-field="mt-password"
              type="password"
              value={password}
              autoComplete="off"
              placeholder="••••••••"
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <label className="field">
            {t("br.server")}
            <input
              data-field="mt-server"
              value={server}
              dir="ltr"
              placeholder="ICMarketsEU-Demo"
              onChange={(e) => setServer(e.target.value)}
            />
          </label>

          <button
            className="dl-go"
            data-action="mt-connect"
            data-state={busy ? "busy" : "idle"}
            disabled={busy || (availability !== null && !availability.available)}
            onClick={() => void doConnect()}
          >
            {busy ? t("br.connecting") : t("br.connect")}
          </button>

          {note && (
            <p className={noteKind === "down" ? "msg down" : noteKind === "up" ? "msg up" : "msg"} data-note="mt-connect-verdict">
              {note}
            </p>
          )}
          {steps.length > 0 && (
            <ol className="br-steps" data-note="mt-connect-steps">
              {steps.map((s) => <li key={s}>{s}</li>)}
            </ol>
          )}
          <p className="msg" data-note="mt-login-security">{t("br.loginSecurity")}</p>
        </section>

        <div className="dl-sep" />

        {/* ---- path 2: offline ---- */}
        <section className="login-path" data-path="offline">
          <b>{t("login.offlineTitle")}</b>
          <p className="msg">{t("login.offlineSub")}</p>

          <div className="row">
            <button data-action="start-sample" className="login-btn" onClick={onOffline}>
              {t("login.sample")}
            </button>
            <button data-action="start-file" className="login-btn" onClick={onImportFile}>
              {t("start.fromFile")}
            </button>
          </div>

          {catalog.length > 0 ? (
            <table className="grid" data-panel="login-catalog">
              <thead>
                <tr>
                  <th>{t("journal.symbol")}</th>
                  <th>TF</th>
                  <th>{t("dl.bars")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {catalog.map((row) => {
                  const key = `${row.symbol}-${row.tf}`;
                  return (
                    <tr key={`${key}-${row.source}`} data-stored={key}>
                      <td>{row.symbol}</td>
                      <td className="num">{row.tf}</td>
                      <td className="num" title={`${day(row.from)} → ${day(row.to)}`}>
                        {latinNum(row.count)}
                      </td>
                      <td>
                        <button
                          className="mini"
                          data-action="mt-load"
                          data-symbol={row.symbol}
                          data-tf={row.tf}
                          disabled={loadingRow !== null}
                          onClick={() => void loadStored(row.symbol, row.tf)}
                        >
                          {loadingRow === key ? "…" : t("dl.mtLoad")}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <p className="msg">{t("login.noStored")}</p>
          )}
        </section>

        <div className="dl-sep" />

        {/* ---- path 3: download history ---- */}
        <section className="login-path" data-path="download">
          <b>{t("login.downloadTitle")}</b>
          <p className="msg">{t("dl.sub")}</p>
          <button data-action="start-download" className="login-btn" onClick={onDownload}>
            {t("login.downloadGo")}
          </button>
        </section>

        <p className="start-foot">{t("start.foot")}</p>
      </div>
    </div>
  );
}
