/**
 * The paper account card, shown at the top of the Trade tab.
 *
 * Soft4FX-style: one compact card that answers "where does the money come from" —
 * the live balance/equity/free-margin line, the account's starting balance and
 * leverage (Apply & reset opens a FRESH account), and the spread/commission the
 * fills are priced with. Cost changes are refused by the session while anything is
 * open — a new spread would misprice live stops — and the refusal is shown verbatim,
 * because it is the engine's own arithmetic, not a UI opinion.
 *
 * The journal is deliberately NOT reset with the account: closed trades are history,
 * and Soft4FX keeps the report.
 */
import React, { useEffect, useState } from "react";
import type { TradingSession, SessionSnapshot, PaperCosts, PaperLimits } from "../trading.js";
import { limitsVerdict } from "../trading.js";
import { useI18n } from "../i18n-context.js";
import { latinNum } from "../../core/format.js";

/** persisted paper-account settings, as App owns them */
export interface PaperAccountSettings {
  startingBalance: number;
  leverage: number;
  mode: "hedging";
}

interface Props {
  session: TradingSession;
  /** the persisted settings; the inputs start from these */
  account: PaperAccountSettings;
  /** the active cost overrides */
  costs: PaperCosts;
  /** the active session loss/profit limits; the inputs start from these */
  limits: PaperLimits;
  /** open a fresh account at (optionally new) settings; discards open positions */
  onApplyAccount: (over?: {
    startingBalance?: number; leverage?: number;
  }) => void;
  /** save + apply cost overrides; returns the session's verdict */
  onApplyCosts: (next: PaperCosts) => { ok: boolean; message?: string };
  /** save + apply the session loss/profit limits */
  onApplyLimits: (next: PaperLimits) => void;
}

/** Money readouts through latinNum, always: prices are compared against broker statements. */
const money = (n: number): string => latinNum(Number(n.toFixed(2)));

export function PaperAccountCard({
  session, account, costs, limits, onApplyAccount, onApplyCosts, onApplyLimits,
}: Props): JSX.Element {
  const { t } = useI18n();
  const [snap, setSnap] = useState<SessionSnapshot>(() => session.snapshot());
  useEffect(() => session.subscribe(setSnap), [session]);

  const [balance, setBalance] = useState(String(account.startingBalance));
  const [leverage, setLeverage] = useState(String(account.leverage));
  const [spread, setSpread] = useState(String(costs.spreadPoints));
  const [commission, setCommission] = useState(String(costs.commissionPerLot));
  const [maxLoss, setMaxLoss] = useState(String(limits.maxLoss));
  const [maxProfit, setMaxProfit] = useState(String(limits.maxProfit));
  /** one-shot note under the limits form; empty when the last apply took */
  const [limitsMsg, setLimitsMsg] = useState("");

  // Keep the fields in step when the persisted values change under them: a reset
  // rewrites the settings, and a symbol switch re-seeds the cost defaults.
  useEffect(() => { setBalance(String(account.startingBalance)); }, [account.startingBalance]);
  useEffect(() => { setLeverage(String(account.leverage)); }, [account.leverage]);
  useEffect(() => { setSpread(String(costs.spreadPoints)); }, [costs.spreadPoints]);
  useEffect(() => { setCommission(String(costs.commissionPerLot)); }, [costs.commissionPerLot]);
  useEffect(() => { setMaxLoss(String(limits.maxLoss)); }, [limits.maxLoss]);
  useEffect(() => { setMaxProfit(String(limits.maxProfit)); }, [limits.maxProfit]);

  /** which destructive button is armed; both open a fresh account */
  const [confirming, setConfirming] = useState<null | "apply" | "reset">(null);
  const [costsMsg, setCostsMsg] = useState("");

  const applyAccount = (): void => {
    const sb = Number(balance);
    const lev = Number(leverage);
    onApplyAccount({
      startingBalance: Number.isFinite(sb) && sb > 0 ? sb : undefined,
      leverage: Number.isFinite(lev) && lev >= 1 ? lev : undefined,
    });
    setConfirming(null);
  };

  const applyCosts = (): void => {
    const sp = Number(spread);
    const com = Number(commission);
    if (!Number.isFinite(sp) || sp < 0 || !Number.isFinite(com) || com < 0) {
      setCostsMsg(t("paper.costsInvalid"));
      return;
    }
    // The session's refusal (open positions would be mispriced) is shown verbatim.
    const r = onApplyCosts({ spreadPoints: sp, commissionPerLot: com });
    setCostsMsg(r.ok ? "" : (r.message ?? ""));
  };

  const applyLimits = (): void => {
    const ml = Number(maxLoss);
    const mp = Number(maxProfit);
    if (!Number.isFinite(ml) || ml < 0 || !Number.isFinite(mp) || mp < 0) {
      setLimitsMsg(t("paper.limitsInvalid"));
      return;
    }
    onApplyLimits({ maxLoss: ml, maxProfit: mp });
    setLimitsMsg("");
  };

  /**
   * The live verdict, from the same pure function the session enforces with, so the
   * card can never claim a limit is fine while orders are being refused (or claim
   * one is hit while they are not).
   */
  const limitState = limitsVerdict(snap.sessionNet, snap.limits);

  return (
    <div className="paper-card" data-panel="paper-account">
      <div className="paper-stats num">
        <div data-kv="paper-balance-now" title={t("trade.balance")}>
          <span>{t("trade.balance")}</span>
          <b>{money(snap.balance)}</b>
        </div>
        <div data-kv="paper-equity-now" title={t("trade.equity")}>
          <span>{t("trade.equity")}</span>
          <b>{money(snap.equity)}</b>
        </div>
        <div data-kv="paper-free-now" title={t("paper.freeMargin")}>
          <span>{t("paper.freeMargin")}</span>
          <b>{money(snap.freeMargin)}</b>
        </div>
        <div data-kv="paper-session-net" title={t("paper.sessionNet")}>
          <span>{t("paper.sessionNet")}</span>
          <b className={snap.sessionNet >= 0 ? "up" : "down"}>
            {snap.sessionNet >= 0 ? "+" : ""}{money(snap.sessionNet)}
          </b>
        </div>
      </div>

      <div className="paper-form">
        <label>
          {t("paper.startBalance")}
          <input
            data-field="paper-balance"
            value={balance}
            onChange={(e) => setBalance(e.target.value)}
            inputMode="decimal"
            dir="ltr"
          />
        </label>
        <label>
          {t("paper.leverage")}
          <input
            data-field="paper-leverage"
            value={leverage}
            onChange={(e) => setLeverage(e.target.value)}
            inputMode="numeric"
            dir="ltr"
          />
        </label>
        {confirming === "apply" ? (
          <div className="paper-confirm warn-box">
            <span>{t("paper.confirmApply")}</span>
            <button data-action="paper-apply" onClick={applyAccount}>
              {t("paper.confirm")}
            </button>
            <button onClick={() => setConfirming(null)}>{t("common.cancel")}</button>
          </div>
        ) : (
          <button
            data-action="paper-apply-ask"
            onClick={() => setConfirming("apply")}
            title={t("paper.applyHint")}
          >
            {t("paper.applyReset")}
          </button>
        )}
        {confirming === "reset" ? (
          <div className="paper-confirm warn-box">
            <span>{t("paper.confirmReset")}</span>
            <button
              data-action="paper-reset"
              onClick={() => { onApplyAccount(); setConfirming(null); }}
            >
              {t("paper.confirm")}
            </button>
            <button onClick={() => setConfirming(null)}>{t("common.cancel")}</button>
          </div>
        ) : (
          <button
            data-action="paper-reset-ask"
            onClick={() => setConfirming("reset")}
            title={t("paper.resetHint")}
          >
            {t("paper.reset")}
          </button>
        )}
      </div>

      <div className="paper-form">
        <label>
          {t("paper.spread")}
          <input
            data-field="paper-spread"
            value={spread}
            onChange={(e) => setSpread(e.target.value)}
            inputMode="decimal"
            dir="ltr"
          />
        </label>
        <label>
          {t("paper.commission")}
          <input
            data-field="paper-commission"
            value={commission}
            onChange={(e) => setCommission(e.target.value)}
            inputMode="decimal"
            dir="ltr"
          />
        </label>
        <button data-action="costs-apply" onClick={applyCosts}>{t("paper.costsApply")}</button>
      </div>

      {costsMsg && <p className="msg" data-kv="costs-message">{costsMsg}</p>}

      {/*
        Session loss/profit limits: once the net crosses one, the session itself
        refuses new orders, so the ticket shows the refusal on any attempt. This
        form is where the limits are set; the banner below states the block
        persistently rather than only after a refused click.
      */}
      <div className="paper-form">
        <label>
          {t("paper.maxLoss")}
          <input
            data-field="paper-max-loss"
            value={maxLoss}
            onChange={(e) => setMaxLoss(e.target.value)}
            inputMode="decimal"
            dir="ltr"
          />
        </label>
        <label>
          {t("paper.maxProfit")}
          <input
            data-field="paper-max-profit"
            value={maxProfit}
            onChange={(e) => setMaxProfit(e.target.value)}
            inputMode="decimal"
            dir="ltr"
          />
        </label>
        <button data-action="limits-apply" onClick={applyLimits}>
          {t("paper.limitsApply")}
        </button>
      </div>

      {limitsMsg && <p className="msg" data-kv="limits-message">{limitsMsg}</p>}
      {limitState.blocked && (
        <p className="warn-box" data-kv="limit-hit">
          {t("paper.limitHit", { reason: limitState.reason ?? "" })}
        </p>
      )}
    </div>
  );
}
