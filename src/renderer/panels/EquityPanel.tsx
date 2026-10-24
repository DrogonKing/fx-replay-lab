/**
 * Equity curve.
 *
 * The data existed in two places and was drawn in neither: the backtester produced
 * `equityCurve`, and the replay account tracked a balance, but the user never saw the shape
 * of the account — only the latest number. For a tool whose whole purpose is "what would have
 * happened", the curve is the answer.
 *
 * Drawn on a plain canvas rather than a charting library: lightweight-charts owns the price
 * chart, and putting a second instance inside a rail panel costs more than 60 lines of
 * moveTo/lineTo.
 */
import React, { useEffect, useMemo, useRef } from "react";
import { useI18n } from "../i18n-context.js";
import { CHART_THEME } from "../chart-theme.js";
import {
  summariseCurve, downsampleCurve, fromTrades, describeCurve, type CurvePoint,
} from "../../core/equity-curve.js";

export interface EquityPanelProps {
  startingBalance: number;
  trades: ReadonlyArray<{ exitTime: number; pnl: number }>;
  /** live balance, shown even before any trade closes */
  balance: number;
}

const PAD = { top: 12, right: 8, bottom: 18, left: 52 };

export function EquityPanel({ startingBalance, trades, balance }: EquityPanelProps): JSX.Element {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const full = useMemo(
    () => fromTrades(startingBalance, trades),
    [startingBalance, trades],
  );
  const summary = useMemo(() => summariseCurve(full), [full]);
  const points: CurvePoint[] = useMemo(() => downsampleCurve(full, 1200), [full]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Measure the CSS box, then size the backing store: reading width/height without setting
    // them makes the canvas 300x150 and every coordinate wrong.
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const plotW = w - PAD.left - PAD.right;
    const plotH = h - PAD.top - PAD.bottom;
    if (plotW <= 0 || plotH <= 0 || points.length < 2) return;

    let lo = Infinity;
    let hi = -Infinity;
    for (const p of points) {
      if (p.equity < lo) lo = p.equity;
      if (p.equity > hi) hi = p.equity;
    }
    // include the starting balance so the break-even line stays on screen
    lo = Math.min(lo, startingBalance);
    hi = Math.max(hi, startingBalance);
    if (hi === lo) { hi = lo + 1; }

    const x = (i: number): number =>
      PAD.left + (points.length === 1 ? 0 : (i / (points.length - 1)) * plotW);
    const y = (v: number): number =>
      PAD.top + plotH - ((v - lo) / (hi - lo)) * plotH;

    // grid + axis labels — the same values the price chart paints with, so the two
    // canvases read as one product
    ctx.strokeStyle = CHART_THEME.grid;
    ctx.fillStyle = CHART_THEME.text;
    ctx.font = "10px ui-monospace, monospace";
    ctx.lineWidth = 1;
    for (let g = 0; g <= 4; g++) {
      const v = lo + ((hi - lo) * g) / 4;
      const yy = y(v);
      ctx.beginPath();
      ctx.moveTo(PAD.left, yy);
      ctx.lineTo(PAD.left + plotW, yy);
      ctx.stroke();
      ctx.fillText(v.toFixed(0), 4, yy + 3);
    }

    // break-even line: above it the account is up
    const beY = y(startingBalance);
    ctx.strokeStyle = `${CHART_THEME.crosshair}55`;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(PAD.left, beY);
    ctx.lineTo(PAD.left + plotW, beY);
    ctx.stroke();
    ctx.setLineDash([]);

    // the curve, filled under the line
    const up = summary.losing === false;
    const colour = up ? "#4f9d69" : "#ef5350";

    ctx.beginPath();
    ctx.moveTo(x(0), y(points[0]!.equity));
    for (let i = 1; i < points.length; i++) ctx.lineTo(x(i), y(points[i]!.equity));
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1.6;
    ctx.stroke();

    ctx.lineTo(x(points.length - 1), PAD.top + plotH);
    ctx.lineTo(PAD.left, PAD.top + plotH);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, PAD.top, 0, PAD.top + plotH);
    grad.addColorStop(0, up ? "rgba(79,157,105,0.22)" : "rgba(239,83,80,0.22)");
    grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = grad;
    ctx.fill();
  }, [points, startingBalance, summary.losing]);

  const pnl = balance - startingBalance;

  return (
    <div className="equity-panel">
      <h2>{t("equity.title")}</h2>

      <div className="kv" data-kv="equity-balance">
        <span>{t("trade.balance")}</span>
        <b className={pnl >= 0 ? "up" : "down"}>{balance.toFixed(2)}</b>
      </div>
      <div className="kv" data-kv="equity-pnl">
        <span>{t("equity.netPnl")}</span>
        <b className={pnl >= 0 ? "up" : "down"}>
          {pnl >= 0 ? "+" : ""}{pnl.toFixed(2)}
        </b>
      </div>
      <div className="kv" data-kv="equity-peak">
        <span>{t("equity.peak")}</span>
        <b>{summary.peak.toFixed(2)}</b>
      </div>
      <div className="kv" data-kv="equity-dd">
        <span>{t("equity.maxDd")}</span>
        <b className="down">
          {summary.worstDrawdown.toFixed(2)} ({summary.worstDrawdownPercent.toFixed(1)}%)
        </b>
      </div>
      <div className="kv" data-kv="equity-now-dd">
        <span>{t("equity.nowDd")}</span>
        <b>{summary.currentDrawdownPercent.toFixed(1)}%</b>
      </div>

      <div className="equity-chart">
        <canvas ref={canvasRef} className="equity-canvas" data-canvas="equity" />
      </div>

      <p className="msg">{describeCurve(summary)}</p>

      {trades.length === 0 && (
        <p className="msg">{t("equity.empty")}</p>
      )}
    </div>
  );
}
