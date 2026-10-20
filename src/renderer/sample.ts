/**
 * Built-in sample data so the app is usable on first launch with no import.
 *
 * Deterministic random walk (seeded LCG) skipping weekends, gold-like prices.
 * 30k M1 bars, as the spec asks for the prototype parity.
 */
import type { Candle, CandleSeries } from "../core/types.js";
import { seriesFromCandles } from "../core/series.js";

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function generateSampleSeries(count = 30_000): CandleSeries {
  const rand = lcg(20240102);
  const bars: Candle[] = [];
  let price = 2000;
  // Start 2024-01-02 00:00 UTC (a Tuesday).
  let t = Date.UTC(2024, 0, 2, 0, 0, 0) / 1000;

  while (bars.length < count) {
    const weekday = new Date(t * 1000).getUTCDay();
    if (weekday === 6 || weekday === 0) {
      t += 3600;
      continue;
    }
    const drift = (rand() - 0.5) * 2.4;
    const open = price;
    const close = Math.max(1, open + drift);
    const high = Math.max(open, close) + rand() * 1.2;
    const low = Math.min(open, close) - rand() * 1.2;
    bars.push({
      time: t,
      open: round2(open),
      high: round2(high),
      low: round2(low),
      close: round2(close),
      volume: Math.round(50 + rand() * 450),
    });
    price = close;
    t += 60;
  }
  return seriesFromCandles(bars);
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
