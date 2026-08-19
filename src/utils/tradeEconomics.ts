import { calculatePnL } from './pnlCalculator';

// DIAGNOSTICS ONLY. This module computes economic-viability numbers for a
// trade at the moment it opens — it NEVER decides whether the trade opens.
// attemptOpenPosition calls this purely to attach numbers to the position
// for later display; nothing here can reject or modify a trade.

export type TradeEconomics = {
  expectedGrossProfit: number;       // P&L if TP is hit exactly (slippage-adjusted exit), before fees
  expectedLoss: number;              // P&L if SL is hit exactly (slippage-adjusted exit), before fees - negative, same sign convention as the rest of the app's P&L fields
  expectedRoundTripFees: number;     // entry fee (already paid) + estimated exit fee at the TP-level exit value
  expectedSlippageCost: number;      // informational dollar estimate of slippage's impact at the TP-level exit, mirrors how the real closePosition computes slippageCost
  expectedNetEdge: number;           // expectedGrossProfit - expectedRoundTripFees
  costAsPctOfExpectedProfit: number | null; // null when expectedGrossProfit <= 0, since "% of profit consumed by cost" is not a meaningful figure when there's no profit to consume
  atrPctOfPrice: number;             // implied ATR (derived from the known 1.5x-ATR stop convention, see mlSignal.ts) as a % of entry price
  tpDistancePctOfPrice: number;      // TP distance as a % of entry price
};

const FEE_PCT = 0.1;
const SLIPPAGE_PCT = 0.05;

export function computeTradeEconomics(
  entryPrice: number, qty: number, direction: 'LONG' | 'SHORT', stopLoss: number, takeProfit: number, entryFee: number
): TradeEconomics {
  // Mirrors applyExitSlippage in paperTradingEngine.ts exactly - same
  // adverse-direction convention, so the expected numbers here are
  // computed the same way the real close will eventually compute them,
  // not a rosier/different estimate.
  const exitSlip = (price: number) => direction === 'LONG' ? price * (1 - SLIPPAGE_PCT / 100) : price * (1 + SLIPPAGE_PCT / 100);

  const effectiveTpExit = exitSlip(takeProfit);
  const effectiveSlExit = exitSlip(stopLoss);

  const expectedGrossProfit = calculatePnL({ entryPrice, exitPrice: effectiveTpExit, qty, direction, fees: 0 });
  const expectedLoss = calculatePnL({ entryPrice, exitPrice: effectiveSlExit, qty, direction, fees: 0 });

  const expectedExitFee = effectiveTpExit * qty * (FEE_PCT / 100);
  const expectedRoundTripFees = entryFee + expectedExitFee;
  const expectedSlippageCost = effectiveTpExit * qty * (SLIPPAGE_PCT / 100);
  const expectedNetEdge = expectedGrossProfit - expectedRoundTripFees;
  const costAsPctOfExpectedProfit = expectedGrossProfit > 0 ? (expectedRoundTripFees / expectedGrossProfit) * 100 : null;

  // atrStopDist = |entryPrice - stopLoss| = 1.5 * realATR by the documented
  // convention in mlSignal.ts (stopLoss = entry - 1.5*currentATR for BUY) -
  // dividing back out by 1.5 recovers the real ATR exactly, not a guess.
  const atrStopDist = Math.abs(entryPrice - stopLoss);
  const impliedAtr = atrStopDist / 1.5;
  const atrPctOfPrice = (impliedAtr / entryPrice) * 100;
  const tpDistancePctOfPrice = (Math.abs(takeProfit - entryPrice) / entryPrice) * 100;

  return {
    expectedGrossProfit, expectedLoss, expectedRoundTripFees, expectedSlippageCost,
    expectedNetEdge, costAsPctOfExpectedProfit, atrPctOfPrice, tpDistancePctOfPrice};
}

// Presentation-only heuristic for the warning banner. This threshold is
// NOT a trading filter and does not gate anything - it only decides which
// of two warning strings (or none) to show. Deliberately separate from
// any future filter threshold, which per the explicit instruction should
// only be set from real recorded paper-trading results, not invented here.
export function tradeEconomicsWarning(econ: TradeEconomics): string | null {
  if (econ.expectedNetEdge <= 0) {
    return '⚠ Expected profit does not cover estimated trading costs.';
  }
  // "Barely exceeds": costs consume more than half of the expected gross
  // profit. costAsPctOfExpectedProfit is guaranteed non-null here since
  // expectedNetEdge > 0 implies expectedGrossProfit > expectedRoundTripFees > 0.
  if (econ.costAsPctOfExpectedProfit != null && econ.costAsPctOfExpectedProfit > 50) {
    return '⚠ Expected profit barely exceeds estimated trading costs.';
  }
  return null;
}
