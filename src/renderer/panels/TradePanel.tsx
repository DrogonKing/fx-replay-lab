/**
 * The order ticket, shown in the right sidebar.
 *
 * This is the entry side of trading: account readouts, the ticket, and risk controls.
 * The positions/orders/history TABLES used to be appended here, which pushed the
 * ticket off screen the moment a few positions opened — they now live in the bottom
 * dock (see PositionsTables.tsx). One engine, two views.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { TradingSession, SessionSnapshot } from "../trading.js";
import type { Side } from "../../core/types.js";
import { useI18n } from "../i18n-context.js";
import { planRiskFromPoints } from "../../core/risk-sizing.js";
import { planMm, type MmBasis, type MmUnit } from "../../core/mm.js";
import { latinNum } from "../../core/format.js";
import { localiseError } from "../../core/errors.js";
import type { SymbolSpec } from "../../core/types.js";

interface Props {
  session: TradingSession;
  /** active news blackout, if any; orders are refused while blocked */
  blackout?: { blocked: boolean; reason?: string };
  /** current bid price, for the preview and the market buttons */
  price: number;
  /** symbol spec, so lot step and contract size come from one place */
  contractSize: number;
  lotStep: number;
  minLot: number;
  maxLot: number;
  /** the session's own spec, so risk sizing uses the same digits/leverage as the engine */
  spec: SymbolSpec;
}

export function TradePanel({
  session, price, contractSize, lotStep, minLot, maxLot, spec, blackout,
}: Props): JSX.Element {
  const { t } = useI18n();
  const [snap, setSnap] = useState<SessionSnapshot>(() => session.snapshot());
  const [lots, setLots] = useState("0.10");
  const [slPts, setSlPts] = useState("10");
  const [tpPts, setTpPts] = useState("20");
  const [tags, setTags] = useState("");
  const [msg, setMsg] = useState("");
  const [kind, setKind] = useState<"market" | "limit" | "stop" | "stop-limit">("market");
  const [triggerPrice, setTriggerPrice] = useState("");
  const [limitPrice, setLimitPrice] = useState("");
  const [oco, setOco] = useState(false);
  const [beR, setBeR] = useState("0");
  const [trailMode, setTrailMode] = useState<"off" | "distance" | "extreme" | "atr">("off");
  const [trailValue, setTrailValue] = useState("5");
  /** sizing mode: raw lots, or lots derived from a risk percentage */
  const [sizeByRisk, setSizeByRisk] = useState(false);
  const [riskPct, setRiskPct] = useState("1");
  /**
   * Ticket mode: manual lots (the original ticket, untouched) or the money-management
   * ticket the user knows from their MT EA — pick a basis and a unit, and the size is
   * computed so that hitting the stop costs exactly the risk asked for.
   */
  const [ticketMode, setTicketMode] = useState<"manual" | "mm">("manual");
  const [mmBasis, setMmBasis] = useState<MmBasis>("balance");
  const [mmUnit, setMmUnit] = useState<MmUnit>("percent");
  const [mmValue, setMmValue] = useState("1");
  /**
   * Auto-TP from risk:reward (the EA's Use_Auto_TP / Default_R_R): while on, the TP
   * is derived from the stop — points × ratio — instead of typed, so a plan cannot
   * be sized for one R:R and placed with another.
   */
  const [mmAutoTp, setMmAutoTp] = useState(false);
  /** reward per unit of risk; 5 by default, like the EA's Default_R_R */
  const [mmRr, setMmRr] = useState("5");
  /**
   * Automatic partial exits (the EA's Partial_exit levels), as editable strings so
   * the three rows behave like every other numeric field here. Defaults are the
   * classic 1R/2R/3R ladder over half, a quarter and a quarter.
   */
  const [mmPartials, setMmPartials] = useState(false);
  const [mmPl, setMmPl] = useState<[string, string][]>([
    ["1", "50"], ["2", "25"], ["3", "25"],
  ]);

  /**
   * The MM settings survive restarts (setting key "mm_settings"), like the rest of the
   * paper account. Saved only once the stored values have been read, or the defaults
   * would overwrite them before the load lands.
   */
  const mmHydrated = useRef(false);
  useEffect(() => {
    const api = (globalThis as unknown as { fxlab?: {
      getSetting?: (key: string) => Promise<string | null>;
    } }).fxlab;
    if (!api?.getSetting) {
      mmHydrated.current = true;
      return;
    }
    let cancelled = false;
    void api.getSetting("mm_settings").then((raw) => {
      if (cancelled) return;
      try {
        const p = JSON.parse(raw ?? "null") as {
          basis?: string; unit?: string; value?: number | string;
          autoTp?: boolean; rr?: number | string;
          partials?: { enabled?: boolean; levels?: Array<{ r?: number; pct?: number }> };
        };
        if (p.basis === "balance" || p.basis === "equity" || p.basis === "freeMargin") {
          setMmBasis(p.basis);
        }
        if (p.unit === "percent" || p.unit === "money") setMmUnit(p.unit);
        const v = Number(p.value);
        if (Number.isFinite(v) && v > 0) setMmValue(String(v));
        // read defensively: values saved before the auto-TP fields exist lack them
        if (typeof p.autoTp === "boolean") setMmAutoTp(p.autoTp);
        const rr = Number(p.rr);
        if (Number.isFinite(rr) && rr >= 0.1) setMmRr(String(rr));
        // ...and the same for the partials ladder, row by row
        if (p.partials && typeof p.partials === "object") {
          if (typeof p.partials.enabled === "boolean") {
            setMmPartials(p.partials.enabled);
          }
          const lv = Array.isArray(p.partials.levels) ? p.partials.levels : [];
          const rows: [string, string][] = [];
          for (const row of lv.slice(0, 3)) {
            const rN = Number(row?.r);
            const pctN = Number(row?.pct);
            rows.push([
              Number.isFinite(rN) && rN > 0 ? String(rN) : "1",
              Number.isFinite(pctN) && pctN > 0 ? String(pctN) : "25",
            ]);
          }
          if (rows.length === 3) setMmPl(rows);
        }
      } catch {
        // unreadable settings: the defaults are what the ticket already shows
      }
      mmHydrated.current = true;
    }).catch(() => {
      mmHydrated.current = true;
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!mmHydrated.current) return;
    const api = (globalThis as unknown as { fxlab?: {
      setSetting?: (key: string, value: string) => Promise<{ ok: boolean }>;
    } }).fxlab;
    void api?.setSetting?.(
      "mm_settings",
      JSON.stringify({
        basis: mmBasis, unit: mmUnit, value: Number(mmValue) || 1,
        autoTp: mmAutoTp, rr: Number(mmRr) || 5,
        partials: {
          enabled: mmPartials,
          levels: mmPl.map(([r, pct]) => ({ r: Number(r) || 1, pct: Number(pct) || 0 })),
        },
      }),
    );
  }, [mmBasis, mmUnit, mmValue, mmAutoTp, mmRr, mmPartials, mmPl]);

  /**
   * Push the partial ladder to the session as it is edited, and again whenever the
   * session instance is rebuilt (symbol switch, account reset): a fresh session
   * starts with the ladder off, and the configured one must follow the account.
   * The session's refusal — a ladder that sums past 100% or has a dead row — is
   * its own arithmetic, shown verbatim.
   */
  useEffect(() => {
    if (!mmHydrated.current) return;
    if (!mmPartials) {
      session.setAutoPartials(null);
      return;
    }
    const res = session.setAutoPartials(
      mmPl.map(([r, pct]) => ({ rMultiple: Number(r), percent: Number(pct) })),
    );
    if (!res.ok) setMsg(res.message ?? "");
  }, [session, mmPartials, mmPl]);

  useEffect(() => session.subscribe(setSnap), [session]);

  useEffect(() => {
    // the price moves with every replay step; keep the panel in sync so the equity
    // readout and the margin check are not stale
    session.setPrice(price, Math.floor(Date.now() / 1000));
  }, [price, session]);

  const slNum = Number(slPts);
  const tpNum = Number(tpPts);

  /**
   * The TP the auto-TP feature implies: stop points × ratio, the same magnitude for
   * a buy and a sell because both are measured from the entry. Null when the feature
   * is off, the ticket is manual, or the inputs are not usable numbers — in which
   * case the typed TP stands.
   */
  const rrNum = Number(mmRr);
  const autoTpPts = ticketMode === "mm" && mmAutoTp &&
    Number.isFinite(slNum) && slNum > 0 &&
    Number.isFinite(rrNum) && rrNum >= 0.1
    ? slNum * rrNum
    : null;

  // The one TP the rest of the panel works with: the preview, the R-multiple and the
  // placed order all read this, so an auto-TP order is placed with exactly the TP it
  // previewed.
  const tpEffNum = autoTpPts !== null ? autoTpPts : tpNum;

  /**
   * Risk-based sizing.
   *
   * Computed from the LIVE balance and free margin, so the size shrinks as the account does.
   * When the plan refuses (the minimum lot would over-risk), `lots` becomes empty and the
   * Buy/Sell buttons are disabled — placing the trade anyway would risk more than asked,
   * which is the one thing a risk tool must not do.
   */
  // Rebuilt on every snapshot, which the session emits on every bar and every mutation.
  const book = useMemo(() => session.bookRisk(), [snap, session]);

  const riskPlan = useMemo(() => {
    if (!sizeByRisk) return null;
    return planRiskFromPoints(
      {
        balance: snap.balance,
        riskPercent: Number(riskPct),
        price,
        leverage: spec.leverage,
        freeMargin: snap.freeMargin,
      },
      Number(slPts),
      spec,
    );
  }, [sizeByRisk, snap.balance, snap.freeMargin, riskPct, slPts, price, spec]);

  /**
   * The money-management ticket, MM-mode counterpart of `riskPlan`.
   *
   * planMm is pure and cheap, so it is recomputed on EVERY render: its inputs are the
   * live snapshot numbers and the current price, which move with every replay step and
   * every live tick. A refused plan (the minimum lot would over-risk) leaves lots at 0
   * and disables Buy/Sell — placing it anyway would risk more than was asked, which is
   * the one thing a risk tool must not do. The refusal text is the core's own
   * arithmetic and is shown verbatim.
   */
  const mmPlan = ticketMode === "mm"
    ? planMm({
      basis: mmBasis,
      unit: mmUnit,
      value: Number(mmValue),
      stopPoints: slNum,
      balance: snap.balance,
      equity: snap.equity,
      freeMargin: snap.freeMargin,
      leverage: session.accountLeverage,
      price,
    }, spec)
    : null;

  // In risk mode the lots field displays the computed size and is read-only: letting the
  // user type over it would let them think they are risk-sized when they are not.
  const effectiveLots = mmPlan
    ? (mmPlan.ok ? mmPlan.lots : 0)
    : riskPlan
      ? (riskPlan.lots > 0 ? riskPlan.lots : 0)
      : Number(lots);

  const lotsNum = effectiveLots;
  const lotsValid = mmPlan
    ? mmPlan.ok && mmPlan.lots > 0
    : riskPlan
      ? riskPlan.lots > 0
      : Number.isFinite(lotsNum) && lotsNum >= minLot && lotsNum <= maxLot;
  const riskMoney = Number.isFinite(slNum) && slNum > 0 && lotsValid
    ? slNum * lotsNum * contractSize
    : 0;
  const rewardMoney = Number.isFinite(tpEffNum) && tpEffNum > 0 && lotsValid
    ? tpEffNum * lotsNum * contractSize
    : 0;
  const rr = riskMoney > 0 ? rewardMoney / riskMoney : 0;

  const place = (side: Side): void => {
    if (!lotsValid) {
      setMsg(`lots must be between ${minLot} and ${maxLot}, in steps of ${lotStep}`);
      return;
    }
    const tagList = tags.split(",").map((t) => t.trim()).filter(Boolean);

    // market: fill now. everything else goes on the book.
    if (kind === "market") {
      const r = session.open(side, lotsNum, slNum || 0, tpEffNum || 0, tagList);
      setMsg(r.ok
        ? `${side} ${lotsNum} ${t("trade.opened")}`
        : localiseError(r.message ?? "", (k, v) => t(k, v)));
      return;
    }

    const trig = Number(triggerPrice);
    if (!Number.isFinite(trig) || trig <= 0) {
      setMsg("enter a valid trigger price");
      return;
    }
    const lim = Number(limitPrice);

    const r = session.placeOrder({
      side,
      kind: kind === "stop-limit" ? "stop-limit" : kind,
      lots: lotsNum,
      price: trig,
      limitPrice: kind === "stop-limit" && Number.isFinite(lim) ? lim : undefined,
      slDistance: slNum || 0,
      tpDistance: tpEffNum || 0,
      tags: tagList,
      // OCO on a pending order pairs it with a stop on the other side, which is the
      // common breakout/breakdown bracket.
      ocoWith: oco
        ? {
            side: side === "buy" ? "sell" : "buy",
            kind: "stop",
            price: side === "buy"
              ? Math.round((trig - Math.max(1, slNum || 10)) * 100) / 100
              : Math.round((trig + Math.max(1, slNum || 10)) * 100) / 100,
          }
        : undefined,
    });
    setMsg(r.ok
      ? (r.message ?? `${side} ${kind} ${t("trade.placed")}`)
      : localiseError(r.message ?? "", (k, v) => t(k, v)));
  };

  return (
    <div className="trade-panel">
      <h3>{t("trade.title")}</h3>

      <div className="kv"><span>{t("trade.bid")}</span><b>{price.toFixed(2)}</b></div>
      <div className="kv"><span>{t("trade.balance")}</span><b>{snap.balance.toFixed(2)}</b></div>
      <div className="kv">
        <span>{t("trade.equity")}</span>
        <b className={snap.equity >= snap.balance ? "up" : "down"}>
          {snap.equity.toFixed(2)}
        </b>
      </div>
      <div className="kv">
        <span>{t("trade.floating")}</span>
        <b className={snap.floatingPnl >= 0 ? "up" : "down"}>
          {snap.floatingPnl >= 0 ? "+" : ""}{snap.floatingPnl.toFixed(2)}
        </b>
      </div>
      <div className="kv"><span>{t("trade.margin")}</span>
        <b>{snap.usedMargin.toFixed(0)} / {snap.freeMargin.toFixed(0)}</b>
      </div>

      {blackout?.blocked && (
        <p className="warn-box">
          {t("trade.blackout", { reason: blackout.reason ?? "" })}
        </p>
      )}

      {snap.stoppedOut && (
        <p className="warn-box">{t("trade.stoppedOut")}</p>
      )}

      <div className="order-form">
        <label>
          {t("mm.mode")}
          <select
            data-field="ticket-mode"
            value={ticketMode}
            onChange={(e) => setTicketMode(e.target.value as "manual" | "mm")}
          >
            <option value="manual">{t("mm.modeManual")}</option>
            <option value="mm">{t("mm.modeMm")}</option>
          </select>
        </label>
        <label>
          {t("trade.type")}
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
          >
            <option value="market">{t("trade.market")}</option>
            <option value="limit">{t("trade.limit")}</option>
            <option value="stop">{t("trade.stop")}</option>
            <option value="stop-limit">{t("trade.stopLimit")}</option>
          </select>
        </label>
        <label>
          {t("trade.lots")}
          <input
            data-field="lots"
            value={
              mmPlan
                ? (mmPlan.ok ? mmPlan.lots.toFixed(2) : "—")
                : sizeByRisk
                  ? (riskPlan && riskPlan.lots > 0 ? riskPlan.lots.toFixed(2) : "—")
                  : lots
            }
            onChange={(e) => setLots(e.target.value)}
            inputMode="decimal"
            readOnly={sizeByRisk || ticketMode === "mm"}
            title={sizeByRisk || ticketMode === "mm" ? t("risk.computed") : undefined}
            dir="ltr"
          />
        </label>
        {ticketMode === "mm" ? (
          <>
            {/*
              The money-management ticket: basis, unit, risk value, and the stop in
              points. The stop is the SAME state the manual ticket's SL uses, so the
              placed order's SL is exactly the distance the size was computed for.
            */}
            <label>
              {t("mm.basis")}
              <select
                data-field="mm-basis"
                value={mmBasis}
                onChange={(e) => setMmBasis(e.target.value as MmBasis)}
              >
                <option value="balance">{t("mm.basisBalance")}</option>
                <option value="equity">{t("mm.basisEquity")}</option>
                <option value="freeMargin">{t("mm.basisFreeMargin")}</option>
              </select>
            </label>
            <label>
              {t("mm.unit")}
              <select
                data-field="mm-unit"
                value={mmUnit}
                onChange={(e) => setMmUnit(e.target.value as MmUnit)}
              >
                <option value="percent">{t("mm.unitPercent")}</option>
                <option value="money">{t("mm.unitMoney")}</option>
              </select>
            </label>
            <label>
              {t("mm.value")}
              <input
                data-field="mm-value"
                value={mmValue}
                onChange={(e) => setMmValue(e.target.value)}
                inputMode="decimal"
                dir="ltr"
              />
            </label>
            <label>
              {t("trade.sl")}
              <input
                data-field="mm-stop"
                value={slPts}
                onChange={(e) => setSlPts(e.target.value)}
                inputMode="decimal"
                dir="ltr"
                title={t("mm.stopHint")}
              />
            </label>
            {/*
              Auto-TP from R:R, the EA's Use_Auto_TP / Default_R_R. While on, the TP
              field below is derived (entry ± stop × ratio) and read-only: typing a
              target over it would let the placed order disagree with the risk plan
              the size was computed for.
            */}
            <label className="checkbox-row">
              <input
                data-field="mm-auto-tp"
                type="checkbox"
                checked={mmAutoTp}
                onChange={(e) => setMmAutoTp(e.target.checked)}
              />
              {t("mm.autoTp")}
            </label>
            {mmAutoTp && (
              <label>
                {t("mm.rr")}
                <input
                  data-field="mm-rr"
                  value={mmRr}
                  onChange={(e) => setMmRr(e.target.value)}
                  inputMode="decimal"
                  dir="ltr"
                  placeholder="5"
                  title={t("mm.autoTpHint")}
                />
              </label>
            )}
          </>
        ) : (
          <>
            <label>
              {t("risk.mode")}
              <input
                data-field="size-by-risk"
                type="checkbox"
                checked={sizeByRisk}
                onChange={(e) => setSizeByRisk(e.target.checked)}
              />
            </label>
            {sizeByRisk && (
              <label>
                {t("risk.percent")}
                <input
                  data-field="risk-percent"
                  value={riskPct}
                  onChange={(e) => setRiskPct(e.target.value)}
                  inputMode="decimal"
                />
              </label>
            )}
            <label>
              {t("trade.sl")}
              <input
                data-field="sl"
                value={slPts}
                onChange={(e) => setSlPts(e.target.value)}
                inputMode="decimal"
              />
            </label>
          </>
        )}
        <label>
          {t("trade.tp")}
          <input
            data-field="tp"
            value={
              autoTpPts !== null
                // trim float noise: 7.5 × 1.5 shows as 11.25, not 11.250000000000002
                ? String(Number(autoTpPts.toFixed(4)))
                : tpPts
            }
            onChange={(e) => setTpPts(e.target.value)}
            inputMode="decimal"
            dir="ltr"
            readOnly={autoTpPts !== null}
            title={autoTpPts !== null ? t("mm.autoTpHint") : undefined}
          />
        </label>
        <label>
          {t("trade.tags")}
          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="breakout, ny"
          />
        </label>
        {kind !== "market" && (
          <>
            <label>
              {t("trade.trigger")}
              <input
                value={triggerPrice}
                onChange={(e) => setTriggerPrice(e.target.value)}
                placeholder={price.toFixed(2)}
                inputMode="decimal"
              />
            </label>
            {kind === "stop-limit" && (
              <label>
                {t("trade.limit")}
                <input
                  value={limitPrice}
                  onChange={(e) => setLimitPrice(e.target.value)}
                  placeholder={price.toFixed(2)}
                  inputMode="decimal"
                />
              </label>
            )}
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={oco}
                onChange={(e) => setOco(e.target.checked)}
              />
              {t("trade.oco")}
            </label>
          </>
        )}
      </div>

      {mmPlan && (mmPlan.ok ? (
        <div className="kv num" data-kv="mm-plan">
          <span>{t("mm.plan")}</span>
          <b>
            {latinNum(Number(mmPlan.lots.toFixed(2)))} {t("trade.lotsShort")} ·{" "}
            {t("mm.risk")} ${latinNum(Number(mmPlan.riskMoney.toFixed(2)))} ·{" "}
            {t("trade.margin")} ${latinNum(Number(mmPlan.margin.toFixed(2)))}
          </b>
        </div>
      ) : (
        <p className="mm-refusal num" data-kv="mm-refusal">{mmPlan.refusal}</p>
      ))}

      <div className="kv" data-kv="book">
        <span>{t("book.total")}</span>
        <b className={book.totalPercent > session.riskLimitPercent && session.riskLimitPercent > 0 ? "down" : ""}>
          {book.totalPercent.toFixed(2)}%
        </b>
      </div>
      <div className="kv" data-kv="book-detail">
        <span>{t("book.detail")}</span>
        <b>
          {t("book.open")} {book.openPercent.toFixed(2)}%
          {book.pendingRisk > 0 && ` · ${t("book.pending")} ${book.pendingPercent.toFixed(2)}%`}
          {book.unprotectedCount > 0 && ` · ${book.unprotectedCount} ${t("book.noStop")}`}
        </b>
      </div>
      <label>
        {t("book.limit")}
        <input
          data-field="book-limit"
          value={String(session.riskLimitPercent)}
          onChange={(e) => session.setRiskLimit(Number(e.target.value) || 0)}
          inputMode="decimal"
        />
      </label>

      <div className="kv">
        <span>{t("trade.riskReward")}</span>
        <b>
          {riskMoney.toFixed(0)} / {rewardMoney.toFixed(0)}
          {rr > 0 && ` (1:${rr.toFixed(2)})`}
        </b>
      </div>

      {sizeByRisk && riskPlan && (
        <>
          <div className="kv" data-kv="at-risk">
            <span>{t("risk.atRisk")}</span>
            <b className={riskPlan.overBudget ? "down" : ""}>
              {riskPlan.riskMoney.toFixed(2)} ({riskPlan.actualRiskPercent.toFixed(2)}%)
            </b>
          </div>
          {riskPlan.reason && (
            <p className={riskPlan.overBudget ? "warn-box" : "msg"}>{riskPlan.reason}</p>
          )}
          {riskPlan.lots > 0 && riskPlan.margin > 0 && (
            <div className="kv">
              <span>{t("trade.margin")}</span>
              <b>{riskPlan.margin.toFixed(2)}</b>
            </div>
          )}
        </>
      )}

      <div className="be-row">
        {t("trade.trail")}
        <select
          value={trailMode}
          onChange={(e) => {
            const m = e.target.value as typeof trailMode;
            setTrailMode(m);
            session.setTrailing(m, Number(trailValue) || 0);
          }}
        >
          <option value="off">{t("trade.off")}</option>
          <option value="distance">{t("trade.trailClose")}</option>
          <option value="extreme">{t("trade.trailExtreme")}</option>
          <option value="atr">{t("trade.trailAtr")}</option>
        </select>
        <input
          value={trailValue}
          onChange={(e) => {
            setTrailValue(e.target.value);
            const n = Number(e.target.value);
            if (Number.isFinite(n)) session.setTrailing(trailMode, n);
          }}
          inputMode="decimal"
          placeholder="5"
        />
        <span className="hint">
          {trailMode === "atr" ? "× ATR(14)" : trailMode === "off" ? "" : "pts"}
        </span>
      </div>

      <label className="be-row">
        {t("trade.breakEven")}
        <input
          value={beR}
          onChange={(e) => {
            setBeR(e.target.value);
            const n = Number(e.target.value);
            session.setBreakEvenTrigger(Number.isFinite(n) ? n : 0);
          }}
          inputMode="decimal"
          placeholder="0"
        />
        R <span className="hint">{t("trade.beHint")}</span>
      </label>

      <div className="row">
        <button
          className="buy-btn"
          onClick={() => place("buy")}
          disabled={snap.stoppedOut || blackout?.blocked || !lotsValid}
          title="Buy at ask"
        >
          <span data-action="buy">▲ {t("trade.buy")} {lotsValid ? lotsNum.toFixed(2) : ""}</span>
        </button>
        <button
          className="sell-btn"
          onClick={() => place("sell")}
          disabled={snap.stoppedOut || blackout?.blocked || !lotsValid}
          title="Sell at bid"
        >
          ▼ {t("trade.sell")} {lotsValid ? lotsNum.toFixed(2) : ""}
        </button>
      </div>

      {msg && <p className="msg">{msg}</p>}
    </div>
  );
}
