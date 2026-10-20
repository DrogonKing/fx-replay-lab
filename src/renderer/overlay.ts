/**
 * Canvas overlay renderer for drawings.
 *
 * Lightweight Charts does not expose a vector layer, so drawings are painted onto
 * a <canvas> positioned exactly over the chart. The coordinate conversion is the
 * only place that knows about the chart's scales; everything below it works in
 * data space, which is what keeps the drawing model testable.
 *
 * Performance: the overlay redraws on a requestAnimationFrame tick when either the
 * visible range or the price scale moves, and skips the frame when neither has
 * changed. Without that, panning drops frames on a long series.
 */
import type { IChartApi, ISeriesApi, Time } from "lightweight-charts";
import type { Drawing, Point } from "../core/drawings.js";
import type { RenderShape } from "../core/drawing-interaction.js";
import { renderDrawing, renderPreview, type InteractionState } from "../core/drawing-interaction.js";

export interface OverlayTheme {
  background: string;
  grid: string;
  text: string;
  crosshair: string;
  accent: string;
  up: string;
  down: string;
}

export interface OverlayCallbacks {
  /** called when the pointer moves in data space, for the coordinate readout */
  onHover?: (p: Point | null) => void;
  /** called when the user finishes creating a shape */
  onCommit?: () => void;
}

/**
 * Convert a data-space point to canvas pixels.
 *
 * Charts with a gaps-free time scale are fine via timeToCoordinate, but it returns
 * null for times outside the loaded range, so the caller must handle that rather
 * than silently drawing at 0.
 */
export function toPixel(
  chart: IChartApi,
  series: ISeriesApi<"Candlestick">,
  p: Point,
): { x: number; y: number } | null {
  const x = chart.timeScale().timeToCoordinate(p.time as Time);
  const y = series.priceToCoordinate(p.price);
  if (x === null || y === null) return null;
  return { x, y };
}

/** Convert pixels back to data space. */
export function toData(
  chart: IChartApi,
  series: ISeriesApi<"Candlestick">,
  x: number,
  y: number,
): Point | null {
  const time = chart.timeScale().coordinateToTime(x);
  const price = series.coordinateToPrice(y);
  if (time === null || price === null) return null;
  return { time: time as number, price };
}

export class DrawingOverlay {
  private ctx: CanvasRenderingContext2D | null = null;
  private raf = 0;
  private lastKey = "";
  private hoveredId: string | null = null;
  private selectedId: string | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private chart: IChartApi,
    private series: ISeriesApi<"Candlestick">,
    private theme: OverlayTheme,
    private callbacks: OverlayCallbacks = {},
  ) {
    this.ctx = canvas.getContext("2d");
    this.resize();
  }

  setTheme(theme: OverlayTheme): void {
    this.theme = theme;
    this.invalidate();
  }

  setHovered(id: string | null): void {
    if (this.hoveredId !== id) {
      this.hoveredId = id;
      this.invalidate();
    }
  }

  setSelected(id: string | null): void {
    if (this.selectedId !== id) {
      this.selectedId = id;
      this.invalidate();
    }
  }

  /**
   * Match the canvas backing store to its CSS size, respecting devicePixelRatio.
   *
   * getBoundingClientRect is used (the CSS box) rather than the width/height
   * attributes, because writing those attributes is what RESIZES the element when
   * CSS does not constrain it — reading them back would make the canvas shrink to
   * whatever it was last set to.
   */
  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    if (this.ctx) {
      // setTransform (not scale) so repeated resizes cannot compound
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    this.invalidate();
  }

  /** Schedule one repaint on the next frame, collapsing duplicate requests. */
  invalidate(): void {
    if (this.raf !== 0) return;
    this.raf = window.requestAnimationFrame(() => {
      this.raf = 0;
      this.paintNow();
    });
  }

  destroy(): void {
    if (this.raf !== 0) window.cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /**
   * Paint the current drawings.
   *
   * `cacheKey` short-circuits identical frames: dragging the price scale fires
   * dozens of events per second and re-stroking every level each time is the
   * difference between smooth and janky.
   */
  paint(drawings: readonly Drawing[], state: InteractionState, cacheKey?: string): void {
    if (cacheKey !== undefined) {
      if (cacheKey === this.lastKey) return;
      this.lastKey = cacheKey;
    }
    this.invalidate();
    void drawings;
    void state;
  }

  private paintNow(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const rect = this.canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);

    const shapes = this.pendingShapes;
    if (!shapes) return;

    for (const shape of shapes.drawings) {
      this.paintShape(shape, shape.id === this.hoveredId, shape.id === this.selectedId);
    }
    if (shapes.preview) {
      ctx.save();
      ctx.setLineDash([5, 4]);
      this.paintShape(shapes.preview, false, false);
      ctx.restore();
    }
  }

  /**
   * Shapes queued for the next paint.
   *
   * Kept as a field rather than a parameter so paint() can be cheap: the caller
   * hands over data, the frame does the (relatively expensive) stroking.
   */
  private pendingShapes: {
    drawings: RenderShape[];
    preview: RenderShape | null;
  } | null = null;

  /**
   * Queue drawings for painting.
   *
   * `rightEdge` is the time of the last visible bar, so rays/channels extend to
   * the edge of what the user can see instead of stopping at their second point.
   */
  queue(
    drawings: readonly Drawing[],
    state: InteractionState,
    rightEdge: number,
    hoveredId: string | null,
    selectedId: string | null,
  ): void {
    this.hoveredId = hoveredId;
    this.selectedId = selectedId;
    this.pendingShapes = {
      drawings: drawings.map((d) => renderDrawing(d, rightEdge)),
      preview: renderPreview(state, { color: this.theme.accent, width: 2 }, rightEdge),
    };
    this.invalidate();
  }

  private paintShape(shape: RenderShape, hovered: boolean, selected: boolean): void {
    const ctx = this.ctx;
    if (!ctx) return;

    const colour = selected ? this.theme.accent : hovered ? "#ffffff" : shape.color;
    ctx.strokeStyle = colour;
    ctx.lineWidth = selected || hovered ? shape.width + 1 : shape.width;
    ctx.lineCap = "round";

    // filled areas first so the outline sits on top
    if (shape.fill) {
      const t = toPixel(this.chart, this.series, shape.fill.top[0]);
      const tb = toPixel(this.chart, this.series, shape.fill.bottom[1]);
      if (t && tb) {
        ctx.save();
        ctx.globalAlpha = 0.12;
        ctx.fillStyle = colour;
        const w = Math.abs(tb.x - t.x);
        const h = Math.abs(tb.y - t.y);
        ctx.fillRect(Math.min(t.x, tb.x), Math.min(t.y, tb.y), w, h);
        ctx.restore();
      }
    }

    for (const line of shape.lines) {
      const a = toPixel(this.chart, this.series, line.from);
      const b = toPixel(this.chart, this.series, line.to);
      // A vertical line has one endpoint off-scale by design; clamp x and keep it.
      if (!a && !b) continue;
      const a2 = a ?? { x: b!.x, y: 0 };
      const b2 = b ?? { x: a!.x, y: this.canvas.getBoundingClientRect().height };
      ctx.save();
      ctx.setLineDash(line.dashed ? [4, 4] : []);
      ctx.beginPath();
      ctx.moveTo(a2.x, a2.y);
      ctx.lineTo(b2.x, b2.y);
      ctx.stroke();
      ctx.restore();
    }

    if (shape.circle) {
      const c = toPixel(this.chart, this.series, shape.circle.center);
      const edgeT = toPixel(this.chart, this.series, {
        time: shape.circle.center.time + shape.circle.radiusTime,
        price: shape.circle.center.price,
      });
      const edgeP = toPixel(this.chart, this.series, {
        time: shape.circle.center.time,
        price: shape.circle.center.price + shape.circle.radiusPrice,
      });
      if (c && edgeT && edgeP) {
        const rx = Math.abs(edgeT.x - c.x);
        const ry = Math.abs(edgeP.y - c.y);
        ctx.beginPath();
        ctx.ellipse(c.x, c.y, Math.max(1, rx), Math.max(1, ry), 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // labels last so they read over the geometry
    ctx.font = "11px ui-monospace, Menlo, monospace";
    ctx.textBaseline = "middle";
    for (const label of shape.labels) {
      const p = toPixel(this.chart, this.series, label.at);
      if (!p) continue;
      const metrics = ctx.measureText(label.text);
      const pad = 3;
      ctx.save();
      ctx.fillStyle = this.theme.background;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(p.x + 4, p.y - 8, metrics.width + pad * 2, 16);
      ctx.globalAlpha = 1;
      ctx.fillStyle = colour;
      ctx.fillText(label.text, p.x + 4 + pad, p.y);
      ctx.restore();
    }
  }
}

export { renderDrawing, renderPreview };
