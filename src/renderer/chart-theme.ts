/**
 * One palette for everything drawn on the price chart.
 *
 * Lightweight Charts is configured in JS, the drawing overlay is a 2D canvas and the
 * equity curve is another 2D canvas: three paint paths that used to carry three copies
 * of the same hex values. When they drifted, the overlay's background no longer matched
 * the chart's and drawings appeared to sit on a different surface than the candles.
 * Every paint path now reads from here, so the chart can be re-skinned in one place.
 *
 * The values are the classic dark-terminal palette (no logos or assets, colours only).
 */
export const CHART_THEME = {
  /** chart canvas + app background */
  background: "#131722",
  /** grid lines, both axes */
  grid: "#1e222d",
  /** price/time scale borders */
  axisBorder: "#2a2e39",
  /** axis tick labels, legend text */
  text: "#d1d4dc",
  /** crosshair lines and their labels */
  crosshair: "#787b86",
  /** rising candles */
  up: "#26a69a",
  /** falling candles */
  down: "#ef5350",
  /** tool accents drawn on the chart (selection, previews) */
  accent: "#2962ff",
} as const;

export type ChartTheme = typeof CHART_THEME;

/** The theme object the drawing overlay expects (same values, its shape). */
export function overlayTheme(): {
  background: string; grid: string; text: string;
  crosshair: string; accent: string; up: string; down: string;
} {
  return {
    background: CHART_THEME.background,
    grid: CHART_THEME.grid,
    text: CHART_THEME.text,
    crosshair: CHART_THEME.crosshair,
    accent: CHART_THEME.accent,
    up: CHART_THEME.up,
    down: CHART_THEME.down,
  };
}
