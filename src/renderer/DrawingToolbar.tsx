/**
 * Drawing toolbar.
 *
 * Mirrors TradingView's tool list, organised the way theirs is: a vertical rail of
 * icon buttons grouped by family, with the rarely used patterns in a "more" menu.
 *
 * Every entry is a real tool implemented in core. Nothing is listed that does not
 * draw something — a disabled-looking button that silently does nothing is worse
 * than not having the button.
 */
import React, { useState } from "react";
import type { DrawingKind } from "../core/drawings.js";

export interface ToolSpec {
  kind: DrawingKind;
  label: string;
  /** single glyph, keeps the rail narrow */
  icon: string;
}

export interface ToolGroup {
  name: string;
  icon: string;
  tools: ToolSpec[];
}

export const TOOL_GROUPS: ToolGroup[] = [
  {
    name: "Lines",
    icon: "╱",
    tools: [
      { kind: "trendline", label: "Trend Line", icon: "╱" },
      { kind: "hline", label: "Horizontal Line", icon: "─" },
      { kind: "vline", label: "Vertical Line", icon: "│" },
      { kind: "ray", label: "Ray", icon: "→" },
      { kind: "extended-line", label: "Extended Line", icon: "↔" },
      { kind: "trend-angle", label: "Trend Angle", icon: "∠" },
      { kind: "cross-line", label: "Cross Line", icon: "┼" },
      { kind: "horizontal-ray", label: "Horizontal Ray", icon: "⇥" },
    ],
  },
  {
    name: "Channels",
    icon: "⫽",
    tools: [
      { kind: "channel", label: "Parallel Channel", icon: "⫽" },
      { kind: "pitchfork", label: "Pitchfork", icon: "⑂" },
      { kind: "regression-trend", label: "Regression Trend", icon: "∿" },
      { kind: "fib-channel", label: "Fib Channel", icon: "≡" },
    ],
  },
  {
    name: "Shapes",
    icon: "▭",
    tools: [
      { kind: "rectangle", label: "Rectangle", icon: "▭" },
      { kind: "rotated-rectangle", label: "Rotated Rectangle", icon: "◪" },
      { kind: "ellipse", label: "Ellipse", icon: "⬭" },
      { kind: "circle", label: "Circle", icon: "◯" },
      { kind: "triangle", label: "Triangle", icon: "△" },
      { kind: "arc", label: "Arc", icon: "◜" },
      { kind: "curve", label: "Curve", icon: "⌒" },
      { kind: "polygon", label: "Polygon", icon: "⬠" },
    ],
  },
  {
    name: "Fibonacci",
    icon: "𝑓",
    tools: [
      { kind: "fib-retracement", label: "Fib Retracement", icon: "𝑓" },
      { kind: "fib-extension", label: "Trend-Based Fib Extension", icon: "ƒ" },
      { kind: "fib-time-zone", label: "Fib Time Zone", icon: "⏐" },
      { kind: "fib-speed-fan", label: "Fib Speed Resistance Fan", icon: "⋔" },
      { kind: "fib-arcs", label: "Fib Arcs", icon: "◠" },
      { kind: "fib-wedge", label: "Fib Wedge", icon: "◁" },
    ],
  },
  {
    name: "Gann",
    icon: "𝐺",
    tools: [
      { kind: "gann-fan", label: "Gann Fan", icon: "𝐺" },
      { kind: "gann-box", label: "Gann Box", icon: "▣" },
    ],
  },
  {
    name: "Patterns",
    icon: "◈",
    tools: [
      { kind: "xabcd", label: "XABCD Pattern", icon: "◈" },
      { kind: "abcd", label: "ABCD Pattern", icon: "◇" },
      { kind: "triangle-pattern", label: "Triangle Pattern", icon: "△" },
      { kind: "three-drives", label: "Three Drives", icon: "⋔" },
      { kind: "head-shoulders", label: "Head and Shoulders", icon: "⌒" },
      { kind: "elliott-impulse", label: "Elliott Impulse (5)", icon: "⑤" },
      { kind: "elliott-correction", label: "Elliott Correction (3)", icon: "③" },
      { kind: "cypher", label: "Cypher Pattern", icon: "⟡" },
      { kind: "bat", label: "Bat Pattern", icon: "⌃" },
      { kind: "crab", label: "Crab Pattern", icon: "⋈" },
      { kind: "butterfly", label: "Butterfly Pattern", icon: "🦋" },
      { kind: "shark", label: "Shark Pattern", icon: "⋉" },
    ],
  },
  {
    name: "Forecast",
    icon: "⊞",
    tools: [
      { kind: "long-position", label: "Long Position", icon: "▲" },
      { kind: "short-position", label: "Short Position", icon: "▼" },
      { kind: "projection", label: "Projection", icon: "⊳" },
      { kind: "date-range", label: "Date Range", icon: "⇹" },
      { kind: "price-range", label: "Price Range", icon: "⇳" },
      { kind: "date-price-range", label: "Date and Price Range", icon: "⊞" },
      { kind: "ghost-feed", label: "Ghost Feed", icon: "👻" },
    ],
  },
  {
    name: "Annotation",
    icon: "T",
    tools: [
      { kind: "text", label: "Text", icon: "T" },
      { kind: "note", label: "Note", icon: "🗒" },
      { kind: "callout", label: "Callout", icon: "💬" },
      { kind: "price-label", label: "Price Label", icon: "🏷" },
      { kind: "arrow", label: "Arrow", icon: "→" },
      { kind: "arrow-marker", label: "Arrow Marker", icon: "➤" },
      { kind: "flag", label: "Flag", icon: "⚑" },
      { kind: "comment", label: "Comment", icon: "!" },
      { kind: "signpost", label: "Signpost", icon: "⚐" },
      { kind: "balloon", label: "Balloon", icon: "○" },
    ],
  },
  {
    name: "Measure",
    icon: "⇕",
    tools: [
      { kind: "measure", label: "Measure", icon: "⇕" },
      { kind: "zoom-in", label: "Zoom In", icon: "⤢" },
    ],
  },
];

/** Flat lookup so the panel can render a name for the active tool. */
export const TOOL_LABELS: Record<string, string> = Object.fromEntries(
  TOOL_GROUPS.flatMap((g) => g.tools.map((t) => [t.kind, t.label])),
);

interface Props {
  active: DrawingKind | null;
  onSelect: (kind: DrawingKind | null) => void;
  onDelete: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  count: number;
}

export function DrawingToolbar({
  active, onSelect, onDelete, onUndo, onRedo, canUndo, canRedo, count,
}: Props): JSX.Element {
  const [openGroup, setOpenGroup] = useState<string | null>(null);

  return (
    <div className="draw-rail">
      <button
        className={active === null ? "tool-btn active" : "tool-btn"}
        title="Cursor / select (Esc)"
        onClick={() => { onSelect(null); setOpenGroup(null); }}
      >
        ⬉
      </button>

      {TOOL_GROUPS.map((group) => (
        <div key={group.name} className="tool-group">
          <button
            className={
              group.tools.some((t) => t.kind === active)
                ? "tool-btn active"
                : "tool-btn"
            }
            title={group.name}
            onClick={() => setOpenGroup(openGroup === group.name ? null : group.name)}
          >
            {group.icon}
          </button>
          {openGroup === group.name && (
            <div className="tool-flyout">
              <div className="flyout-title">{group.name}</div>
              {group.tools.map((t) => (
                <button
                  key={t.kind}
                  className={active === t.kind ? "flyout-item active" : "flyout-item"}
                  onClick={() => { onSelect(t.kind); setOpenGroup(null); }}
                >
                  <span className="fi-icon">{t.icon}</span>
                  <span>{t.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      ))}

      <div className="rail-sep" />

      <button className="tool-btn" title="Undo (Ctrl+Z)" onClick={onUndo} disabled={!canUndo}>↶</button>
      <button className="tool-btn" title="Redo (Ctrl+Shift+Z)" onClick={onRedo} disabled={!canRedo}>↷</button>
      <button className="tool-btn" title="Delete all drawings" onClick={onDelete} disabled={count === 0}>🗑</button>

      <div className="rail-count">{count > 0 ? count : ""}</div>
    </div>
  );
}
