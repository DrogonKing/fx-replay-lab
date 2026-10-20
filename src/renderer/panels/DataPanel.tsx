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

  const handleFile = async (file: File): Promise<void> => {
    try {
      const text = await file.text();
      const parsed = parseCsv(text);
      if (parsed.candles.length === 0) {
        setNote(`No usable bars in ${file.name} (${parsed.rowsRejected} rows rejected)`);
        return;
      }
      onImport(text, file.name);
      setNote(
        `${file.name}: ${parsed.candles.length.toLocaleString()} bars, ` +
        `${parsed.detectedMinutes ?? "?"}m${parsed.skippedHeader ? ", header skipped" : ""}` +
        (parsed.rowsRejected > 0 ? `, ${parsed.rowsRejected} rejected` : ""),
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
          <div className="kv"><span>bars</span><b>{status.barCount.toLocaleString()}</b></div>
          <p className="status-note">{status.message}</p>
        </div>
      )}

      {note && <p className="status">{note}</p>}
    </div>
  );
}
