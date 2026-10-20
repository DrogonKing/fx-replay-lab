/**
 * Core data model. Pure types only -- no Electron, no DOM, no Node APIs.
 * This file is the single source of truth for shapes shared by the UI,
 * the account engine, the backtester and the worker threads.
 *
 * Time convention (enforced everywhere): every timestamp is UTC epoch SECONDS.
 * Conversion to a display timezone happens only at the UI edge.
 */

/** One OHLCV bar. `time` = UTC epoch seconds marking the bar's OPEN. */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Column-oriented candle storage.
 *
 * Why columnar: 5M bars x 6 numbers as objects costs ~1.2 GB of JS heap and
 * thrashes GC; six typed arrays cost 5M * 8B * 6 = 240 MB with no per-object
 * overhead and allow slicing without copying. Aggregation and indicator code
 * read one column at a time, which is also cache-friendly.
 */
export interface CandleSeries {
  time: Float64Array;
  open: Float64Array;
  high: Float64Array;
  low: Float64Array;
  close: Float64Array;
  volume: Float64Array;
  length: number;
}

export interface SymbolSpec {
  /** e.g. "XAUUSD" */
  name: string;
  /** price decimals, e.g. 2 for XAUUSD, 5 for EURUSD */
  digits: number;
  /** smallest price increment that counts as one pip, e.g. 0.01 or 0.0001 */
  pipSize: number;
  /** units per 1.00 lot */
  contractSize: number;
  lotMin: number;
  lotMax: number;
  lotStep: number;
  /** spread in price units (used when spreadMode === "fixed") */
  spread: number;
  spreadMode: "fixed" | "variable";
  /** account currency charged per 1.00 lot, on entry */
  commissionPerLot: number;
  swapLong: number;
  swapShort: number;
  leverage: number;
  quoteCurrency: string;
  /** profit currency = account currency when true; otherwise a conversion is needed */
  profitCurrencyIsAccount: boolean;
}

export type AccountMode = "hedging" | "netting";

export interface Account {
  id: number;
  name: string;
  currency: string;
  startingBalance: number;
  leverage: number;
  mode: AccountMode;
}

export type OrderType = "market" | "limit" | "stop";
export type Side = "buy" | "sell";

export interface Order {
  id: number;
  accountId: number;
  symbol: string;
  side: Side;
  type: OrderType;
  lots: number;
  /** requested price for limit/stop; ignored for market */
  price: number | null;
  slDistance: number;
  tpDistance: number;
  createdAt: number;
  /** set once the order is filled or cancelled */
  status: "pending" | "filled" | "cancelled";
}

export type ExitReason =
  | "SL"
  | "TP"
  | "Manual"
  | "Partial"
  | "Net"
  | "Signal"
  | "Stop-out";

export interface Position {
  id: number;
  accountId: number;
  symbol: string;
  side: Side;
  lots: number;
  entryPrice: number;
  entryTime: number;
  sl: number | null;
  tp: number | null;
  /** optional trailing distance in price units; null disables trailing */
  trailDistance: number | null;
  commission: number;
  swap: number;
}

export interface Trade {
  id: number;
  accountId: number;
  positionId: number;
  symbol: string;
  side: Side;
  lots: number;
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  sl: number | null;
  tp: number | null;
  reason: ExitReason;
  /** realised profit/loss in account currency, after commission and swap */
  pnl: number;
  commission: number;
  swap: number;
  notes: string;
  tags: string[];
}

export type Impact = "low" | "medium" | "high";

export interface NewsEvent {
  id: number;
  time: number;
  currency: string;
  impact: Impact;
  title: string;
}

export interface Theme {
  name: string;
  bullish: string;
  bearish: string;
  background: string;
  grid: string;
  crosshair: string;
  text: string;
}

/** A timeframe expressed in minutes. 0 means "session-anchored daily/weekly". */
export interface Timeframe {
  label: string;
  /** bar length in minutes for intraday frames; 0 for day/week */
  minutes: number;
  kind: "minute" | "day" | "week";
}
