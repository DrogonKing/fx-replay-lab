/**
 * The bottom dock's trading tables.
 *
 * These three tables lived at the bottom of the TradePanel in the sidebar, where a
 * five-row position list pushed the order ticket off screen. In a terminal the
 * ticket belongs beside the chart and the tables belong below it, so they moved to
 * the dock: Positions & Orders (pending + open) and History (closed + summary).
 *
 * Each tab subscribes to the session itself: the dock re-renders on engine events
 * (fills, closes, trailing stops), not on the ticket's render cycle.
 */
import React, { useEffect, useState } from "react";
import type { TradingSession, SessionSnapshot } from "../trading.js";
import { useI18n } from "../i18n-context.js";
import { localiseError } from "../../core/errors.js";

interface TablesProps {
  session: TradingSession;
  /** current price, so open P/L is live */
  price: number;
  minLot: number;
  lotStep: number;
}

function useSnap(session: TradingSession): SessionSnapshot {
  const [snap, setSnap] = useState<SessionSnapshot>(() => session.snapshot());
  useEffect(() => session.subscribe(setSnap), [session]);
  return snap;
}

export function PositionsOrdersTab({
  session, price, minLot, lotStep,
}: TablesProps): JSX.Element {
  const { t } = useI18n();
  const snap = useSnap(session);
  const [msg, setMsg] = useState("");

  return (
    <div className="dock-tables" data-panel="positions">
      {msg && <p className="msg">{msg}</p>}

      {snap.pendingOrders.length === 0 && snap.positions.length === 0 && (
        <p className="msg">{t("positions.empty")}</p>
      )}

      {snap.pendingOrders.length > 0 && (
        <>
          <h3>{t("trade.pending")} ({snap.pendingOrders.length})</h3>
          <table className="grid">
            <thead>
              <tr>
                <th>{t("trade.order")}</th>
                <th>{t("trade.price")}</th>
                <th>{t("trade.lotsShort")}</th>
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
                  <td className="num">
                    {o.price.toFixed(2)}
                    {o.limitPrice !== undefined && ` / ${o.limitPrice.toFixed(2)}`}
                  </td>
                  <td className="num">{o.lots.toFixed(2)}</td>
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
                /*
                  Show NET: what this position has actually earned after the commission that was
                  charged on entry. Equity counts the gross move because that commission already
                  left the balance, so both numbers are right and they are not the same number —
                  which is why they come from one engine call instead of being recomputed here.
                */
                const pnl = session.positionBreakdown(p, price).net;
                return (
                  <tr key={p.id}>
                    <td className={p.side === "buy" ? "up" : "down"}>{p.side}</td>
                    <td className="num">{p.lots.toFixed(2)}</td>
                    <td className="num">{p.entryPrice.toFixed(2)}</td>
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
                          if (!r.ok) setMsg(localiseError(r.message ?? "", (k, v) => t(k, v)));
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
          <button onClick={() => { session.closeAll(); }}>
            {t("trade.closeAll")}
          </button>
        </>
      )}
    </div>
  );
}

export function HistoryTab({ session }: { session: TradingSession }): JSX.Element {
  const { t } = useI18n();
  const snap = useSnap(session);

  return (
    <div className="dock-tables" data-panel="history">
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

      {snap.trades.length === 0 ? (
        <p className="msg">{t("history.empty")}</p>
      ) : (
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
              {snap.trades.slice(-50).reverse().map((tr) => (
                <tr key={tr.id}>
                  <td className={tr.side === "buy" ? "up" : "down"}>{tr.side}</td>
                  <td className="num">{tr.lots.toFixed(2)}</td>
                  <td className={tr.pnl >= 0 ? "up" : "down"}>{tr.pnl.toFixed(2)}</td>
                  <td>{tr.reason}</td>
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
