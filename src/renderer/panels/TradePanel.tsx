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
    const r = session.open(side, lotsNum, slNum || 0, tpNum || 0, tagList);
    setMsg(r.ok ? `${side} ${lotsNum} opened` : (r.message ?? "refused"));
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
      </div>

      <div className="kv">
        <span>risk / reward</span>
        <b>
          {riskMoney.toFixed(0)} / {rewardMoney.toFixed(0)}
          {rr > 0 && ` (1:${rr.toFixed(2)})`}
        </b>
      </div>

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

      {snap.positions.length > 0 && (
        <>
          <h3>Open ({snap.positions.length})</h3>
          <table className="grid">
            <thead>
              <tr><th>side</th><th>lots</th><th>entry</th><th>P/L</th><th /></tr>
            </thead>
            <tbody>
              {snap.positions.map((p) => {
                const exit = p.side === "buy" ? price : price;
                const delta = p.side === "buy" ? exit - p.entryPrice : p.entryPrice - exit;
                const pnl = delta * p.lots * contractSize;
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
          <button onClick={() => { const n = session.closeAll(); onFiled?.(n); }}>
            Close all
          </button>
        </>
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
