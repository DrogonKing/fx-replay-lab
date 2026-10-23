/**
 * Rewrite the broker panel as the user asked: this panel is for logging in, nothing else.
 *
 * What was there and is now gone, because it is noise in a login screen:
 *   - the transport dropdown (MT4/MT5 vs OANDA vs cTrader) — the app's purpose here is MT5, and a
 *     dropdown that changes what the whole panel means is a menu of decisions before the first click
 *   - the bridge URL field and the "probe the bridge" button — the bridge is started by the app, so
 *     asking for its address was asking the user to configure our own internals
 *   - the Windows-only warning paragraph — the build is Windows-only now, so it warned about a
 *     platform the user cannot be on
 *   - the OANDA token block and the cTrader block
 *   - the symbol/timeframe/from/to/load-candles block — candles load automatically after connecting,
 *     which is what "I gave it the account, why is there no chart" was about
 *
 * What is left: three fields, one button, and the state of the connection.
 *
 * The panel keeps its file because App.tsx imports it, and keeps `onLoad`/`onStatus` because the
 * chart still needs the bars and the status bar still needs the sentence.
 */
import { readFileSync, writeFileSync } from "node:fs";

const path = "src/renderer/panels/BrokerPanel.tsx";
const src = readFileSync(path, "utf8");

// Keep the imports, types, helpers and hooks; replace only the render tree.
const renderStart = src.indexOf("  return (\n    <div className=\"broker\" data-panel=\"broker\">");
if (renderStart < 0) { console.log("render start not found"); process.exit(1); }

// The component ends with the final `);\n}` of the file.
const renderEnd = src.lastIndexOf("\n}\n");
if (renderEnd < 0 || renderEnd < renderStart) { console.log("render end not found"); process.exit(1); }

const head = src.slice(0, renderStart);
const tail = src.slice(renderEnd);

const render = `  return (
    <div className="broker" data-panel="broker">
      <h3>{t("br.title")}</h3>
      <p className="msg">{t("br.sub")}</p>

      {/* The runtime's own state, in one line. No address, no port, no probe button: the app owns
          all of that now, and exposing it only invited the user to configure our internals. */}
      {availability && !availability.available && (
        <p className="msg down" data-note="br-unavailable">{availability.reason}</p>
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

      {/* After a successful connect the chart fills itself. This line reports what came back, so a
          silent failure cannot look like a working login. */}
      {loadNote && (
        <p className={loadState === "fail" ? "msg down" : "msg"} data-note="br-load">
          {loadNote}
        </p>
      )}

      <p className="msg" data-note="br-login-security">{t("br.loginSecurity")}</p>
    </div>
  );`;

// The new render uses two pieces of state that must exist in the component head.
let newHead = head;
if (!newHead.includes('data-note="br-load"') && !newHead.includes("const [loadNote")) {
  newHead = newHead.replace(
    `  const [availability, setAvailability] = useState<{`,
    `  /** What the automatic chart load did, so a silent fetch failure is visible. */
  const [loadState, setLoadState] = useState<"idle" | "busy" | "ok" | "fail">("idle");
  const [loadNote, setLoadNote] = useState("");

  const [availability, setAvailability] = useState<{`,
  );
}

writeFileSync(path, newHead + render + tail);
console.log(`rewrote the panel render (${src.split("\\n").length} -> ${(newHead + render + tail).split("\\n").length} lines)`);
