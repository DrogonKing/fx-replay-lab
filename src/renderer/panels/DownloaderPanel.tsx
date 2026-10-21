/**
 * Download history, or import a file you already have.
 *
 * Both routes land in the same place, because a user does not care which one produced their
 * candles — they care that the chart has them. The import side sniffs the format rather than
 * demanding a conversion step, since people arrive with a pile of files in whatever shape
 * their old tool produced.
 */
import React, { useMemo, useState } from "react";
import { useI18n } from "../i18n-context.js";
import {
  auditCandles, describeSpacing, type QualityReport,
} from "../../core/importer.js";
import { daysBetween, describeProgress, type DownloadProgress } from "../../core/dukascopy.js";
import type { Candle } from "../../core/types.js";

export interface DownloaderPanelProps {
  symbols: Array<{ id: string; label: string }>;
  onLoad: (symbol: string, candles: Candle[]) => void;
  /** a text file the user picked; App parses it so the panel stays dumb about bytes */
  onImportFile: (name: string, text: string) => void;
  onStatus: (msg: string) => void;
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

export function DownloaderPanel({
  symbols, onLoad, onImportFile, onStatus,
}: DownloaderPanelProps): JSX.Element {
  const { t } = useI18n();

  const [symbol, setSymbol] = useState(symbols[0]?.id ?? "EURUSD");
  const [fromYear, setFromYear] = useState(2010);
  const [fromMonth, setFromMonth] = useState(1);
  const [toYear, setToYear] = useState(2016);
  const [toMonth, setToMonth] = useState(12);
  const [workers, setWorkers] = useState(4);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);

  // imported-file state
  const [report, setReport] = useState<QualityReport | null>(null);
  const [importedName, setImportedName] = useState("");

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
        `${candles.length.toLocaleString()} bars · ` +
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
        <b className={invalidRange ? "down" : ""}>{dayCount.toLocaleString()}</b>
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
          <div className="kv"><span>{t("dl.bars")}</span><b>{report.bars.toLocaleString()}</b></div>
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
