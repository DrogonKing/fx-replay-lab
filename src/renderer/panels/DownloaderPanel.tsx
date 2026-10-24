/**
 * Download history, or import a file you already have.
 *
 * Both routes land in the same place, because a user does not care which one produced their
 * candles — they care that the chart has them. The import side sniffs the format rather than
 * demanding a conversion step, since people arrive with a pile of files in whatever shape
 * their old tool produced.
 */
import React, { useEffect, useMemo, useState } from "react";
import { useI18n } from "../i18n-context.js";
import {
  auditCandles, describeSpacing, type QualityReport,
} from "../../core/importer.js";
import { daysBetween, describeProgress, type DownloadProgress } from "../../core/dukascopy.js";
import { latinNum } from "../../core/format.js";
import type { Candle } from "../../core/types.js";

export interface DownloaderPanelProps {
  symbols: Array<{ id: string; label: string }>;
  /** the connected MT account's server, or null when no account is connected */
  mtServer: string | null;
  onLoad: (symbol: string, candles: Candle[]) => void;
  /** bars from the local MT store, into replay mode */
  onMtLoad: (label: string, candles: Candle[]) => void;
  /** a text file the user picked; App parses it so the panel stays dumb about bytes */
  onImportFile: (name: string, text: string) => void;
  onStatus: (msg: string) => void;
}

interface MtCatalogRow {
  symbol: string; tf: string; source: string; count: number; from: number; to: number;
}

interface DownloaderApi {
  downloadHistory?: (req: {
    symbol: string; from: number; to: number; workers: number;
  }) => Promise<{
    ok: boolean;
    candles?: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>;
    progress?: DownloadProgress;
    message?: string;
  }>;
  onDownloadProgress?: (cb: (p: DownloadProgress) => void) => void;
  pickDataFile?: () => Promise<{
    ok: boolean;
    name?: string;
    text?: string;
    candles?: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>;
    message?: string;
  }>;
  mtDownload?: (req: {
    symbol: string; timeframe: string; from: number; to: number; source: string;
  }) => Promise<{
    ok: boolean;
    state: { chunksTotal: number; chunksDone: number; bars: number; failed: number; failures: string[] } | null;
    error?: string;
  }>;
  onMtDownloadProgress?: (cb: (p: {
    chunksTotal: number; chunksDone: number; bars: number; failed: number; failures: string[];
  }) => void) => void;
  mtCancelDownload?: () => Promise<{ ok: boolean }>;
  mtCatalog?: () => Promise<MtCatalogRow[]>;
  mtLoadCandles?: (req: {
    symbol: string; timeframe: string; from?: number; to?: number;
  }) => Promise<Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>>;
}

function api(): DownloaderApi {
  return (globalThis as unknown as { fxlab?: DownloaderApi }).fxlab ?? {};
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Dukascopy's own coverage, verified: majors from 2003. */
const EARLIEST_YEAR = 2003;

/** "YYYY-MM-DD" (UTC) -> epoch seconds; null when the string is not a date. */
function parseDate(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const epoch = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 1000;
  return Number.isFinite(epoch) ? epoch : null;
}

const isoDay = (epoch: number): string => new Date(epoch * 1000).toISOString().slice(0, 10);

export function DownloaderPanel({
  symbols, mtServer, onLoad, onMtLoad, onImportFile, onStatus,
}: DownloaderPanelProps): JSX.Element {
  const { t } = useI18n();

  const [source, setSource] = useState<"dukascopy" | "mt">("dukascopy");
  const [symbol, setSymbol] = useState(symbols[0]?.id ?? "EURUSD");
  const [fromYear, setFromYear] = useState(2010);
  const [fromMonth, setFromMonth] = useState(1);
  const [toYear, setToYear] = useState(2016);
  const [toMonth, setToMonth] = useState(12);
  const [workers, setWorkers] = useState(4);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);

  // MetaTrader source state: the broker's own symbol name and day-precision dates.
  const [mtSymbol, setMtSymbol] = useState("EURUSD");
  const todayIso = new Date().toISOString().slice(0, 10);
  const monthAgoIso = new Date(Date.now() - 30 * 86400 * 1000).toISOString().slice(0, 10);
  const [mtFrom, setMtFrom] = useState(monthAgoIso);
  const [mtTo, setMtTo] = useState(todayIso);
  const [mtBusy, setMtBusy] = useState(false);
  const [mtProgress, setMtProgress] = useState<{
    chunksDone: number; chunksTotal: number; bars: number;
  } | null>(null);
  const [catalog, setCatalog] = useState<MtCatalogRow[]>([]);

  // imported-file state
  const [report, setReport] = useState<QualityReport | null>(null);
  const [importedName, setImportedName] = useState("");

  /** Re-read what the local MT store holds. Called on mount and after a download. */
  const refreshCatalog = async (): Promise<void> => {
    try {
      setCatalog(await api().mtCatalog?.() ?? []);
    } catch { /* an older build: the list simply stays as it was */ }
  };

  useEffect(() => {
    void refreshCatalog();
  }, []);

  // Live progress while a chunked MT download runs; the handler replaces itself on
  // each subscription (the preload removes previous listeners), so one subscription
  // for the panel's lifetime is enough.
  useEffect(() => {
    api().onMtDownloadProgress?.((p) => {
      setMtProgress({ chunksDone: p.chunksDone, chunksTotal: p.chunksTotal, bars: p.bars });
    });
  }, []);

  const mtFromSec = parseDate(mtFrom);
  const mtToSec = parseDate(mtTo);
  const mtRangeInvalid =
    mtFromSec === null || mtToSec === null || mtToSec < mtFromSec;

  const startMtDownload = async (): Promise<void> => {
    const a = api();
    if (!a.mtDownload) {
      onStatus(t("dl.noBridge"));
      return;
    }
    if (!mtServer) {
      onStatus(t("dl.mtNeedsAccount"));
      return;
    }
    if (mtRangeInvalid) {
      onStatus(t("dl.badRange"));
      return;
    }
    setMtBusy(true);
    setMtProgress({ chunksDone: 0, chunksTotal: 0, bars: 0 });
    try {
      const r = await a.mtDownload({
        symbol: mtSymbol.trim().toUpperCase(),
        timeframe: "M1",
        from: mtFromSec!,
        to: mtToSec!,
        source: `mt5:${mtServer}`,
      });
      if (r.state) {
        setMtProgress({
          chunksDone: r.state.chunksDone, chunksTotal: r.state.chunksTotal, bars: r.state.bars,
        });
      }
      if (!r.ok) {
        onStatus(r.error ?? t("dl.nothing"));
        return;
      }
      onStatus(t("dl.mtDone", { bars: latinNum(r.state?.bars ?? 0) }));
      void refreshCatalog();
    } catch (e) {
      onStatus(`download failed: ${(e as Error).message}`);
    } finally {
      setMtBusy(false);
    }
  };

  const cancelMtDownload = async (): Promise<void> => {
    try {
      await api().mtCancelDownload?.();
      onStatus(t("dl.mtCancelled"));
    } catch (e) {
      onStatus(`cancel failed: ${(e as Error).message}`);
    }
  };

  const loadFromCatalog = async (row: MtCatalogRow): Promise<void> => {
    const a = api();
    if (!a.mtLoadCandles) return;
    try {
      const candles = await a.mtLoadCandles({ symbol: row.symbol, timeframe: row.tf });
      if (candles.length === 0) {
        onStatus(t("dl.nothing"));
        return;
      }
      onMtLoad(`${row.symbol} ${row.tf} (stored)`, candles as Candle[]);
    } catch (e) {
      onStatus(`load failed: ${(e as Error).message}`);
    }
  };

  const nowYear = new Date().getUTCFullYear();
  const years = useMemo(() => {
    const out: number[] = [];
    for (let y = nowYear; y >= EARLIEST_YEAR; y--) out.push(y);
    return out;
  }, [nowYear]);

  const from = Math.floor(Date.UTC(fromYear, fromMonth - 1, 1) / 1000);
  const to = Math.floor(Date.UTC(toYear, toMonth, 0, 23, 59) / 1000);

  // A day count the user can sanity-check before starting: this is what decides whether the
  // download is minutes or hours.
  const dayCount = useMemo(() => {
    if (to < from) return 0;
    return daysBetween(from, to).length;
  }, [from, to]);

  const invalidRange = to < from;

  const startDownload = async (): Promise<void> => {
    const a = api();
    if (!a.downloadHistory) {
      onStatus(t("dl.noBridge"));
      return;
    }
    if (invalidRange) {
      onStatus(t("dl.badRange"));
      return;
    }
    setBusy(true);
    setProgress(null);
    a.onDownloadProgress?.((p) => setProgress(p));
    try {
      const r = await a.downloadHistory({ symbol, from, to, workers });
      if (r.progress) setProgress(r.progress);
      if (!r.ok || !r.candles || r.candles.length === 0) {
        onStatus(r.message ?? t("dl.nothing"));
        return;
      }
      const candles: Candle[] = r.candles;
      const audit = auditCandles(candles);
      setReport(audit);
      onLoad(symbol, candles);
      onStatus(
        `${latinNum(candles.length)} bars · ` +
        `${describeSpacing(audit.spacingSeconds)} · ${audit.verdict}`,
      );
    } catch (e) {
      onStatus(`download failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const importFile = async (): Promise<void> => {
    const a = api();
    if (!a.pickDataFile) {
      onStatus(t("dl.noBridge"));
      return;
    }
    try {
      const r = await a.pickDataFile();
      if (!r.ok) {
        if (r.message) onStatus(r.message);
        return;
      }
      setImportedName(r.name ?? "");

      // Three shapes come back, and each has one destination:
      //   candles  — a .bi5 already decoded by main, because LZMA and the day offset live there
      //   text     — CSV, or a ZIP already unpacked, parsed here where the logic is tested
      //   nothing  — an error the user needs to read
      if (r.candles && r.candles.length > 0) {
        onLoad(r.name ?? "file", r.candles as Candle[]);
        return;
      }
      if (typeof r.text === "string" && r.text.length > 0) {
        onImportFile(r.name ?? "file", r.text);
        return;
      }
      onStatus(r.message ?? t("dl.nothing"));
    } catch (e) {
      onStatus(`import failed: ${(e as Error).message}`);
    }
  };

  return (
    <div className="downloader" data-panel="downloader">
      <h3>{t("dl.title")}</h3>
      <p className="msg">{t("dl.sub")}</p>

      <label className="field">
        {t("dl.source")}
        <select
          data-field="dl-source"
          value={source}
          onChange={(e) => setSource(e.target.value as typeof source)}
        >
          <option value="dukascopy">{t("dl.srcDukascopy")}</option>
          <option value="mt">{t("dl.srcMt")}</option>
        </select>
      </label>

      {source === "dukascopy" && (
        <>
          <label className="field">
            {t("dl.symbol")}
            <select
              data-field="dl-symbol"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
            >
              {symbols.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </label>

          <div className="dl-range">
            <label className="field">
              {t("dl.from")}
              <div className="dl-row">
                <select
                  data-field="dl-from-month"
                  value={fromMonth}
                  onChange={(e) => setFromMonth(Number(e.target.value))}
                >
                  {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                </select>
                <select
                  data-field="dl-from-year"
                  value={fromYear}
                  onChange={(e) => setFromYear(Number(e.target.value))}
                >
                  {years.map((y) => <option key={y} value={y}>{y}</option>)}
                </select>
              </div>
            </label>

            <label className="field">
              {t("dl.to")}
              <div className="dl-row">
                <select
                  data-field="dl-to-month"
                  value={toMonth}
                  onChange={(e) => setToMonth(Number(e.target.value))}
                >
                  {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                </select>
                <select
                  data-field="dl-to-year"
                  value={toYear}
                  onChange={(e) => setToYear(Number(e.target.value))}
                >
                  {years.map((y) => <option key={y} value={y}>{y}</option>)}
                </select>
              </div>
            </label>
          </div>

          <label className="field">
            {t("dl.workers")}
            <select
              data-field="dl-workers"
              value={workers}
              onChange={(e) => setWorkers(Number(e.target.value))}
            >
              {[1, 2, 4, 6, 8].map((w) => <option key={w} value={w}>{w}</option>)}
            </select>
          </label>

          {/* The day count is the honest estimate: it is what decides minutes vs hours, and the
              server's latency is unpredictable, so a time estimate would be a guess. */}
          <div className="kv" data-kv="dl-days">
            <span>{t("dl.dayFiles")}</span>
            <b className={invalidRange ? "down" : "num"}>{latinNum(dayCount)}</b>
          </div>

          {invalidRange && <p className="msg down" data-note="dl-bad-range">{t("dl.badRange")}</p>}

          <button
            className="dl-go"
            data-action="dl-start"
            disabled={busy || invalidRange}
            onClick={() => void startDownload()}
          >
            {busy ? t("dl.working") : t("dl.start")}
          </button>

          {progress && (
            <>
              <div className="dl-bar">
                <div
                  className="dl-fill"
                  style={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }}
                />
              </div>
              <p className="msg" data-note="dl-progress">{describeProgress(progress)}</p>
            </>
          )}
        </>
      )}

      {source === "mt" && (
        <>
          {!mtServer && (
            <p className="msg warn" data-note="mt-no-account">{t("dl.mtNeedsAccount")}</p>
          )}

          <label className="field">
            {t("dl.mtSymbol")}
            <input
              data-field="dl-mt-symbol"
              value={mtSymbol}
              dir="ltr"
              onChange={(e) => setMtSymbol(e.target.value)}
            />
          </label>

          <div className="dl-range">
            <label className="field">
              {t("dl.from")}
              <input
                className="dl-date num"
                data-field="dl-mt-from"
                type="date"
                dir="ltr"
                value={mtFrom}
                onChange={(e) => setMtFrom(e.target.value)}
              />
            </label>
            <label className="field">
              {t("dl.to")}
              <input
                className="dl-date num"
                data-field="dl-mt-to"
                type="date"
                dir="ltr"
                value={mtTo}
                onChange={(e) => setMtTo(e.target.value)}
              />
            </label>
          </div>

          {mtRangeInvalid && (
            <p className="msg down" data-note="dl-mt-bad-range">{t("dl.badRange")}</p>
          )}

          <div className="row">
            <button
              className="dl-go"
              data-action="dl-mt-start"
              disabled={mtBusy || mtRangeInvalid || !mtServer}
              onClick={() => void startMtDownload()}
            >
              {mtBusy ? t("dl.working") : t("dl.start")}
            </button>
            {mtBusy && (
              <button data-action="dl-mt-cancel" onClick={() => void cancelMtDownload()}>
                {t("dl.mtCancel")}
              </button>
            )}
          </div>

          {mtProgress && mtProgress.chunksTotal > 0 && (
            <>
              <div className="dl-bar">
                <div
                  className="dl-fill"
                  style={{
                    width: `${Math.round((mtProgress.chunksDone / Math.max(1, mtProgress.chunksTotal)) * 100)}%`,
                  }}
                />
              </div>
              <p className="msg num" data-note="dl-mt-progress">
                {t("dl.mtProgress", {
                  done: mtProgress.chunksDone,
                  total: mtProgress.chunksTotal,
                  bars: latinNum(mtProgress.bars),
                })}
              </p>
            </>
          )}

          <h3>{t("dl.mtStored")}</h3>
          {catalog.length === 0 ? (
            <p className="msg">{t("dl.mtNothing")}</p>
          ) : (
            <table className="grid" data-panel="mt-catalog">
              <thead>
                <tr>
                  <th>{t("dl.symbol")}</th>
                  <th>TF</th>
                  <th>{t("dl.bars")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {catalog.map((row) => (
                  <tr key={`${row.symbol}-${row.tf}-${row.source}`} data-stored={`${row.symbol}-${row.tf}`}>
                    <td>{row.symbol}</td>
                    <td className="num">{row.tf}</td>
                    <td className="num" title={`${isoDay(row.from)} → ${isoDay(row.to)}`}>
                      {latinNum(row.count)}
                    </td>
                    <td>
                      <button
                        className="mini"
                        data-action="mt-load"
                        data-symbol={row.symbol}
                        data-tf={row.tf}
                        onClick={() => void loadFromCatalog(row)}
                      >
                        {t("dl.mtLoad")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      <div className="dl-sep" />

      <h3>{t("dl.importTitle")}</h3>
      <p className="msg">{t("dl.importSub")}</p>
      <button data-action="dl-import" onClick={() => void importFile()}>
        {t("dl.import")}
      </button>

      {importedName && (
        <p className="msg" data-note="dl-imported">{importedName}</p>
      )}

      {report && (
        <div className="dl-report" data-panel="quality">
          <div className="kv"><span>{t("dl.bars")}</span><b className="num">{latinNum(report.bars)}</b></div>
          <div className="kv"><span>{t("dl.spacing")}</span><b>{describeSpacing(report.spacingSeconds)}</b></div>
          <div className="kv">
            <span>{t("dl.range")}</span>
            <b>
              {report.firstTime !== null
                ? new Date(report.firstTime * 1000).toISOString().slice(0, 10)
                : "—"}
              {" → "}
              {report.lastTime !== null
                ? new Date(report.lastTime * 1000).toISOString().slice(0, 10)
                : "—"}
            </b>
          </div>
          <div className="kv">
            <span>{t("dl.gaps")}</span>
            <b className={report.gaps > 0 ? "warn" : ""}>{report.gaps}</b>
          </div>
          <div className="kv">
            <span>{t("dl.verdict")}</span>
            <b className={report.verdict === "clean" ? "up" : report.verdict === "suspect" ? "down" : "warn"}>
              {t(`dl.v.${report.verdict}`)}
            </b>
          </div>
          {report.notes.map((n) => <p className="msg" key={n}>· {n}</p>)}
        </div>
      )}

      <p className="msg">{t("dl.foot")}</p>
    </div>
  );
}
