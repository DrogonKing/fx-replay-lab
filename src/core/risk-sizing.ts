/**
 * Position sizing from a risk budget.
 *
 * Pure. The one rule this module exists to enforce: **never take more risk than asked.**
 *
 * The existing `lotsForRisk` in symbol.ts rounds a sub-minimum size UP to `lotMin`, which
 * silently risks more than the user requested — the one direction a risk tool must never
 * round. Here the size always rounds DOWN to the lot step, and when even the minimum lot
 * would exceed the budget the result says so with the actual risk percentage, so the UI can
 * ask before placing the trade instead of quietly over-risking.
 */
import { normaliseLots, requiredMargin } from "./symbol.js";
import type { SymbolSpec } from "./types.js";

export interface RiskRequest {
  /** account balance in account currency */
  balance: number;
  /** percent of balance to risk, e.g. 1 for 1% */
  riskPercent: number;
  /** stop distance in PRICE units (not points) */
  slDistance: number;
  /** current ask/bid, for the margin check */
  price: number;
  leverage: number;
  /** free margin, so a size that cannot be held is refused */
  freeMargin: number;
}

export interface RiskPlan {
  /** lots to trade; 0 when the request cannot be met at all */
  lots: number;
  /** money at risk at those lots */
  riskMoney: number;
  /** percent of balance actually at risk (may differ from the request after rounding) */
  actualRiskPercent: number;
  /** margin the position will use */
  margin: number;
  /** true when the size could not be met without exceeding the budget */
  overBudget: boolean;
  /** true when free margin, not the risk budget, is the limit */
  marginLimited: boolean;
  /** why lots is 0 or why overBudget is set */
  reason?: string;
}

/**
 * Points to price units.
 *
 * One point is `10^-digits` of price: 0.01 on gold (2 digits), 0.00001 on a 5-digit pair.
 * The first version used `10^(-digits+1)`, a factor of ten too large, which would have sized
 * every risk-based trade ten times over.
 */
export function pointsToPrice(points: number, sym: SymbolSpec): number {
  return points * Math.pow(10, -sym.digits);
}

/** Price units to points. */
export function priceToPoints(price: number, sym: SymbolSpec): number {
  return price / Math.pow(10, -sym.digits);
}

const dec = (step: number): number => String(step).split(".")[1]?.length ?? 2;

/** Round DOWN to the lot step, so risk is never increased by rounding. */
function floorToStep(lots: number, step: number): number {
  if (!Number.isFinite(lots) || lots <= 0) return 0;
  return Number((Math.floor(lots / step + 1e-9) * step).toFixed(dec(step)));
}

/**
 * Size a position from a risk budget.
 *
 * Order of the checks matters: the risk budget decides first, then margin can only shrink
 * the result. Doing it the other way round would let margin "allow" a size the user never
 * wanted to risk.
 */
export function planRisk(req: RiskRequest, sym: SymbolSpec): RiskPlan {
  const empty = (reason: string): RiskPlan => ({
    lots: 0, riskMoney: 0, actualRiskPercent: 0, margin: 0,
    overBudget: false, marginLimited: false, reason,
  });

  if (!(req.balance > 0)) return empty("balance must be positive");
  if (!(req.riskPercent > 0)) return empty("risk must be positive");
  if (!(req.slDistance > 0)) return empty("a stop loss is required to size from risk");
  if (!(sym.contractSize > 0)) return empty("symbol has no contract size");

  const riskMoney = (req.balance * req.riskPercent) / 100;
  const perLot = req.slDistance * sym.contractSize;
  if (!(perLot > 0)) return empty("cannot value the stop distance");

  const exact = riskMoney / perLot;
  const floored = floorToStep(exact, sym.lotStep);

  // Below one step: the trade is impossible without over-risking.
  if (floored < sym.lotStep) {
    const minRisk = sym.lotMin * perLot;
    return {
      lots: 0,
      riskMoney: 0,
      actualRiskPercent: 0,
      margin: 0,
      overBudget: true,
      marginLimited: false,
      reason:
        `the smallest trade (${sym.lotMin} lots) would risk ${minRisk.toFixed(2)}` +
        ` = ${((minRisk / req.balance) * 100).toFixed(2)}% of the balance, more than the` +
        ` ${req.riskPercent}% asked for`,
    };
  }

  let lots = Math.min(floored, sym.lotMax);

  // Margin can only shrink the size, never grow it.
  const marginFor = (l: number): number =>
    requiredMargin(l, req.price, sym, req.leverage);
  let margin = marginFor(lots);
  let marginLimited = false;

  if (margin > req.freeMargin) {
    marginLimited = true;
    // step down until it fits; a bounded loop because lots is already floored to the step
    let candidate = lots;
    for (let i = 0; i < 10_000 && candidate >= sym.lotMin; i++) {
      candidate = Number((candidate - sym.lotStep).toFixed(dec(sym.lotStep)));
      if (candidate < sym.lotMin) break;
      if (marginFor(candidate) <= req.freeMargin) {
        lots = candidate;
        margin = marginFor(candidate);
        break;
      }
    }
    if (lots === floored) {
      return {
        lots: 0,
        riskMoney: 0,
        actualRiskPercent: 0,
        margin: 0,
        overBudget: false,
        marginLimited: true,
        reason: `not enough free margin: ${req.freeMargin.toFixed(2)} available, ` +
          `${marginFor(sym.lotMin).toFixed(2)} needed for the minimum lot`,
      };
    }
  }

  const usedRisk = lots * perLot;
  return {
    lots,
    riskMoney: usedRisk,
    actualRiskPercent: (usedRisk / req.balance) * 100,
    margin,
    overBudget: false,
    marginLimited,
    reason: marginLimited
      ? `reduced to ${lots} lots by free margin (risk ${((usedRisk / req.balance) * 100).toFixed(2)}%)`
      : undefined,
  };
}

/**
 * Lots for a stop given in POINTS, which is what the trade panel collects.
 *
 * A thin wrapper so the UI never converts units itself: the digits-to-points conversion is
 * the easiest place in this codebase to be off by a factor of ten.
 */
export function planRiskFromPoints(
  req: Omit<RiskRequest, "slDistance">,
  slPoints: number,
  sym: SymbolSpec,
): RiskPlan {
  return planRisk({ ...req, slDistance: pointsToPrice(slPoints, sym) }, sym);
}

/** Money at risk for an already-chosen size, for the "you are risking X" line. */
export function riskOfLots(
  lots: number,
  slPriceDistance: number,
  sym: SymbolSpec,
  balance: number,
): { money: number; percent: number } {
  const money = lots * slPriceDistance * sym.contractSize;
  return { money, percent: balance > 0 ? (money / balance) * 100 : 0 };
}

/**
 * Reward-to-risk from the two distances.
 *
 * Returns null when either is missing: an "RR" computed from a missing stop is a number
 * someone will trust.
 */
export function rewardRisk(
  slPoints: number,
  tpPoints: number,
): number | null {
  if (!(slPoints > 0) || !(tpPoints > 0)) return null;
  return tpPoints / slPoints;
}

/**
 * The maximum stop distance that fits a risk budget at the symbol's minimum lot.
 *
 * This is the question a trader actually asks when a setup needs a wide stop: "can I even
 * take this at my risk?" — answered in points, which is what the panel shows.
 */
export function maxStopPoints(
  balance: number,
  riskPercent: number,
  sym: SymbolSpec,
): number {
  if (!(balance > 0) || !(riskPercent > 0) || !(sym.contractSize > 0)) return 0;
  const riskMoney = (balance * riskPercent) / 100;
  const perLot = sym.lotMin * sym.contractSize;
  if (!(perLot > 0)) return 0;
  const priceDistance = riskMoney / perLot;
  return priceToPoints(priceDistance, sym);
}

/** Normalise a user-typed lots value the way the engine will, for display. */
export function clampLots(lots: number, sym: SymbolSpec): number {
  return normaliseLots(lots, sym);
}
