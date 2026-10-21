/**
 * Dukascopy historical data: decode, and the URL scheme.
 *
 * Dukascopy is the only free source with 1-minute bars back to 2003 for the majors, and it
 * publishes real bid/ask rather than a synthetic spread. The cost is that the format is
 * undocumented and the server is unreliable, so both facts are handled here rather than in
 * the caller.
 *
 * Pure: no network, no DOM. The downloader (main process) does the fetching; this does the
 * part that has to be exactly right.
 */
import type { Candle } from "./types.js";

/**
 * Dukascopy URLs are ZERO-INDEXED by month.
 *
 * `2010/00/04` is 4 January 2010, not February. Getting this wrong shifts every request by a
 * month, which either 404s or — worse — silently returns the wrong month's data.
 */
export function dukascopyUrl(
  symbol: string,
  year: number,
  month1: number,
  day: number,
  kind: "candles" | "ticks" = "candles",
): string {
  const m0 = month1 - 1;
  const pad = (n: number): string => String(n).padStart(2, "0");
  if (kind === "candles") {
    return (
      `https://datafeed.dukascopy.com/datafeed/${symbol}/` +
      `${year}/${pad(m0)}/${pad(day)}/BID_candles_min_1.bi5`
    );
  }
  // ticks are one file per HOUR, which is why a day of ticks is 24 requests
  return (
    `https://datafeed.dukascopy.com/datafeed/${symbol}/` +
    `${year}/${pad(m0)}/${pad(day)}/${pad(0)}h_ticks.bi5`
  );
}

/** Hours of the day, for a tick download. */
export function tickUrls(symbol: string, year: number, month1: number, day: number): string[] {
  const m0 = month1 - 1;
  const pad = (n: number): string => String(n).padStart(2, "0");
  const out: string[] = [];
  for (let h = 0; h < 24; h++) {
    out.push(
      `https://datafeed.dukascopy.com/datafeed/${symbol}/` +
      `${year}/${pad(m0)}/${pad(day)}/${pad(h)}h_ticks.bi5`,
    );
  }
  return out;
}

/** Point size per instrument, so a raw integer price can be scaled. */
export function pointScale(symbol: string): number {
  // JPY pairs and metals quote with different decimals; everything here is 1e-5 except the
  // ones listed. A wrong scale is a price off by 10x, so it is explicit rather than inferred.
  const jpy = /JPY$/.test(symbol);
  if (jpy) return 1e3;
  if (symbol.startsWith("XAU") || symbol.startsWith("XAG")) return 1e3;
  if (symbol.startsWith("BTC") || symbol.startsWith("ETH")) return 1e1;
  return 1e5;
}

/** One decoded 1-minute bar, before it becomes a Candle. */
export interface DukaBar {
  /** seconds from midnight UTC */
  offset: number;
  open: number;
  close: number;
  low: number;
  high: number;
  volume: number;
}

/**
 * Decode one day of 1-minute candles.
 *
 * The layout is NOT documented and is the main trap: each 24-byte record is
 *
 *   uint32  seconds from midnight UTC
 *   uint32  open   (integer, scaled)
 *   uint32  close
 *   uint32  low
 *   uint32  high
 *   float32 volume
 *
 * Note the order is open, CLOSE, LOW, HIGH — not OHLC. Reading the four prices as float32
 * gives all zeros, which looks like corrupt data rather than a wrong layout.
 *
 * Records with open === 0 are minutes with no ticks (weekends, holidays). They are DROPPED:
 * keeping them would put a zero price in the chart and a fake 100% drop in the account.
 */
export function decodeCandles(raw: Uint8Array, scale: number): DukaBar[] {
  const out: DukaBar[] = [];
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const n = Math.floor(raw.byteLength / 24);

  for (let i = 0; i < n; i++) {
    const at = i * 24;
    const offset = view.getUint32(at, false);
    const open = view.getUint32(at + 4, false);
    const close = view.getUint32(at + 8, false);
    const low = view.getUint32(at + 12, false);
    const high = view.getUint32(at + 16, false);
    const volume = view.getFloat32(at + 20, false);

    // a minute with no ticks: not a bar
    if (open === 0) continue;

    out.push({
      offset,
      open: open / scale,
      close: close / scale,
      low: low / scale,
      high: high / scale,
      volume: Number.isFinite(volume) ? volume : 0,
    });
  }
  return out;
}

/** Convert decoded bars to candles for one UTC day. */
export function barsToCandles(
  bars: readonly DukaBar[],
  year: number,
  month1: number,
  day: number,
): Candle[] {
  const midnight = Date.UTC(year, month1 - 1, day) / 1000;
  return bars.map((b) => ({
    time: midnight + b.offset,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
  }));
}

/**
 * Days in a range, as {year, month, day} triples.
 *
 * Skips nothing: weekends are included on purpose, because Dukascopy serves them as flat
 * weekend bars and dropping them would make the replay jump from Friday to Monday with no
 * indication that a gap is real.
 */
export function daysBetween(from: number, to: number): Array<{ y: number; m: number; d: number }> {
  const out: Array<{ y: number; m: number; d: number }> = [];
  const start = new Date(from * 1000);
  const end = new Date(to * 1000);
  const cur = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const last = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());

  for (let t = cur; t <= last; t += 86400_000) {
    const d = new Date(t);
    out.push({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() });
  }
  return out;
}

/** A stable key for one day's file, used to resume a download. */
export function dayKey(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export interface DownloadProgress {
  /** day files finished, whether they had data or not */
  done: number;
  total: number;
  /** day files that returned no data (404, or an all-zero file) */
  empty: number;
  /** day files that failed after retries */
  failed: number;
  /** bars accumulated */
  bars: number;
  /** day keys that failed, for a retry pass */
  failures: string[];
}

export function emptyProgress(total: number): DownloadProgress {
  return { done: 0, total, empty: 0, failed: 0, bars: 0, failures: [] };
}

/** Fraction complete, 0..1, safe when total is 0. */
export function progressFraction(p: DownloadProgress): number {
  if (p.total <= 0) return 0;
  return Math.min(1, p.done / p.total);
}

/** A one-line summary for the UI. */
export function describeProgress(p: DownloadProgress): string {
  const pct = Math.round(progressFraction(p) * 100);
  const parts = [`${pct}% (${p.done}/${p.total} days)`];
  if (p.bars > 0) parts.push(`${p.bars.toLocaleString()} bars`);
  if (p.empty > 0) parts.push(`${p.empty} empty`);
  if (p.failed > 0) parts.push(`${p.failed} failed`);
  return parts.join(" · ");
}
