/**
 * Trading panel: manual order entry, open positions, account state.
 *
 * This is the piece that was missing — the account engine existed and the backtester
 * used it, but the renderer had no way to place a trade. Closing a position here
 * files it to the journal automatically (see renderer/trading.ts).
 */
import React, { useEffect, useState } from "react";
import type { TradingSession, SessionSnapshot } from "../trading.js";
import type { Side } from "../../core/types.js";

interface Props {
  session: TradingSession;
  /** current bid price, for the preview and the market buttons */
  price: number;
  /** symbol spec, so lot step and contract size come from one place */
  contractSize: number;
  lotStep: number;
  minLot: number;
  maxLot: number;
  onFiled?: (count: number) => void;
}

export function TradePanel({
  session, price, contractSize, lotStep, minLot, maxLot, onFiled,
}: Props): JSX.Element {
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

  useEffect(() => session.subscribe(setSnap), [session]);

  useEffect(() => {
    // the price moves with every replay step; keep the panel in sync so the equity
    // readout and the margin check are not stale
    session.setPrice(price, Math.floor(Date.now() / 1000));
  }, [price, session]);

  const lotsNum = Number(lots);
  const slNum = Number(slPts);
  const tpNum = Number(tpPts);
  const lotsValid = Number.isFinite(lotsNum) && lotsNum >= minLot && lotsNum <= maxLot;
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
      <h3>Trade</h3>

      <div className="kv"><span>bid</span><b>{price.toFixed(2)}</b></div>
      <div className="kv"><span>balance</span><b>{snap.balance.toFixed(2)}</b></div>
      <div className="kv">
        <span>equity</span>
        <b className={snap.equity >= snap.balance ? "up" : "down"}>
          {snap.equity.toFixed(2)}
        </b>
      </div>
      <div className="kv">
        <span>floating</span>
        <b className={snap.floatingPnl >= 0 ? "up" : "down"}>
          {snap.floatingPnl >= 0 ? "+" : ""}{snap.floatingPnl.toFixed(2)}
        </b>
      </div>
      <div className="kv"><span>margin</span>
        <b>{snap.usedMargin.toFixed(0)} / free {snap.freeMargin.toFixed(0)}</b>
      </div>

      {snap.stoppedOut && (
        <p className="warn-box">
          Account stopped out — equity reached zero and every position was force-closed.
          Trading is halted.
        </p>
      )}

      <div className="order-form">
        <label>
          type
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
          >
            <option value="market">market</option>
            <option value="limit">limit</option>
            <option value="stop">stop</option>
            <option value="stop-limit">stop-limit</option>
          </select>
        </label>
        <label>
          lots
          <input
            value={lots}
            onChange={(e) => setLots(e.target.value)}
            inputMode="decimal"
          />
        </label>
        <label>
          SL (pts)
          <input value={slPts} onChange={(e) => setSlPts(e.target.value)} inputMode="decimal" />
        </label>
        <label>
          TP (pts)
          <input value={tpPts} onChange={(e) => setTpPts(e.target.value)} inputMode="decimal" />
        </label>
        <label>
          tags
          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="breakout, ny"
          />
        </label>
        {kind !== "market" && (
          <>
            <label>
              trigger
              <input
                value={triggerPrice}
                onChange={(e) => setTriggerPrice(e.target.value)}
                placeholder={price.toFixed(2)}
                inputMode="decimal"
              />
            </label>
            {kind === "stop-limit" && (
              <label>
                limit
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
              OCO bracket
            </label>
          </>
        )}
      </div>

      <div className="kv">
        <span>risk / reward</span>
        <b>
          {riskMoney.toFixed(0)} / {rewardMoney.toFixed(0)}
          {rr > 0 && ` (1:${rr.toFixed(2)})`}
        </b>
      </div>

      <label className="be-row">
        auto break-even at
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
        R <span className="hint">(stop moves to entry; 0 = off)</span>
      </label>

      <div className="row">
        <button
          className="buy-btn"
          onClick={() => place("buy")}
          disabled={snap.stoppedOut}
          title="Buy at ask"
        >
          ▲ Buy {lotsValid ? lotsNum.toFixed(2) : ""}
        </button>
        <button
          className="sell-btn"
          onClick={() => place("sell")}
          disabled={snap.stoppedOut}
          title="Sell at bid"
        >
          ▼ Sell {lotsValid ? lotsNum.toFixed(2) : ""}
        </button>
      </div>

      {msg && <p className="msg">{msg}</p>}

      {snap.pendingOrders.length > 0 && (
        <>
          <h3>Pending ({snap.pendingOrders.length})</h3>
          <table className="grid">
            <thead>
              <tr><th>order</th><th>price</th><th>status</th><th /></tr>
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
                    {o.triggered ? "armed" : "waiting"}
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
          <button onClick={() => session.cancelAllOrders()}>Cancel all orders</button>
        </>
      )}

      {snap.positions.length > 0 && (
        <>
          <h3>Open ({snap.positions.length})</h3>
          <table className="grid">
            <thead>
              <tr><th>side</th><th>lots</th><th>entry</th><th>P/L</th><th /></tr>
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
                    <td>
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
          <p className="msg">
            Drag the SL / TP lines on the chart to move them. A stop cannot cross the
            entry — the drag is refused and the reason appears under the chart.
          </p>
          <button onClick={() => { const n = session.closeAll(); onFiled?.(n); }}>
            Close all
          </button>
        </>
      )}

      {snap.orderHistory.length > 0 && (
        <p className="msg">
          Orders so far: {snap.orderHistory.filter((o) => o.status === "filled").length} filled,{" "}
          {snap.orderHistory.filter((o) => o.status === "cancelled").length} cancelled
          {snap.orderHistory.some((o) => o.cancelReason?.includes("OCO"))
            ? " (OCO cancelled the sibling)"
            : ""}
        </p>
      )}

      {snap.trades.length > 0 && (
        <>
          <h3>Closed ({snap.trades.length})</h3>
          <table className="grid">
            <thead><tr><th>side</th><th>lots</th><th>P/L</th><th>why</th></tr></thead>
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
          <p className="msg">
            Every closed trade is filed to the JOURNAL automatically, tagged with its
            exit reason.
          </p>
        </>
      )}
    </div>
  );
}
