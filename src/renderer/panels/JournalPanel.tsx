/**
 * Trade journal.
 *
 * Records closed trades with tags and notes, then derives the analytics the spec
 * asks for: win rate by tag, R multiples, and a monthly breakdown of P/L.
 *
 * The analytics functions are pure and exported so they are unit-testable without
 * Electron, and so the same numbers back the CSV export.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  parseJournal, serialiseJournal,
} from "../../core/persist.js";
import { mergeNewEntries } from "../../core/trade-to-journal.js";
import { useI18n } from "../i18n-context.js";

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

interface JournalBridge {
  loadJournal?: () => Promise<{ value: unknown[]; rejected: string[] }>;
  saveJournal?: (entries: unknown[]) => Promise<{
    ok: boolean; accepted?: number; rejected?: string[];
  }>;
}

interface Props {
  /** reports the current entries so other panels (sessions) can aggregate them */
  onEntries?: (entries: ReadonlyArray<{
    entryTime: number; pnl: number; symbol: string;
  }>) => void;
  /** when provided, closed trades arrive here automatically */
  session?: {
    takePending: () => Array<{
      id: string; symbol: string; side: "buy" | "sell"; lots: number;
      entryTime: number; exitTime: number; entryPrice: number; exitPrice: number;
      pnl: number; risk: number; tags: string[]; notes: string;
    }>;
  };
}

export function JournalPanel({ session, onEntries }: Props = {}): JSX.Element {
  const { t } = useI18n();
  const [entries, setEntries] = useState<JournalEntry[]>([]);

  // Test hook: lets a smoke script seed rows without going through localStorage or IPC.
  useEffect(() => {
    const w = window as unknown as { __fxlabSetJournal?: (rows: unknown[]) => void };
    w.__fxlabSetJournal = (rows) => setEntries(rows as JournalEntry[]);
  }, []);

  // Report upward on every change: one effect rather than five call sites, so no mutation
  // path can forget to notify.
  useEffect(() => {
    onEntries?.(entries.map((e) => ({
      entryTime: e.entryTime,
      pnl: e.pnl,
      symbol: e.symbol,
    })));
  }, [entries, onEntries]);
  const [tagInput, setTagInput] = useState("");
  const [note, setNote] = useState("");

  const stats = useMemo(() => computeJournalStats(entries), [entries]);

  const bridge = (): JournalBridge =>
    (globalThis as unknown as { fxlab?: JournalBridge }).fxlab ?? {};

  /**
   * Guards the load→save race. Without it the autosave fires on the first render
   * with the empty starting state and immediately overwrites the stored journal.
   */
  const hydrated = useRef(false);

  useEffect(() => {
    const api = bridge();
    if (!api.loadJournal) return;
    let cancelled = false;
    void api.loadJournal().then((res) => {
      if (cancelled) return;
      const parsed = parseJournal({ entries: res.value });

      // MERGE, do not replace. The drain effect above may already have pulled a
      // trade that closed while this request was in flight; replacing state would
      // silently discard it, and since takePending() had already emptied the
      // session buffer the entry would be gone for good.
      setEntries((current) => mergeNewEntries(parsed.value, current).merged);
      hydrated.current = true;
      if (res.rejected.length > 0 || parsed.rejected.length > 0) {
        setNote(
          `Dropped ${res.rejected.length + parsed.rejected.length} damaged ` +
          `journal row(s) on load.`,
        );
      }
    }).catch((e: Error) => {
      hydrated.current = true;
      setNote(`Could not load the journal: ${e.message}`);
    });
    return () => { cancelled = true; };
  }, []);

  /**
   * Pull any trades the session has filed.
   *
   * drained on every mount and on a short poll while the panel is open. A poll is
   * deliberate: the write happens inside the replay tick, which is not a React
   * event, and a subscription would need the panel to outlive tab switches.
   */
  useEffect(() => {
    if (!session) return;
    const pull = (): void => {
      const pending = session.takePending();
      if (pending.length === 0) return;
      setEntries((prev) => mergeNewEntries(prev, pending).merged);
    };
    pull();
    // 400 ms: fast enough that the journal looks live while stepping the replay,
    // slow enough not to re-render the panel constantly.
    const timer = window.setInterval(pull, 400);
    return () => window.clearInterval(timer);
  }, [session]);

  useEffect(() => {
    if (!hydrated.current) return;
    const api = bridge();
    if (!api.saveJournal) return;
    const t = window.setTimeout(() => {
      const payload = serialiseJournal(entries);
      // api.loadJournal was checked above, but saveJournal is a separate optional
      // member; capture it so the closure keeps the narrowed type.
      const save = api.saveJournal;
      if (!save) return;
      void save(payload.entries as unknown[]);
    }, 400);
    return () => window.clearTimeout(t);
  }, [entries]);

  /**
   * Adds a SAMPLE row, explicitly tagged `demo`.
   *
   * This used to generate a random P/L and file it as a real trade, which quietly
   * corrupts every statistic on the panel. A journal whose numbers you cannot trust
   * is worse than no journal, so the row is labelled and its tag is not optional.
   */
  const addSample = (): void => {
    const now = Math.floor(Date.now() / 1000);
    const tags = tagInput
      ? tagInput.split(",").map((t) => t.trim()).filter(Boolean)
      : [];
    setEntries((l) => [
      ...l,
      {
        id: `demo_${Date.now()}`,
        symbol: "XAUUSD",
        side: "buy",
        lots: 0.1,
        entryTime: now - 3600,
        exitTime: now,
        entryPrice: 2000,
        exitPrice: 2010,
        pnl: 100,
        risk: 100,
        tags: ["demo", ...tags],
        notes: "sample row — replace with a real trade",
      },
    ]);
  };

  const remove = (id: string): void => {
    setEntries((l) => l.filter((e) => e.id !== id));
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
      <h3>{t("journal.title")}</h3>
      <div className="row">
        <input
          placeholder={t("trade.tags")}
          value={tagInput}
          onChange={(e) => setTagInput(e.target.value)}
        />
        <button onClick={addSample} title={t("journal.sample")}>{t("journal.sample")}</button>
      </div>

      {note && <p className="status status-warn" data-note="journal">{note}</p>}

      {stats.count === 0 && <p className="msg">{t("journal.empty")}</p>}

      {stats.count > 0 && (
        <>
          <div className="kv"><span>{t("journal.trades")}</span><b>{stats.count}</b></div>
          <div className="kv"><span>{t("journal.netPnl")}</span>
            <b className={stats.netPnl >= 0 ? "up" : "down"}>{stats.netPnl.toFixed(0)}</b>
          </div>
          <div className="kv"><span>{t("journal.winRate")}</span><b>{stats.winRate.toFixed(1)}%</b></div>
          <div className="kv"><span>{t("journal.expectancy")}</span><b>{stats.expectancy.toFixed(2)}</b></div>
          <div className="kv"><span>{t("journal.avgR")}</span><b>{stats.avgR.toFixed(2)}</b></div>
          <div className="kv"><span>{t("journal.bestWorstR")}</span>
            <b>{stats.bestR.toFixed(1)} / {stats.worstR.toFixed(1)}</b>
          </div>

          {stats.byTag.length > 0 && (
            <>
              <h3>{t("journal.byTag")}</h3>
              <table className="grid">
                <thead>
                  <tr>
                    <th>{t("journal.tag")}</th>
                    <th>{t("journal.n")}</th>
                    <th>{t("journal.net")}</th>
                    <th>{t("journal.winPct")}</th>
                  </tr>
                </thead>
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

          <h3>{t("journal.byMonth")}</h3>
          <table className="grid">
            <thead>
              <tr>
                <th>{t("journal.month")}</th>
                <th>{t("journal.n")}</th>
                <th>{t("journal.net")}</th>
              </tr>
            </thead>
            <tbody>
              {stats.byMonth.map((m) => (
                <tr key={m.month}>
                  <td>{m.month}</td><td>{m.count}</td>
                  <td className={m.netPnl >= 0 ? "up" : "down"}>{m.netPnl.toFixed(0)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="row">
            <button onClick={download}>{t("journal.export")}</button>
            <button
              onClick={() => setEntries((l) => l.filter((e) => !e.tags.includes("demo")))}
              title="Remove the labelled sample rows"
            >
              {t("journal.clearSamples")}
            </button>
          </div>

          {entries.some((e) => e.tags.includes("demo")) && (
            <p className="msg">
              Rows tagged <b>demo</b> are samples and are included in the statistics
              above. Clear them before trusting the numbers.
            </p>
          )}

          {entries.length > 0 && (
            <>
              <h3>{t("journal.rows")}</h3>
              <table className="grid">
                <thead>
                  <tr>
                    <th>{t("journal.symbol")}</th>
                    <th>{t("trade.side")}</th>
                    <th>{t("trade.pnl")}</th>
                    <th>{t("journal.rMultiple")}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {entries.slice(-20).reverse().map((e) => (
                    <tr key={e.id}>
                      <td>{e.symbol}</td>
                      <td>{e.side}</td>
                      <td className={e.pnl >= 0 ? "up" : "down"}>{e.pnl.toFixed(0)}</td>
                      <td>{e.risk > 0 ? (e.pnl / e.risk).toFixed(2) : "—"}</td>
                      <td>
                        <button className="row-del" onClick={() => remove(e.id)} title="Delete">✕</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
    </div>
  );
}
