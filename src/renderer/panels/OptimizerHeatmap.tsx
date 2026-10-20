/**
 * The optimizer's parameter surface, as a heatmap.
 *
 * A grid search's real output is a SURFACE. The ranked table answers "which combination won";
 * the heatmap answers "is there a region that works, or did one cell win by luck" — which is
 * the question that decides whether the result is worth trading.
 *
 * The roughness readout is the point: a smooth surface means the parameter choice is not
 * sensitive. A jagged one means the grid is fitting noise, and the winner is probably luck.
 */
import React, { useMemo, useState } from "react";
import { useI18n } from "../i18n-context.js";
import {
  buildHeatmap, pickAxes, normalise, bestCell, paramsForCell, describeHeatmap, roughness,
  higherIsBetter, type Heatmap, type HeatmapAxes,
} from "../../core/optimize-heatmap.js";
import type { OptimizationResult, RankMetric } from "../../core/optimize.js";

export interface OptimizerHeatmapProps {
  result: OptimizationResult;
  onApply: (params: Record<string, number>) => void;
}

const METRICS: RankMetric[] = [
  "netProfit", "profitFactor", "expectancy", "sharpe", "winRate", "maxDrawdown",
];

/** Green for good, red for bad, on a dark terminal background. */
function cellColour(t: number): string {
  if (Number.isNaN(t)) return "#1a1d26";
  // 0 -> deep red, 0.5 -> neutral, 1 -> green. Interpolated in two halves so the midpoint is
  // readable rather than muddy.
  if (t < 0.5) {
    const k = t / 0.5;
    const r = Math.round(120 + k * 40);
    const g = Math.round(40 + k * 55);
    return `rgb(${r},${g},${Math.round(45 + k * 15)})`;
  }
  const k = (t - 0.5) / 0.5;
  const r = Math.round(160 - k * 105);
  const g = Math.round(95 + k * 90);
  return `rgb(${r},${g},${Math.round(60 + k * 30)})`;
}

export function OptimizerHeatmap({ result, onApply }: OptimizerHeatmapProps): JSX.Element {
  const { t } = useI18n();
  const [metric, setMetric] = useState<RankMetric>("netProfit");
  const axes = useMemo(() => pickAxes(result.runs), [result]);
  const [override, setOverride] = useState<HeatmapAxes | null>(null);
  const chosen = override ?? axes;

  const heat: Heatmap | null = useMemo(
    () => buildHeatmap(result, chosen ?? undefined, metric),
    [result, chosen, metric],
  );

  if (!heat) {
    return <p className="msg">{t("opt.noSurface")}</p>;
  }

  const best = bestCell(heat);
  const bestParams = best ? paramsForCell(heat, result, best) : null;
  const rough = roughness(heat);

  // Roughness above ~0.5 means neighbouring parameter values disagree wildly. Say so plainly:
  // this is the warning that stops a user trading a lucky cell.
  const roughVerdict =
    rough > 0.5 ? t("opt.roughHigh")
      : rough > 0.25 ? t("opt.roughMedium")
        : t("opt.roughLow");

  const paramNames = Object.keys(result.runs[0]?.params ?? {});

  return (
    <div className="heatmap" data-panel="heatmap">
      <div className="heat-controls">
        <label>
          {t("opt.metric")}
          <select
            data-field="heat-metric"
            value={metric}
            onChange={(e) => setMetric(e.target.value as RankMetric)}
          >
            {METRICS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>

        <label>
          {t("opt.axisX")}
          <select
            data-field="heat-x"
            value={heat.xLabel}
            onChange={(e) => setOverride({ x: e.target.value, y: heat.yLabel })}
          >
            {paramNames.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>

        <label>
          {t("opt.axisY")}
          <select
            data-field="heat-y"
            value={heat.yLabel}
            onChange={(e) => setOverride({ x: heat.xLabel, y: e.target.value })}
          >
            {paramNames.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      </div>

      <table className="heat-grid" data-grid="heatmap">
        <thead>
          <tr>
            <th className="heat-corner">{heat.yLabel} \ {heat.xLabel}</th>
            {heat.xValues.map((v) => <th key={v}>{v}</th>)}
          </tr>
        </thead>
        <tbody>
          {heat.cells.map((row, yi) => (
            <tr key={heat.yValues[yi]}>
              <th className="heat-rowhead">{heat.yValues[yi]}</th>
              {row.map((cell, xi) => {
                const isBest = best !== null && cell.bestRun === best.bestRun;
                return (
                  <td
                    key={xi}
                    data-cell={`${xi}-${yi}`}
                    data-samples={cell.samples}
                    className={isBest ? "heat-best" : undefined}
                    style={{ background: cellColour(normalise(cell.value, heat.min, heat.max, metric)) }}
                    title={
                      Number.isNaN(cell.value)
                        ? t("opt.untested")
                        : `${cell.value.toFixed(2)}${cell.samples > 1 ? ` · ${cell.samples} runs` : ""}`
                    }
                  >
                    {Number.isNaN(cell.value) ? "·" : cell.value.toFixed(0)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      <p className="msg" data-note="heat-summary">{describeHeatmap(heat)}</p>

      <div className="kv" data-kv="roughness">
        <span>{t("opt.roughness")}</span>
        <b className={rough > 0.5 ? "down" : rough > 0.25 ? "warn" : "up"}>
          {rough.toFixed(2)} — {roughVerdict}
        </b>
      </div>

      {bestParams && (
        <>
          <div className="kv" data-kv="heat-best">
            <span>{t("opt.bestCell")}</span>
            <b>
              {Object.entries(bestParams).map(([k, v]) => `${k}=${v}`).join(" ")}
            </b>
          </div>
          <button data-action="apply-best" onClick={() => onApply(bestParams)}>
            {t("opt.applyBest")}
          </button>
        </>
      )}

      <p className="msg">
        {higherIsBetter(metric) ? t("opt.higherBetter") : t("opt.lowerBetter")}
        {heat.collapsed.length > 0 && ` · ${t("opt.collapsed")}: ${heat.collapsed.join(", ")}`}
      </p>
    </div>
  );
}
