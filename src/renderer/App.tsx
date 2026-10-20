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
import { DrawingHistory, type Drawing, type DrawingKind } from "../core/drawings.js";
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
    const ro = new ResizeObserver(() => chart.applyOptions({}));
    ro.observe(chartHost.current);
    return () => {
      ro.disconnect();
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
      } else if ((e.ctrlKey || e.metaKey) && e.code === "KeyZ") {
        e.preventDefault();
        drawingsRef.current.undo();
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

        <label>
          draw{" "}
          <select
            value={tool ?? ""}
            onChange={(e) => setTool((e.target.value || null) as DrawingKind | null)}
          >
            <option value="">none</option>
            <option value="hline">horizontal line</option>
            <option value="trendline">trend line</option>
            <option value="ray">ray</option>
            <option value="rectangle">rectangle</option>
            <option value="fib-retracement">fib retracement</option>
            <option value="channel">channel</option>
            <option value="long-position">long position</option>
            <option value="short-position">short position</option>
          </select>
        </label>
      </header>

      <div className="chart-area">
        <div ref={chartHost} className="chart-host" />
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
