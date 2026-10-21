#!/usr/bin/env python3
"""
Verify the importer against REAL files, end to end.

Unit tests use synthetic bytes. This builds the same bytes Dukascopy actually serves (by
downloading one), writes a real HistData-shaped CSV, an MT4 export and a ZIP, then runs the
compiled importer over all of them through Node — the same code the app runs.
"""
import lzma
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
WORK = Path("/tmp/import-test")
WORK.mkdir(exist_ok=True)


def fetch(url, tries=10):
    for _ in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            time.sleep(3)
        except Exception:
            time.sleep(3)
    return None


print("=" * 72)
print("1. A REAL DUKASCOPY FILE, decoded by the app's own code")
print("=" * 72)
url = "https://datafeed.dukascopy.com/datafeed/GBPUSD/2014/05/02/BID_candles_min_1.bi5"
blob = fetch(url)
if not blob:
    print("  could not download; skipping the .bi5 check")
else:
    (WORK / "gbpusd.bi5").write_bytes(blob)
    raw = lzma.decompress(blob)
    print(f"  downloaded {len(blob)} bytes -> {len(raw)} raw -> {len(raw) // 24} records")
    # independent decode, to have a number to compare the app's output against
    prices = []
    for i in range(len(raw) // 24):
        t, o, c, lo, hi, v = struct.unpack(">IIIIIf", raw[i * 24:i * 24 + 24])
        if o > 0:
            prices.append((t, o / 1e5))
    print(f"  python decode: {len(prices)} bars, first +{prices[0][0]}s O={prices[0][1]:.5f}")
    (WORK / "expected.txt").write_text(f"{len(prices)}\n{prices[0][1]:.5f}\n")

print()
print("=" * 72)
print("2. BUILD THE OTHER FORMATS A USER WOULD REALISTICALLY HAVE")
print("=" * 72)
# HistData monthly ASCII M1: 20240101 000000;O;H;L;C;V
lines = []
base_o = 1.10366
for i in range(500):
    o = base_o + i * 0.00001
    lines.append(f"2024010{1 + i // 400} {9 + (i % 400) // 60:02d}{(i % 400) % 60:02d}00;"
                 f"{o:.5f};{o + 0.00004:.5f};{o - 0.00002:.5f};{o + 0.00002:.5f};{i % 7}")
hist = WORK / "DAT_ASCII_EURUSD_M1_202401.csv"
hist.write_text("\n".join(lines))
print(f"  HistData CSV: {hist.name}, {len(lines)} rows")

# MT4/MT5 export with a header and tabs
mt = ["<DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>"]
for i in range(300):
    mt.append(f"2024.01.02\t{9 + i // 60:02d}:{i % 60:02d}\t1.1{i % 100:02d}0\t1.2{i % 100:02d}0\t1.0{i % 100:02d}0\t1.15{i % 100:02d}0\t{i}")
mtfile = WORK / "mt5-export.csv"
mtfile.write_text("\n".join(mt))
print(f"  MT4/MT5 export: {mtfile.name}, {len(mt) - 1} rows")

# a ZIP of the HistData file, which is how HistData actually ships
zpath = WORK / "histdata.zip"
with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
    z.write(hist, hist.name)
print(f"  ZIP: {zpath.name}, {zpath.stat().st_size} bytes")

# A deliberately broken file: high < low, a duplicate, a zero price, and a corrupt row
broken = ["<DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>"]
broken.append("2024.01.02\t10:00\t1.1000\t1.0900\t1.1050\t1.1020")   # high < low
broken.append("2024.01.02\t10:01\t1.1020\t1.1030\t1.1010\t1.1025")
broken.append("2024.01.02\t10:01\t1.1020\t1.1030\t1.1010\t1.1025")   # duplicate
broken.append("2024.01.02\t10:02\t0.0000\t0.0000\t0.0000\t0.0000")   # zero price
broken.append("THIS ROW IS CORRUPT")
broken.append("2024.01.02\t10:03\t1.1025\t1.1035\t1.1015\t1.1030")
bfile = WORK / "broken.csv"
bfile.write_text("\n".join(broken))
print(f"  broken file: {bfile.name}, {len(broken) - 1} rows (1 impossible, 1 dup, 1 zero, 1 garbage)")

print()
print("=" * 72)
print("3. RUN THE APP'S OWN COMPILED IMPORTER OVER ALL OF THEM")
print("=" * 72)
script = """
import { readFileSync } from "node:fs";
import { parseText, auditCandles, describeSpacing, parseDukascopyDay } from "/root/fx-replay-lab/dist/main/importer-check.mjs";

const W = "/tmp/import-test/";

// HistData CSV
const hist = parseText("DAT_ASCII_EURUSD_M1_202401.csv", readFileSync(W + "DAT_ASCII_EURUSD_M1_202401.csv", "utf8"));
console.log("HISTDATA", JSON.stringify({
  format: hist.format, bars: hist.candles.length, skipped: hist.skipped,
  first: hist.candles[0]?.open, spacing: describeSpacing(auditCandles(hist.candles).spacingSeconds),
}));

// MT4 export
const mt = parseText("mt5-export.csv", readFileSync(W + "mt5-export.csv", "utf8"));
console.log("MT4", JSON.stringify({
  format: mt.format, bars: mt.candles.length, skipped: mt.skipped,
  hasHeaderInData: mt.candles.some(c => !Number.isFinite(c.open)),
  firstOpen: mt.candles[0]?.open,
}));

// broken file: the audit must NOT say clean
const bad = parseText("broken.csv", readFileSync(W + "broken.csv", "utf8"));
const audit = auditCandles(bad.candles);
console.log("BROKEN", JSON.stringify({
  bars: bad.candles.length,
  skipped: bad.skipped,
  errors: bad.errors.length,
  badPrices: audit.badPrices,
  duplicates: audit.duplicates,
  verdict: audit.verdict,
  notes: audit.notes,
}));
"""
(WORK / "check.mjs").write_text(script)

# the importer lives in core, which dist/main does not compile; build a one-off bundle for it
build = subprocess.run(
    ["npx", "esbuild", "src/core/importer.ts", "--bundle", "--format=esm",
     "--outfile=dist/main/importer-check.mjs", "--platform=node"],
    cwd="/root/fx-replay-lab", capture_output=True, text=True,
)
if build.returncode != 0:
    print("  esbuild failed:", build.stderr[:400])
    sys.exit(1)

run = subprocess.run(["node", str(WORK / "check.mjs")], capture_output=True, text=True)
print(run.stdout.strip() or run.stderr[:800])

print()
print("=" * 72)
print("4. THE REAL .bi5 THROUGH THE APP'S DECODER, COMPARED WITH PYTHON")
print("=" * 72)
bi5check = """
import { readFileSync } from "node:fs";
import { decompressBi5 } from "/root/fx-replay-lab/dist/main/dukascopy-download.js";
import { parseDukascopyDay } from "/root/fx-replay-lab/dist/main/importer-check.mjs";

const buf = readFileSync("/tmp/import-test/gbpusd.bi5");
const raw = decompressBi5(buf);
const r = parseDukascopyDay(raw, "GBPUSD", 2014, 6, 2);
const expected = readFileSync("/tmp/import-test/expected.txt", "utf8").trim().split("\\n");
console.log(JSON.stringify({
  rawBytes: raw.length,
  bars: r.candles.length,
  expectedBars: Number(expected[0]),
  barsMatch: r.candles.length === Number(expected[0]),
  firstOpen: r.candles[0]?.open,
  expectedFirstOpen: Number(expected[1]),
  priceMatches: Math.abs((r.candles[0]?.open ?? 0) - Number(expected[1])) < 1e-9,
  firstTime: r.candles[0] ? new Date(r.candles[0].time * 1000).toISOString() : null,
}));
"""
(WORK / "bi5.mjs").write_text(bi5check)
run2 = subprocess.run(["node", str(WORK / "bi5.mjs")], capture_output=True, text=True)
print(run2.stdout.strip() or run2.stderr[:800])
