// ─────────────────────────────────────────────────────────────────────────────
// PREMIUM / DISCOUNT DETECTION  (v4.8.0)
//
// Fully objective — no heuristics in this module.
// All values are deterministic given two price points (swingHigh, swingLow).
//
// DEFINITIONS:
//   Position   = (price - swingLow) / (swingHigh - swingLow)
//   Premium    = position > 0.5 (price is in the upper half of the range)
//   Discount   = position < 0.5 (price is in the lower half)
//   Equilibrium= position = 0.5 = (swingHigh + swingLow) / 2
//
// Fibonacci levels placed objectively at fixed ratios of the range.
// These are standard technical analysis measurements, not heuristics.
// ─────────────────────────────────────────────────────────────────────────────
import { Candle } from '../indicators';
import { DetectedPD } from './smcTypes';
import { PrecomputedStructure } from '../structure/marketStructure';

function fibLevel(lo: number, hi: number, ratio: number): number {
  return lo + (hi - lo) * ratio;
}

// ── Compute premium/discount at bar i ─────────────────────────────────────────
// Uses the most recent confirmed major swing high and swing low (from precomputed
// structure) that are both causal at bar i (index <= i - 5 for lookback=5).
export function detectPDAt(
  price: number,
  msStructure: PrecomputedStructure,
  i: number
): DetectedPD | null {
  const highs = msStructure.majorHighs.filter(s => s.index <= i - 5);
  const lows  = msStructure.majorLows.filter(s => s.index <= i - 5);
  if (highs.length === 0 || lows.length === 0) return null;

  const swingHigh = highs[highs.length - 1].price;
  const swingLow  = lows[lows.length - 1].price;
  const range     = swingHigh - swingLow;
  if (range <= 0) return null;

  const position    = (price - swingLow) / range;
  const equilibrium = (swingHigh + swingLow) / 2;

  return {
    swingHigh,
    swingLow,
    equilibrium,
    position:   Math.max(0, Math.min(1, position)),  // clamp to [0,1]
    isPremium:  position > 0.5,
    isDiscount: position < 0.5,
    fib236: fibLevel(swingLow, swingHigh, 0.236),
    fib382: fibLevel(swingLow, swingHigh, 0.382),
    fib618: fibLevel(swingLow, swingHigh, 0.618),
    fib786: fibLevel(swingLow, swingHigh, 0.786)};
}

// ── Precompute for all bars — O(n + s) with monotonic pointers ───────────────
// Previously O(n × s): each bar re-scanned the full majorHighs/majorLows array
// via .filter(s => s.index <= i - 5). Now: two pointers advance forward only,
// giving O(s) total pointer work across all n bars.
//
// Output is identical to the previous implementation — detectPDAt() itself
// is unchanged; we just feed it pre-filtered views instead of re-filtering.
export function computeDetectedPD(
  candles: Candle[],
  msStructure: PrecomputedStructure
): (DetectedPD | null)[] {
  const LOOKBACK = 5;
  const mh = msStructure.majorHighs;  // sorted ascending by index
  const ml = msStructure.majorLows;
  const result: (DetectedPD | null)[] = new Array(candles.length).fill(null);

  let ptrH = -1;  // index into mh: last admitted high (index <= i - LOOKBACK)
  let ptrL = -1;  // index into ml: last admitted low

  for (let i = 0; i < candles.length; i++) {
    // Advance pointers — O(s) total across all i
    while (ptrH + 1 < mh.length && mh[ptrH + 1].index <= i - LOOKBACK) ptrH++;
    while (ptrL + 1 < ml.length && ml[ptrL + 1].index <= i - LOOKBACK) ptrL++;

    if (i < 10 || ptrH < 0 || ptrL < 0) { result[i] = null; continue; }

    const swingHigh = mh[ptrH].price;
    const swingLow  = ml[ptrL].price;
    const range     = swingHigh - swingLow;
    if (range <= 0) { result[i] = null; continue; }

    const price       = candles[i].close;
    const position    = (price - swingLow) / range;
    const equilibrium = (swingHigh + swingLow) / 2;

    result[i] = {
      swingHigh, swingLow, equilibrium,
      position:   Math.max(0, Math.min(1, position)),
      isPremium:  position > 0.5,
      isDiscount: position < 0.5,
      fib236: fibLevel(swingLow, swingHigh, 0.236),
      fib382: fibLevel(swingLow, swingHigh, 0.382),
      fib618: fibLevel(swingLow, swingHigh, 0.618),
      fib786: fibLevel(swingLow, swingHigh, 0.786)};
  }
  return result;
}
