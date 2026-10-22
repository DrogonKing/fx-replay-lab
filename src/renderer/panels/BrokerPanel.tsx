/**
 * Broker connection panel.
 *
 * Three transports, one list, because "broker" is not one protocol:
 *   - MetaTrader 4/5: no HTTP API exists, so this talks to a local bridge that talks to the
 *     user's own terminal. Works with ANY MT4/MT5 broker.
 *   - OANDA: real REST, real bid/ask.
 *   - cTrader: OAuth + protobuf.
 *
 * Credentials are held in component state only. They are never written to the database, never
 * logged, and never included in a status message — a secret that reaches a log line is leaked.
 */
import React, { useCallback, useEffect, useState } from "react";
import { useI18n } from "../i18n-context.js";
import { ADAPTERS, describeTransport } from "../../core/brokers.js";
import type { Candle } from "../../core/types.js";

export interface BrokerPanelProps {
  onLoad: (label: string, candles: Candle[]) => void;
  onStatus: (msg: string) => void;
}

interface BridgeHealth {
  ok?: boolean;
  connected?: boolean;
  symbols?: number;
  error?: string;
}

interface BridgeTestResult {
  ok: boolean;
  health?: BridgeHealth;
  symbols?: string[];
  bars?: number;
  firstOpen?: number;
  firstTime?: string;
  lastTime?: string;
  error?: string;
}

interface BrokerApi {
  /** ask main to probe a bridge URL; main does the fetch because CSP blocks the renderer */
  testBridge?: (url: string) => Promise<BridgeTestResult>;
  fetchBridgeCandles?: (req: {
    url: string; symbol: string; timeframe: string; from: number; to: number;
  }) => Promise<{ ok: boolean; candles?: Candle[]; error?: string }>;
  /** log the MT5 terminal in through the bridge; the only write-shaped call */
  bridgeLogin?: (req: {
    url: string; login: string; password: string; server: string;
  }) => Promise<{ ok: boolean; account?: string; symbols?: number; error?: string }>;
  /**
   * One press: start the bundled bridge, then log in. The app owns the whole chain, so the user does
   * not install Python or run a script.
   */
  bridgeConnect?: (req: {
    login: string; password: string; server: string; url?: string;
  }) => Promise<{
    ok: boolean; account?: string; symbols?: number;
    error?: string; stage?: "start" | "login" | "done"; steps?: string[];
  }>;
  bridgeAvailability?: () => Promise<{
    available: boolean; reason: string | null; running: boolean; port: number; platform: string;
  }>;
  fetchOandaCandles?: (req: {
    token: string; accountId: string; symbol: string; intervalMinutes: number;
    from: number; to: number; price: "bid" | "ask" | "mid"; practice: boolean;
  }) => Promise<{ ok: boolean; candles?: Candle[]; error?: string }>;
}

function api(): BrokerApi {
  return (globalThis as unknown as { fxlab?: BrokerApi }).fxlab ?? {};
}

const TIMEFRAMES = ["M1", "M5", "M15", "M30", "H1", "H4", "D1"];

/** A default range that almost every broker has: one week, two weeks back. */
function defaultRange(): { from: number; to: number; fromStr: string; toStr: string } {
  const now = new Date();
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(to.getTime() - 14 * 86400_000);
  const iso = (d: Date): string => d.toISOString().slice(0, 10);
  return {
    from: Math.floor(from.getTime() / 1000),
    to: Math.floor(to.getTime() / 1000),
    fromStr: iso(from),
    toStr: iso(to),
  };
}

export function BrokerPanel({ onLoad, onStatus }: BrokerPanelProps): JSX.Element {
  const { t } = useI18n();

  const [adapterId, setAdapterId] = useState<string>("mt5");
  const adapter = ADAPTERS.find((a) => a.id === adapterId) ?? ADAPTERS[0]!;

  // MT5 bridge fields
  const [bridgeUrl, setBridgeUrl] = useState("http://127.0.0.1:8765");

  /**
   * MT5 login credentials, used only if the terminal is not already logged in.
   *
   * Held in component state: never written to the database, never logged, and cleared from the
   * inputs once the login succeeds. The preferred path is still to log in to MetaTrader by hand,
   * because then the app never sees a password at all — which the panel says, next to the fields.
   */
  const [mtLogin, setMtLogin] = useState("");
  const [mtPassword, setMtPassword] = useState("");
  const [mtServer, setMtServer] = useState("");
  const [loginState, setLoginState] = useState<"idle" | "busy" | "ok" | "fail">("idle");
  const [loginDetail, setLoginDetail] = useState("");

  /**
   * The one-press connect flow.
   *
   * `steps` is not decoration: when the chain fails, the useful fact is WHICH step failed — starting
   * the bundled Python, or the broker refusing the credentials. Reporting "connection failed" for
   * both is what made the previous version unhelpful.
   */
  const [connectState, setConnectState] = useState<"idle" | "busy" | "ok" | "fail">("idle");
  const [connectDetail, setConnectDetail] = useState("");
  const [connectSteps, setConnectSteps] = useState<string[]>([]);
  const [availability, setAvailability] = useState<{
    available: boolean; reason: string | null; running: boolean; port: number; platform: string;
  } | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const fn = api().bridgeAvailability;
        if (!fn) return;
        const a = await fn();
        if (alive) setAvailability(a);
      } catch {
        // an older main process without this IPC: leave the panel in manual mode
      }
    })();
    return () => { alive = false; };
  }, []);

  const doConnect = useCallback(async (): Promise<void> => {
    if (!mtLogin.trim() || !mtPassword || !mtServer.trim()) {
      setConnectState("fail");
      setConnectDetail(t("br.connectNeedAll"));
      return;
    }
    setConnectState("busy");
    setConnectDetail("");
    setConnectSteps([]);
    try {
      const connect = api().bridgeConnect;
      if (!connect) {
        setConnectState("fail");
        setConnectDetail(t("br.connectUnsupported"));
        return;
      }
      const r = await connect({
        login: mtLogin.trim(),
        password: mtPassword,
        server: mtServer.trim(),
      });
      setConnectSteps(r.steps ?? []);
      if (r.ok) {
        setConnectState("ok");
        setConnectDetail(`${t("br.connected")} — ${r.account ?? mtServer}`);
        // the password has done its job; do not keep it in the field
        setMtPassword("");
        setLoginState("ok");
        setLoginDetail(r.account ?? "");
        setBridgeState("ok");
        const probe = await api().testBridge?.(bridgeUrl);
        if (probe?.ok && probe.symbols) setSymbols(probe.symbols);
      } else {
        setConnectState("fail");
        setConnectDetail(r.error ?? t("br.connectFailed"));
      }
    } catch (e) {
      setConnectState("fail");
      setConnectDetail((e as Error).message);
    }
  }, [mtLogin, mtPassword, mtServer, bridgeUrl, t]);
  const [bridgeState, setBridgeState] = useState<"idle" | "testing" | "ok" | "fail">("idle");
  const [bridgeDetail, setBridgeDetail] = useState("");
  const [symbols, setSymbols] = useState<string[]>([]);
  const [symbol, setSymbol] = useState("EURUSD");
  const [timeframe, setTimeframe] = useState("M1");

  // OANDA fields
  const [token, setToken] = useState("");
  const [accountId, setAccountId] = useState("");
  const [practice, setPractice] = useState(true);
  const [price, setPrice] = useState<"bid" | "ask" | "mid">("mid");

  const r = defaultRange();
  const [fromStr, setFromStr] = useState(r.fromStr);
  const [toStr, setToStr] = useState(r.toStr);

  const [busy, setBusy] = useState(false);

  // The symbol list from the bridge is authoritative: most brokers use a suffix
  // (EURUSD.m, EURUSD#, EURUSD_), so guessing the name is the most common failure. Offer a
  // filtered list the moment the bridge answers.
  const testBridge = useCallback(async (): Promise<void> => {
    const a = api();
    if (!a.testBridge) {
      onStatus(t("br.noBridge"));
      return;
    }
    setBridgeState("testing");
    setBridgeDetail("");
    try {
      const res = await a.testBridge(bridgeUrl);
      if (!res.ok) {
        setBridgeState("fail");
        setBridgeDetail(res.error ?? "no response");
        return;
      }
      const syms = res.symbols ?? [];
      setSymbols(syms);
      setBridgeState("ok");
      setBridgeDetail(
        `${res.health?.symbols ?? syms.length} symbols · ` +
        `${res.bars ?? 0} bars · ${res.firstOpen ?? "—"}`,
      );
      // pick a sensible default from what the broker actually offers
      const prefer = syms.find((s) => /^EURUSD$/i.test(s))
        ?? syms.find((s) => /^EURUSD/i.test(s))
        ?? syms.find((s) => /EUR/i.test(s))
        ?? syms[0];
      if (prefer) setSymbol(prefer);
    } catch (e) {
      setBridgeState("fail");
      setBridgeDetail((e as Error).message);
    }
  }, [bridgeUrl, onStatus, t]);

  /**
   * Log the terminal in through the bridge.
   *
   * The bridge is the only thing that can do this: it holds the MetaTrader terminal, and there is
   * no public API to authenticate one from outside. On success the password fields are cleared
   * immediately — a credential left in a form field is a credential left on screen.
   */
  const doLogin = useCallback(async (): Promise<void> => {
    const a = api();
    if (!a.bridgeLogin) {
      onStatus(t("br.noBridge"));
      return;
    }
    if (mtLogin.trim() === "" || mtPassword === "" || mtServer.trim() === "") {
      setLoginState("fail");
      setLoginDetail(t("br.needCredsAll"));
      return;
    }
    setLoginState("busy");
    setLoginDetail("");
    try {
      const res = await a.bridgeLogin({
        url: bridgeUrl, login: mtLogin.trim(), password: mtPassword, server: mtServer.trim(),
      });
      if (!res.ok) {
        setLoginState("fail");
        // the bridge's own error is passed through: "initialize failed: (-6, '...')" names the
        // actual problem, and a generic message would hide it
        setLoginDetail(res.error ?? "login failed");
        return;
      }
      setLoginState("ok");
      setLoginDetail(res.account ?? "");
      setMtPassword("");
      // a login means the bridge is usable, so re-probe rather than making the user press again
      await testBridge();
    } catch (e) {
      setLoginState("fail");
      setLoginDetail((e as Error).message);
    }
  }, [bridgeUrl, mtLogin, mtPassword, mtServer, onStatus, t, testBridge]);

  /*
    Auto-probe once on mount, but ONLY when the bridge can actually run here.

    Probing an unavailable runtime can only produce a failure, and that failure's text ("start it
    with python …") contradicts the note above it saying the bridge is built in. Two messages
    disagreeing is worse than one; when the runtime is unavailable, the availability note is the
    whole story.
  */
  useEffect(() => {
    if (adapterId !== "mt5") return;
    if (availability && !availability.available) return;
    void testBridge();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adapterId, availability?.available]);

  const load = async (): Promise<void> => {
    const a = api();
    const from = Math.floor(new Date(`${fromStr}T00:00:00Z`).getTime() / 1000);
    const to = Math.floor(new Date(`${toStr}T23:59:59Z`).getTime() / 1000);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) {
      onStatus(t("br.badRange"));
      return;
    }

    setBusy(true);
    try {
      if (adapterId === "mt5") {
        if (!a.fetchBridgeCandles) {
          onStatus(t("br.noBridge"));
          return;
        }
        const res = await a.fetchBridgeCandles({
          url: bridgeUrl, symbol, timeframe, from, to,
        });
        if (!res.ok || !res.candles || res.candles.length === 0) {
          // the bridge's own error is surfaced verbatim: it names the rejected symbol, which is
          // the only way the user can find their broker's naming
          onStatus(res.error ?? t("br.nothing"));
          return;
        }
        onLoad(`${symbol} ${timeframe} (${adapter.label})`, res.candles);
        return;
      }

      if (adapterId === "oanda") {
        if (!a.fetchOandaCandles) {
          onStatus(t("br.noBridge"));
          return;
        }
        if (token.trim().length === 0 || accountId.trim().length === 0) {
          onStatus(t("br.needCreds"));
          return;
        }
        const res = await a.fetchOandaCandles({
          token, accountId,
          symbol,
          intervalMinutes: timeframeToMinutes(timeframe),
          from, to, price, practice,
        });
        if (!res.ok || !res.candles || res.candles.length === 0) {
          // never echo the token, even inside an error string
          onStatus((res.error ?? t("br.nothing")).replace(token, "[REDACTED]"));
          return;
        }
        onLoad(`${symbol} ${timeframe} (OANDA ${practice ? "practice" : "live"})`, res.candles);
        return;
      }

      onStatus(t("br.notImplemented"));
    } catch (e) {
      onStatus(`failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const filtered = symbols.filter((s) =>
    symbol.length === 0 ? true : s.toUpperCase().includes(symbol.toUpperCase()),
  ).slice(0, 40);

  return (
    <div className="broker" data-panel="broker">
      <h3>{t("br.title")}</h3>
      <p className="msg">{t("br.sub")}</p>

      <label className="field">
        {t("br.transport")}
        <select
          data-field="br-adapter"
          value={adapterId}
          onChange={(e) => {
            setAdapterId(e.target.value);
            setBridgeState("idle");
            setSymbols([]);
          }}
        >
          {ADAPTERS.map((a) => (
            <option key={a.id} value={a.id}>{a.label}</option>
          ))}
        </select>
      </label>
      <p className="msg">{describeTransport(adapter.transport)}</p>

      {adapter.windowsOnly && (
        <p className="msg warn" data-note="br-windows">
          {t("br.windowsOnly")}
        </p>
      )}

      {adapterId === "mt5" && (
        <>
          <label className="field">
            {t("br.bridgeUrl")}
            <input
              data-field="br-url"
              value={bridgeUrl}
              onChange={(e) => setBridgeUrl(e.target.value)}
              placeholder="http://127.0.0.1:8765"
            />
          </label>

          <button data-action="br-test" onClick={() => void testBridge()}>
            {bridgeState === "testing" ? t("br.testing") : t("br.test")}
          </button>

          {/* The verdict is a sentence, not a colour: a failed probe has to say WHY */}
          {bridgeState !== "idle" && bridgeState !== "testing" && (
            <p
              className={bridgeState === "ok" ? "msg up" : "msg down"}
              data-note="br-verdict"
              data-verdict={bridgeState}
            >
              {bridgeState === "ok" ? `${t("br.connected")} — ${bridgeDetail}` : bridgeDetail}
            </p>
          )}

          {/*
            Credentials. Shown always, not only when the probe failed, because a user who has not
            started their terminal yet reads the panel top to bottom and needs to know this exists.
            The note above says the better path first, so nobody types a password who does not
            need to.
          */}
          {/*
            Kept visible after a successful probe. Hiding it on success meant a successful login
            made the form disappear along with the only confirmation, and left a user who needs to
            switch accounts with no form to do it in.
          */}
          {bridgeState === "ok" && loginState === "ok" && (
            // the confirmation, kept on screen: a form that vanishes on success leaves the user
            // unsure whether it worked
            <p className="msg up" data-note="br-login-verdict" data-verdict="ok">
              {`${t("br.loggedIn")} — ${loginDetail}`}
            </p>
          )}
          {/*
            Credentials, always available.

            The block is NOT removed once connected: a user who logs in and then needs a different
            account would otherwise have no form to do it with, and the confirmation they just
            earned would vanish with it. Instead it collapses to a summary so it stops dominating
            the panel, and the account line stays on screen.
          */}
          {bridgeState === "ok" && loginState === "ok" && (
            <p className="msg up" data-note="br-login-verdict" data-verdict="ok">
              {`${t("br.loggedIn")} — ${loginDetail}`}
            </p>
          )}
          <div className="br-login" data-note="br-login-block">
            {/*
              One button, and the app does the rest: it starts the bundled Python bridge, logs the
              terminal in, and says which step failed. The old version told the user to install
              Python and run a script themselves, which is the app delegating its own setup.
            */}
            {availability && !availability.available && (
              <p className="msg down" data-note="br-unavailable">
                {availability.reason}
              </p>
            )}

            {availability?.available && (
              <p className="msg" data-note="br-runtime">
                {t("br.runtimeBundled").replace("{port}", String(availability.port))}
              </p>
            )}

            <label className="field">
              {t("br.login")}
              <input
                data-field="br-login"
                value={mtLogin}
                onChange={(e) => setMtLogin(e.target.value)}
                placeholder="12345678"
                inputMode="numeric"
              />
            </label>
            <label className="field">
              {t("br.password")}
              <input
                data-field="br-password"
                type="password"
                value={mtPassword}
                onChange={(e) => setMtPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="off"
              />
            </label>
            <label className="field">
              {t("br.server")}
              <input
                data-field="br-server"
                value={mtServer}
                onChange={(e) => setMtServer(e.target.value)}
                placeholder="ICMarkets-Demo"
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
              <p className="msg down" data-note="br-connect-verdict" data-verdict="fail">
                {connectDetail}
              </p>
            )}
            {connectState === "ok" && (
              <p className="msg up" data-note="br-connect-verdict" data-verdict="ok">
                {connectDetail}
              </p>
            )}

            {connectSteps.length > 0 && (
              <ol className="br-steps" data-note="br-connect-steps">
                {connectSteps.map((s) => <li key={s}>{s}</li>)}
              </ol>
            )}

            <p className="msg" data-note="br-login-security">{t("br.loginSecurity")}</p>
          </div>

          {bridgeState === "ok" && symbols.length > 0 && (
            <>
              <label className="field">
                {t("br.symbol")}
                <input
                  data-field="br-symbol"
                  value={symbol}
                  onChange={(e) => setSymbol(e.target.value)}
                  list="br-symbol-list"
                  placeholder="EURUSD"
                />
                <datalist id="br-symbol-list">
                  {filtered.map((s) => <option key={s} value={s} />)}
                </datalist>
              </label>
              <p className="msg" data-note="br-symbol-hint">
                {t("br.symbolHint")}
              </p>
              {filtered.length > 0 && filtered[0] !== symbol && (
                <p className="msg">
                  {t("br.didYouMean")}: {filtered.slice(0, 3).join(", ")}
                </p>
              )}
            </>
          )}
        </>
      )}

      {adapterId === "oanda" && (
        <>
          <label className="field">
            {t("br.token")}
            <input
              data-field="br-token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="••••••"
              autoComplete="off"
            />
          </label>
          <label className="field">
            {t("br.accountId")}
            <input
              data-field="br-account"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              placeholder="101-004-1234567-001"
            />
          </label>
          <label className="field">
            {t("br.price")}
            <select
              data-field="br-price"
              value={price}
              onChange={(e) => setPrice(e.target.value as "bid" | "ask" | "mid")}
            >
              <option value="mid">mid</option>
              <option value="bid">bid</option>
              <option value="ask">ask</option>
            </select>
          </label>
          <label className="field">
            {t("br.host")}
            <select
              data-field="br-practice"
              value={practice ? "yes" : "no"}
              onChange={(e) => setPractice(e.target.value === "yes")}
            >
              <option value="yes">practice (api-fxpractice)</option>
              <option value="no">live (api-fxtrade)</option>
            </select>
          </label>
          <p className="msg">{t("br.tokenNote")}</p>
          {adapterId === "oanda" && (
            <label className="field">
              {t("br.symbol")}
              <input
                data-field="br-symbol"
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
                placeholder="EUR_USD"
              />
            </label>
          )}
        </>
      )}

      {adapterId !== "ctrader" && (
        <>
          <label className="field">
            {t("br.timeframe")}
            <select
              data-field="br-timeframe"
              value={timeframe}
              onChange={(e) => setTimeframe(e.target.value)}
            >
              {TIMEFRAMES.map((tf) => <option key={tf} value={tf}>{tf}</option>)}
            </select>
          </label>

          <div className="dl-range">
            <label className="field">
              {t("br.from")}
              <input
                data-field="br-from"
                type="date"
                value={fromStr}
                onChange={(e) => setFromStr(e.target.value)}
              />
            </label>
            <label className="field">
              {t("br.to")}
              <input
                data-field="br-to"
                type="date"
                value={toStr}
                onChange={(e) => setToStr(e.target.value)}
              />
            </label>
          </div>

          <button
            className="dl-go"
            data-action="br-load"
            disabled={busy || (adapterId === "mt5" && bridgeState !== "ok")}
            onClick={() => void load()}
          >
            {busy ? t("br.loading") : t("br.load")}
          </button>
        </>
      )}

      {adapterId === "ctrader" && (
        <p className="msg warn">{t("br.notImplemented")}</p>
      )}

      <p className="msg" data-note="br-security">{t("br.security")}</p>
    </div>
  );
}

/** "M15" -> 15. The bridge takes its own names; OANDA takes minutes. */
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
