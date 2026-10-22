/**
 * Replace the broker panel's login block with a single Connect flow.
 *
 * The app now owns the whole chain: it starts the bundled Python bridge, logs the terminal in, and
 * reports which step failed. So the "how to run the bridge yourself" instructions are gone — they
 * described a manual prerequisite that no longer exists — and the panel shows one button plus a
 * live status line.
 *
 * Written as a script because the block is ~60 lines inside a 572-line file and a line-range edit
 * would silently drift the moment anything above it changes. The markers are unique.
 */
import { readFileSync, writeFileSync } from "node:fs";

const path = "src/renderer/panels/BrokerPanel.tsx";
let src = readFileSync(path, "utf8");

const startMarker = `          <div className="br-login" data-note="br-login-block" data-collapsed={bridgeState === "ok" ? "yes" : "no"}>`;
const endMarker = `            <p className="msg" data-note="br-login-security">{t("br.loginSecurity")}</p>
          </div>`;

const startAt = src.indexOf(startMarker);
if (startAt < 0) { console.log("start marker not found"); process.exit(1); }
const endAt = src.indexOf(endMarker, startAt);
if (endAt < 0) { console.log("end marker not found — refusing to guess"); process.exit(1); }

const block = `          <div className="br-login" data-note="br-login-block">
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
          </div>`;

src = src.slice(0, startAt) + block + src.slice(endAt + endMarker.length);
writeFileSync(path, src);
console.log("replaced the login block with a one-press connect flow");
