/**
 * Money-management entry sizing — the "Glory"-style ticket.
 *
 * The user asked for their MetaTrader money-management EA's behaviour in the
 * paper-trading ticket. The EA is a compiled .ex5 whose parameter schema cannot
 * be extracted (the program body is compressed; only the copyright string
 * survives), so this implements the standard fixed-fractional scheme that
 * money-management EAs of this family expose: pick a basis (balance / equity /
 * free margin), pick a unit (percent of it, or a fixed money amount), give a
 * stop distance in points, and the ticket sizes the lots so that hitting the
 * stop costs exactly that much — never more. Rounding is DOWN to the lot step,
 * because rounding up risks more than asked; and when even the minimum lot
 * would over-risk, the plan is a refusal with the arithmetic, not a silent
 * smaller-risk trade the user did not ask for.
 *
 * Pure: no Electron, no DOM — the same module prices the offline replay ticket
 * and the online live ticket, which is the whole point of "one code path".
 */
import type { SymbolSpec } from "./types.js";

export type MmBasis = "balance" | "equity" | "freeMargin";
export type MmUnit = "percent" | "money";

export interface MmRequest {
  basis: MmBasis;
  unit: MmUnit;
  /** percent of the basis (1 = 1%), or a fixed money amount when unit is "money" */
  value: number;
  /** stop distance in points (1 point = 10^-digits of the symbol) */
  stopPoints: number;
  balance: number;
  equity: number;
  freeMargin: number;
  leverage: number;
  /** entry price of the side being traded (ask for a buy, bid for a sell) */
  price: number;
}

export interface MmPlan {
  /** sized lots, already rounded DOWN to the symbol's step; 0 when refused */
  lots: number;
  /** what the position loses if the stop is hit, at `lots` */
  riskMoney: number;
  /** margin the position locks; the caller compares against free margin itself when needed */
  margin: number;
  ok: boolean;
  /** refusal reason WITH the arithmetic, in words, when ok is false */
  refusal?: string;
}

/** The money the sizing is measured against for a basis. */
function basisValue(req: MmRequest): number {
  switch (req.basis) {
    case "equity": return req.equity;
    case "freeMargin": return req.freeMargin;
    default: return req.balance;
  }
}

/**
 * Size the position. Every refusal names its numbers: "risking 1% of 10,000 =
 * 100.00 but the minimum 0.01 lots already risks 130.00" is a decision the user
 * can act on; "cannot trade" is not.
 */
export function planMm(req: MmRequest, sym: SymbolSpec): MmPlan {
  const point = Math.pow(10, -sym.digits);
  const stopPriceDistance = req.stopPoints * point;

  if (!(req.stopPoints > 0)) {
    return { lots: 0, riskMoney: 0, margin: 0, ok: false, refusal: "stop distance must be more than zero" };
  }
  if (!(req.value > 0)) {
    return { lots: 0, riskMoney: 0, margin: 0, ok: false, refusal: "risk value must be more than zero" };
  }
  if (!(req.price > 0)) {
    return { lots: 0, riskMoney: 0, margin: 0, ok: false, refusal: "no price yet — wait for the first bar" };
  }

  const base = basisValue(req);
  const riskMoney = req.unit === "percent" ? (base * req.value) / 100 : req.value;
  const riskSentence =
    req.unit === "percent"
      ? `risking ${req.value}% of ${base.toFixed(2)} = ${riskMoney.toFixed(2)}`
      : `risking a fixed ${riskMoney.toFixed(2)}`;

  // what ONE full lot loses over the stop distance, in quote currency:
  // distance (price units) × units per lot. No division by price — a $2.00 stop
  // on 100 oz/lot gold loses $200 per lot whatever gold costs; dividing by the
  // price here was a real bug the tests caught (it priced stops as percentages).
  const lossPerLot = stopPriceDistance * sym.contractSize;
  if (!(lossPerLot > 0)) {
    return { lots: 0, riskMoney: 0, margin: 0, ok: false, refusal: "loss per lot computed as zero — malformed symbol spec" };
  }

  const rawLots = riskMoney / lossPerLot;
  // DOWN to the step, always: 0.037 lots at step 0.01 is 0.03, not 0.04
  const stepped = Math.floor(rawLots / sym.lotStep + 1e-9) * sym.lotStep;
  const lots = Math.min(stepped, sym.lotMax);

  if (lots < sym.lotMin) {
    const minRisk = sym.lotMin * lossPerLot;
    return {
      lots: 0, riskMoney: 0, margin: 0, ok: false,
      refusal: `${riskSentence}, but the minimum ${sym.lotMin} lots over that stop already risks ${minRisk.toFixed(2)} — widen the stop or raise the risk`,
    };
  }

  const actualRisk = lots * lossPerLot;
  const margin = (lots * sym.contractSize * req.price) / req.leverage;

  return { lots, riskMoney: actualRisk, margin, ok: true };
}
