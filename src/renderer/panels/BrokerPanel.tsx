/**
 * Broker panel: log in, and nothing else.
 *
 * What this panel is for, in the user's words: "this menu should only be entering an account and
 * logging in." So it has three fields and one button. Everything the previous version also offered -
 * a transport dropdown, a bridge URL, a probe button, an OANDA token, a symbol/timeframe/date range
 * and a Load candles button - was removed. Those were internals of our own plumbing, or a second way
 * to ask a question the Connect button already answers.
 *
 * Two behaviours worth naming:
 *   - Connecting loads the chart. A login that leaves the chart empty reads as a login that failed,
 *     which is exactly how it was reported.
 *   - Credentials are used once, in memory, and cleared. The bridge attaches to a terminal that is
 *     already running rather than starting one, so no MetaTrader window opens on Connect.
 */
import React, { useCallback, useEffect, useState } from "react";
import type { Candle } from "../../core/types.js";
import { useI18n } from "../i18n-context.js";

/** The slice of the preload bridge this panel needs. Everything else stays out of reach. */
interface BridgeApi {
  bridgeConnect?: (req: {
    login: string; password: string; server: string; url?: string;
  }) => Promise<{
    ok: boolean; account?: string; error?: string;
    stage?: "start" | "login" | "done"; steps?: string[];
  }>;
  bridgeAvailability?: () => Promise<{
    available: boolean; reason: string | null; running: boolean; port: number; platform: string;
  }>;
  testBridge?: (url: string) => Promise<{ ok: boolean; symbols?: string[]; error?: string }>;
  fetchBridgeCandles?: (req: {
    url: string; symbol: string; timeframe: string; from: number; to: number;
  }) => Promise<{ ok: boolean; candles?: Candle[]; error?: string }>;
}

function api(): BridgeApi {
  return (globalThis as unknown as { fxlab?: BridgeApi }).fxlab ?? {};
}

export interface BrokerPanelProps {
  onStatus: (message: string) => void;
  onLoad: (label: string, candles: Candle[]) => void;
}

export function BrokerPanel({ onStatus, onLoad }: BrokerPanelProps): JSX.Element {
  const { t } = useI18n();

  const [availability, setAvailability] = useState<{
    available: boolean; reason: string | null; running: boolean; port: number; platform: string;
  } | null>(null);

  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [server, setServer] = useState("");

  const [connectState, setConnectState] = useState<"idle" | "busy" | "ok" | "fail">("idle");
  const [connectDetail, setConnectDetail] = useState("");
  const [connectSteps, setConnectSteps] = useState<string[]>([]);
  const [loadNote, setLoadNote] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);

  // Ask main once whether the bundled runtime can run here, and why not if it cannot. The answer
  // decides whether Connect is even possible, so it is not optional decoration.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const fn = api().bridgeAvailability;
        if (!fn) return;
        const a = await fn();
        if (alive) setAvailability(a);
      } catch {
        // an older main process: leave availability null and let the click report the failure
      }
    })();
    return () => { alive = false; };
  }, []);

  /**
   * Fetch bars and hand them to the chart.
   *
   * Symbol naming is the broker's, not ours: an account may quote EURUSD.a or EURUSDm, so the first
   * symbol the terminal reports is used when the expected name is absent. Guessing wrong here is
   * silent — the bridge answers "unknown symbol" and the user sees an empty chart — so the error is
   * surfaced verbatim.
   */
  const fillChart = useCallback(async (): Promise<void> => {
    const a = api();
    const now = Math.floor(Date.now() / 1000);
    const from = now - 60 * 60 * 24 * 14;

    const probe = await a.testBridge?.("http://127.0.0.1:8765");
    if (!probe?.ok) {
      setLoadFailed(true);
      setLoadNote(probe?.error ?? t("br.nothing"));
      return;
    }

    /*
      Resolve our name to the broker's name.

      Brokers decorate symbols: EURUSD.m, EURUSD.a, EURUSDm, EURUSDmicro, EURUSD.pro. Demanding an
      exact "EURUSD" match is why a successful login produced an empty chart - the bridge answered
      "symbol 'EURUSD' not available at this broker" and the panel threw that away.

      Preference order: exact match, then a decorated variant of the same pair, then anything the
      terminal lists. The chosen name is shown in the chart label so the user can see which one was
      used rather than having to guess.
    */
    const wanted = "EURUSD";
    const list = probe.symbols ?? [];
    const decorated = list.find((s) => s.toUpperCase().startsWith(wanted));
    const symbol = list.includes(wanted) ? wanted : (decorated ?? list[0] ?? wanted);

    const res = await a.fetchBridgeCandles?.({
      url: "http://127.0.0.1:8765", symbol, timeframe: "M1", from, to: now,
    });
    if (!res?.ok || !res.candles?.length) {
      setLoadFailed(true);
      setLoadNote(res?.error ?? t("br.nothing"));
      onStatus(res?.error ?? t("br.nothing"));
      return;
    }
    onLoad(`${symbol} M1 (MT5)`, res.candles);
    setLoadFailed(false);
    setLoadNote(`${res.candles.length.toLocaleString()} bars loaded into the chart`);
  }, [onLoad, onStatus, t]);

  const doConnect = useCallback(async (): Promise<void> => {
    if (!login.trim() || !password || !server.trim()) {
      setConnectState("fail");
      setConnectDetail(t("br.connectNeedAll"));
      return;
    }
    const connect = api().bridgeConnect;
    if (!connect) {
      setConnectState("fail");
      setConnectDetail(t("br.connectUnsupported"));
      return;
    }

    setConnectState("busy");
    setConnectDetail("");
    setConnectSteps([]);
    setLoadNote("");
    setLoadFailed(false);

    try {
      const r = await connect({
        login: login.trim(), password, server: server.trim(),
      });
      setConnectSteps(r.steps ?? []);
      if (!r.ok) {
        setConnectState("fail");
        setConnectDetail(r.error ?? t("br.connectFailed"));
        return;
      }
      setConnectState("ok");
      setConnectDetail(`${t("br.connected")} — ${r.account ?? server.trim()}`);
      // the password has done its job
      setPassword("");
      await fillChart();
    } catch (e) {
      setConnectState("fail");
      setConnectDetail((e as Error).message);
    }
  }, [login, password, server, fillChart, t]);

  return (
    <div className="broker" data-panel="broker">
      <h3>{t("br.title")}</h3>
      <p className="msg">{t("br.sub")}</p>

      {/* The runtime's state, one line. No address, no port, no probe button: the app owns all of it,
          and exposing it only invited the user to configure our internals. */}
      {availability && !availability.available && (
        <p className="msg down" data-note="br-unavailable">{availability.reason}</p>
      )}

      <label className="field">
        {t("br.login")}
        <input
          data-field="br-login"
          value={login}
          onChange={(e) => setLogin(e.target.value)}
          placeholder="12345678"
          inputMode="numeric"
        />
      </label>
      <label className="field">
        {t("br.password")}
        <input
          data-field="br-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
          autoComplete="off"
        />
      </label>
      <label className="field">
        {t("br.server")}
        <input
          data-field="br-server"
          value={server}
          onChange={(e) => setServer(e.target.value)}
          placeholder="ICMarketsEU-Demo"
        />
      </label>

      <button
        className="primary"
        data-action="br-connect"
        data-state={connectState}
        disabled={connectState === "busy" || !availability?.available}
        onClick={() => void doConnect()}
      >
        {connectState === "busy" ? t("br.connecting") : t("br.connect")}
      </button>

      {connectState === "fail" && (
        <p className="msg down" data-note="br-connect-verdict" data-verdict="fail">{connectDetail}</p>
      )}
      {connectState === "ok" && (
        <p className="msg up" data-note="br-connect-verdict" data-verdict="ok">{connectDetail}</p>
      )}

      {connectSteps.length > 0 && (
        <ol className="br-steps" data-note="br-connect-steps">
          {connectSteps.map((s) => <li key={s}>{s}</li>)}
        </ol>
      )}

      {loadNote && (
        <p className={loadFailed ? "msg down" : "msg"} data-note="br-load">{loadNote}</p>
      )}

      <p className="msg" data-note="br-login-security">{t("br.loginSecurity")}</p>
    </div>
  );
}

/** "M15" -> 15. Kept because tests/broker-boundary.test.ts imports it as a public helper. */
export function timeframeToMinutes(tf: string): number {
  const m = /^([MHD])(\d+)$/i.exec(tf);
  if (!m) return 1;
  const n = Number(m[2]);
  switch (m[1]!.toUpperCase()) {
    case "M": return n;
    case "H": return n * 60;
    case "D": return n * 1440;
    default: return 1;
  }
}
