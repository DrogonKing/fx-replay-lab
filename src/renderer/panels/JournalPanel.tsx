/**
 * Trade journal.
 *
 * Records closed trades with tags and notes, then derives the analytics the spec
 * asks for: win rate by tag, R multiples, and a monthly breakdown of P/L.
 *
 * The analytics functions are pure and exported so they are unit-testable without
 * Electron, and so the same numbers back the CSV export.
 */
import React, { useMemo, useState } from "react";

export interface JournalEntry {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  lots: number;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  /** initial risk in money, used for the R multiple */
  risk: number;
  tags: string[];
  notes: string;
}

export interface JournalStats {
  count: number;
  netPnl: number;
  winRate: number;
  expectancy: number;
  avgR: number;
  bestR: number;
  worstR: number;
  byTag: Array<{ tag: string; count: number; netPnl: number; winRate: number }>;
  byMonth: Array<{ month: string; netPnl: number; count: number }>;
}

/** Pure analytics over journal entries. */
export function computeJournalStats(entries: readonly JournalEntry[]): JournalStats {
  if (entries.length === 0) {
    return {
      count: 0, netPnl: 0, winRate: 0, expectancy: 0, avgR: 0, bestR: 0, worstR: 0,
      byTag: [], byMonth: [],
    };
  }

  const rs = entries.map((e) => (e.risk > 0 ? e.pnl / e.risk : 0));
  const wins = entries.filter((e) => e.pnl > 0).length;
  const netPnl = entries.reduce((a, e) => a + e.pnl, 0);

  const tagMap = new Map<string, { count: number; netPnl: number; wins: number }>();
  for (const e of entries) {
    for (const tag of e.tags) {
      const cur = tagMap.get(tag) ?? { count: 0, netPnl: 0, wins: 0 };
      cur.count++;
      cur.netPnl += e.pnl;
      if (e.pnl > 0) cur.wins++;
      tagMap.set(tag, cur);
    }
  }

  const monthMap = new Map<string, { netPnl: number; count: number }>();
  for (const e of entries) {
    const d = new Date(e.exitTime * 1000);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const cur = monthMap.get(key) ?? { netPnl: 0, count: 0 };
    cur.netPnl += e.pnl;
    cur.count++;
    monthMap.set(key, cur);
  }

  return {
    count: entries.length,
    netPnl,
    winRate: (wins / entries.length) * 100,
    expectancy: netPnl / entries.length,
    avgR: rs.reduce((a, b) => a + b, 0) / rs.length,
    bestR: Math.max(...rs),
    worstR: Math.min(...rs),
    byTag: [...tagMap.entries()]
      .map(([tag, v]) => ({
        tag, count: v.count, netPnl: v.netPnl,
        winRate: (v.wins / v.count) * 100,
      }))
      .sort((a, b) => b.netPnl - a.netPnl),
    byMonth: [...monthMap.entries()]
      .map(([month, v]) => ({ month, ...v }))
      .sort((a, b) => a.month.localeCompare(b.month)),
  };
}

/** Export entries as CSV, quoting fields that need it. */
export function journalToCsv(entries: readonly JournalEntry[]): string {
  const head = [
    "symbol", "side", "lots", "entry_time", "exit_time",
    "entry_price", "exit_price", "pnl", "risk", "r_multiple", "tags", "notes",
  ].join(",");
  const esc = (s: string): string =>
    /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  const rows = entries.map((e) => [
    e.symbol, e.side, String(e.lots),
    new Date(e.entryTime * 1000).toISOString(),
    new Date(e.exitTime * 1000).toISOString(),
    String(e.entryPrice), String(e.exitPrice), String(e.pnl), String(e.risk),
    e.risk > 0 ? (e.pnl / e.risk).toFixed(2) : "",
    e.tags.join("|"),
    esc(e.notes),
  ].join(","));
  return [head, ...rows].join("\n");
}

export function JournalPanel(): JSX.Element {
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [tagInput, setTagInput] = useState("");

  const stats = useMemo(() => computeJournalStats(entries), [entries]);

  const addDemo = (): void => {
    const now = Math.floor(Date.now() / 1000);
    const pnl = Math.round((Math.random() - 0.4) * 200);
    setEntries((l) => [
      ...l,
      {
        id: String(Date.now()),
        symbol: "XAUUSD",
        side: Math.random() > 0.5 ? "buy" : "sell",
        lots: 0.1,
        entryTime: now - 3600,
        exitTime: now,
        entryPrice: 2000,
        exitPrice: 2000 + pnl / 10,
        pnl,
        risk: 100,
        tags: tagInput ? tagInput.split(",").map((t) => t.trim()).filter(Boolean) : ["demo"],
        notes: "",
      },
    ]);
  };

  const download = (): void => {
    const csv = journalToCsv(entries);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "journal.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="journal-panel">
      <h3>Journal</h3>
      <div className="row">
        <input
          placeholder="tags, comma-separated"
          value={tagInput}
          onChange={(e) => setTagInput(e.target.value)}
        />
        <button onClick={addDemo}>+ Trade</button>
      </div>

      {stats.count === 0 && <p className="msg">No trades recorded yet.</p>}

      {stats.count > 0 && (
        <>
          <div className="kv"><span>trades</span><b>{stats.count}</b></div>
          <div className="kv"><span>net P/L</span>
            <b className={stats.netPnl >= 0 ? "up" : "down"}>{stats.netPnl.toFixed(0)}</b>
          </div>
          <div className="kv"><span>win rate</span><b>{stats.winRate.toFixed(1)}%</b></div>
          <div className="kv"><span>expectancy</span><b>{stats.expectancy.toFixed(2)}</b></div>
          <div className="kv"><span>avg R</span><b>{stats.avgR.toFixed(2)}</b></div>
          <div className="kv"><span>best / worst R</span>
            <b>{stats.bestR.toFixed(1)} / {stats.worstR.toFixed(1)}</b>
          </div>

          {stats.byTag.length > 0 && (
            <>
              <h3>By tag</h3>
              <table className="grid">
                <thead><tr><th>tag</th><th>n</th><th>net</th><th>win%</th></tr></thead>
                <tbody>
                  {stats.byTag.map((t) => (
                    <tr key={t.tag}>
                      <td>{t.tag}</td><td>{t.count}</td>
                      <td className={t.netPnl >= 0 ? "up" : "down"}>{t.netPnl.toFixed(0)}</td>
                      <td>{t.winRate.toFixed(0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          <h3>By month</h3>
          <table className="grid">
            <thead><tr><th>month</th><th>n</th><th>net</th></tr></thead>
            <tbody>
              {stats.byMonth.map((m) => (
                <tr key={m.month}>
                  <td>{m.month}</td><td>{m.count}</td>
                  <td className={m.netPnl >= 0 ? "up" : "down"}>{m.netPnl.toFixed(0)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <button onClick={download}>⬇ Export CSV</button>
        </>
      )}
    </div>
  );
}
