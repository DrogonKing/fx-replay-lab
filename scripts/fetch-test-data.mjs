#!/usr/bin/env node
/**
 * Pull a small, real slice of history through the app's OWN downloader, so the backtest below
 * runs on data this app actually fetched rather than a fixture.
 */
import { downloadRange } from "../dist/main/dukascopy-download.js";

// one week of GBPUSD 1-minute bars. Small enough to finish in minutes, long enough to trade.
const from = Date.UTC(2014, 5, 2) / 1000; // 2 June 2014
const to = Date.UTC(2014, 5, 6) / 1000; // 6 June 2014

const t0 = Date.now();
const res = await downloadRange({
  symbol: "GBPUSD",
  from,
  to,
  dir: "history",
  workers: 4,
  onProgress: (p) => {
    process.stdout.write(`\r  ${p.done}/${p.total} days · ${p.bars} bars · ${p.failed} failed`);
  },
});
process.stdout.write("\n");
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(JSON.stringify({
  bars: res.candles.length,
  fromCacheOnly: res.fromCacheOnly,
  progress: res.progress,
}, null, 2).slice(0, 700));
