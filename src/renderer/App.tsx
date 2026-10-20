/**
 * Application shell.
 *
 * Layout mirrors a trading terminal: a slim toolbar, the chart in the middle, and
 * a right rail that switches between data, indicators, strategy and journal.
 *
 * Live vs offline is a single switch in the data panel. When offline, nothing in
 * this component can reach the network: the feed is not called, and the renderer
 * CSP forbids connections anyway.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type LineData,
  type Time,
} from "lightweight-charts";
import { generateSampleSeries } from "./sample.js";
import { aggregate, TIMEFRAMES, parseTimeframeLabel } from "../core/aggregate.js";
import { sma, ema, bollinger, rsi } from "../core/indicators.js";
import { adx, cci, vwap, supertrend } from "../core/indicators-ext.js";
import { formatDateTime, formatOffset } from "../core/timezone.js";
import { parseCsv } from "../core/csv.js";
import { seriesFromCandles } from "../core/series.js";
import {
  DrawingHistory, type Drawing, type DrawingKind, type Point,
} from "../core/drawings.js";
import {
  initialState, onPointerDown, onPointerMove, onPointerUp, onCancel,
  type InteractionState, type PointerContext,
} from "../core/drawing-interaction.js";
import { nearestDrawing } from "../core/drawing-interaction.js";
import { DrawingToolbar, TOOL_LABELS } from "./DrawingToolbar.js";
import { DrawingOverlay, toData } from "./overlay.js";
import { DataPanel } from "./panels/DataPanel.js";
import { StrategyPanel } from "./panels/StrategyPanel.js";
import { JournalPanel } from "./panels/JournalPanel.js";
import { createFeed, symbols as LIVE_SYMBOLS } from "./livefeed.js";
import type { Feed, FeedStatus } from "../core/feed.js";
import type { CandleSeries, Timeframe } from "../core/types.js";

type IndicatorKind = "SMA" | "EMA" | "BB" | "RSI" | "ADX" | "CCI" | "VWAP" | "SUPERTREND";
type RailTab = "data" | "indicators" | "strategy" | "journal";

interface IndicatorState {
  id: number;
  kind: IndicatorKind;
  period: number;
  color: string;
}

const SPEEDS = [1, 3, 10, 40] as const;
const INDICATOR_COLORS: Record<IndicatorKind, string> = {
  SMA: "#f0b90b", EMA: "#ff7043", BB: "#42a5f5", RSI: "#ab47bc",
  ADX: "#26c6da", CCI: "#ec407a", VWAP: "#9ccc65", SUPERTREND: "#ffa726",
};

const ACCOUNT = {
  id: 1, name: "Demo", currency: "USD", startingBalance: 10_000,
  leverage: 100, mode: "hedging" as const,
};

export function App(): JSX.Element {
  const chartHost = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const lineRefs = useRef<Map<string, ISeriesApi<"Line">>>(new Map());

  const [base, setBase] = useState<CandleSeries>(() => generateSampleSeries(30_000));
  const [tf, setTf] = useState<Timeframe>(TIMEFRAMES[1]!);
  const [custom, setCustom] = useState("");
  const [zone, setZone] = useState<string>("UTC");
  const [revealed, setRevealed] = useState(2_000);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(10);
  const [indicators, setIndicators] = useState<IndicatorState[]>([
    { id: 1, kind: "SMA", period: 20, color: INDICATOR_COLORS.SMA },
  ]);
  const [status, setStatus] = useState<string>("");
  const [rail, setRail] = useState<RailTab>("data");
  const [offline, setOffline] = useState(true);
  const [symbolId, setSymbolId] = useState("GC=F");
  const [feedStatus, setFeedStatus] = useState<FeedStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [tool, setTool] = useState<DrawingKind | null>(null);

  const feedRef = useRef<Feed | null>(null);
  const drawingsRef = useRef(new DrawingHistory());
  const overlayRef = useRef<DrawingOverlay | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Drawing interaction lives in a ref: pointer handlers fire at pointer rate and
  // re-rendering React on every mouse move would make the chart stutter.
  const interRef = useRef<InteractionState>(initialState());
  const [drawCount, setDrawCount] = useState(0);
  /**
   * Bumped on every drawing mutation so the undo/redo buttons re-render with the
   * right disabled state. A separate counter that only the keyboard path touched
   * left the buttons disabled after mouse drawing, which made undo look broken.
   */
  const [revision, setRevision] = useState(0);
  const [hoverId, setHoverId] = useState<string | null>(null);

  // The chart shows only the revealed bars so replay cannot peek ahead.
  const view = useMemo(() => {
    const n = Math.min(revealed, base.length);
    const slice: CandleSeries = {
      time: base.time.subarray(0, n),
      open: base.open.subarray(0, n),
      high: base.high.subarray(0, n),
      low: base.low.subarray(0, n),
      close: base.close.subarray(0, n),
      volume: base.volume.subarray(0, n),
      length: n,
    };
    return aggregate(slice, tf);
  }, [base, revealed, tf]);

  // ---------------------------------------------------------- chart setup
  useEffect(() => {
    if (!chartHost.current) return;
    const chart = createChart(chartHost.current, {
      layout: {
        background: { color: "#131722" },
        textColor: "#d1d4dc",
        attributionLogo: false,   // spec: no TradingView logos/assets
      },
      grid: {
        vertLines: { color: "#1e222d" },
        horzLines: { color: "#1e222d" },
      },
      crosshair: { mode: 0 },
      rightPriceScale: { borderColor: "#2a2e39" },
      timeScale: { borderColor: "#2a2e39", timeVisible: true, secondsVisible: false },
      autoSize: true,
    });
    chartRef.current = chart;
    candleRef.current = chart.addCandlestickSeries({
      upColor: "#26a69a", downColor: "#ef5350", borderVisible: false,
      wickUpColor: "#26a69a", wickDownColor: "#ef5350",
    });
    // Drawing overlay: a canvas pinned exactly over the chart. Lightweight Charts
    // has no vector layer, so shapes are painted here in screen space while the
    // model stays in data space.
    if (canvasRef.current && candleRef.current) {
      overlayRef.current = new DrawingOverlay(
        canvasRef.current, chart, candleRef.current,
        {
          background: "#131722", grid: "#1e222d", text: "#d1d4dc",
          crosshair: "#787b86", accent: "#f0b90b",
          up: "#26a69a", down: "#ef5350",
        },
      );
    }

    const ro = new ResizeObserver(() => {
      chart.applyOptions({});
      overlayRef.current?.resize();
      overlayRef.current?.invalidate();
    });
    ro.observe(chartHost.current);

    // Repaint drawings whenever the visible range changes (pan, zoom, new bar).
    const onRange = () => overlayRef.current?.invalidate();
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange);

    return () => {
      ro.disconnect();
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange);
      overlayRef.current?.destroy();
      overlayRef.current = null;
      chart.remove();
      chartRef.current = null;
      lineRefs.current.clear();
    };
  }, []);

  // ----------------------------------------------------------- data feed
  useEffect(() => {
    const series = candleRef.current;
    if (!series || view.length === 0) return;
    const data: CandlestickData[] = [];
    for (let i = 0; i < view.length; i++) {
      data.push({
        time: view.time[i]! as Time,
        open: view.open[i]!,
        high: view.high[i]!,
        low: view.low[i]!,
        close: view.close[i]!,
      });
    }
    series.setData(data);
    chartRef.current?.timeScale().fitContent();
  }, [view]);

  // --------------------------------------------------------- indicators
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    for (const [key, s] of lineRefs.current) {
      if (!indicators.some((i) => String(i.id) === key)) {
        chart.removeSeries(s);
        lineRefs.current.delete(key);
      }
    }
    for (const ind of indicators) {
      const key = String(ind.id);
      let s = lineRefs.current.get(key);
      if (!s) {
        s = chart.addLineSeries({ color: ind.color, lineWidth: 2, priceLineVisible: false });
        lineRefs.current.set(key, s);
      } else {
        s.applyOptions({ color: ind.color });
      }
      const line = computeIndicator(ind, view);
      const data: LineData[] = [];
      for (let i = 0; i < view.length; i++) {
        const v = line[i]!;
        if (!Number.isNaN(v)) data.push({ time: view.time[i]! as Time, value: v });
      }
      s.setData(data);
    }
  }, [indicators, view]);

  // ------------------------------------------------------------- replay
  useEffect(() => {
    if (!playing) return;
    const stepMs = Math.max(16, 1000 / speed);
    const id = window.setInterval(() => {
      setRevealed((r) => {
        const next = r + 1;
        if (next >= base.length) {
          setPlaying(false);
          return base.length;
        }
        return next;
      });
    }, stepMs);
    return () => window.clearInterval(id);
  }, [playing, speed, base.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
      if (e.code === "Space") { e.preventDefault(); setPlaying((p) => !p); }
      else if (e.code === "ArrowRight") {
        e.preventDefault();
        setRevealed((r) => Math.min(base.length, r + 1));
      } else if (e.code === "Escape") {
        setTool(null);
        interRef.current = onCancel(interRef.current, drawingsRef.current.get()).state;
        overlayRef.current?.invalidate();
      } else if ((e.ctrlKey || e.metaKey) && e.code === "KeyZ") {
        e.preventDefault();
        if (e.shiftKey) {
          if (drawingsRef.current.canRedo()) applyDrawings(drawingsRef.current.redo(), false);
        } else if (drawingsRef.current.canUndo()) {
          applyDrawings(drawingsRef.current.undo(), false);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [base.length]);

  // ------------------------------------------------------------- loading
  const loadLive = useCallback(async (): Promise<void> => {
    if (offline) {
      setStatus("Offline mode is on — import a CSV or turn it off to fetch.");
      return;
    }
    setLoading(true);
    try {
      if (!feedRef.current) feedRef.current = createFeed();
      const r = await feedRef.current.load({
        symbol: symbolId,
        intervalMinutes: 5,
        from: Math.floor(Date.now() / 1000) - 30 * 86400,
      });
      setFeedStatus(r.status);
      if (r.series.length > 0) {
        // A live fetch replaces the sample so the chart shows real prices.
        setBase(r.series);
        setRevealed(r.series.length);
        setStatus(`${r.status.message} — ${r.series.length.toLocaleString()} bars`);
      } else {
        setStatus(r.status.message);
      }
    } catch (e) {
      setStatus(`Live load failed: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [offline, symbolId]);

  const importCsv = useCallback((text: string, name: string): void => {
    try {
      const parsed = parseCsv(text);
      if (parsed.candles.length === 0) {
        setStatus(`No usable bars in ${name}`);
        return;
      }
      const s = seriesFromCandles(parsed.candles);
      setBase(s);
      setRevealed(Math.min(2_000, s.length));
      setFeedStatus({
        state: "offline", mode: "offline", servedBy: "file", fromCache: true,
        barCount: s.length,
        message: `Imported ${name}`,
        usable: true,
      });
      setStatus(
        `Imported ${parsed.candles.length.toLocaleString()} bars from ${name}` +
        (parsed.detectedMinutes ? ` (${parsed.detectedMinutes}m)` : ""),
      );
    } catch (e) {
      setStatus(`Import failed: ${(e as Error).message}`);
    }
  }, []);

  const applyCustom = useCallback(() => {
    const parsed = parseTimeframeLabel(custom);
    if (!parsed) { setStatus(`Invalid timeframe: ${custom}`); return; }
    setTf(parsed);
    setStatus(`Timeframe set to ${parsed.label}`);
  }, [custom]);

  // ------------------------------------------------- drawing interaction
  /**
   * Convert a browser pointer event into data space.
   *
   * The tolerance is derived from pixels so a 6 px hit area feels the same at any
   * zoom: price units per pixel from the price scale, and seconds per pixel from
   * the time scale, combined into the isotropic `timeWeight` the core expects.
   */
  const pointerCtx = useCallback((e: React.PointerEvent): PointerContext | null => {
    const chart = chartRef.current;
    const series = candleRef.current;
    const canvas = canvasRef.current;
    if (!chart || !series || !canvas) return null;

    const rect = canvas.getBoundingClientRect();
    const p = toData(chart, series, e.clientX - rect.left, e.clientY - rect.top);
    if (!p) return null;

    const pricePerPx = Math.abs(series.coordinateToPrice(1)! - series.coordinateToPrice(0)!) || 0.01;
    const timeScale = chart.timeScale();
    const t0 = timeScale.coordinateToTime(0);
    const t1 = timeScale.coordinateToTime(100);
    const secPerPx = t0 !== null && t1 !== null
      ? Math.abs((t1 as number) - (t0 as number)) / 100
      : 60;

    return {
      point: p,
      tolerance: pricePerPx * 6,
      // price units per second, so a pixel tolerance is isotropic
      timeWeight: pricePerPx / Math.max(1e-9, secPerPx),
      nextId: () => `dr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      style: { color: "#f0b90b", width: 2 },
      rightEdge: view.length > 0 ? view.time[view.length - 1]! + 3600 : p.time,
    };
  }, [view]);

  /**
   * Apply a mutation to the drawing collection.
   *
   * Single funnel so the count, the revision (button state) and the canvas can
   * never disagree. Every earlier bug in this area came from updating some of the
   * three and forgetting another.
   */
  const applyDrawings = useCallback((next: Drawing[] | readonly Drawing[], record: boolean) => {
    // commit() records history; setCurrent() replaces without touching it. Never
    // reset() here: that would wipe the stacks and break repeated undo/redo.
    if (record) drawingsRef.current.commit([...next]);
    else drawingsRef.current.setCurrent([...next]);
    setDrawCount(drawingsRef.current.get().length);
    setRevision((r) => r + 1);
    overlayRef.current?.invalidate();
  }, []);

  const repaint = useCallback(() => {
    const o = overlayRef.current;
    if (!o || view.length === 0) return;
    const rightEdge = view.time[view.length - 1]! + 3600;
    o.queue(
      drawingsRef.current.get(), interRef.current, rightEdge,
      hoverId, null,
    );
    setDrawCount(drawingsRef.current.get().length);
  }, [view, hoverId]);

  const onCanvasDown = useCallback((e: React.PointerEvent) => {
    const chart = chartRef.current;
    if (!chart) return;
    if (tool === null) {
      // select mode: let the chart pan unless we grabbed a drawing
      const c = pointerCtx(e);
      if (!c) return;
      const hit = nearestDrawing(drawingsRef.current.get(), c.point, c.tolerance, c.timeWeight);
      if (!hit) return;
    }
    e.preventDefault();
    const c = pointerCtx(e);
    if (!c) return;
    const r = onPointerDown(interRef.current, drawingsRef.current.get(), c);
    interRef.current = r.state;
    if (r.committed) applyDrawings(r.drawings, true);
    else repaint();
  }, [tool, pointerCtx, repaint, applyDrawings]);

  const onCanvasMove = useCallback((e: React.PointerEvent) => {
    const c = pointerCtx(e);
    if (!c) return;

    if (interRef.current.pressed || interRef.current.tool) {
      const r = onPointerMove(interRef.current, drawingsRef.current.get(), c);
      interRef.current = r.state;
      if (interRef.current.draggingId) {
        // live drag: mutate without recording a history entry per pixel
        applyDrawings(r.drawings, false);
      } else {
        repaint();
      }
      return;
    }

    // hover highlight
    const hit = nearestDrawing(drawingsRef.current.get(), c.point, c.tolerance, c.timeWeight);
    if (hit !== hoverId) {
      setHoverId(hit);
      overlayRef.current?.setHovered(hit);
      repaint();
    }
  }, [pointerCtx, repaint, hoverId]);

  const onCanvasUp = useCallback((e: React.PointerEvent) => {
    const c = pointerCtx(e);
    if (!c) return;
    const r = onPointerUp(interRef.current, drawingsRef.current.get(), c);
    interRef.current = r.state;
    if (r.committed) applyDrawings(r.drawings, true);
    else repaint();
  }, [pointerCtx, repaint, applyDrawings]);

  // Keep the overlay's queued shapes in sync with the model. Every mutation bumps
  // `revision`, so this is the single place that pushes drawings to the canvas.
  useEffect(() => {
    repaint();
  }, [revision, view, hoverId, repaint]);

  const currentTime = view.length > 0 ? view.time[view.length - 1]! : 0;
  const lastBar = view.length > 0
    ? {
        open: view.open[view.length - 1]!, high: view.high[view.length - 1]!,
        low: view.low[view.length - 1]!, close: view.close[view.length - 1]!,
      }
    : null;

  return (
    <div className="app">
      <header className="toolbar">
        <strong className="brand">FX Replay Lab</strong>
        <span className={offline ? "badge off" : "badge on"}>
          {offline ? "OFFLINE" : "LIVE"}
        </span>

        <label>
          TF{" "}
          <select
            value={tf.label}
            onChange={(e) => {
              const found = TIMEFRAMES.find((t) => t.label === e.target.value);
              if (found) setTf(found);
            }}
          >
            {TIMEFRAMES.map((t) => <option key={t.label} value={t.label}>{t.label}</option>)}
          </select>
        </label>

        <label>
          custom{" "}
          <input
            className="w-16" value={custom} placeholder="7"
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") applyCustom(); }}
          />
        </label>

        <label>
          TZ{" "}
          <select value={zone} onChange={(e) => setZone(e.target.value)}>
            {["UTC", "America/New_York", "Europe/London", "Europe/Berlin",
              "Asia/Tehran", "Asia/Dubai", "Asia/Tokyo", "Australia/Sydney"].map((z) => (
              <option key={z} value={z}>{z}</option>
            ))}
          </select>
        </label>

        <button onClick={() => setPlaying((p) => !p)}>{playing ? "⏸ Pause" : "▶ Play"}</button>
        <button onClick={() => setRevealed((r) => Math.min(base.length, r + 1))}>⏭ Step</button>

        <label>
          speed{" "}
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
            {SPEEDS.map((s) => <option key={s} value={s}>{s}x</option>)}
          </select>
        </label>

        <div className="grow" />

        {/* A readout, not a control: the tool is chosen in the rail. Showing the
            active tool name here removes any doubt about what a click will draw. */}
        {tool && <span className="active-tool">{TOOL_LABELS[tool] ?? tool}</span>}
      </header>

      <DrawingToolbar
        active={tool}
        onSelect={(k) => {
          setTool(k);
          interRef.current = { ...initialState(), tool: k };
        }}
        onDelete={() => {
          if (drawingsRef.current.get().length === 0) return;
          applyDrawings([], true);
        }}
        onUndo={() => {
          if (!drawingsRef.current.canUndo()) return;
          applyDrawings(drawingsRef.current.undo(), false);
        }}
        onRedo={() => {
          if (!drawingsRef.current.canRedo()) return;
          applyDrawings(drawingsRef.current.redo(), false);
        }}
        canUndo={revision >= 0 && drawingsRef.current.canUndo()}
        canRedo={revision >= 0 && drawingsRef.current.canRedo()}
        count={drawCount}
      />

      <div className="chart-area">
        <div ref={chartHost} className="chart-host" />
        <canvas
          ref={canvasRef}
          className="draw-canvas"
          onPointerDown={onCanvasDown}
          onPointerMove={onCanvasMove}
          onPointerUp={onCanvasUp}
          onPointerLeave={onCanvasUp}
        />
        <div className="legend">
          <span className="sym">{offline ? "XAUUSD (sample)" : symbolId}</span>
          <span className="sep">·</span>
          <span>{tf.label}</span>
          <span className="sep">·</span>
          <span className={lastBar && lastBar.close >= lastBar.open ? "up" : "down"}>
            {lastBar
              ? `O ${lastBar.open.toFixed(2)}  H ${lastBar.high.toFixed(2)}  ` +
                `L ${lastBar.low.toFixed(2)}  C ${lastBar.close.toFixed(2)}`
              : ""}
          </span>
        </div>
        {loading && <div className="loading">loading…</div>}
      </div>

      <aside className="panel">
        <nav className="rail-tabs">
          {(["data", "indicators", "strategy", "journal"] as RailTab[]).map((t) => (
            <button
              key={t}
              className={rail === t ? "rail-tab active" : "rail-tab"}
              onClick={() => setRail(t)}
            >
              {t}
            </button>
          ))}
        </nav>

        {rail === "data" && (
          <>
            <DataPanel
              status={feedStatus}
              offline={offline}
              symbol={symbolId}
              symbols={LIVE_SYMBOLS.map((s) => ({ id: s.id, label: s.label }))}
              onToggleOffline={setOffline}
              onSymbol={setSymbolId}
              onReload={() => void loadLive()}
              onImport={importCsv}
            />
            <h3>Replay</h3>
            <div className="kv"><span>base bars</span><b>{base.length.toLocaleString()}</b></div>
            <div className="kv"><span>revealed</span><b>{revealed.toLocaleString()}</b></div>
            <div className="kv"><span>view TF</span><b>{tf.label}</b></div>
            <div className="kv"><span>offset</span><b>{formatOffset(currentTime, zone)}</b></div>
            <div className="kv"><span>time</span><b>{currentTime ? formatDateTime(currentTime, zone) : "—"}</b></div>
            <input
              className="slider" type="range" min={10} max={base.length}
              value={revealed} onChange={(e) => setRevealed(Number(e.target.value))}
            />
          </>
        )}

        {rail === "indicators" && (
          <>
            <h3>Indicators</h3>
            <select
              value=""
              onChange={(e) => {
                const kind = e.target.value as IndicatorKind;
                if (!kind) return;
                const period = kind === "RSI" ? 14 : kind === "CCI" ? 20 : kind === "ADX" ? 14 : 20;
                setIndicators((l) => [...l, {
                  id: Date.now(), kind, period, color: INDICATOR_COLORS[kind],
                }]);
              }}
            >
              <option value="">add indicator…</option>
              {(["SMA", "EMA", "BB", "RSI", "ADX", "CCI", "VWAP", "SUPERTREND"] as IndicatorKind[])
                .map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
            <ul className="ind-list">
              {indicators.map((ind) => (
                <li key={ind.id}>
                  <span className="dot" style={{ background: ind.color }} />
                  {ind.kind}({ind.period})
                  <button
                    className="mini"
                    onClick={() => setIndicators((l) => l.filter((x) => x.id !== ind.id))}
                  >✕</button>
                </li>
              ))}
            </ul>
          </>
        )}

        {rail === "strategy" && (
          <StrategyPanel series={view} account={ACCOUNT} symbolId="XAUUSD" />
        )}

        {rail === "journal" && <JournalPanel />}

        {status && <p className="status">{status}</p>}

        <footer className="credit">Charting by Lightweight Charts (Apache-2.0)</footer>
      </aside>
    </div>
  );
}

/** Compute one indicator line for the current view. */
function computeIndicator(ind: IndicatorState, view: CandleSeries): Float64Array {
  switch (ind.kind) {
    case "SMA": return sma(view.close, ind.period);
    case "EMA": return ema(view.close, ind.period);
    case "RSI": return rsi(view, ind.period);
    case "BB": return bollinger(view, ind.period, 2).middle;
    case "ADX": return adx(view, ind.period).adx;
    case "CCI": return cci(view, ind.period);
    case "VWAP": return vwap(view);
    case "SUPERTREND": return supertrend(view, ind.period, 3).line;
  }
}
