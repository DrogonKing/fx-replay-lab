/**
 * Per-tool style and visibility, saved across sessions.
 *
 * TradingView lets you set a tool's colour, width, line style and opacity once, and every
 * future drawing of that kind inherits it. It also lets you hide a tool from the rail, and
 * scope it to certain timeframes. Without this, every drawing started from the same defaults
 * and the rail carried 65 tools whether or not you used them.
 *
 * Pure. The precedence rule is the whole design: an explicit per-drawing value beats the
 * tool default, which beats the shipped default. Getting that order wrong means a user's
 * chosen colour silently reverts.
 */
import type { DrawingKind } from "./drawings.js";

/** How a line is painted. Mirrors what a canvas can do. */
export type LineStyle = "solid" | "dashed" | "dotted";

export interface ToolStyle {
  color: string;
  /** 1..4, in chart pixels */
  width: number;
  style: LineStyle;
  /** 0..1 */
  opacity: number;
  /** fill under/inside the shape, when the shape has an area */
  fill: boolean;
  /** fill opacity, 0..1; independent of the line opacity */
  fillOpacity: number;
}

export interface ToolConfig {
  style: ToolStyle;
  /** hidden from the rail; the tool still works if selected programmatically */
  hidden: boolean;
  /**
   * Timeframes the tool is shown on, as labels ("M1", "H4", "D1").
   *
   * Empty means every timeframe. A tool scoped to ["D1"] is hidden on M5 — the point being
   * that a weekly pivot or a swing tool is noise on a 1-minute chart, and TradingView lets
   * you say so once instead of remembering to ignore it.
   */
  timeframes: string[];
  /** false when the user has never touched this tool; used to show "modified" */
  isDefault: boolean;
}

export const DEFAULT_STYLE: ToolStyle = {
  color: "#2962ff",
  width: 1,
  style: "solid",
  opacity: 1,
  fill: false,
  fillOpacity: 0.12,
};

/** Tools whose default is a filled shape rather than a line. */
const FILLED_KINDS = new Set<DrawingKind>([
  "rectangle", "rotated-rectangle", "ellipse", "circle", "triangle", "polygon",
  "channel", "fib-channel", "gann-box", "long-position", "short-position",
  "date-range", "price-range", "date-price-range", "projection",
]);

/** Tools that make more sense as a thicker, more visible line by default. */
const BOLD_KINDS = new Set<DrawingKind>([
  "trendline", "ray", "extended-line", "cross-line", "horizontal-ray", "trend-angle",
]);

export function defaultStyleFor(kind: DrawingKind): ToolStyle {
  const base = { ...DEFAULT_STYLE };
  if (FILLED_KINDS.has(kind)) {
    base.fill = true;
    base.fillOpacity = 0.12;
  }
  if (BOLD_KINDS.has(kind)) base.width = 2;
  return base;
}

export function defaultConfigFor(kind: DrawingKind): ToolConfig {
  return {
    style: defaultStyleFor(kind),
    hidden: false,
    timeframes: [],
    isDefault: true,
  };
}

/** All configs at their defaults, for a fresh install or a reset. */
export function defaultConfigs(kinds: readonly DrawingKind[]): Record<string, ToolConfig> {
  const out: Record<string, ToolConfig> = {};
  for (const k of kinds) out[k] = defaultConfigFor(k);
  return out;
}

/**
 * Merge stored configs over the defaults.
 *
 * New tools appear in the rail after an update, and a stored config from an older version
 * will not have them. Merging rather than replacing means a new tool shows up with its
 * default instead of being invisible until the user resets everything.
 */
export function mergeConfigs(
  stored: unknown,
  kinds: readonly DrawingKind[],
): Record<string, ToolConfig> {
  const out = defaultConfigs(kinds);
  if (typeof stored !== "object" || stored === null) return out;

  for (const kind of kinds) {
    const raw = (stored as Record<string, unknown>)[kind];
    if (typeof raw !== "object" || raw === null) continue;
    const cfg = raw as Partial<ToolConfig>;
    const style = (cfg.style ?? {}) as Partial<ToolStyle>;
    const base = out[kind]!;

    out[kind] = {
      style: {
        color: typeof style.color === "string" && /^#[0-9a-f]{3,8}$/i.test(style.color)
          ? style.color : base.style.color,
        width: clampWidth(style.width, base.style.width),
        style: isLineStyle(style.style) ? style.style : base.style.style,
        opacity: clamp01(style.opacity, base.style.opacity),
        fill: typeof style.fill === "boolean" ? style.fill : base.style.fill,
        fillOpacity: clamp01(style.fillOpacity, base.style.fillOpacity),
      },
      hidden: cfg.hidden === true,
      timeframes: Array.isArray(cfg.timeframes)
        ? cfg.timeframes.filter((t): t is string => typeof t === "string").slice(0, 20)
        : [],
      isDefault: cfg.isDefault !== false,
    };
  }
  return out;
}

function clampWidth(v: unknown, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(4, Math.max(1, Math.round(v)));
}

function clamp01(v: unknown, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(1, Math.max(0, v));
}

function isLineStyle(v: unknown): v is LineStyle {
  return v === "solid" || v === "dashed" || v === "dotted";
}

/**
 * The style to draw a NEW drawing with.
 *
 * An explicit per-drawing value wins. This is the precedence that makes a user's chosen
 * colour stick: reading the tool default here would make every new drawing ignore it.
 */
export function styleFor(
  configs: Record<string, ToolConfig>,
  kind: DrawingKind,
  override?: Partial<ToolStyle>,
): ToolStyle {
  const base = configs[kind]?.style ?? defaultStyleFor(kind);
  if (!override) return { ...base };
  return {
    color: override.color ?? base.color,
    width: override.width ?? base.width,
    style: override.style ?? base.style,
    opacity: override.opacity ?? base.opacity,
    fill: override.fill ?? base.fill,
    fillOpacity: override.fillOpacity ?? base.fillOpacity,
  };
}

/**
 * Should the tool appear in the rail on this timeframe?
 *
 * A hidden tool is hidden everywhere. A tool with no timeframe list shows on all of them.
 */
export function isVisible(
  configs: Record<string, ToolConfig>,
  kind: DrawingKind,
  timeframe: string,
): boolean {
  const cfg = configs[kind];
  if (!cfg) return true;
  if (cfg.hidden) return false;
  if (cfg.timeframes.length === 0) return true;
  return cfg.timeframes.includes(timeframe);
}

/**
 * Update one tool's config, marking it as modified.
 *
 * `style` is a DEEP partial: `Omit` first, so `style?: Partial<ToolStyle>` does not get
 * intersected with `ToolConfig`'s own `style: ToolStyle` and end up requiring every field.
 */
export function setConfig(
  configs: Record<string, ToolConfig>,
  kind: DrawingKind,
  patch: Omit<Partial<ToolConfig>, "style"> & { style?: Partial<ToolStyle> },
): Record<string, ToolConfig> {
  const current = configs[kind] ?? defaultConfigFor(kind);
  return {
    ...configs,
    [kind]: {
      style: { ...current.style, ...(patch.style ?? {}) },
      hidden: patch.hidden ?? current.hidden,
      timeframes: patch.timeframes ?? current.timeframes,
      isDefault: false,
    },
  };
}

/** Reset one tool, or all of them when `kind` is omitted. */
export function resetConfigs(
  configs: Record<string, ToolConfig>,
  kinds: readonly DrawingKind[],
  kind?: DrawingKind,
): Record<string, ToolConfig> {
  if (kind) return { ...configs, [kind]: defaultConfigFor(kind) };
  return defaultConfigs(kinds);
}

/** Tools the user has changed, for a "modified" badge and for export. */
export function modifiedTools(configs: Record<string, ToolConfig>): DrawingKind[] {
  return (Object.keys(configs) as DrawingKind[]).filter((k) => configs[k]?.isDefault === false);
}

/**
 * Serialise for storage.
 *
 * Only modified tools are written. Storing all 95 defaults means a future change to a
 * default never reaches an existing user, because their stored copy wins forever.
 */
export function serialiseConfigs(configs: Record<string, ToolConfig>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [kind, cfg] of Object.entries(configs)) {
    if (cfg.isDefault) continue;
    out[kind] = {
      style: cfg.style,
      hidden: cfg.hidden,
      timeframes: cfg.timeframes,
      isDefault: false,
    };
  }
  return out;
}

/** Canvas dash pattern for a line style at a given width. */
export function dashPattern(style: LineStyle, width: number): number[] {
  if (style === "dashed") return [width * 5, width * 4];
  if (style === "dotted") return [width, width * 3];
  return [];
}

/** A short description for the tool list. */
export function describeStyle(s: ToolStyle): string {
  const parts = [s.color, `${s.width}px`, s.style];
  if (s.opacity < 1) parts.push(`${Math.round(s.opacity * 100)}%`);
  if (s.fill) parts.push(`fill ${Math.round(s.fillOpacity * 100)}%`);
  return parts.join(" · ");
}
