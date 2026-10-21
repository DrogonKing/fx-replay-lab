/**
 * The downloader, in the main process.
 *
 * Two hard facts drive this design:
 *
 *  1. The Dukascopy server 503s in bursts and single requests take anywhere from 0.5s to 45s.
 *     So every fetch retries with backoff, and nothing is assumed about latency.
 *  2. A 7-year pull is ~2557 files and takes tens of minutes to hours. So it must be
 *     RESUMABLE: completed days are recorded on disk, and a restart picks up where it stopped.
 *
 * Decompression uses lzma-purejs because Node's zlib has no LZMA. That library is slow but the
 * work is one-off, and it avoids shipping a native module.
 */
import { promises as fs } from "node:fs";
import { inflateRawSync } from "node:zlib";
import * as path from "node:path";
import lzma from "lzma-purejs";
import {
  dukascopyUrl, daysBetween, dayKey, decodeCandles, pointScale, emptyProgress,
  type DownloadProgress,
} from "../core/dukascopy.js";
import type { Candle } from "../core/types.js";

export interface DownloadRequest {
  symbol: string;
  /** epoch seconds */
  from: number;
  to: number;
  /** where to keep the cached files; one folder per symbol */
  dir: string;
  /** parallel fetches; 4 is a sane ceiling because the server already struggles */
  workers: number;
  /** called on every completed day, for a progress bar */
  onProgress?: (p: DownloadProgress) => void;
}

export interface DownloadResult {
  candles: Candle[];
  progress: DownloadProgress;
  /** true when everything came from cache and nothing was fetched */
  fromCacheOnly: boolean;
}

const MAX_RETRIES = 10;
const RETRY_DELAY_MS = 4000;
/** a day file is ~11 KB compressed; anything smaller is an error page, not data */
const MIN_VALID_BYTES = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Decompress an LZMA .bi5 buffer.
 *
 * lzma-purejs wants a byte array and returns one. A failure here means the file is an HTML
 * error page that got past the size check, so it is reported rather than swallowed.
 */
export function decompressBi5(buf: Buffer): Uint8Array {
  const input = new Uint8Array(buf);
  const out = lzma.decompressFile(input);
  if (!out || out.length === 0) {
    throw new Error("lzma decompress returned nothing");
  }
  return out instanceof Uint8Array ? out : new Uint8Array(out);
}

/**
 * Fetch one day, with retries.
 *
 * Returns `null` for a day the server says does not exist (404) — that is a real answer, not a
 * failure, and retrying it would waste minutes. Throws only when retries are exhausted.
 */
async function fetchDay(url: string): Promise<Buffer | null> {
  let lastErr = "unknown";
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "FX-Replay-Lab/1.0" },
        signal: AbortSignal.timeout(90_000),
      });
      if (res.status === 404) return null;
      if (!res.ok) {
        lastErr = `HTTP ${res.status}`;
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength < MIN_VALID_BYTES) {
        // an error page or an empty day; retry, because the server does this under load
        lastErr = `only ${buf.byteLength} bytes`;
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      return buf;
    } catch (e) {
      lastErr = (e as Error).message;
      await sleep(RETRY_DELAY_MS);
    }
  }
  throw new Error(`gave up after ${MAX_RETRIES} attempts: ${lastErr}`);
}

/** Path of the cached CSV for one day. */
function cachePath(dir: string, symbol: string, key: string): string {
  return path.join(dir, symbol, `${key}.csv`);
}

/**
 * Read a cached day, if present.
 *
 * Cached as CSV rather than the original .bi5: it is human-inspectable, and a user can open
 * the folder and see exactly what was downloaded.
 */
async function readCache(file: string): Promise<Candle[] | null> {
  try {
    const text = await fs.readFile(file, "utf8");
    const out: Candle[] = [];
    for (const line of text.split("\n")) {
      if (line.length === 0) continue;
      const [t, o, h, l, c, v] = line.split(",");
      const time = Number(t);
      if (!Number.isFinite(time)) continue;
      out.push({
        time,
        open: Number(o), high: Number(h), low: Number(l), close: Number(c),
        volume: Number(v) || 0,
      });
    }
    return out;
  } catch {
    return null;
  }
}

async function writeCache(file: string, candles: readonly Candle[]): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const lines = candles.map(
    (c) => `${c.time},${c.open},${c.high},${c.low},${c.close},${c.volume}`,
  );
  await fs.writeFile(file, lines.join("\n"), "utf8");
}

/**
 * Download a range, one day at a time, caching each day and resuming from cache.
 *
 * The whole range is walked rather than only weekdays: Dukascopy serves weekends as flat bars,
 * and dropping them would make the chart jump from Friday to Monday with no gap shown.
 */
export async function downloadRange(req: DownloadRequest): Promise<DownloadResult> {
  const days = daysBetween(req.from, req.to);
  const progress = emptyProgress(days.length);
  const collected: Candle[] = [];
  let fromCacheOnly = true;
  let nextIndex = 0;

  const scale = pointScale(req.symbol);

  /** Handle one day. Called by the worker pool. */
  const handleDay = async (): Promise<void> => {
    const idx = nextIndex++;
    if (idx >= days.length) return;
    const d = days[idx]!;
    const key = dayKey(d.y, d.m, d.d);
    const file = cachePath(req.dir, req.symbol, key);

    const cached = await readCache(file);
    if (cached) {
      collected.push(...cached);
      progress.done++;
      if (cached.length === 0) progress.empty++;
      progress.bars += cached.length;
      req.onProgress?.(progress);
      return;
    }

    fromCacheOnly = false;
    try {
      const buf = await fetchDay(dukascopyUrl(req.symbol, d.y, d.m, d.d));
      if (buf === null) {
        // the server says this day has no file; record it as empty so a resume does not
        // retry it forever
        progress.empty++;
        progress.done++;
        await writeCache(file, []);
        req.onProgress?.(progress);
        return;
      }

      const raw = decompressBi5(buf);
      const bars = decodeCandles(raw, scale);
      const midnight = Date.UTC(d.y, d.m - 1, d.d) / 1000;
      const candles: Candle[] = bars.map((b) => ({
        time: midnight + b.offset,
        open: b.open, high: b.high, low: b.low, close: b.close,
        volume: b.volume,
      }));

      if (candles.length === 0) progress.empty++;
      collected.push(...candles);
      progress.bars += candles.length;
      progress.done++;
      await writeCache(file, candles);
      req.onProgress?.(progress);
    } catch (e) {
      // A failed day is recorded but NOT cached, so a later resume retries it.
      progress.failed++;
      progress.done++;
      progress.failures.push(`${key}: ${(e as Error).message}`);
      req.onProgress?.(progress);
    }
  };

  const workers = Math.max(1, Math.min(8, req.workers));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (nextIndex < days.length) await handleDay();
    }),
  );

  collected.sort((a, b) => a.time - b.time);
  return { candles: collected, progress, fromCacheOnly };
}

/**
 * A second pass over the failures.
 *
 * The first pass runs at full speed and accepts some losses; this one is slower and tries only
 * what failed, which is what turns "2540 of 2557" into a complete file.
 */
export async function retryFailures(
  req: DownloadRequest,
  failures: readonly string[],
  onProgress?: (p: DownloadProgress) => void,
): Promise<Candle[]> {
  const out: Candle[] = [];
  const progress = emptyProgress(failures.length);
  const scale = pointScale(req.symbol);

  for (const entry of failures) {
    const key = entry.split(":")[0] ?? "";
    const [ys, ms, ds] = key.split("-");
    const y = Number(ys), m = Number(ms), d = Number(ds);
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
      progress.done++;
      continue;
    }
    try {
      const buf = await fetchDay(dukascopyUrl(req.symbol, y, m, d));
      if (buf) {
        const raw = decompressBi5(buf);
        const bars = decodeCandles(raw, scale);
        const midnight = Date.UTC(y, m - 1, d) / 1000;
        const candles = bars.map((b) => ({
          time: midnight + b.offset,
          open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
        }));
        out.push(...candles);
        await writeCache(cachePath(req.dir, req.symbol, key), candles);
        progress.bars += candles.length;
      }
    } catch {
      progress.failed++;
    }
    progress.done++;
    onProgress?.(progress);
    // gentler than the first pass: the server is already struggling
    await sleep(1500);
  }
  return out.sort((a, b) => a.time - b.time);
}

/**
 * Extract the text of every .csv inside a ZIP.
 *
 * Node's stdlib has no ZIP reader and adding a package for one import is not worth it. This
 * walks the central directory, which is what every archive has, and inflates the entries.
 * Files that are not CSV are ignored: a HistData ZIP contains exactly one, and ignoring the
 * rest is safer than guessing.
 */
export function unzipCsv(buf: Buffer): string[] {
  const out: string[] = [];
  // find the end-of-central-directory record
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return out;

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);

  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString("utf8");
    off += 46 + nameLen + extraLen + commentLen;

    if (!/\.(csv|txt)$/i.test(name)) continue;

    // the local header repeats the name and extra lengths, which can differ from the central
    // directory's — so read them here rather than reusing the values above
    if (buf.readUInt32LE(localOff) !== 0x04034b50) continue;
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const method = buf.readUInt16LE(localOff + 8);
    const compSize = buf.readUInt32LE(localOff + 18);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(dataStart, dataStart + compSize);

    try {
      out.push(method === 0 ? data.toString("utf8") : inflateRawSync(data).toString("utf8"));
    } catch {
      // a broken entry should not abort the whole import
    }
  }
  return out;
}

/** How much is already cached, for a "you have this" hint before downloading. */
export async function cachedSummary(
  dir: string,
  symbol: string,
  from: number,
  to: number,
): Promise<{ days: number; total: number }> {
  const days = daysBetween(from, to);
  let have = 0;
  for (const d of days) {
    try {
      await fs.access(cachePath(dir, symbol, dayKey(d.y, d.m, d.d)));
      have++;
    } catch {
      // not cached
    }
  }
  return { days: have, total: days.length };
}
