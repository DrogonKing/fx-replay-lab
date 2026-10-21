import { readFileSync, writeFileSync } from "node:fs";

/**
 * Replace the login block wholesale.
 *
 * Patching it piecemeal left a half-written <details> wrapper, which is exactly the kind of
 * breakage that a targeted patch invites. The block is one unit, so it is written as one unit.
 */
const path = "src/renderer/panels/BrokerPanel.tsx";
const lines = readFileSync(path, "utf8").split("\n");

// replace file lines 341..398 (1-indexed) — the whole login block up to the symbols section
const start = 341 - 1;
const end = 399 - 1; // exclusive; line 399 is the symbols conditional

const block = `          {/*
            Credentials, always available.

            The block is NOT removed once connected: a user who logs in and then needs a different
            account would otherwise have no form to do it with, and the confirmation they just
            earned would vanish with it. Instead it collapses to a summary so it stops dominating
            the panel, and the account line stays on screen.
          */}
          {bridgeState === "ok" && loginState === "ok" && (
            <p className="msg up" data-note="br-login-verdict" data-verdict="ok">
              {\`\${t("br.loggedIn")} — \${loginDetail}\`}
            </p>
          )}
          <div className="br-login" data-note="br-login-block" data-collapsed={bridgeState === "ok" ? "yes" : "no"}>
            {bridgeState === "ok" && <p className="msg">{t("br.loginSwitch")}</p>}
            {bridgeState !== "ok" && <p className="msg">{t("br.loginHint")}</p>}
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
              data-action="br-login"
              disabled={loginState === "busy"}
              onClick={() => void doLogin()}
            >
              {loginState === "busy" ? t("br.loggingIn") : t("br.loginGo")}
            </button>
            {loginState === "fail" && (
              <p className="msg down" data-note="br-login-verdict" data-verdict="fail">
                {loginDetail}
              </p>
            )}
            <p className="msg" data-note="br-login-security">{t("br.loginSecurity")}</p>
          </div>
`;

const out = [...lines.slice(0, start), block, ...lines.slice(end)];
writeFileSync(path, out.join("\n"));
console.log("rewrote login block; lines", lines.length, "->", out.join("\n").split("\n").length);
