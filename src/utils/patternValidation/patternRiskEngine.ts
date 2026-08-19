// ─────────────────────────────────────────────────────────────────────────────
// PATTERN RISK ENGINE  (v6.3.18)
//
// Computes entry, stop-loss, and three targets for any validated pattern.
// Returns null when Risk:Reward < 1.5 (the minimum acceptable trade setup).
//
// REUSES: geometry's existing stopLevel and target from PatternResult.
// NO new indicator computation — all inputs come from the validator.
//
// Target calculation logic:
//   Target 1 = conservative: half the pattern height from breakout
//   Target 2 = standard:     full pattern height from breakout (measured move)
//   Target 3 = extended:     1.618× pattern height (Fibonacci extension)
// ─────────────────────────────────────────────────────────────────────────────

import { BreakoutState, PatternRisk } from './patternValidationTypes';
import { PatternResult } from '../chartPatterns';

const MIN_RISK_REWARD = 1.5;
const FIBO_EXT = 1.618;

// ── ATR-gated stop loss ───────────────────────────────────────────────────────
// If the pattern's stopLevel is very close to entry (< 0.5 ATR),
// floor it to 0.5 ATR below entry to avoid trivial stops.
function computeStopLoss(
  entry:     number,
  stopLevel: number,
  atr:       number,
  direction: 'bullish' | 'bearish' | 'neutral',
): number {
  const minStopDist = atr * 0.5;
  if (direction === 'bullish') {
    return Math.min(stopLevel, entry - minStopDist);
  }
  if (direction === 'bearish') {
    return Math.max(stopLevel, entry + minStopDist);
  }
  // neutral: use geometry stop as-is
  return stopLevel;
}

// ── Compute targets from measured move ───────────────────────────────────────
function computeTargets(
  entry:         number,
  stopLoss:      number,
  patternTarget: number | undefined,
  direction:     'bullish' | 'bearish' | 'neutral',
): { t1: number; t2: number; t3: number; height: number } {
  const stopDist = Math.abs(entry - stopLoss);

  // If the geometry detector provided a target, use it as T2
  // Otherwise compute from stopDist × 2 (1:2 risk-reward as minimum)
  const height = patternTarget != null
    ? Math.abs(patternTarget - entry)
    : stopDist * 2;

  const sign = direction === 'bearish' ? -1 : 1;

  return {
    t1:     entry + sign * height * 0.5,
    t2:     entry + sign * height,
    t3:     entry + sign * height * FIBO_EXT,
    height};
}

// ── Public API ────────────────────────────────────────────────────────────────
export function computePatternRisk(
  geometry:  PatternResult,
  breakout:  BreakoutState,
  atr:       number,
  currentPrice: number,
): PatternRisk | null {
  // Use breakout price as entry when confirmed, else use current price
  const entry = breakout.hasBreakout && breakout.breakoutPrice != null
    ? breakout.breakoutPrice
    : currentPrice;

  // Must have a valid stop level from the geometry detector
  if (geometry.stopLevel == null) return null;

  const stopLoss = computeStopLoss(entry, geometry.stopLevel, atr, geometry.direction);
  const stopDistance = Math.abs(entry - stopLoss);

  // Stop distance sanity check
  if (stopDistance < atr * 0.1 || stopDistance > atr * 15) return null;

  const { t1, t2, t3, height } = computeTargets(entry, stopLoss, geometry.target, geometry.direction);

  const rr1 = Math.abs(t1 - entry) / stopDistance;
  const rr2 = Math.abs(t2 - entry) / stopDistance;
  const rr3 = Math.abs(t3 - entry) / stopDistance;

  // Reject if even the primary target doesn't meet minimum R:R
  if (rr2 < MIN_RISK_REWARD) return null;

  return {
    entry,
    stopLoss,
    target1:     t1,
    target2:     t2,
    target3:     t3,
    riskReward1: Math.round(rr1 * 100) / 100,
    riskReward2: Math.round(rr2 * 100) / 100,
    riskReward3: Math.round(rr3 * 100) / 100,
    stopDistance,
    atrMultiple: Math.round((stopDistance / atr) * 100) / 100};
}
