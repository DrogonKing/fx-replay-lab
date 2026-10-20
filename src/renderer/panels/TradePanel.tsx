/**
 * Trading panel: manual order entry, open positions, account state.
 *
 * This is the piece that was missing — the account engine existed and the backtester
 * used it, but the renderer had no way to place a trade. Closing a position here
 * files it to the journal automatically (see renderer/trading.ts).
 */
import React, { useEffect, useMemo, useState } from "react";
import type { TradingSession, SessionSnapshot } from "../trading.js";
import type { Side } from "../../core/types.js";
import { useI18n } from "../i18n-context.js";
import { planRiskFromPoints } from "../../core/risk-sizing.js";
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
  onFiled?: (count: number) => void;
}

export function TradePanel({
  session, price, contractSize, lotStep, minLot, maxLot, spec, onFiled, blackout,
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

  useEffect(() => session.subscribe(setSnap), [session]);

  useEffect(() => {
    // the price moves with every replay step; keep the panel in sync so the equity
    // readout and the margin check are not stale
    session.setPrice(price, Math.floor(Date.now() / 1000));
  }, [price, session]);

  const slNum = Number(slPts);
  const tpNum = Number(tpPts);

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

  // In risk mode the lots field displays the computed size and is read-only: letting the
  // user type over it would let them think they are risk-sized when they are not.
  const effectiveLots = riskPlan
    ? (riskPlan.lots > 0 ? riskPlan.lots : 0)
    : Number(lots);

  const lotsNum = effectiveLots;
  const lotsValid = riskPlan
    ? riskPlan.lots > 0
    : Number.isFinite(lotsNum) && lotsNum >= minLot && lotsNum <= maxLot;
  const riskMoney = Number.isFinite(slNum) && slNum > 0 && lotsValid
    ? slNum * lotsNum * contractSize
    : 0;
  const rewardMoney = Number.isFinite(tpNum) && tpNum > 0 && lotsValid
    ? tpNum * lotsNum * contractSize
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
      const r = session.open(side, lotsNum, slNum || 0, tpNum || 0, tagList);
      setMsg(r.ok ? `${side} ${lotsNum} opened` : (r.message ?? "refused"));
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
      tpDistance: tpNum || 0,
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
    setMsg(r.ok ? (r.message ?? `${side} ${kind} placed`) : (r.message ?? "refused"));
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
            value={sizeByRisk ? (riskPlan && riskPlan.lots > 0 ? riskPlan.lots.toFixed(2) : "—") : lots}
            onChange={(e) => setLots(e.target.value)}
            inputMode="decimal"
            readOnly={sizeByRisk}
            title={sizeByRisk ? t("risk.computed") : undefined}
          />
        </label>
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
        <label>
          {t("trade.tp")}
          <input
            data-field="tp"
            value={tpPts}
            onChange={(e) => setTpPts(e.target.value)}
            inputMode="decimal"
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

      {snap.pendingOrders.length > 0 && (
        <>
          <h3>{t("trade.pending")} ({snap.pendingOrders.length})</h3>
          <table className="grid">
            <thead>
              <tr>
                <th>{t("trade.order")}</th>
                <th>{t("trade.price")}</th>
                <th>{t("trade.status")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {snap.pendingOrders.map((o) => (
                <tr key={o.id}>
                  <td className={o.side === "buy" ? "up" : "down"}>
                    {o.side} {o.kind}
                  </td>
                  <td>
                    {o.price.toFixed(2)}
                    {o.limitPrice !== undefined && ` / ${o.limitPrice.toFixed(2)}`}
                  </td>
                  <td>
                    {o.triggered ? t("trade.armed") : t("trade.waiting")}
                    {o.ocoGroup && " · OCO"}
                  </td>
                  <td>
                    <button
                      className="row-del"
                      onClick={() => session.cancelOrder(o.id)}
                      title="Cancel this order"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button onClick={() => session.cancelAllOrders()}>{t("trade.cancelAll")}</button>
        </>
      )}

      {snap.positions.length > 0 && (
        <>
          <h3>{t("trade.open")} ({snap.positions.length})</h3>
          <table className="grid">
            <thead>
              <tr>
                <th>{t("trade.side")}</th>
                <th>{t("trade.lotsShort")}</th>
                <th>{t("trade.entryPrice")}</th>
                <th>{t("trade.pnl")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {snap.positions.map((p) => {
                // Use the engine's own valuation. Recomputing here produced a row that
                // disagreed with the account by exactly the commission, and a no-op
                // ternary lost the bid/ask distinction for shorts.
                const pnl = session.positionPnl(p, price);
                return (
                  <tr key={p.id}>
                    <td className={p.side === "buy" ? "up" : "down"}>{p.side}</td>
                    <td>{p.lots}</td>
                    <td>{p.entryPrice.toFixed(2)}</td>
                    <td className={pnl >= 0 ? "up" : "down"}>{pnl.toFixed(2)}</td>
                    <td className="row-actions">
                      <button
                        className="row-half"
                        onClick={() => {
                          const half = Math.max(
                            minLot,
                            Math.floor((p.lots / 2) / lotStep) * lotStep,
                          );
                          const r = session.closePartial(p.id, Number(half.toFixed(2)));
                          if (!r.ok) setMsg(r.message ?? "partial close refused");
                        }}
                        title={`Close half (${(Math.max(minLot, Math.floor((p.lots / 2) / lotStep) * lotStep)).toFixed(2)} lots)`}
                      >
                        ½
                      </button>
                      <button
                        className="row-del"
                        onClick={() => session.closeOne(p.id)}
                        title="Close this position"
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="msg">{t("trade.dragHint")}</p>
          <button onClick={() => { const n = session.closeAll(); onFiled?.(n); }}>
            {t("trade.closeAll")}
          </button>
        </>
      )}

      {snap.orderHistory.length > 0 && (
        <p className="msg">
          {t("trade.ordersSummary", {
            filled: snap.orderHistory.filter((o) => o.status === "filled").length,
            cancelled: snap.orderHistory.filter((o) => o.status === "cancelled").length,
          })}
          {snap.orderHistory.some((o) => o.cancelReason?.includes("OCO"))
            ? t("trade.ocoCancelled")
            : ""}
        </p>
      )}

      {snap.trades.length > 0 && (
        <>
          <h3>{t("trade.closed")} ({snap.trades.length})</h3>
          <table className="grid">
            <thead>
              <tr>
                <th>{t("trade.side")}</th>
                <th>{t("trade.lotsShort")}</th>
                <th>{t("trade.pnl")}</th>
                <th>{t("trade.why")}</th>
              </tr>
            </thead>
            <tbody>
              {snap.trades.slice(-8).reverse().map((t) => (
                <tr key={t.id}>
                  <td className={t.side === "buy" ? "up" : "down"}>{t.side}</td>
                  <td>{t.lots}</td>
                  <td className={t.pnl >= 0 ? "up" : "down"}>{t.pnl.toFixed(2)}</td>
                  <td>{t.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="msg">{t("trade.filedNotice")}</p>
        </>
      )}
    </div>
  );
}
