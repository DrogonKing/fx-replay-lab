/**
 * Trade -> journal entry conversion.
 *
 * Kept pure and in core so the mapping is unit-tested. The interesting part is
 * `risk`: the journal's R multiple depends on it, and it is NOT recoverable from a
 * Trade alone — a Trade records where the stop ended up (an SL fill price), not the
 * distance that was at risk when the position opened. The caller supplies it from
 * the position, and when it is unknown the risk is recorded as 0, which the journal
 * renders as "—" rather than inventing an R.
 */
import type { Trade } from "./types.js";
import type { JournalEntry } from "./persist.js";

export interface RiskInfo {
  /** initial stop distance in price units at entry; 0 or absent = unknown */
  stopDistance?: number;
  /** contract size of the instrument, for money risk */
  contractSize: number;
  /** free-form tags the user attached at entry */
  tags?: string[];
  notes?: string;
}

/**
 * Convert a closed trade into a journal entry.
 *
 * `risk` is money at risk at entry: stopDistance × lots × contractSize. Using the
 * REALISED pnl for the R numerator (not a recomputed price delta) matters: pnl
 * already includes commission and swap, so the R reflects what the account actually
 * made, which is the number a trader reviews.
 */
export function tradeToJournalEntry(
  t: Trade,
  risk: RiskInfo,
  /** id generator so this stays pure */
  makeId: () => string,
): JournalEntry {
  const stopDistance = risk.stopDistance ?? 0;
  const riskMoney = stopDistance > 0
    ? stopDistance * t.lots * risk.contractSize
    : 0;

  return {
    id: makeId(),
    symbol: t.symbol,
    side: t.side,
    lots: t.lots,
    entryTime: t.entryTime,
    exitTime: t.exitTime,
    entryPrice: t.entryPrice,
    exitPrice: t.exitPrice,
    pnl: t.pnl,
    risk: riskMoney,
    tags: [
      // the exit reason is the single most useful automatic tag: "was this a stop
      // or a target?" is the first question any journal review asks
      t.reason.toLowerCase(),
      ...(risk.tags ?? []),
    ],
    notes: risk.notes ?? t.notes ?? "",
  };
}

/**
 * Deduplicate journal entries by an identity that survives a reload.
 *
 * A Trade's numeric id is per-session (the engine counts from 1 each run), so two
 * different sessions both produce `id: 3`. Keying on entryTime+exitTime+symbol+lots
 * is the honest approximation: two fills of the same size on the same instrument
 * with identical second-resolution timestamps are the same trade for journal
 * purposes.
 */
export function tradeIdentity(t: {
  symbol: string; side: string; lots: number; entryTime: number; exitTime: number;
}): string {
  return `${t.symbol}|${t.side}|${t.lots}|${t.entryTime}|${t.exitTime}`;
}

/** Add entries, skipping any whose identity is already present. */
export function mergeNewEntries(
  existing: readonly JournalEntry[],
  incoming: readonly JournalEntry[],
): { merged: JournalEntry[]; added: number } {
  const seen = new Set(existing.map(tradeIdentity));
  const merged = [...existing];
  let added = 0;
  for (const e of incoming) {
    const key = tradeIdentity(e);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(e);
    added++;
  }
  return { merged, added };
}
