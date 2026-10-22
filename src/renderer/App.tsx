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
  canAggregate, detectTimeframe, explainUnavailable,
} from "../core/resolution.js";
import {
  DrawingHistory, type Drawing, type DrawingKind,
} from "../core/drawings.js";
import {
  initialState, onPointerDown, onPointerMove, onPointerUp, onCancel,
  type InteractionState, type PointerContext,
} from "../core/drawing-interaction.js";
import { nearestDrawing } from "../core/drawing-interaction.js";
import { DrawingToolbar, TOOL_LABELS, ALL_KINDS } from "./DrawingToolbar.js";
import { ToolSettings } from "./panels/ToolSettings.js";
import { StartScreen, type StartChoice } from "./panels/StartScreen.js";
import {
  TimeframeMenu, SymbolMenu, loadTfFavourites, saveTfFavourites,
} from "./TimeframeMenu.js";
import {
  mergeSeries, newBarIndices, availability, effectiveFrom, describeMode,
  parseModeState, type SessionMode, type ModeState,
} from "../core/session-mode.js";
import {
  defaultConfigs, mergeConfigs, serialiseConfigs, styleFor,
  type ToolConfig,
} from "../core/tool-config.js";
import { DrawingOverlay, toData } from "./overlay.js";
import {
  parseDrawings, serialiseDrawings, workspaceKey,
} from "../core/persist.js";
import { TradingSession } from "./trading.js";
import {
  positionLines, hitHandle,
} from "../core/position-manage.js";
import { TradePanel } from "./panels/TradePanel.js";
import { NewsPanel } from "./panels/NewsPanel.js";
import { SessionsPanel } from "./panels/SessionsPanel.js";
import { EquityPanel } from "./panels/EquityPanel.js";
import { SymbolsPanel } from "./panels/SymbolsPanel.js";
import { newsMarkers, type CalendarEvent } from "../core/news.js";
import { useI18n } from "./i18n-context.js";
import { LOCALES } from "../core/i18n.js";
import {
  sessionSpans, sessionLabel, sessionOpenFor, sessionDef, type SessionName,
} from "../core/sessions.js";
import {
  parseSessionState, worthRestoring, describeSession,
} from "../core/session-state.js";
import { DataPanel } from "./panels/DataPanel.js";
import { StrategyPanel } from "./panels/StrategyPanel.js";
import { JournalPanel } from "./panels/JournalPanel.js";
import { DownloaderPanel } from "./panels/DownloaderPanel.js";
import { BrokerPanel } from "./panels/BrokerPanel.js";
import { TimezonePicker } from "./panels/TimezonePicker.js";
import { createFeed, symbols as LIVE_SYMBOLS } from "./livefeed.js";
import { findSymbol } from "../core/symbol.js";
import type { Feed, FeedStatus } from "../core/feed.js";
import type { Candle, CandleSeries, Timeframe } from "../core/types.js";
import { auditCandles, describeSpacing, parseText } from "../core/importer.js";

type IndicatorKind = "SMA" | "EMA" | "BB" | "RSI" | "ADX" | "CCI" | "VWAP" | "SUPERTREND";
type RailTab =
  | "data" | "download" | "broker" | "trade" | "news" | "sessions" | "equity"
  | "indicators" | "strategy" | "journal" | "symbols";

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
/**
 * Build the price series for a chart type.
 *
 * lightweight-charts fixes a series' type at creation, so switching candles <-> line means
 * a new series. Kept as one function so the colours cannot drift between the branches, and
 * so the call site never has to know which options each type accepts.
 */
function makePriceSeries(
  chart: IChartApi,
  kind: "candles" | "bars" | "line" | "area",
): ISeriesApi<"Candlestick"> {
  if (kind === "bars") {
    return chart.addBarSeries({
      upColor: "#22c58b", downColor: "#f2495e", thinBars: false,
    }) as unknown as ISeriesApi<"Candlestick">;
  }
  if (kind === "line") {
    return chart.addLineSeries({
      color: "#22c58b", lineWidth: 2, priceLineVisible: false,
    }) as unknown as ISeriesApi<"Candlestick">;
  }
  if (kind === "area") {
    return chart.addAreaSeries({
      lineColor: "#22c58b", topColor: "rgba(34,197,139,0.28)",
      bottomColor: "rgba(38,166,154,0.02)", lineWidth: 2,
    }) as unknown as ISeriesApi<"Candlestick">;
  }
  return chart.addCandlestickSeries({
    upColor: "#22c58b", downColor: "#f2495e", borderVisible: false,
    wickUpColor: "#22c58b", wickDownColor: "#f2495e",
  });
}

  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  /** "candles" | "bars" | "line" | "area"; a chart type change rebuilds the series */
  const [chartType, setChartType] = useState<"candles" | "bars" | "line" | "area">("candles");
  const [logScale, setLogScale] = useState(false);
  const chartTypeRef = useRef(chartType);
  const lineRefs = useRef<Map<string, ISeriesApi<"Line">>>(new Map());

  const [base, setBase] = useState<CandleSeries>(() => generateSampleSeries(30_000));

  /**
   * What resolution is actually loaded?
   *
   * Detected from the bars, because four different load paths feed this chart — provider, file
   * import, Dukascopy download, broker — and not all of them can report their interval. Reading
   * it from the data is the one rule that works for all four, and it cannot lie.
   */
  const baseFrame = useMemo(() => detectTimeframe(base), [base]);

  /**
   * Every frame that can be BUILT from that base.
   *
   * This is what makes "all timeframes" honest rather than decorative: 1m data offers every
   * frame, 5m data offers everything above 5m and refuses 1m, because a lower frame cannot be
   * invented from coarser bars.
   */
  const [tf, setTf] = useState<Timeframe>(TIMEFRAMES[0]!);
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

  /**
   * Whether the right-hand panel is showing.
   *
   * A charting workspace needs the full width sometimes, and there was no way to get it: the
   * panel was always rendered and always occupied 280px. Remembered across launches, because a
   * user who prefers chart-only should not have to close it on every start.
   */
  const [panelOpen, setPanelOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem("fxlab.panelOpen") !== "0";
    } catch {
      return true;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem("fxlab.panelOpen", panelOpen ? "1" : "0");
    } catch {
      // storage can be unavailable; the toggle still works for this session
    }
  }, [panelOpen]);
  const { lang, setLang, t } = useI18n();

  /** One-line note about the restored (or refused) session, shown under the chart. */
  const [sessionNotice, setSessionNotice] = useState("");
  /** false until the session restore attempt has finished; gates bar processing */
  const [restoreSettled, setRestoreSettled] = useState(false);

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
  // EUR/USD: this is a forex tool and the start screen no longer asks, so the default is the
  // instrument the app is actually for.
  const [symbolId, setSymbolId] = useState("EURUSD=X");

  /**
   * Frames pinned to the top of the menu.
   *
   * Persisted, because pinning is a statement of preference, not a one-off. Two sensible defaults
   * are seeded so the favourites section is not empty and therefore not discoverable on first run.
   */
  const [tfFavourites, setTfFavourites] = useState<string[]>(loadTfFavourites);
  useEffect(() => { saveTfFavourites(tfFavourites); }, [tfFavourites]);

  /**
   * Trading session, rebuilt when the symbol changes.
   *
   * The engine is constructed with the symbol's spec (contract size, spread, lot
   * step), so reusing one across a symbol switch would price gold with EURUSD's
   * contract size. Rebuilding discards open positions, which is correct: they belong
   * to the old instrument.
   */
  const sessionSymbol = (id: string): string =>
    id.startsWith("GC=F") ? "XAUUSD" : id;

  // Built with the INITIAL symbol, not a hardcoded XAUUSD. A hardcoded default plus an
  // effect that rebuilds on [symbolId] replaced the session on the very first commit,
  // which silently threw away a restored one — the restore import landed on an instance
  // the UI then discarded.
  const [session, setSession] = useState(() => new TradingSession(sessionSymbol(symbolId)));
  const sessionForSymbol = useRef(symbolId);
  useEffect(() => {
    if (sessionForSymbol.current === symbolId) return;
    sessionForSymbol.current = symbolId;
    setSession(new TradingSession(sessionSymbol(symbolId)));
  }, [symbolId]);
  const [feedStatus, setFeedStatus] = useState<FeedStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [tool, setTool] = useState<DrawingKind | null>(null);

  const feedRef = useRef<Feed | null>(null);
  const drawingsRef = useRef(new DrawingHistory());

  /** per-tool style and visibility; persisted, so a chosen colour survives a restart */
  const [toolConfigs, setToolConfigs] = useState<Record<string, ToolConfig>>(
    () => defaultConfigs(ALL_KINDS),
  );
  const [settingsFor, setSettingsFor] = useState<DrawingKind | null>(null);
  const [magnet, setMagnet] = useState(false);
  const [locked, setLocked] = useState(false);
  const [hiddenDrawings, setHiddenDrawings] = useState(false);
  const [favourites, setFavourites] = useState<DrawingKind[]>([]);

  /** live paper trading, or replay; null until the start screen has been answered */
  const [sessionMode, setSessionMode] = useState<SessionMode | null>(null);
  const [modeState, setModeState] = useState<ModeState>(() => parseModeState(null));
  /** the last bar time the account has already processed, so a poll cannot re-charge it */
  const lastProcessedRef = useRef(0);
  const liveTimerRef = useRef<number | null>(null);

  // Load the saved per-tool styles once. A failure here must not stop the app: the defaults
  // are perfectly usable, so it reports and carries on.
  useEffect(() => {
    const api = (globalThis as unknown as {
      fxlab?: { loadToolConfigs?: () => Promise<{ raw: string | null }> };
    }).fxlab;
    if (!api?.loadToolConfigs) return;
    let cancelled = false;
    void api.loadToolConfigs().then((res) => {
      if (cancelled || res.raw === null) return;
      try {
        setToolConfigs(mergeConfigs(JSON.parse(res.raw), ALL_KINDS));
      } catch (e) {
        setStatus(`tool settings unreadable, using defaults: ${(e as Error).message}`);
      }
    }).catch(() => { /* defaults are fine */ });
    return () => { cancelled = true; };
  }, []);

  /** Persist on every change. Only modified tools are written, so defaults stay live. */
  const applyToolConfigs = (next: Record<string, ToolConfig>): void => {
    setToolConfigs(next);
    const api = (globalThis as unknown as {
      fxlab?: { saveToolConfigs?: (c: unknown) => Promise<{ ok: boolean }> };
    }).fxlab;
    void api?.saveToolConfigs?.(serialiseConfigs(next));
  };
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
  /*
    Keyed on the host APPEARING, not on the first render.

    This effect used to have `[]` as its dependency list, so it ran once — while the start screen
    was showing, where `.chart-host` does not exist. `chartHost.current` was null, the effect
    returned immediately, and it never ran again when the chart host mounted after the user chose a
    mode. The div stayed empty: measured `childCount: 0` and `canvasCount: 0` in `.chart-host`
    while the legend showed live OHLC, so the app was fetching bars and painting nothing.

    `chartReady` is set by the host's ref callback below, which fires when the node attaches.
  */
  const [chartReady, setChartReady] = useState(0);
  /**
   * A STABLE callback ref.
   *
   * An inline `ref={(el) => ...}` is a new function on every render, so React detaches and
   * re-attaches it every time — and setting state inside it produced a re-render, a new callback,
   * and another setState. That is React error #185, "Maximum update depth exceeded": the chart
   * never mounted at all. `useCallback` with an empty dep list keeps the identity fixed, and the
   * state is only bumped when the node actually changes.
   */
  const setChartHost = useCallback((el: HTMLDivElement | null) => {
    if (chartHost.current === el) return;
    chartHost.current = el;
    if (el) setChartReady((n) => n + 1);
  }, []);
  useEffect(() => {
    if (!chartHost.current) return;
    const chart = createChart(chartHost.current, {
      layout: {
        background: { color: "#0d1119" },
        textColor: "#c3c9d6",
        attributionLogo: false,   // spec: no TradingView logos/assets
      },
      grid: {
        vertLines: { color: "#151b27" },
        horzLines: { color: "#151b27" },
      },
      crosshair: { mode: 0 },
      rightPriceScale: { borderColor: "#232b3b" },
      timeScale: { borderColor: "#232b3b", timeVisible: true, secondsVisible: false },
      autoSize: true,
    });
    chartRef.current = chart;
    candleRef.current = makePriceSeries(chart, chartTypeRef.current);
    // Drawing overlay: a canvas pinned exactly over the chart. Lightweight Charts
    // has no vector layer, so shapes are painted here in screen space while the
    // model stays in data space.
    if (canvasRef.current && candleRef.current) {
      overlayRef.current = new DrawingOverlay(
        canvasRef.current, chart, candleRef.current,
        {
          background: "#0d1119", grid: "#151b27", text: "#c3c9d6",
          crosshair: "#787b86", accent: "#5b8def",
          up: "#22c58b", down: "#f2495e",
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
  }, [chartReady]);

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
      } else if (e.code === "F2") {
        // TradingView's shortcut for hiding the side panel, so it is where the hand expects it
        e.preventDefault();
        setPanelOpen((v) => !v);
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

  /**
   * One live poll.
   *
   * Re-requests a trailing window because that is the only thing a quote endpoint offers, then
   * MERGES rather than replaces: replacing would reset the series and the account would lose
   * every bar it has already accounted for. `lastProcessedRef` is what stops a forming bar
   * from being filled twice — commission and swap would double on every poll otherwise.
   */
  const pollLive = useCallback(async (): Promise<void> => {
    if (!feedRef.current) feedRef.current = createFeed();
    const nowSec = Math.floor(Date.now() / 1000);
    const a = availability(5, nowSec - 30 * 86400, nowSec);
    try {
      const r = await feedRef.current.load({
        symbol: symbolId,
        intervalMinutes: 5,
        from: effectiveFrom(nowSec - 30 * 86400, a),
      });
      setFeedStatus(r.status);
      if (r.series.length === 0) return;

      setBase((prev) => {
        const merged = mergeSeries(prev, r.series);
        const added = newBarIndices(prev.time.length, merged.time.length);
        const i = merged.time.length - 1;
        const lastTime = merged.time[i]!;

        // Only a bar strictly newer than the last processed one may advance the account.
        // A forming bar would otherwise be filled at a price that never existed, and the
        // commission and swap would be charged again on every poll.
        if (added.length > 0 && lastTime > lastProcessedRef.current) {
          lastProcessedRef.current = lastTime;
          session.onBar(
            {
              time: lastTime,
              open: merged.open[i]!,
              high: merged.high[i]!,
              low: merged.low[i]!,
              close: merged.close[i]!,
              volume: merged.volume[i]!,
            },
            i,
          );
        }
        // live shows the newest bar: there is nothing to reveal
        setRevealed(merged.time.length);
        return merged;
      });
    } catch (e) {
      setStatus(`live poll failed: ${(e as Error).message}`);
    }
  }, [symbolId, session]);

  // ------------------------------------------------------------- loading
  /**
   * Fetch the live window for a symbol.
   *
   * `forSymbol` exists because React state updates are asynchronous: after choosing a new
   * instrument the old `symbolId` is still in scope for this render, so the fetch would request
   * the PREVIOUS symbol and the chart would appear not to change.
   */
  const loadLive = useCallback(async (forSymbol?: string): Promise<void> => {
    if (offline) {
      setStatus("Offline mode is on — import a CSV or turn it off to fetch.");
      return;
    }
    setLoading(true);
    try {
      if (!feedRef.current) feedRef.current = createFeed();
      const r = await feedRef.current.load({
        symbol: forSymbol ?? symbolId,
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

  /**
   * Load candles that came from either route — a download or an imported file.
   *
   * Both go through here on purpose: the chart, the account and the replay should not care
   * where the bars came from, and two code paths would eventually disagree.
   */
  const loadCandles = useCallback((label: string, candles: Candle[]): void => {
    if (candles.length === 0) {
      setStatus(`No usable bars from ${label}`);
      return;
    }
    const s = seriesFromCandles(candles);
    setBase(s);
    setRevealed(Math.min(2_000, s.length));
    setFeedStatus({
      state: "offline", mode: "offline", servedBy: "file", fromCache: true,
      barCount: s.length,
      message: `Loaded ${label}`,
      usable: true,
    });
    const audit = auditCandles(candles);
    setStatus(
      `${candles.length.toLocaleString()} bars from ${label} · ` +
      `${describeSpacing(audit.spacingSeconds)} · ${audit.verdict}`,
    );
  }, []);

  // A new load can change the detected base (a coarser file), which may make the current
  // selection impossible. Fall back to the base rather than render coarser bars under a finer
  // label — that would be a lie the chart cannot reveal.
  useEffect(() => {
    if (baseFrame === null) return;
    if (!canAggregate(baseFrame, tf)) setTf(baseFrame);
  }, [baseFrame, tf]);

  // Keep the custom box in step with the selection, so it never shows a stale frame.
  useEffect(() => {
    setCustom(tf.kind === "minute" ? String(tf.minutes) : tf.label);
  }, [tf]);

  const applyCustom = useCallback(() => {
    const parsed = parseTimeframeLabel(custom);
    if (!parsed) {
      setStatus(`Invalid timeframe: ${custom}. Use a number of minutes (7, 90) or a label (H2, D1).`);
      return;
    }
    // a custom frame is only usable if it can be built from what is loaded — 7m from 15m bars
    // would silently render 15m candles labelled 7m
    if (!canAggregate(baseFrame, parsed)) {
      setStatus(explainUnavailable(baseFrame, parsed));
      return;
    }
    setTf(parsed);
    setStatus(`Timeframe set to ${parsed.label}`);
  }, [custom, baseFrame]);

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
      // the active tool's saved style: a user who set trend lines to teal gets teal,
      // and the fallback is the amber this used before
      style: tool
        ? styleFor(toolConfigs, tool)
        : { color: "#f0b90b", width: 2, style: "solid", opacity: 1, fill: false, fillOpacity: 0.12 },
      rightEdge: view.length > 0 ? view.time[view.length - 1]! + 3600 : p.time,
    };
  }, [view, tool, toolConfigs]);

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
        balance: session.snapshot().balance,
        equity: session.snapshot().equity,
        freeMargin: session.snapshot().freeMargin,
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
    // No bar may be processed until the session restore attempt has finished. The restore is
    // an async IPC round trip while effects run synchronously, so without this gate the first
    // bar is processed against an empty engine and the restored position is already stopped
    // out by the time the state arrives.
    if (!restoreSettled) return;
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
  }, [base, revealed, session, restoreSettled]);

  /**
   * The live poll timer.
   *
   * Started only in live mode and cleared on unmount or mode change. A leaked timer would keep
   * polling after the user switched to replay, appending today's bars onto a 2019 chart.
   */
  useEffect(() => {
    if (sessionMode !== "live") {
      if (liveTimerRef.current !== null) {
        window.clearInterval(liveTimerRef.current);
        liveTimerRef.current = null;
      }
      return;
    }
    void pollLive();
    const id = window.setInterval(() => { void pollLive(); }, modeState.pollSeconds * 1000);
    liveTimerRef.current = id;
    return () => {
      window.clearInterval(id);
      liveTimerRef.current = null;
    };
  }, [sessionMode, modeState.pollSeconds, pollLive]);

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

  /**
   * Restore the live trading session for this workspace.
   *
   * Only when the stored session is worth restoring — an untouched session would prompt the
   * user to "resume" nothing, which makes the prompt meaningless over time. On refusal the
   * reason is shown and a clean session starts, rather than a partially applied one.
   */
  const sessionRestored = useRef<string | null>(null);
  useEffect(() => {
    const api = (globalThis as unknown as { fxlab?: {
      loadLiveSession?: (w: string) => Promise<{
        raw: string | null; updatedAt: number | null;
      }>;
    } }).fxlab;
    if (!api?.loadLiveSession) {
      setRestoreSettled(true);
      return;
    }
    if (sessionRestored.current === workspace) return;
    sessionRestored.current = workspace;

    void api.loadLiveSession(workspace).then((res) => {
      if (res.raw === null) {
        setRestoreSettled(true);
        return;
      }

      let parsed: ReturnType<typeof parseSessionState>;
      try {
        // The single decode point, same as drawings: the main process hands over raw JSON.
        parsed = parseSessionState(JSON.parse(res.raw), { workspace });
      } catch (e) {
        setSessionNotice(`stored session is unreadable: ${(e as Error).message}`);
        setRestoreSettled(true);
        return;
      }

      if (parsed.rejected) {
        setSessionNotice(`session not restored — ${parsed.rejected}`);
        setRestoreSettled(true);
        return;
      }
      const state = parsed.value;
      if (!state || !worthRestoring(state)) {
        setRestoreSettled(true);
        return;
      }

      session.importState(state);
      // Skip the bar the session was saved at: the restored position was already exposed to
      // it, and re-testing its stop against that bar closes it the moment it comes back.
      lastBarRef.current = session.restoredThrough;
      setRevealed((r) => Math.max(r, state.revealed));
      setSessionNotice(`restored ${describeSession(state)}`);
      setRestoreSettled(true);
    });
  }, [workspace, session]);

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

  /**
   * Persist the live session.
   *
   * Driven by the session's own subscription, not by a render dependency: positions and the
   * balance change inside `onBar`, which does not re-render App, so a React effect keyed on
   * props would save stale state. Debounced because a single bar can settle several
   * positions and each would otherwise write.
   */
  const liveSaveTimer = useRef<number | null>(null);
  const revealedRef = useRef(0);
  useEffect(() => {
    revealedRef.current = revealed;
  }, [revealed]);

  useEffect(() => {
    const api = (globalThis as unknown as { fxlab?: {
      saveLiveSession?: (w: string, s: unknown) => Promise<{ ok: boolean }>;
    } }).fxlab;
    if (!api?.saveLiveSession) return;

    const off = session.subscribe(() => {
      if (liveSaveTimer.current !== null) window.clearTimeout(liveSaveTimer.current);
      liveSaveTimer.current = window.setTimeout(() => {
        const state = session.exportState(workspace, revealedRef.current);
        void api.saveLiveSession!(workspace, state);
      }, 800);
    });

    return () => {
      off();
      if (liveSaveTimer.current !== null) window.clearTimeout(liveSaveTimer.current);
    };
  }, [session, workspace]);

  /**
   * Rebuild the price series when the chart type changes.
   *
   * The overlay keeps a reference to the series for `priceToCoordinate`, so it is rebuilt
   * too — a stale series reference paints every drawing at the wrong height.
   */
  const firstTypeRun = useRef(true);
  useEffect(() => {
    chartTypeRef.current = chartType;
    const chart = chartRef.current;
    if (!chart || !canvasRef.current) return;
    if (firstTypeRun.current) { firstTypeRun.current = false; return; }

    if (candleRef.current) chart.removeSeries(candleRef.current);
    const series = makePriceSeries(chart, chartType);
    candleRef.current = series;

    // feed whatever the current view holds; an empty chart stays empty until the next reveal
    if (view.length > 0) {
      // The series was cast to Candlestick for the ref, but at runtime a line series only
      // accepts {time,value}. Cast the ARGUMENT, not the elements.
      const isValueSeries = chartType === "line" || chartType === "area";
      // view.time is a Float64Array, so .map would return a typed array and coerce the
      // object literals to numbers. Convert to a real array first.
      const times = Array.from(view.time);
      let data: unknown[];
      if (isValueSeries) {
        data = times.map((t, i) => ({ time: t, value: view.close[i]! }));
      } else {
        data = times.map((t, i) => ({
          time: t, open: view.open[i]!, high: view.high[i]!,
          low: view.low[i]!, close: view.close[i]!,
        }));
      }
      const setData = (series as unknown as { setData: (d: unknown[]) => void }).setData;
      setData.call(series, data);
    }

    overlayRef.current = new DrawingOverlay(
      canvasRef.current, chart, series,
      {
        background: "#0d1119", grid: "#151b27", text: "#c3c9d6",
        crosshair: "#787b86", accent: "#5b8def",
        up: "#22c58b", down: "#f2495e",
      },
    );
    overlayRef.current.queue(
      drawingsRef.current.get(), interRef.current, view.length, null, null,
    );
    setRevision((r) => r + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartType]);

  /** Log scale is a price-scale option: one call, no series rebuild. */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.applyOptions({
      rightPriceScale: {
        mode: logScale ? 1 : 0,
        borderColor: "#232b3b",
      },
    });
  }, [logScale]);

  const currentTime = view.length > 0 ? view.time[view.time.length - 1]! : 0;
  const lastBar = view.length > 0
    ? {
        open: view.open[view.length - 1]!, high: view.high[view.length - 1]!,
        low: view.low[view.length - 1]!, close: view.close[view.length - 1]!,
      }
    : null;

  /**
   * Start a session from the start screen.
   *
   * Live and replay differ in exactly two ways: where the bars come from, and whether the
   * clock advances on its own. Everything downstream — account engine, trade panel, journal —
   * is the same code, which is the point.
   */
  const startSession = async (choice: StartChoice): Promise<void> => {
    setSessionMode(choice.mode);
    setModeState((m) => ({ ...m, mode: choice.mode }));
    setSymbolId(choice.symbol);
    setOffline(false);
    setLoading(true);
    setStatus("");

    try {
      if (!feedRef.current) feedRef.current = createFeed();

      if (choice.mode === "live") {
        const nowSec = Math.floor(Date.now() / 1000);
        const a = availability(choice.intervalMinutes, nowSec - 30 * 86400, nowSec);
        const r = await feedRef.current.load({
          symbol: choice.symbol,
          intervalMinutes: choice.intervalMinutes,
          from: effectiveFrom(nowSec - 30 * 86400, a),
        });
        setFeedStatus(r.status);
        if (r.series.length === 0) {
          setStatus(r.status.message);
          setSessionMode(null);
          return;
        }
        setBase(r.series);
        setRevealed(r.series.length);
        // the account starts from the newest CLOSED bar, not the forming one
        lastProcessedRef.current = r.series.time[r.series.time.length - 1]!;
        setStatus(`${r.status.message} — ${r.series.length.toLocaleString()} bars · ${describeMode("live")}`);
      } else {
        const nowSec = Math.floor(Date.now() / 1000);
        const a = availability(choice.intervalMinutes, choice.from ?? 0, nowSec);
        const r = await feedRef.current.load({
          symbol: choice.symbol,
          intervalMinutes: choice.intervalMinutes,
          from: effectiveFrom(choice.from ?? 0, a),
        });
        setFeedStatus(r.status);
        if (r.series.length === 0) {
          setStatus(r.status.message);
          setSessionMode(null);
          return;
        }
        setBase(r.series);
        // replay reveals a leading window so there is context, then steps forward
        const lead = Math.min(200, Math.max(20, Math.floor(r.series.length * 0.1)));
        setRevealed(lead);
        lastProcessedRef.current = 0;
        setStatus(`${r.status.message} — ${r.series.length.toLocaleString()} bars · replay`);
      }
    } catch (e) {
      setStatus(`load failed: ${(e as Error).message}`);
      setSessionMode(null);
    } finally {
      setLoading(false);
    }
  };

  // The start screen owns the whole window until a mode is chosen: there is no meaningful
  // chart to show before the user has said what they want to trade.
  if (sessionMode === null) {
    return (
      <StartScreen
        symbols={LIVE_SYMBOLS.map((s) => ({ id: s.id, label: s.label }))}
        onStart={(c) => void startSession(c)}
        onImport={() => {
          // Open the picker directly. The previous version only switched to the Data tab and
          // printed "Import a CSV from the Data panel", which is the app asking the user to do
          // what the button they just pressed was supposed to do.
          //
          // This goes through main's own picker rather than a browser <input type="file">, because
          // a .bi5 file stores only offsets from midnight and its date comes from the PATH — which
          // a browser file input cannot give. ZIPs and the 60 MB cap are handled there too.
          void (async () => {
            const api = (globalThis as unknown as {
              fxlab?: { pickDataFile?: () => Promise<{
                ok: boolean; name?: string; text?: string; message?: string;
                candles?: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>;
              }> };
            }).fxlab;
            if (!api?.pickDataFile) {
              setStatus("file picking is not available in this build");
              return;
            }
            const res = await api.pickDataFile();
            if (!res.ok) {
              // main's message explains WHY (bad path, oversized file, no CSV in the archive),
              // so it is shown rather than replaced with a generic failure
              if (res.message) setStatus(res.message);
              return;
            }
            setSessionMode("replay");
            setRail("data");
            // main decodes a .bi5 itself (its date lives in the path), so candles may arrive
            // ready to use; anything else arrives as text for the renderer's own parser
            if (res.candles && res.candles.length > 0 && res.name) {
              loadCandles(res.name, res.candles);
              return;
            }
            if (res.text && res.name) {
              importCsv(res.text, res.name);
              return;
            }
            setStatus(`nothing usable in ${res.name ?? "that file"}`);
          })();
        }}
      />
    );
  }

  return (
    <div className="app">
      <header className="toolbar">
        <strong className="brand">{t("app.name")}</strong>
        <span className={offline ? "badge off" : "badge on"}>
          {offline ? t("app.offline") : t("app.live")}
        </span>

        <SymbolMenu
          symbols={LIVE_SYMBOLS.map((s) => ({ id: s.id, label: s.label }))}
          current={symbolId}
          onChoose={(id) => { setSymbolId(id); void loadLive(id); }}
        />

        <TimeframeMenu
          current={tf}
          frames={[...TIMEFRAMES, ...(TIMEFRAMES.some((f) => f.label === tf.label) ? [] : [tf])]}
          baseFrame={baseFrame ?? tf}
          favourites={tfFavourites}
          onToggleFavourite={(label) =>
            setTfFavourites((f) => (f.includes(label) ? f.filter((x) => x !== label) : [...f, label]))}
          onChoose={(f) => setTf(f)}
          onReject={(f) => setStatus(explainUnavailable(baseFrame ?? tf, f))}
          onCustom={(label) => {
            const found = parseTimeframeLabel(label);
            if (!found) { setStatus(`Invalid timeframe: ${label}`); return false; }
            if (!canAggregate(baseFrame ?? tf, found)) {
              setStatus(explainUnavailable(baseFrame ?? tf, found));
              return false;
            }
            setTf(found);
            return true;
          }}
        />


        <label title={t("app.customHint")}>
          {t("app.custom")}{" "}
          <input
            className="w-16" value={custom} placeholder="7"
            data-field="custom-tf"
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") applyCustom(); }}
          />
        </label>

        <label>
          {t("app.chartType")}{" "}
          <select
            data-field="chart-type"
            value={chartType}
            onChange={(e) => setChartType(e.target.value as typeof chartType)}
          >
            <option value="candles">{t("app.candles")}</option>
            <option value="bars">{t("app.bars")}</option>
            <option value="line">{t("app.line")}</option>
            <option value="area">{t("app.area")}</option>
          </select>
        </label>

        <label title={t("app.logScaleHint")}>
          <input
            data-field="log-scale"
            type="checkbox"
            checked={logScale}
            onChange={(e) => setLogScale(e.target.checked)}
          />{" "}
          {t("app.logScale")}
        </label>

        {/* The picker takes the chart's own time as its reference, so a replay of last July shows
            the DST offsets that were in force then — not today's. */}
        <TimezonePicker
          value={zone}
          referenceEpoch={currentTime || Math.floor(Date.now() / 1000)}
          onChange={setZone}
        />

        <button onClick={() => setPlaying((p) => !p)}>
          {playing ? t("app.pause") : t("app.play")}
        </button>
        <button onClick={() => setRevealed((r) => Math.min(base.length, r + 1))}>
          {t("app.step")}
        </button>

        <label>
          {t("app.language")}{" "}
          <select
            data-field="lang"
            value={lang}
            onChange={(e) => setLang(e.target.value as typeof lang)}
          >
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

        {/*
          Panel toggle. The panel was permanently on screen with no way to close it, so a user who
          wants the full chart width had none. F2 is the shortcut TradingView uses for the same
          action, and it is advertised in the title so it can be discovered.
        */}
        <button
          className={panelOpen ? "panel-toggle on" : "panel-toggle"}
          data-action="panel-toggle"
          aria-pressed={panelOpen}
          title={t("app.panelToggle")}
          onClick={() => setPanelOpen((v) => !v)}
        >
          {panelOpen ? "▤" : "▢"}
        </button>

        {/* A readout, not a control: the tool is chosen in the rail. Showing the
            active tool name here removes any doubt about what a click will draw. */}
        {tool && <span className="active-tool">{TOOL_LABELS[tool] ?? tool}</span>}
      </header>

      <DrawingToolbar
        active={tool}
        configs={toolConfigs}
        timeframe={tf.label}
        magnet={magnet}
        onMagnet={setMagnet}
        locked={locked}
        onLocked={setLocked}
        hidden={hiddenDrawings}
        onHidden={setHiddenDrawings}
        onSettings={(k) => setSettingsFor(k)}
        favourites={favourites}
        onToggleFavourite={(k) => setFavourites((f) =>
          f.includes(k) ? f.filter((x) => x !== k) : [...f, k])}
        onSelect={(k) => {
          setTool(k);
          // a new drawing starts from the tool's saved style, which is the whole point of
          // customising it once
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

      {/* data-bars is the VIEW length, not the base length: the whole point of a derived frame
          is that it draws fewer, wider bars, and reporting the base made every frame look
          identical to a test (and to anyone reading the DOM) */}
      <div
        className="chart-area"
        data-bars={view.length}
        data-base-bars={base.length}
        data-frame={tf.label}
        data-mode={sessionMode}
        data-tool-active={tool === null ? "no" : "yes"}
      >
        <div ref={setChartHost} className="chart-host" />
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
              /*
                Price precision follows the instrument.
                `toFixed(2)` is right for gold and wrong for EUR/USD: at two decimals the whole
                legend read "O 1.12 H 1.12 L 1.12 C 1.12" and the spread was invisible. Five
                decimals for pairs quoted near 1, three for JPY crosses, two for metals and indices.
              */
              ? (() => {
                  const p = findSymbol(symbolId).digits;
                  return `O ${lastBar.open.toFixed(p)}  H ${lastBar.high.toFixed(p)}  ` +
                    `L ${lastBar.low.toFixed(p)}  C ${lastBar.close.toFixed(p)}`;
                })()
              : ""}
          </span>
        </div>
        {loading && <div className="loading">loading…</div>}
      </div>

      <aside className="panel" data-panel-open={panelOpen ? "yes" : "no"}>
        <nav className="rail-tabs">
          {(["data", "download", "broker", "trade", "news", "sessions", "equity", "indicators", "strategy", "journal", "symbols"] as RailTab[]).map((tabId) => (
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

        {rail === "download" && (
          <DownloaderPanel
            symbols={LIVE_SYMBOLS.map((s) => ({ id: s.id, label: s.label }))}
            onStatus={setStatus}
            onLoad={(sym, candles) => loadCandles(`${sym} (downloaded)`, candles)}
            onImportFile={(name, text) => {
              const r = parseText(name, text);
              if (r.candles.length === 0) {
                setStatus(
                  `No usable bars in ${name}` +
                  (r.skipped > 0 ? ` — ${r.skipped} rows rejected` : ""),
                );
                return;
              }
              loadCandles(name, r.candles);
              if (r.skipped > 0) {
                setStatus(
                  `${r.candles.length.toLocaleString()} bars from ${name} · ` +
                  `${r.skipped} rows skipped`,
                );
              }
            }}
          />
        )}

        {rail === "broker" && (
          <BrokerPanel
            onStatus={setStatus}
            onLoad={(label, candles) => loadCandles(label, candles)}
          />
        )}

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
            spec={session.specRef}
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

        {rail === "symbols" && <SymbolsPanel />}

        {rail === "equity" && (
          <EquityPanel
            startingBalance={session.startBalance}
            trades={session.snapshot().trades.map((t) => ({
              exitTime: t.exitTime, pnl: t.pnl,
            }))}
            balance={session.snapshot().balance}
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
                  <b>{ind.kind}</b>
                  <input
                    className="mini-num"
                    data-field={`period-${ind.id}`}
                    value={String(ind.period)}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      // Guard the period here rather than in computeIndicator: a period of
                      // 0 or NaN makes every indicator return NaN, which looks like a broken
                      // chart rather than a bad input.
                      if (!Number.isFinite(n) || n < 1) return;
                      setIndicators((l) =>
                        l.map((x) => (x.id === ind.id ? { ...x, period: Math.floor(n) } : x)),
                      );
                    }}
                    inputMode="numeric"
                    title={t("ind.period")}
                  />
                  <button
                    className="mini"
                    data-action={`remove-${ind.id}`}
                    onClick={() => setIndicators((l) => l.filter((x) => x.id !== ind.id))}
                    title={t("ind.remove")}
                  >✕</button>
                </li>
              ))}
            </ul>
            {indicators.length === 0 && <p className="msg">{t("ind.empty")}</p>}
            <p className="msg" data-kv="ind-count">
              {t("ind.count")}: {indicators.length}
            </p>
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

        {settingsFor && (
          <ToolSettings
            kind={settingsFor}
            configs={toolConfigs}
            onChange={applyToolConfigs}
            onClose={() => setSettingsFor(null)}
            allKinds={ALL_KINDS}
          />
        )}

        {dragMessage && <p className="status status-warn">{dragMessage}</p>}
        {sessionNotice && (
          <p className="status status-info">
            {sessionNotice}
            <button
              className="status-dismiss"
              onClick={() => {
                setSessionNotice("");
                const api = (globalThis as unknown as {
                  fxlab?: { clearLiveSession?: (w: string) => Promise<{ ok: boolean }> };
                }).fxlab;
                void api?.clearLiveSession?.(workspace);
              }}
              title="Start a clean session"
            >
              ✕
            </button>
          </p>
        )}
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
