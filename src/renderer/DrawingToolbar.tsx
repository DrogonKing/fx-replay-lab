/**
 * Drawing toolbar — TradingView's rail, in TradingView's order.
 *
 * The order and grouping below are not arbitrary: they are the order TradingView uses, so a
 * user coming from that platform finds a tool where their hand expects it. Reordering these
 * for tidiness would break the only thing the rail has going for it, which is muscle memory.
 *
 * Layout, top to bottom:
 *   1  cursor / crosshair
 *   2  trend line      ▸ (line family)
 *   3  fibonacci       ▸ (fib + gann)
 *   4  brush           ▸ (freehand, highlighter, marker)
 *   5  arrows          ▸ (arrows, patterns)
 *   6  projection      ▸ (long/short position, projection, ranges)
 *   7  text            ▸ (text, note, callout, labels)
 *   8  icons           ▸ (emoji, stickers, marks)
 *   9  shapes          ▸ (rectangle, ellipse, polygon, curves)
 *  10  measure         ▸ (measure, ruler)
 *  11  zoom in
 *  12  magnet          (snap to OHLC)
 *  13  lock all
 *  14  hide all
 *  15  delete
 *  ── gap ──
 *  ★   favourites
 *
 * Every entry is a tool that actually draws something. A button that silently does nothing is
 * worse than a missing button.
 */
import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { DrawingKind } from "../core/drawings.js";
import type { ToolConfig, ToolStyle } from "../core/tool-config.js";
import { isVisible } from "../core/tool-config.js";

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
  /** true when TradingView shows a chevron for this entry */
  chevron: boolean;
}

/** The rail, in TradingView's order. */
export const TOOL_GROUPS: ToolGroup[] = [
  {
    name: "Lines",
    icon: "╱",
    chevron: true,
    tools: [
      { kind: "trendline", label: "Trend Line", icon: "╱" },
      { kind: "ray", label: "Ray", icon: "→" },
      { kind: "info-line", label: "Info Line", icon: "ⓘ" },
      { kind: "extended-line", label: "Extended Line", icon: "↔" },
      { kind: "trend-angle", label: "Trend Angle", icon: "∠" },
      { kind: "hline", label: "Horizontal Line", icon: "─" },
      { kind: "vline", label: "Vertical Line", icon: "│" },
      { kind: "cross-line", label: "Cross Line", icon: "┼" },
      { kind: "horizontal-ray", label: "Horizontal Ray", icon: "⇥" },
      { kind: "channel", label: "Parallel Channel", icon: "⫽" },
      { kind: "flat-top-bottom", label: "Flat Top/Bottom", icon: "⬒" },
      { kind: "disjoint-channel", label: "Disjoint Channel", icon: "⫻" },
      { kind: "pitchfork", label: "Pitchfork", icon: "⑂" },
      { kind: "schiff-pitchfork", label: "Schiff Pitchfork", icon: "⑂" },
      { kind: "modified-schiff-pitchfork", label: "Modified Schiff", icon: "⑂" },
      { kind: "inside-pitchfork", label: "Inside Pitchfork", icon: "⑂" },
      { kind: "regression-trend", label: "Regression Trend", icon: "∿" },
    ],
  },
  {
    name: "Fibonacci",
    icon: "𝑓",
    chevron: true,
    tools: [
      { kind: "fib-retracement", label: "Fib Retracement", icon: "𝑓" },
      { kind: "fib-extension", label: "Trend-Based Fib Extension", icon: "ƒ" },
      { kind: "fib-channel", label: "Fib Channel", icon: "≡" },
      { kind: "fib-time-zone", label: "Fib Time Zone", icon: "⏐" },
      { kind: "fib-retracement-time", label: "Trend-Based Fib Time", icon: "⏐" },
      { kind: "fib-speed-fan", label: "Fib Speed Resistance Fan", icon: "⋔" },
      { kind: "fib-speed-fan", label: "Fib Speed Resistance Arcs", icon: "◠" },
      { kind: "fib-arcs", label: "Fib Arcs", icon: "◠" },
      { kind: "fib-circles", label: "Fib Circles", icon: "◎" },
      { kind: "fib-spiral", label: "Fib Spiral", icon: "◌" },
      { kind: "fib-wedge", label: "Fib Wedge", icon: "◁" },
      { kind: "pitchfan", label: "Pitchfan", icon: "⑂" },
      { kind: "gann-fan", label: "Gann Fan", icon: "𝐺" },
      { kind: "gann-fan-fixed", label: "Gann Fan (Fixed)", icon: "𝐺" },
      { kind: "gann-box", label: "Gann Box", icon: "▣" },
      { kind: "gann-square", label: "Gann Square", icon: "▢" },
      { kind: "gann-square-fixed", label: "Gann Square (Fixed)", icon: "▢" },
    ],
  },
  {
    name: "Brush",
    icon: "✎",
    chevron: true,
    tools: [
      { kind: "path", label: "Brush", icon: "✎" },
      { kind: "highlighter", label: "Highlighter", icon: "▮" },
      { kind: "curve", label: "Curve", icon: "⌒" },
      { kind: "double-curve", label: "Double Curve", icon: "∿" },
      { kind: "arc", label: "Arc", icon: "◜" },
      { kind: "ellipse-arc", label: "Ellipse Arc", icon: "◝" },
    ],
  },
  {
    name: "Arrows & Patterns",
    icon: "➤",
    chevron: true,
    tools: [
      { kind: "arrow", label: "Arrow", icon: "→" },
      { kind: "arrow-marker", label: "Arrow Marker", icon: "➤" },
      { kind: "arrow-shape", label: "Arrow Shape", icon: "➔" },
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
      { kind: "five-points-pattern", label: "5-0 Pattern", icon: "⑤" },
      { kind: "bars-pattern", label: "Bars Pattern", icon: "▥" },
    ],
  },
  {
    name: "Projection",
    icon: "⊞",
    chevron: true,
    tools: [
      { kind: "long-position", label: "Long Position", icon: "▲" },
      { kind: "short-position", label: "Short Position", icon: "▼" },
      { kind: "projection", label: "Projection", icon: "⊳" },
      { kind: "date-range", label: "Date Range", icon: "⇹" },
      { kind: "price-range", label: "Price Range", icon: "⇳" },
      { kind: "date-price-range", label: "Date and Price Range", icon: "⊞" },
      { kind: "price-range-pct", label: "Price Range %", icon: "%" },
      { kind: "date-price-range-pct", label: "Date and Price Range %", icon: "%" },
      { kind: "ghost-feed", label: "Ghost Feed", icon: "👻" },
    ],
  },
  {
    name: "Text",
    icon: "T",
    chevron: true,
    tools: [
      { kind: "text", label: "Text", icon: "T" },
      { kind: "anchored-text", label: "Anchored Text", icon: "T" },
      { kind: "note", label: "Note", icon: "🗒" },
      { kind: "anchored-note", label: "Anchored Note", icon: "🗒" },
      { kind: "callout", label: "Callout", icon: "💬" },
      { kind: "comment", label: "Comment", icon: "!" },
      { kind: "price-label", label: "Price Label", icon: "🏷" },
      { kind: "signpost", label: "Signpost", icon: "⚐" },
      { kind: "flag", label: "Flag", icon: "⚑" },
      { kind: "table", label: "Table", icon: "▦" },
    ],
  },
  {
    name: "Icons",
    icon: "☺",
    chevron: true,
    tools: [
      { kind: "emoji", label: "Emoji", icon: "☺" },
      { kind: "sticker", label: "Sticker", icon: "★" },
      { kind: "balloon", label: "Balloon", icon: "○" },
      { kind: "image", label: "Image", icon: "🖼" },
    ],
  },
  {
    name: "Shapes",
    icon: "▭",
    chevron: true,
    tools: [
      { kind: "rectangle", label: "Rectangle", icon: "▭" },
      { kind: "rotated-rectangle", label: "Rotated Rectangle", icon: "◪" },
      { kind: "ellipse", label: "Ellipse", icon: "⬭" },
      { kind: "rotated-ellipse", label: "Rotated Ellipse", icon: "⬮" },
      { kind: "circle", label: "Circle", icon: "◯" },
      { kind: "triangle", label: "Triangle", icon: "△" },
      { kind: "polygon", label: "Polygon", icon: "⬠" },
      { kind: "star", label: "Star", icon: "☆" },
    ],
  },
  {
    name: "Measure",
    icon: "⇕",
    chevron: true,
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

export const ALL_KINDS: DrawingKind[] = Array.from(
  new Set(TOOL_GROUPS.flatMap((g) => g.tools.map((t) => t.kind))),
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
  /** per-tool style and visibility */
  configs: Record<string, ToolConfig>;
  /** current timeframe label, for the per-tool timeframe filter */
  timeframe: string;
  /** snap new points to the nearest OHLC value */
  magnet: boolean;
  onMagnet: (on: boolean) => void;
  /** drawings are not hit-tested while locked */
  locked: boolean;
  onLocked: (on: boolean) => void;
  /** drawings are not painted while hidden */
  hidden: boolean;
  onHidden: (on: boolean) => void;
  /** open the per-tool settings for a kind */
  onSettings: (kind: DrawingKind) => void;
  favourites: DrawingKind[];
  onToggleFavourite: (kind: DrawingKind) => void;
}

export function DrawingToolbar({
  active, onSelect, onDelete, onUndo, onRedo, canUndo, canRedo, count,
  configs, timeframe, magnet, onMagnet, locked, onLocked, hidden, onHidden,
  onSettings, favourites, onToggleFavourite,
}: Props): JSX.Element {
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [showFavourites, setShowFavourites] = useState(false);

  /**
   * Screen coordinates for the open group's flyout.
   *
   * The flyout is portalled onto <body>, so `position: fixed` needs real numbers. It is anchored
   * to the RIGHT edge of the 44px rail and clamped to the viewport, because a menu that runs off
   * the bottom of a short window is the same bug in a different direction.
   */
  const [flyoutPos, setFlyoutPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    if (openGroup === null) { setFlyoutPos(null); return; }
    const place = (): void => {
      const btn = document.querySelector<HTMLElement>(`[data-group="${CSS.escape(openGroup)}"]`);
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      const menuH = 380;
      const top = Math.max(44, Math.min(r.top, window.innerHeight - Math.min(menuH, window.innerHeight - 50)));
      setFlyoutPos({ left: r.right + 4, top });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [openGroup]);

  /** A tiny swatch of the tool's own colour, so the rail reflects customisation. */
  const swatch = (kind: DrawingKind): React.CSSProperties => {
    const st: ToolStyle | undefined = configs[kind]?.style;
    if (!st) return {};
    return {
      borderBottom: `2px ${st.style === "solid" ? "solid" : st.style} ${st.color}`,
      opacity: st.opacity < 1 ? 0.5 + st.opacity / 2 : 1,
    };
  };

  return (
    <div className="draw-rail" data-rail="draw">
      {/* 1. cursor */}
      <button
        className={active === null ? "tool-btn active" : "tool-btn"}
        data-tool="cursor"
        title="Cursor / select (Esc)"
        onClick={() => { onSelect(null); setOpenGroup(null); }}
      >
        ✛
      </button>

      {/* 2..10: the drawing families, in TradingView's order */}
      {TOOL_GROUPS.map((group) => {
        const visibleTools = group.tools.filter((t) => isVisible(configs, t.kind, timeframe));
        // a family whose every tool is filtered out on this timeframe disappears entirely,
        // which is the point of the per-tool timeframe filter
        if (visibleTools.length === 0) return null;

        const isActive = group.tools.some((t) => t.kind === active);
        return (
          <div className="tool-group" key={group.name}>
            <button
              className={isActive ? "tool-btn active" : "tool-btn"}
              data-group={group.name}
              title={group.name}
              style={swatch(visibleTools[0]!.kind)}
              onClick={() => setOpenGroup(openGroup === group.name ? null : group.name)}
              onContextMenu={(e) => {
                // right-click a family to configure its first tool, the way TV opens
                // settings from the rail
                e.preventDefault();
                onSettings(visibleTools[0]!.kind);
              }}
            >
              {group.icon}
              {group.chevron && <span className="tool-chev" />}
            </button>

            {openGroup === group.name && (
              /*
                Rendered into a portal on <body>, NOT inside the rail.
                The rail scrolls (`overflow-y: auto`) to fit a short window, and CSS coerces the
                other axis to `auto` as well — so a flyout inside it was clipped to the rail's 44px
                width and painted under the chart, and a real mouse click at the item's centre hit
                "draw-canvas" while a synthesised .click() still worked. A portal leaves that
                stacking context and clipping entirely.
              */
              createPortal(
              <div
                className="tool-flyout"
                style={flyoutPos ? { left: `${flyoutPos.left}px`, top: `${flyoutPos.top}px` } : { visibility: "hidden" }}
                data-flyout-group={group.name}
              >
                <div className="flyout-title">{group.name}</div>
                {visibleTools.map((t) => (
                  <div className="flyout-row" key={`${t.kind}-${t.label}`}>
                    <button
                      className={active === t.kind ? "flyout-item active" : "flyout-item"}
                      data-tool-item={t.kind}
                      onClick={() => { onSelect(t.kind); setOpenGroup(null); }}
                    >
                      <span className="fi-icon">{t.icon}</span>
                      <span>{t.label}</span>
                    </button>
                    <button
                      className="fi-star"
                      data-fav={t.kind}
                      title="favourite"
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleFavourite(t.kind);
                      }}
                    >
                      {favourites.includes(t.kind) ? "★" : "☆"}
                    </button>
                    <button
                      className="fi-gear"
                      data-settings={t.kind}
                      title="settings"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSettings(t.kind);
                      }}
                    >
                      ⚙
                    </button>
                  </div>
                ))}
              </div>,
              document.body,
              )
            )}
          </div>
        );
      })}

      <div className="rail-sep" />

      {/* 11..15: the utility toggles, no chevrons */}
      <button
        className="tool-btn"
        data-tool="zoom-in"
        title="Zoom in"
        onClick={() => onSelect("zoom-in")}
      >⤢</button>

      <button
        className={magnet ? "tool-btn on" : "tool-btn"}
        data-toggle="magnet"
        title="Magnet — snap to OHLC"
        onClick={() => onMagnet(!magnet)}
      >∪</button>

      <button
        className={locked ? "tool-btn on" : "tool-btn"}
        data-toggle="lock"
        title="Lock all drawings"
        onClick={() => onLocked(!locked)}
      >{locked ? "🔒" : "🔓"}</button>

      <button
        className={hidden ? "tool-btn on" : "tool-btn"}
        data-toggle="hide"
        title="Hide all drawings"
        onClick={() => onHidden(!hidden)}
      >{hidden ? "◌" : "◉"}</button>

      <button
        className="tool-btn"
        data-tool="delete"
        title="Remove all drawings"
        onClick={onDelete}
        disabled={count === 0}
      >🗑</button>

      <div className="rail-sep strong" />

      <button className="tool-btn" title="Undo (Ctrl+Z)" onClick={onUndo} disabled={!canUndo}>↶</button>
      <button className="tool-btn" title="Redo (Ctrl+Shift+Z)" onClick={onRedo} disabled={!canRedo}>↷</button>

      {/* the gap, then the star pinned at the bottom */}
      <div className="rail-grow" />

      <button
        className={showFavourites ? "tool-btn active star" : "tool-btn star"}
        data-toggle="favourites"
        title="Favourites"
        onClick={() => setShowFavourites((v) => !v)}
      >★</button>

      {showFavourites && (
        <div className="tool-flyout star-flyout">
          <div className="flyout-title">Favourites</div>
          {favourites.length === 0 && (
            <div className="flyout-empty">Star a tool in any menu to pin it here.</div>
          )}
          {favourites.map((k) => (
            <div className="flyout-row" key={k}>
              <button
                className={active === k ? "flyout-item active" : "flyout-item"}
                onClick={() => { onSelect(k); setShowFavourites(false); }}
              >
                <span className="fi-icon">★</span>
                <span>{TOOL_LABELS[k] ?? k}</span>
              </button>
              <button className="fi-gear" onClick={() => onSettings(k)} title="settings">⚙</button>
            </div>
          ))}
        </div>
      )}

      <div className="rail-count">{count > 0 ? count : ""}</div>
    </div>
  );
}
