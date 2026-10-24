/**
 * Data source panel: switch between live and offline, import a CSV, and see the
 * honest state of whatever is loaded.
 *
 * The distinction the user asked for lives here:
 *   ONLINE  -> fetch from the provider, chart updates
 *   OFFLINE -> replay/backtest from cache or an imported file, no network
 */
import React, { useRef, useState } from "react";
import { parseCsv } from "../../core/csv.js";
import { latinNum } from "../../core/format.js";
import {
  mapHeaders, checkMap, rowFromMap, auditCandles, describeQuality,
  type ColumnMap, type QualityReport,
} from "../../core/csv-map.js";
import { parseTimestampField, parseDateTimeParts, detectDelimiter } from "../../core/csv.js";
import type { FeedStatus } from "../../core/feed.js";

interface Props {
  status: FeedStatus | null;
  offline: boolean;
  symbol: string;
  symbols: Array<{ id: string; label: string }>;
  onToggleOffline: (v: boolean) => void;
  onSymbol: (id: string) => void;
  onReload: () => void;
  onImport: (csvText: string, name: string) => void;
}

export function DataPanel({
  status, offline, symbol, symbols,
  onToggleOffline, onSymbol, onReload, onImport,
}: Props): JSX.Element {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [note, setNote] = useState("");

  /**
   * The last imported file, kept so the column mapping can be changed and re-applied without
   * asking the user to pick it again — which is the whole point of having a mapping.
   */
  const [pending, setPending] = useState<{
    name: string;
    text: string;
    headers: string[];
    rows: string[][];
    map: ColumnMap;
  } | null>(null);
  const [quality, setQuality] = useState<QualityReport | null>(null);

  /** Apply a column map to the pending file and import it. */
  const applyMap = (map: ColumnMap): void => {
    if (!pending) return;
    const check = checkMap(map);
    if (!check.ok) {
      setNote(`cannot import: no column for ${check.missing.join(", ")}`);
      return;
    }
    const candles = [];
    let rejected = 0;
    for (const cols of pending.rows) {
      const c = rowFromMap(cols, map, (raw, tod) => (tod != null
        ? parseDateTimeParts(raw, tod, 0)
        : parseTimestampField(raw, 0)));
      if (c) candles.push(c); else rejected++;
    }
    candles.sort((a, b) => a.time - b.time);

    const audit = auditCandles(candles);
    setQuality(audit);
    setPending({ ...pending, map });

    if (candles.length === 0) {
      setNote(`${pending.name}: no usable bars with this mapping (${rejected} rows rejected)`);
      return;
    }
    // the candles are handed over as CSV text so the caller keeps a single import path
    const head = "time,open,high,low,close,volume";
    const body = candles
      .map((c) => `${c.time},${c.open},${c.high},${c.low},${c.close},${c.volume}`)
      .join("\n");
    onImport(`${head}\n${body}`, pending.name);
    setNote(
      `${pending.name}: ${latinNum(candles.length)} bars` +
      (rejected > 0 ? `, ${rejected} rows rejected` : "") +
      (audit.clean ? "" : " — see the data quality report"),
    );
  };

  const handleFile = async (file: File): Promise<void> => {
    try {
      const text = await file.text();
      const cleaned = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
      const lines = cleaned.split("\n").filter((l) => l.trim() !== "");

      // The auto-detector handles the common layouts. When it works, import immediately — a
      // mapping dialog for a file that already parses is friction. When it does not, open the
      // mapping UI seeded with whatever the headers suggest.
      const auto = parseCsv(text);
      const delim = detectDelimiter(lines[0] ?? "");
      const headers = (lines[0] ?? "").split(delim).map((h) => h.trim());
      const rows = lines.slice(1).map((l) => l.split(delim).map((c) => c.trim()));
      const map = mapHeaders(headers);

      if (auto.candles.length > 0) {
        const audit = auditCandles(auto.candles, auto.detectedMinutes * 60);
        setQuality(audit);
        setPending({ name: file.name, text, headers, rows, map });
        onImport(text, file.name);
        setNote(
          `${file.name}: ${latinNum(auto.candles.length)} bars, ` +
          `${auto.detectedMinutes || "?"}m${auto.skippedHeader ? ", header skipped" : ""}` +
          (auto.rowsRejected > 0 ? `, ${auto.rowsRejected} rejected` : "") +
          (audit.clean ? "" : " — see the data quality report"),
        );
        return;
      }

      // Auto-detection found nothing: show the mapping so the user can point at the columns
      // rather than being told "0 bars" with no recourse.
      setPending({ name: file.name, text, headers, rows, map });
      setQuality(null);
      setNote(
        `${file.name}: auto-detection found no usable bars — ` +
        `${auto.rowsRejected} of ${auto.rowsRead} rows rejected. Map the columns below.`,
      );
    } catch (e) {
      setNote(`Import failed: ${(e as Error).message}`);
    }
  };

  const stateClass =
    status?.state === "live" ? "up"
      : status?.state === "degraded" ? "warn"
        : status?.state === "error" ? "down"
          : "";

  return (
    <div className="data-panel">
      <h3>Data</h3>

      <label className="switch-row">
        <input
          type="checkbox"
          checked={offline}
          onChange={(e) => onToggleOffline(e.target.checked)}
        />
        <span>Offline mode (no network)</span>
      </label>

      <label className="field">
        <span>Symbol</span>
        <select value={symbol} onChange={(e) => onSymbol(e.target.value)} disabled={offline}>
          {symbols.map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </select>
      </label>

      <button onClick={onReload} disabled={offline}>⟳ Reload history</button>

      <div className="import">
        <button onClick={() => fileRef.current?.click()}>📂 Import CSV…</button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.txt"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
            e.target.value = "";
          }}
        />
      </div>

      {status && (
        <div className="feed-status">
          <div className="kv">
            <span>state</span>
            <b className={stateClass}>{status.state}</b>
          </div>
          <div className="kv"><span>mode</span><b>{status.mode}</b></div>
          <div className="kv"><span>source</span><b>{status.servedBy ?? "—"}</b></div>
          <div className="kv"><span>bars</span><b className="num">{latinNum(status.barCount)}</b></div>
          <p className="status-note">{status.message}</p>
        </div>
      )}

      {note && <p className="status">{note}</p>}

      {pending && pending.headers.length > 0 && (
        <div className="colmap" data-panel="colmap">
          <h4>columns</h4>
          <table className="grid">
            <tbody>
              {(["time", "timeOfDay", "open", "high", "low", "close", "volume"] as Array<
                keyof ColumnMap
              >).map((field) => (
                <tr key={field}>
                  <td>{field === "timeOfDay" ? "time (of day)" : field}</td>
                  <td>
                    <select
                      data-field={`map-${field}`}
                      value={String(pending.map[field])}
                      onChange={(e) => {
                        const next: ColumnMap = { ...pending.map, [field]: Number(e.target.value) };
                        setPending({ ...pending, map: next });
                      }}
                    >
                      <option value="-1">—</option>
                      {pending.headers.map((h, i) => (
                        <option key={`${field}-${i}`} value={String(i)}>
                          {i}: {h || `col ${i}`}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="map-sample">
                    {pending.map[field] >= 0
                      ? (pending.rows[0]?.[pending.map[field]!] ?? "")
                      : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <button data-action="apply-map" onClick={() => applyMap(pending.map)}>
            Apply mapping
          </button>
          {!checkMap(pending.map).ok && (
            <p className="msg" data-note="mapmissing">
              missing: {checkMap(pending.map).missing.join(", ")}
            </p>
          )}
        </div>
      )}

      {quality && (
        <div className="quality" data-panel="quality">
          <h4>data quality</h4>
          <div className="kv" data-kv="q-bars">
            <span>bars</span><b className="num">{latinNum(quality.bars)}</b>
          </div>
          <div className="kv" data-kv="q-spacing">
            <span>spacing</span><b>{Math.round(quality.spacing / 60)}m</b>
          </div>
          {quality.bars > 0 && (
            <div className="kv" data-kv="q-range">
              <span>range</span>
              <b>
                {new Date(quality.from * 1000).toISOString().slice(0, 10)} →{" "}
                {new Date(quality.to * 1000).toISOString().slice(0, 10)}
              </b>
            </div>
          )}
          <p className={quality.clean ? "msg" : "status status-warn"} data-note="quality">
            {describeQuality(quality)[0]}
          </p>
          {describeQuality(quality).slice(1).map((line) => (
            <p className="msg" key={line}>{line}</p>
          ))}
        </div>
      )}
    </div>
  );
}
