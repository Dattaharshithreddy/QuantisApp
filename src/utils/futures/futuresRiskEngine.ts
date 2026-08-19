// ─────────────────────────────────────────────────────────────────────────────
// FUTURES RISK ENGINE  (v1.1.0)
//
// Margin-aware lot sizing for Angel One NFO futures orders.
//
// Sizing logic:
//   1. affordableLots  = floor(availableMargin / marginPerLot)
//   2. riskBasedLots   = floor(riskAmount / (stopDistance × lotSize))
//      where riskAmount = availableMargin × riskPerTradePct%
//   3. finalLots       = min(affordableLots, riskBasedLots, MAX_LOTS_CAP)
//   4. if finalLots < 1 → reject with clear reason
//
// The MAX_LOTS_CAP (default: 5) prevents accidental large positions during
// early live trading. Remove or raise it as users gain confidence.
//
// Margin used:
//   We use availablecash + collateral from Angel One RMS as the margin base.
//   The actual margin blocked by the exchange (SPAN + exposure) is typically
//   10-15% of notional. We estimate from MARGIN_PCT in futuresTypes.ts.
//   Actual blocking differs from our estimate — always leave 20% buffer.
// ─────────────────────────────────────────────────────────────────────────────

import { FuturesUnderlying, LOT_SIZES, MARGIN_PCT } from './futuresTypes';
import { getRiskSettings } from '../riskManager';

const MARGIN_BUFFER_PCT = 0.80; // use only 80% of available margin to leave headroom

export type FuturesSizingResult =
  | { ok: true;  lots: number; qty: number; lotSize: number; marginRequired: number; reason: string }
  | { ok: false; lots: 0;      reason: string };

export type FuturesSizingInput = {
  underlying:       FuturesUnderlying;
  currentPrice:     number;        // price of the futures contract
  stopLoss:         number;        // signal stop-loss level
  availableMargin:  number;        // from AO RMS (availablecash + collateral)
};

/**
 * Computes the number of lots to trade given available margin and risk settings.
 * Returns ok:false with a user-readable reason if even 1 lot is unaffordable.
 */
export async function computeFuturesLots(
  input: FuturesSizingInput,
): Promise<FuturesSizingResult> {
  const { underlying, currentPrice, stopLoss, availableMargin } = input;

  const lotSize     = LOT_SIZES[underlying];
  const marginPct   = MARGIN_PCT[underlying] / 100;
  const settings    = await getRiskSettings();

  const notionalPerLot   = currentPrice * lotSize;
  const marginPerLot     = notionalPerLot * marginPct;
  const usableMargin     = availableMargin * MARGIN_BUFFER_PCT;

  // 1. How many lots can we afford given available margin?
  const affordableLots = Math.floor(usableMargin / marginPerLot);

  if (affordableLots < 1) {
    const required = marginPerLot.toFixed(0);
    const available = usableMargin.toFixed(0);
    return {
      ok: false, lots: 0,
      reason:
        `Insufficient margin for 1 lot of ${underlying} futures.\n\n` +
        `Required: ₹${required} (${(marginPct * 100).toFixed(0)}% of ₹${notionalPerLot.toFixed(0)} notional)\n` +
        `Available: ₹${available} (80% of ₹${availableMargin.toFixed(0)} RMS balance)\n\n` +
        `Add funds to your Angel One account or trade a lower-notional contract.`};
  }

  // 2. Risk-based sizing: how many lots fit within the risk budget?
  //    riskAmount = usableMargin × riskPerTradePct%  (using margin as proxy for account size)
  const stopDistance = Math.abs(currentPrice - stopLoss);
  const riskAmount   = availableMargin * (settings.riskPerTradePct / 100);
  const riskPerLot   = stopDistance * lotSize;
  const riskBasedLots = riskPerLot > 0
    ? Math.floor(riskAmount / riskPerLot)
    : affordableLots;   // no stop → fall back to affordable only

  // 3. Final: minimum of the two, capped at settings.maxFuturesLots (configurable in Risk Manager)
  const maxLotsCap = settings.maxFuturesLots ?? 5;
  const rawLots    = Math.max(1, Math.min(affordableLots, riskBasedLots > 0 ? riskBasedLots : affordableLots));
  const finalLots  = Math.min(rawLots, maxLotsCap);

  const qty             = finalLots * lotSize;
  const marginRequired  = finalLots * marginPerLot;

  const capNote = rawLots > maxLotsCap
    ? ` (capped at ${maxLotsCap} lots — increase Max Futures Lots in Risk Manager)`
    : '';

  return {
    ok: true,
    lots:            finalLots,
    qty,
    lotSize,
    marginRequired,
    reason:
      `${finalLots} lot${finalLots !== 1 ? 's' : ''} (${qty} units)${capNote}\n` +
      `Margin required: ≈ ₹${marginRequired.toFixed(0)}\n` +
      `Risk per trade: ₹${riskAmount.toFixed(0)} (${settings.riskPerTradePct}% of ₹${availableMargin.toFixed(0)})`};
}
