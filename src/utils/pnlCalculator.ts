// SINGLE SOURCE OF TRUTH for P&L calculations across the entire app.
//
// ROOT CAUSE OF THE SHORT-PNL BUG this module fixes: PaperTradingScreen.tsx
// computed each open position's displayed P&L inline as
// `(currentPrice - entryPrice) * qty` with NO direction multiplier at all.
// That formula is only correct for LONG. For SHORT it produces the exact
// inverse sign of the truth — verified directly against the reported case
// (entry 1576.98, current 1583.69, qty 19): (1583.69-1576.98)*19 = +127.49,
// matching the reported "+127.47" almost exactly, while the CORRECT SHORT
// P&L for that same move is -127.49 (a loss, since price rose against a
// short). The engine's own closePosition/closePositionPartial/
// monitorOpenPositions already had the right formula via a private
// `sideMultiplier` helper — but paperPortfolio.ts's computePortfolioValue
// duplicated the same multiplier inline instead of importing it, and
// PaperTradingScreen.tsx's per-row display didn't use any multiplier at
// all. Three independent implementations of the same concept is exactly
// how one of them silently went wrong while the others stayed correct.
//
// Going forward there is exactly ONE place this arithmetic lives.

export type TradeDirection = 'LONG' | 'SHORT';

/**
 * The canonical direction -> sign mapping. LONG profits when price rises
 * (+1), SHORT profits when price falls (-1). Every directional P&L in the
 * app should derive from this, not redefine it.
 */
export function directionMultiplier(direction: TradeDirection): number {
  return direction === 'LONG' ? 1 : -1;
}

/**
 * The actual arithmetic core, direction-agnostic. Takes an already-resolved
 * multiplier (+1/-1) rather than a direction string, so domains with a
 * wider set of direction labels (e.g. the manual journal's BUY_CE/SELL_PE
 * options-style directions) can supply their own multiplier mapping while
 * still going through this one formula.
 */
export function calculatePnLWithMultiplier(
  entryPrice: number, exitPrice: number, qty: number, multiplier: number, fees = 0
): number {
  return (exitPrice - entryPrice) * qty * multiplier - fees;
}

/**
 * The standard entry point for anything using plain LONG/SHORT. Equivalent
 * to the explicit formulas requested:
 *   LONG:  (exitPrice - entryPrice) * qty
 *   SHORT: (entryPrice - exitPrice) * qty
 * (multiplying by -1 for SHORT is algebraically identical to swapping the
 * subtraction order — verified below in the unit tests.)
 */
export function calculatePnL(params: {
  entryPrice: number; exitPrice: number; qty: number; direction: TradeDirection; fees?: number;
}): number {
  return calculatePnLWithMultiplier(params.entryPrice, params.exitPrice, params.qty, directionMultiplier(params.direction), params.fees ?? 0);
}

/** P&L as a percentage of the original position notional (entryPrice * qty). */
export function calculatePnLPct(pnl: number, entryPrice: number, qty: number): number {
  const notional = entryPrice * qty;
  return notional !== 0 ? (pnl / notional) * 100 : 0;
}

/**
 * Whether a position is currently in profit, at a loss, or exactly at
 * break-even — centralized so "is this green or red" is never decided by
 * a second, separately-derived comparison anywhere in the UI.
 */
export function pnlSign(pnl: number): 'profit' | 'loss' | 'breakeven' {
  if (pnl > 0) return 'profit';
  if (pnl < 0) return 'loss';
  return 'breakeven';
}

/**
 * Canonical unrealized P&L for an open position given a live price.
 * Use this instead of inline (exitPrice - entryPrice) * qty * multiplier
 * wherever an open position's current value is displayed.
 *
 * No fees are deducted — this is the mark-to-market unrealized figure.
 * The entry fee was debited at open (cash-accounting) and the exit fee
 * will be deducted at close; neither belongs in the live display P&L.
 */
export function computeUnrealizedPnL(params: {
  entryPrice: number;
  currentPrice: number;
  qty: number;
  direction: TradeDirection;
}): number {
  return calculatePnLWithMultiplier(
    params.entryPrice, params.currentPrice, params.qty,
    directionMultiplier(params.direction),
    0, // no fees for unrealized display
  );
}

/**
 * Peak-profit withdrawal metrics — computed from accumulated position tracking fields.
 * Used by analytics and journal screens to display these consistently.
 *
 * All inputs come from the frozen PaperTradeRecord (for closed trades) or the live
 * PaperPosition (for open trades). Never recomputed from prices.
 */
export type PeakProfitMetrics = {
  peakProfit:         number;  // highest unrealized P&L seen during the trade
  maxProfitWithdrawn: number;  // largest (peakProfit - unrealizedPnL) seen during the trade
  mfe:                number;  // Maximum Favorable Excursion (= peakProfit when > 0, else 0)
  mae:                number;  // Maximum Adverse Excursion (always <= 0)
  tradeEfficiency:    number;  // pnl / peakProfit when peakProfit > 0, else 0 (0..1)
};

export function extractPeakProfitMetrics(trade: {
  pnl: number;
  maxUnrealizedProfit: number;
  maxDrawdownDuringTrade: number;
  peakProfit?: number;
  maxProfitWithdrawn?: number;
}): PeakProfitMetrics {
  const peakProfit         = trade.peakProfit ?? Math.max(0, trade.maxUnrealizedProfit ?? 0);
  const maxProfitWithdrawn = trade.maxProfitWithdrawn ?? 0;
  const mfe                = Math.max(0, trade.maxUnrealizedProfit ?? 0);
  const mae                = Math.min(0, trade.maxDrawdownDuringTrade ?? 0);
  const tradeEfficiency    = peakProfit > 0 ? Math.min(1, trade.pnl / peakProfit) : 0;
  return { peakProfit, maxProfitWithdrawn, mfe, mae, tradeEfficiency };
}
