/**
 * Toolbar icon menu: chart type + log scale in one dropdown.
 *
 * Both controls used to sit as labelled form rows in the toolbar, which is where a
 * settings form does not belong — the toolbar is for switching, the menus are for
 * options. Collapsed into one candle icon, exactly like the reference terminal.
 *
 * The two controls keep their original data-field names; only their location moved.
 */
import React, { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n-context.js";

export interface ChartTypeMenuProps {
  chartType: "candles" | "bars" | "line" | "area";
  logScale: boolean;
  onChartType: (t: "candles" | "bars" | "line" | "area") => void;
  onLogScale: (on: boolean) => void;
}

const ICONS: Record<ChartTypeMenuProps["chartType"], string> = {
  candles: "🕯",
  bars: "≡",
  line: "╱",
  area: "▲",
};

export function ChartTypeMenu({
  chartType, logScale, onChartType, onLogScale,
}: ChartTypeMenuProps): JSX.Element {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);

  // Close on an outside click — same contract as the timeframe and timezone menus.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Fixed + measured, because the toolbar scrolls and clips positioned children — the
  // same bug the timezone picker already documented and fixed.
  useEffect(() => {
    if (!open) { setAnchor(null); return; }
    const measure = (): void => {
      const el = buttonRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setAnchor({
        left: Math.max(4, Math.min(r.left, window.innerWidth - 220)),
        top: r.bottom + 6,
      });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open]);

  return (
    <div className="tf-menu" ref={boxRef} data-panel="chart-type">
      <button
        ref={buttonRef}
        className="tf-button"
        data-action="chart-type-open"
        aria-haspopup="menu"
        aria-expanded={open}
        title={t("toolbar.chartMenu")}
        onClick={() => setOpen((o) => !o)}
      >
        {/* keeps the pre-restructure data-field name: this node holds the current type,
            which is what the old toolbar select exposed */}
        <span data-field="chart-type">{ICONS[chartType]}</span>
        <span className="tf-caret">▾</span>
      </button>

      {open && (
        <div
          className="tf-dialog"
          role="menu"
          data-dialog="chart-type"
          style={anchor ? { left: `${anchor.left}px`, top: `${anchor.top}px` } : { visibility: "hidden" }}
        >
          <div className="tf-section">{t("app.chartType")}</div>
          <div className="chart-type-list">
            {(["candles", "bars", "line", "area"] as const).map((k) => (
              <button
                key={k}
                className={"tf-pick" + (chartType === k ? " on" : "")}
                data-chart-type={k}
                onClick={() => { onChartType(k); setOpen(false); }}
              >
                <span className="fi-icon">{ICONS[k]}</span> {t(`app.${k}`)}
              </button>
            ))}
          </div>
          <div className="tf-sep" />
          <label className="chart-menu-row">
            <input
              type="checkbox"
              data-field="log-scale"
              checked={logScale}
              onChange={(e) => onLogScale(e.target.checked)}
            />
            {t("app.logScale")}
          </label>
          <p className="tf-foot">{t("app.logScaleHint")}</p>
        </div>
      )}
    </div>
  );
}
