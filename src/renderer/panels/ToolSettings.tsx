/**
 * Per-tool settings.
 *
 * One tool's colour, width, line style, opacity, fill, and which timeframes it appears on.
 * TradingView opens this from a double-click on a drawing or from the tool's menu; here it is
 * opened from the gear in any tool menu.
 *
 * The timeframe filter is the part that earns its place: a weekly pivot or a swing tool is
 * noise on a 1-minute chart, and being able to say so once — instead of remembering to ignore
 * it — is what turns a 95-tool rail into a usable one.
 */
import React, { useState } from "react";
import { useI18n } from "../i18n-context.js";
import type { DrawingKind } from "../../core/drawings.js";
import {
  describeStyle, dashPattern, resetConfigs, setConfig, styleFor,
  type ToolConfig, type LineStyle,
} from "../../core/tool-config.js";
import { TOOL_LABELS } from "../DrawingToolbar.js";

const PALETTE = [
  "#2962ff", "#f0b90b", "#26a69a", "#ef5350", "#ab47bc",
  "#ff9800", "#00bcd4", "#8bc34a", "#e91e63", "#d1d4dc",
  "#787b86", "#ffffff",
];

const TIMEFRAMES = ["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1"];

export interface ToolSettingsProps {
  kind: DrawingKind;
  configs: Record<string, ToolConfig>;
  onChange: (configs: Record<string, ToolConfig>) => void;
  onClose: () => void;
  /** reset every tool, not just this one */
  allKinds: readonly DrawingKind[];
}

export function ToolSettings({
  kind, configs, onChange, onClose, allKinds,
}: ToolSettingsProps): JSX.Element {
  const { t } = useI18n();
  const cfg = configs[kind];
  const [preview] = useState(() => styleFor(configs, kind));

  if (!cfg) {
    return (
      <div className="tool-settings">
        <p className="msg">{t("ts.unknown")}</p>
        <button onClick={onClose}>{t("ts.close")}</button>
      </div>
    );
  }

  const style = cfg.style;
  const patch = (p: Parameters<typeof setConfig>[2]): void =>
    onChange(setConfig(configs, kind, p));

  const toggleTf = (tf: string): void => {
    const has = cfg.timeframes.includes(tf);
    // an empty list means "all timeframes", so un-toggling the last one must not silently
    // hide the tool everywhere — it goes back to "all"
    const next = has
      ? cfg.timeframes.filter((x) => x !== tf)
      : [...cfg.timeframes, tf];
    patch({ timeframes: next });
  };

  return (
    <div className="tool-settings" data-panel="tool-settings" data-kind={kind}>
      <div className="ts-head">
        <b>{TOOL_LABELS[kind] ?? kind}</b>
        <button className="mini" data-action="ts-close" onClick={onClose}>✕</button>
      </div>

      <h4>{t("ts.colour")}</h4>
      <div className="ts-swatches">
        {PALETTE.map((c) => (
          <button
            key={c}
            data-swatch={c}
            className={style.color.toLowerCase() === c.toLowerCase() ? "sw on" : "sw"}
            style={{ background: c }}
            title={c}
            onClick={() => patch({ style: { color: c } })}
          />
        ))}
        <input
          type="color"
          data-field="ts-color"
          value={style.color}
          onChange={(e) => patch({ style: { color: e.target.value } })}
        />
      </div>

      <h4>{t("ts.width")}</h4>
      <div className="ts-widths">
        {[1, 2, 3, 4].map((w) => (
          <button
            key={w}
            data-width={w}
            className={style.width === w ? "ts-w on" : "ts-w"}
            onClick={() => patch({ style: { width: w } })}
          >
            <span style={{ height: w, background: style.color, display: "block" }} />
          </button>
        ))}
      </div>

      <h4>{t("ts.style")}</h4>
      <div className="ts-styles">
        {(["solid", "dashed", "dotted"] as LineStyle[]).map((s) => (
          <button
            key={s}
            data-linestyle={s}
            className={style.style === s ? "ts-ls on" : "ts-ls"}
            onClick={() => patch({ style: { style: s } })}
          >
            <svg width="34" height="8">
              <line
                x1="0" y1="4" x2="34" y2="4"
                stroke={style.color}
                strokeWidth={style.width}
                strokeDasharray={dashPattern(s, style.width).join(" ") || undefined}
              />
            </svg>
          </button>
        ))}
      </div>

      <label className="ts-row">
        {t("ts.opacity")}
        <input
          type="range" min="0.1" max="1" step="0.05"
          data-field="ts-opacity"
          value={style.opacity}
          onChange={(e) => patch({ style: { opacity: Number(e.target.value) } })}
        />
        <b>{Math.round(style.opacity * 100)}%</b>
      </label>

      <label className="ts-row">
        <input
          type="checkbox"
          data-field="ts-fill"
          checked={style.fill}
          onChange={(e) => patch({ style: { fill: e.target.checked } })}
        />
        {t("ts.fill")}
      </label>

      {style.fill && (
        <label className="ts-row">
          {t("ts.fillOpacity")}
          <input
            type="range" min="0.02" max="0.6" step="0.02"
            data-field="ts-fill-opacity"
            value={style.fillOpacity}
            onChange={(e) => patch({ style: { fillOpacity: Number(e.target.value) } })}
          />
          <b>{Math.round(style.fillOpacity * 100)}%</b>
        </label>
      )}

      <h4>{t("ts.timeframes")}</h4>
      <p className="msg">{t("ts.tfHint")}</p>
      <div className="ts-tfs">
        {TIMEFRAMES.map((tf) => (
          <button
            key={tf}
            data-tf={tf}
            className={cfg.timeframes.includes(tf) ? "ts-tf on" : "ts-tf"}
            onClick={() => toggleTf(tf)}
          >{tf}</button>
        ))}
      </div>

      <label className="ts-row">
        <input
          type="checkbox"
          data-field="ts-hidden"
          checked={cfg.hidden}
          onChange={(e) => patch({ hidden: e.target.checked })}
        />
        {t("ts.hidden")}
      </label>

      <div className="ts-preview" style={{ borderColor: style.color }}>
        <span style={{ color: style.color }}>{describeStyle(style)}</span>
        <small>{preview.color === style.color ? "" : ""}</small>
      </div>

      <div className="ts-actions">
        <button
          data-action="ts-reset"
          onClick={() => onChange(resetConfigs(configs, allKinds, kind))}
        >{t("ts.reset")}</button>
        <button
          data-action="ts-reset-all"
          onClick={() => onChange(resetConfigs(configs, allKinds))}
        >{t("ts.resetAll")}</button>
        <button className="primary" data-action="ts-done" onClick={onClose}>
          {t("ts.close")}
        </button>
      </div>
    </div>
  );
}
