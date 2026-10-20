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
import {
  parseDrawings, serialiseDrawings, workspaceKey,
} from "../core/persist.js";
import { TradingSession } from "./trading.js";
import {
  positionLines, hitHandle, type PriceLine,
} from "../core/position-manage.js";
import { TradePanel } from "./panels/TradePanel.js";
import { NewsPanel } from "./panels/NewsPanel.js";
import { SessionsPanel } from "./panels/SessionsPanel.js";
import { newsMarkers, type CalendarEvent } from "../core/news.js";
import { useI18n } from "./i18n-context.js";
import { LOCALES } from "../core/i18n.js";
import {
  sessionSpans, sessionLabel, sessionOpenFor, sessionDef, type SessionName,
} from "../core/sessions.js";
import { DataPanel } from "./panels/DataPanel.js";
import { StrategyPanel } from "./panels/StrategyPanel.js";
import { JournalPanel } from "./panels/JournalPanel.js";
import { createFeed, symbols as LIVE_SYMBOLS } from "./livefeed.js";
import type { Feed, FeedStatus } from "../core/feed.js";
import type { CandleSeries, Timeframe } from "../core/types.js";

type IndicatorKind = "SMA" | "EMA" | "BB" | "RSI" | "ADX" | "CCI" | "VWAP" | "SUPERTREND";
type RailTab =
  | "data" | "trade" | "news" | "sessions" | "indicators" | "strategy" | "journal";

const SESSION_LABELS: Record<SessionName, string> = {
  sydney: sessionLabel("sydney"),
  tokyo: sessionLabel("tokyo"),
  london: sessionLabel("london"),
  newyork: sessionLabel("newyork"),
};

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
  const { lang, setLang, t } = useI18n();

  /** Journal entries mirrored for the session breakdown. */
  const [journalEntries, setJournalEntries] = useState<Array<{
    entryTime: number; pnl: number; symbol: string;
  }>>([]);

  /** Session shading: off by default, because not every trader wants four washes. */
  const [showSessions, setShowSessions] = useState(false);
  const [activeSessions, setActiveSessions] = useState<
    Array<"sydney" | "tokyo" | "london" | "newyork">
  >(["london", "newyork"]);

  /**
   * Time of the newest revealed bar, in epoch seconds.
   *
   * The news blackout must be evaluated against the REPLAY clock, not wall time: during
   * a replay of 2024 a 2024 calendar would never block anything if compared to today,
   * and a current calendar would block the wrong bars.
   */
  const replayTime = useMemo(() => {
    if (base.length === 0) return 0;
    const i = Math.min(revealed, base.length) - 1;
    return i >= 0 ? (base.time[i] ?? 0) : 0;
  }, [base, revealed]);

  /** Imported economic calendar, mirrored into chart markers. */
  const [calendar, setCalendar] = useState<CalendarEvent[]>([]);
  /** News blackout state, so the trade panel can refuse orders. */
  const [blackout, setBlackout] = useState<{ blocked: boolean; reason?: string }>({
    blocked: false,
  });
  const [offline, setOffline] = useState(true);
  const [symbolId, setSymbolId] = useState("GC=F");

  /**
   * Trading session, rebuilt when the symbol changes.
   *
   * The engine is constructed with the symbol's spec (contract size, spread, lot
   * step), so reusing one across a symbol switch would price gold with EURUSD's
   * contract size. Rebuilding discards open positions, which is correct: they belong
   * to the old instrument.
   */
  const [session, setSession] = useState(() => new TradingSession("XAUUSD"));
  useEffect(() => {
    setSession(new TradingSession(symbolId.startsWith("GC=F") ? "XAUUSD" : symbolId));
  }, [symbolId]);
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

  /**
   * Test-only hook, enabled with `?test=1` in the URL.
   *
   * The smoke scripts need to drive the engine directly to assert that a drag reaches
   * it; the DOM alone cannot prove that. Guarded by an explicit query flag so it is
   * absent in normal runs, and it exposes nothing that is not already on screen.
   */
  useEffect(() => {
    if (!window.location.search.includes("test=1")) return;
    (window as unknown as { __fxlab?: unknown }).__fxlab = {
      session,
      // calendar helpers so a smoke test can assert the blackout reaches the engine
      setBlackout: (b: { blocked: boolean; reason?: string } | null) =>
        session.setBlackout(b),
      chart: () => chartRef.current,
      state: () => ({
        positions: session.snapshot().positions.map((p) => ({
          id: p.id, side: p.side, lots: p.lots,
          entryPrice: p.entryPrice, sl: p.sl, tp: p.tp, commission: p.commission,
        })),
        pendingOrders: session.snapshot().pendingOrders.length,
      }),
      setLevel: (id: number, kind: "sl" | "tp", price: number) =>
        session.setLevel(id, kind, price),
      setBreakEven: (r: number) => session.setBreakEvenTrigger(r),
      setJournalEntries: (rows: unknown[]) =>
        (window as unknown as { __fxlabSetJournal?: (r: unknown[]) => void })
          .__fxlabSetJournal?.(rows),
      sessionOpenSample: () => {
        // Sample the London open in January and July so a smoke test can prove the band
        // follows DST without importing the module by path.
        const jan = sessionOpenFor(Date.UTC(2024, 0, 15, 12) / 1000, sessionDef("london"));
        const jul = sessionOpenFor(Date.UTC(2024, 6, 15, 12) / 1000, sessionDef("london"));
        return {
          january: new Date(jan * 1000).toISOString(),
          july: new Date(jul * 1000).toISOString(),
          shiftedByOneHour: jan % 86_400 !== jul % 86_400,
        };
      },
      setTrailing: (m: "off" | "distance" | "extreme" | "atr", v: number) =>
        session.setTrailing(m, v),
      closePartial: (id: number, lots: number) => session.closePartial(id, lots),
      priceToY: (price: number) => {
        const c = chartRef.current;
        const s = candleRef.current;
        if (!c || !s) return null;
        return s.priceToCoordinate(price);
      },
    };
  }, [session]);

  /**
   * Repaint whenever the account changes: a fill, a close, a moved stop.
   *
   * Without this the position lines would only refresh on a chart interaction, so a
   * trailing stop would appear frozen at its old price while the engine had moved it.
   */
  const repaint = useCallback(() => {
    const o = overlayRef.current;
    if (!o || view.length === 0) return;
    const rightEdge = view.time[view.length - 1]! + 3600;
    o.queue(
      drawingsRef.current.get(), interRef.current, rightEdge,
      hoverId, null,
      // live account levels: rebuilt every frame from the engine, never persisted
      session.snapshot().positions.flatMap(positionLines),
      // session washes, only when enabled
      showSessions
        ? sessionSpans(view.time[0]!, view.time[view.length - 1]!, {
            only: activeSessions,
          }).map((s) => ({
            from: s.from,
            to: s.to,
            colour: s.colour,
            label: SESSION_LABELS[s.name],
          }))
        : [],
    );
    setDrawCount(drawingsRef.current.get().length);
  }, [view, hoverId, session, showSessions, activeSessions]);

  useEffect(() => {
    // Must re-QUEUE, not just invalidate: invalidate() repaints the LAST QUEUED shapes,
    // which know nothing about a position that just opened. That is exactly why the
    // SL/TP lines were invisible after a fill until the next chart interaction.
    const off = session.subscribe(() => repaint());
    return off;
  }, [session, repaint]);

  // Push the news state into the session so open()/placeOrder() can refuse. A disabled
  // button is a hint; this is the rule.
  useEffect(() => {
    session.setBlackout(blackout);
  }, [blackout, session]);

  /**
   * News markers on the price series.
   *
   * lightweight-charts 4.x keeps markers on the series, and setMarkers() replaces the
   * whole list — appending is not offered, so the full visible window is mapped each
   * time. Only that window: a marker per event across 30k bars builds tens of thousands
   * of shapes for no benefit.
   */
  useEffect(() => {
    const series = candleRef.current;
    if (!series || view.length === 0) return;
    const from = view.time[0]!;
    const to = view.time[view.length - 1]!;
    const markers = newsMarkers(calendar, from, to, { maxPerBar: 1 });

    series.setMarkers(markers.map((m) => ({
      time: m.time as Time,
      position: m.position,
      color: m.color,
      shape: m.shape,
      text: m.text,
    })));
  }, [calendar, view]);

  /** Handle being dragged: which position and which leg. */
  const dragHandle = useRef<{ positionId: number; kind: "sl" | "tp" } | null>(null);

  /**
   * Grab a position handle if the pointer is on one.
   *
   * Checked before the drawing interaction so an SL line sitting on top of a trendline
   * does not steal the drag. Returns true when the event was consumed.
   */
  const tryGrabHandle = useCallback((e: React.PointerEvent): boolean => {
    const c = pointerCtx(e);
    if (!c) return false;
    const positions = session.snapshot().positions;
    if (positions.length === 0) return false;

    const lines = positions.flatMap(positionLines);
    const hit = hitHandle(lines, c.point.price, c.tolerance * 2);
    if (!hit) return false;

    dragHandle.current = { positionId: hit.positionId, kind: hit.kind as "sl" | "tp" };
    e.preventDefault();
    return true;
  }, [pointerCtx, session]);

  const onCanvasDown = useCallback((e: React.PointerEvent) => {
    const chart = chartRef.current;
    if (!chart) return;
    if (tryGrabHandle(e)) return;
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
  }, [tool, pointerCtx, repaint, applyDrawings, tryGrabHandle]);

  /** Reason a dragged level was refused, shown in the status line. */
  const [dragMessage, setDragMessage] = useState("");

  const onCanvasMove = useCallback((e: React.PointerEvent) => {
    const c = pointerCtx(e);
    if (!c) return;

    // a position handle is being dragged: constrain, apply, repaint
    if (dragHandle.current) {
      const { positionId, kind } = dragHandle.current;
      const r = session.setLevel(positionId, kind, c.point.price);
      if (!r.ok && r.message) setDragMessage(r.message);
      else setDragMessage("");
      return;
    }

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
    // releasing a dragged position handle takes priority over the drawing machine
    if (dragHandle.current) {
      dragHandle.current = null;
      setDragMessage("");
      return;
    }
    const c = pointerCtx(e);
    if (!c) return;
    const r = onPointerUp(interRef.current, drawingsRef.current.get(), c);
    interRef.current = r.state;
    if (r.committed) applyDrawings(r.drawings, true);
    else repaint();
  }, [pointerCtx, repaint, applyDrawings]);

  /**
   * Price of the newest revealed bar, used by the trade panel.
   *
   * Taken from the BASE series rather than the aggregated view: the engine checks
   * stops against the bar the user is actually watching, which during replay is the
   * forming higher-timeframe candle.
   */
  const currentPrice = useMemo(() => {
    if (base.length === 0) return 0;
    const i = Math.min(revealed, base.length) - 1;
    return i >= 0 ? base.close[i]! : 0;
  }, [base, revealed]);

  /**
   * Advance the trading engine on every newly revealed bar.
   *
   * Without this, a stop placed during replay would never trigger — the engine only
   * checks SL/TP inside onBar(), and nothing was calling it. Each call can file
   * journal entries, which the session buffers.
   */
  const lastBarRef = useRef<number>(-1);
  useEffect(() => {
    if (base.length === 0 || revealed <= 0) return;
    const i = Math.min(revealed, base.length) - 1;
    if (i === lastBarRef.current) return;
    lastBarRef.current = i;
    const bar = {
      time: base.time[i]!,
      open: base.open[i]!,
      high: base.high[i]!,
      low: base.low[i]!,
      close: base.close[i]!,
      volume: base.volume[i]!,
    };
    session.onBar(bar, i);
  }, [base, revealed, session]);

  /**
   * ATR series for ATR trailing, computed once per loaded series.
   *
   * Only the revealed prefix matters, but the whole array is computed because the
   * replay can reveal more bars later without reloading: recomputing on every step
   * would cost a full pass over 30k bars per bar advanced.
   */
  useEffect(() => {
    if (base.length === 0) return;
    // The WHOLE series: the session indexes ATR by the absolute bar index, which runs
    // to the end of the replay. A truncated array would silently return ATR 0 past the
    // cut, turning trailing off mid-session.
    session.setAtrSeries(
      Array.from(base.high),
      Array.from(base.low),
      Array.from(base.close),
    );
  }, [base, session]);

  // Keep the overlay's queued shapes in sync with the model. Every mutation bumps
  // `revision`, so this is the single place that pushes drawings to the canvas.
  useEffect(() => {
    repaint();
  }, [revision, view, hoverId, repaint]);

  // ------------------------------------------------ persistence: drawings
  const workspace = workspaceKey(symbolId, tf.label);
  /**
   * True while a load is settling. Without it the save effect fires immediately
   * after hydration and writes the EMPTY pre-load collection back over the stored
   * drawings — the classic "my drawings disappeared" bug.
   */
  const loadingRef = useRef(false);

  useEffect(() => {
    const api = (globalThis as unknown as { fxlab?: { loadDrawings?: (w: string) => Promise<{
      raw: string | null; updatedAt: number | null;
    }> } }).fxlab;
    if (!api?.loadDrawings) return;

    let cancelled = false;
    loadingRef.current = true;
    void api.loadDrawings(workspace).then((res) => {
      if (cancelled) return;

      // The single decode point. The main process deliberately hands over the raw
      // JSON so the wire form is parsed exactly once — parsing a decoded Drawing[]
      // again rejects every shape, because the wire keys are {t,p}, not
      // {time,price}.
      let parsed: { value: Drawing[]; rejected: string[] } = { value: [], rejected: [] };
      if (res.raw !== null) {
        try {
          parsed = parseDrawings(JSON.parse(res.raw));
        } catch (e) {
          parsed = { value: [], rejected: [`stored JSON is corrupt: ${(e as Error).message}`] };
        }
      }

      drawingsRef.current.reset(parsed.value);
      setDrawCount(parsed.value.length);
      setRevision((r) => r + 1);
      loadingRef.current = false;
      if (parsed.rejected.length > 0) {
        setStatus(
          `Loaded ${parsed.value.length} drawings; dropped ${parsed.rejected.length} damaged`,
        );
      }
    }).catch((e: Error) => {
      loadingRef.current = false;
      setStatus(`Could not load drawings: ${e.message}`);
    });

    return () => { cancelled = true; };
  }, [workspace]);

  /** Debounced autosave: a drag would otherwise write on every pointer move. */
  const saveTimer = useRef<number | null>(null);
  useEffect(() => {
    if (loadingRef.current) return;
    const api = (globalThis as unknown as { fxlab?: {
      saveDrawings?: (w: string, d: unknown[]) => Promise<{ ok: boolean }>;
    } }).fxlab;
    if (!api?.saveDrawings) return;

    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      const payload = serialiseDrawings(drawingsRef.current.get());
      void api.saveDrawings!(workspace, payload.drawings as unknown[]);
    }, 600);

    return () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    };
  }, [revision, workspace]);

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
        <strong className="brand">{t("app.name")}</strong>
        <span className={offline ? "badge off" : "badge on"}>
          {offline ? t("app.offline") : t("app.live")}
        </span>

        <label>
          {t("app.tf")}{" "}
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
          {t("app.custom")}{" "}
          <input
            className="w-16" value={custom} placeholder="7"
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") applyCustom(); }}
          />
        </label>

        <label>
          {t("app.tz")}{" "}
          <select value={zone} onChange={(e) => setZone(e.target.value)}>
            {["UTC", "America/New_York", "Europe/London", "Europe/Berlin",
              "Asia/Tehran", "Asia/Dubai", "Asia/Tokyo", "Australia/Sydney"].map((z) => (
              <option key={z} value={z}>{z}</option>
            ))}
          </select>
        </label>

        <button onClick={() => setPlaying((p) => !p)}>
          {playing ? t("app.pause") : t("app.play")}
        </button>
        <button onClick={() => setRevealed((r) => Math.min(base.length, r + 1))}>
          {t("app.step")}
        </button>

        <label>
          {t("app.language")}{" "}
          <select value={lang} onChange={(e) => setLang(e.target.value as typeof lang)}>
            {LOCALES.map((l) => (
              <option key={l.lang} value={l.lang}>{l.label}</option>
            ))}
          </select>
        </label>

        <label>
          {t("app.speed")}{" "}
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
          {(["data", "trade", "news", "sessions", "indicators", "strategy", "journal"] as RailTab[]).map((tabId) => (
            <button
              key={tabId}
              data-tab={tabId}
              className={rail === tabId ? "rail-tab active" : "rail-tab"}
              onClick={() => setRail(tabId)}
            >
              {t(`tab.${tabId}`)}
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

        {rail === "trade" && (
          <TradePanel
            session={session}
            blackout={blackout}
            price={currentPrice}
            contractSize={session.specRef.contractSize}
            lotStep={session.specRef.lotStep}
            minLot={session.specRef.lotMin}
            maxLot={session.specRef.lotMax}
          />
        )}

        {rail === "news" && (
          <NewsPanel
            currency={session.symbol.startsWith("XAU") ? "USD" : session.symbol.slice(0, 3)}
            now={replayTime}
            onEvents={setCalendar}
            onBlackout={setBlackout}
          />
        )}

        {rail === "sessions" && (
          <SessionsPanel
            show={showSessions}
            onShow={setShowSessions}
            active={activeSessions}
            onActive={setActiveSessions}
            trades={journalEntries}
          />
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

        {rail === "journal" && (
          <JournalPanel
            session={session}
            onEntries={(list) => setJournalEntries([...list])}
          />
        )}

        {dragMessage && <p className="status status-warn">{dragMessage}</p>}
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
