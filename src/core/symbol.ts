/**
 * Symbol specs and the money math that depends on them.
 *
 * All conversions between price distance and account money live here so the
 * account engine, the backtester and the risk calculator cannot drift apart.
 */
import type { SymbolSpec } from "./types.js";

export const DEFAULT_SYMBOLS: SymbolSpec[] = [
  {
    name: "XAUUSD",
    digits: 2,
    pipSize: 0.01,
    contractSize: 100,
    lotMin: 0.01,
    lotMax: 100,
    lotStep: 0.01,
    spread: 0.2,
    spreadMode: "fixed",
    commissionPerLot: 3,
    swapLong: -0.6,
    swapShort: 0.1,
    leverage: 100,
    quoteCurrency: "USD",
    profitCurrencyIsAccount: true,
  },
  {
    name: "EURUSD",
    digits: 5,
    pipSize: 0.0001,
    contractSize: 100_000,
    lotMin: 0.01,
    lotMax: 100,
    lotStep: 0.01,
    spread: 0.00002,
    spreadMode: "fixed",
    commissionPerLot: 3,
    swapLong: -0.7,
    swapShort: 0.2,
    leverage: 100,
    quoteCurrency: "USD",
    profitCurrencyIsAccount: true,
  },
  {
    name: "GBPUSD",
    digits: 5,
    pipSize: 0.0001,
    contractSize: 100_000,
    lotMin: 0.01,
    lotMax: 100,
    lotStep: 0.01,
    spread: 0.00003,
    spreadMode: "fixed",
    commissionPerLot: 3,
    swapLong: -0.5,
    swapShort: 0.15,
    leverage: 100,
    quoteCurrency: "USD",
    profitCurrencyIsAccount: true,
  },
  {
    name: "USDJPY",
    digits: 3,
    pipSize: 0.01,
    contractSize: 100_000,
    lotMin: 0.01,
    lotMax: 100,
    lotStep: 0.01,
    spread: 0.003,
    spreadMode: "fixed",
    commissionPerLot: 3,
    swapLong: 0.4,
    swapShort: -1.1,
    leverage: 100,
    quoteCurrency: "JPY",
    // profit is in JPY, so the account engine must convert; flagged, not hidden
    profitCurrencyIsAccount: false,
  },
  {
    name: "SPX500",
    digits: 2,
    pipSize: 0.1,
    contractSize: 10,
    lotMin: 0.01,
    lotMax: 100,
    lotStep: 0.01,
    spread: 0.5,
    spreadMode: "fixed",
    commissionPerLot: 3,
    swapLong: -2,
    swapShort: -1,
    leverage: 50,
    quoteCurrency: "USD",
    profitCurrencyIsAccount: true,
  },
  {
    name: "NAS100",
    digits: 2,
    pipSize: 0.1,
    contractSize: 10,
    lotMin: 0.01,
    lotMax: 100,
    lotStep: 0.01,
    spread: 1.5,
    spreadMode: "fixed",
    commissionPerLot: 3,
    swapLong: -2,
    swapShort: -1,
    leverage: 50,
    quoteCurrency: "USD",
    profitCurrencyIsAccount: true,
  },
  {
    name: "US30",
    digits: 2,
    pipSize: 1,
    contractSize: 10,
    lotMin: 0.01,
    lotMax: 100,
    lotStep: 0.01,
    spread: 3,
    spreadMode: "fixed",
    commissionPerLot: 3,
    swapLong: -2,
    swapShort: -1,
    leverage: 50,
    quoteCurrency: "USD",
    profitCurrencyIsAccount: true,
  },
  {
    name: "BTCUSD",
    digits: 2,
    pipSize: 1,
    contractSize: 1,
    lotMin: 0.01,
    lotMax: 50,
    lotStep: 0.01,
    spread: 12,
    spreadMode: "fixed",
    commissionPerLot: 3,
    swapLong: -5,
    swapShort: 1,
    leverage: 10,
    quoteCurrency: "USD",
    profitCurrencyIsAccount: true,
  },
];

/**
 * Provider symbols that map onto a different spec name.
 *
 * Yahoo calls gold "GC=F" and the S&P "^GSPC", but the money math needs the
 * contract details a provider id does not carry. Without this map,
 * findSymbol("GC=F") throws and any code path that touches the strategy panel or
 * the risk calculator dies for a live-loaded symbol.
 */
const SYMBOL_ALIASES: Record<string, string> = {
  "GC=F": "XAUUSD",
  "XAUUSD=X": "XAUUSD",
  GOLD: "XAUUSD",
  "BTC-USD": "BTCUSD",
  "EURUSD=X": "EURUSD",
  "GBPUSD=X": "GBPUSD",
  "USDJPY=X": "USDJPY",
  "^GSPC": "SPX500",
  "^NDX": "NAS100",
  "^DJI": "US30",
  SPY: "SPX500",
};

/** Fall back to a generic spec for anything unknown, so the UI never dies. */
function generic(name: string): SymbolSpec {
  return {
    name,
    digits: 2,
    pipSize: 0.01,
    contractSize: 1,
    lotMin: 0.01,
    lotMax: 100,
    lotStep: 0.01,
    spread: 0,
    spreadMode: "fixed",
    commissionPerLot: 3,
    swapLong: 0,
    swapShort: 0,
    leverage: 100,
    quoteCurrency: "USD",
    profitCurrencyIsAccount: true,
  };
}

export function findSymbol(name: string): SymbolSpec {
  const direct = DEFAULT_SYMBOLS.find((x) => x.name === name);
  if (direct) return direct;

  const alias = SYMBOL_ALIASES[name];
  if (alias) {
    const viaAlias = DEFAULT_SYMBOLS.find((x) => x.name === alias);
    if (viaAlias) return viaAlias;
  }

  // Unknown instruments (a user's imported CSV, a new provider symbol) must not
  // throw here: the chart and backtester only need *a* spec, and the UI shows
  // which symbol is being used. Throwing would take down the whole panel.
  return generic(name);
}

/** True when the name has dedicated money math rather than the generic fallback. */
export function hasDedicatedSpec(name: string): boolean {
  return DEFAULT_SYMBOLS.some(
    (x) => x.name === name || x.name === SYMBOL_ALIASES[name],
  );
}

/** Round a price to the symbol's tick precision (avoids 2399.9999999 on charts). */
export function roundPrice(price: number, sym: SymbolSpec): number {
  const f = Math.pow(10, sym.digits);
  return Math.round(price * f) / f;
}

/** Normalise lots to the symbol's step and clamp to [lotMin, lotMax]. */
export function normaliseLots(lots: number, sym: SymbolSpec): number {
  if (!Number.isFinite(lots) || lots <= 0) return sym.lotMin;
  const stepped = Math.floor(lots / sym.lotStep + 1e-9) * sym.lotStep;
  const clamped = Math.min(sym.lotMax, Math.max(sym.lotMin, stepped));
  // kill float dust: 0.30000000000000004 -> 0.3
  const dec = String(sym.lotStep).split(".")[1]?.length ?? 2;
  return Number(clamped.toFixed(dec));
}

/**
 * Money value of a price move, in account currency.
 *
 * pnl = (priceDelta) * contractSize * lots
 *
 * Only valid when the symbol's profit currency is the account currency (the
 * common case, and all default symbols here). When it is not, a conversion rate
 * is required and this function refuses rather than returning a wrong number.
 */
export function moneyFromPriceDelta(
  priceDelta: number,
  lots: number,
  sym: SymbolSpec,
): number {
  if (!sym.profitCurrencyIsAccount) {
    throw new Error(
      `${sym.name}: profit currency ${sym.quoteCurrency} differs from account ` +
        `currency; a conversion rate is required (not implemented)`,
    );
  }
  return priceDelta * sym.contractSize * lots;
}

/** Price distance equivalent to a given money amount (inverse of the above). */
export function priceDeltaFromMoney(
  money: number,
  lots: number,
  sym: SymbolSpec,
): number {
  if (lots <= 0) return 0;
  return money / (sym.contractSize * lots);
}

/** Margin required to hold `lots` at `price`, in account currency. */
export function requiredMargin(
  lots: number,
  price: number,
  sym: SymbolSpec,
  leverage: number,
): number {
  const notional = lots * sym.contractSize * price;
  return notional / Math.max(1, leverage);
}

/**
 * Lots for a given risk: riskPercent of balance over an SL distance.
 * Returns 0 when the SL distance is zero (no risk defined), which the caller
 * must treat as "cannot size".
 */
export function lotsForRisk(
  balance: number,
  riskPercent: number,
  slPriceDistance: number,
  sym: SymbolSpec,
): number {
  if (slPriceDistance <= 0 || balance <= 0) return 0;
  const riskMoney = (balance * riskPercent) / 100;
  const perLot = slPriceDistance * sym.contractSize;
  if (perLot <= 0) return 0;
  return normaliseLots(riskMoney / perLot, sym);
}
