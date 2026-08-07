// ─────────────────────────────────────────────────────────────────────────────
// PATTERN LIFECYCLE  (v6.3.18)
//
// Every detected geometry passes through exactly four states:
//
//   FORMING   → geometry partially matches, not enough swing history
//   DETECTED  → full geometry confirmed, waiting for breakout
//   CONFIRMED → breakout validated by close + volume + no false-break
//   FAILED    → false breakout / failed retest / close returned inside pattern
//
// This module ONLY manages state transitions.
// It never modifies validation scores or risk calculations.
//
// REUSES: BreakoutState, RetestState from patternValidationTypes.ts
// ─────────────────────────────────────────────────────────────────────────────

import { PatternStatus, BreakoutState, RetestState } from './patternValidationTypes';
import { PatternResult } from '../chartPatterns';
import { Candle } from '../indicators';

// Minimum strength for a detected geometry to advance past FORMING
const MIN_GEOMETRY_STRENGTH_FOR_DETECTED = 0.25;

// Minimum breakout strength (in ATR units) to advance to CONFIRMED
const MIN_BREAKOUT_ATR_MULTIPLE = 0.3;

// Max bars after a breakout for a failed retest to still FAIL the pattern
const FALSE_BREAK_LOOKBACK_BARS = 3;

// ── Advance from FORMING to DETECTED ─────────────────────────────────────────
// A pattern moves to DETECTED when its geometry strength exceeds the minimum.
// Geometry strength comes from the existing detector (PatternResult.strength).
export function evaluateDetected(geometry: PatternResult): PatternStatus {
  if (geometry.strength >= MIN_GEOMETRY_STRENGTH_FOR_DETECTED) return 'DETECTED';
  return 'FORMING';
}

// ── Detect breakout state ─────────────────────────────────────────────────────
// Reads the candles after the pattern formed to detect a close-based breakout.
// Does NOT recompute swing points — uses the pre-computed breakoutLevel.
//
// Rules (close-based, not wick-only):
//   Bullish: close > breakoutLevel by at least MIN_BREAKOUT_ATR_MULTIPLE × ATR
//   Bearish: close < breakoutLevel by at least MIN_BREAKOUT_ATR_MULTIPLE × ATR
//   Neutral: either direction
export function detectBreakout(
  candles:        Candle[],
  currentBar:     number,
  breakoutLevel:  number,
  direction:      'bullish' | 'bearish' | 'neutral',
  atr:            number,
  vol20Avg:       number,
): BreakoutState {
  const minBreakout = MIN_BREAKOUT_ATR_MULTIPLE * atr;

  for (let i = 1; i <= Math.min(5, currentBar); i++) {
    const bar = currentBar - i + 1;
    if (bar < 0 || bar >= candles.length) continue;
    const c = candles[bar];

    const closedAbove = c.close - breakoutLevel >= minBreakout;
    const closedBelow = breakoutLevel - c.close >= minBreakout;

    const isBreakout =
      direction === 'bullish' ? closedAbove :
      direction === 'bearish' ? closedBelow :
      closedAbove || closedBelow;

    if (!isBreakout) continue;

    const strength = direction === 'bullish'
      ? Math.min(1, (c.close - breakoutLevel) / (atr * 2))
      : direction === 'bearish'
      ? Math.min(1, (breakoutLevel - c.close) / (atr * 2))
      : Math.min(1, Math.abs(c.close - breakoutLevel) / (atr * 2));

    const volRatio = vol20Avg > 0 ? c.volume / vol20Avg : 1;

    // False breakout check: did the close return inside the pattern within 3 bars?
    let falseBreakout = false;
    for (let j = bar + 1; j <= Math.min(bar + FALSE_BREAK_LOOKBACK_BARS, currentBar); j++) {
      if (j >= candles.length) break;
      const fc = candles[j];
      const returnedInside =
        direction === 'bullish' ? fc.close < breakoutLevel :
        direction === 'bearish' ? fc.close > breakoutLevel :
        false;
      if (returnedInside) { falseBreakout = true; break; }
    }

    return {
      hasBreakout:      true,
      breakoutBar:      bar,
      breakoutPrice:    c.close,
      breakoutStrength: strength,
      isCloseBreakout:  true,
      volumeAtBreakout: volRatio,
      falseBreakout};
  }

  return {
    hasBreakout:      false,
    breakoutBar:      null,
    breakoutPrice:    null,
    breakoutStrength: 0,
    isCloseBreakout:  false,
    volumeAtBreakout: null,
    falseBreakout:    false};
}

// ── Detect retest state ───────────────────────────────────────────────────────
// After a confirmed breakout, price often retests the breakout level.
// A SUCCESSFUL retest = price touched the level and bounced (still on breakout side).
// A FAILED retest = price closed back through the breakout level.
export function detectRetest(
  candles:        Candle[],
  breakoutBar:    number,
  breakoutLevel:  number,
  direction:      'bullish' | 'bearish' | 'neutral',
  atr:            number,
  currentBar:     number,
): RetestState {
  const retestZone = atr * 0.5; // within 0.5 ATR of the breakout level

  for (let i = breakoutBar + 1; i <= currentBar && i < candles.length; i++) {
    const c = candles[i];
    const nearLevel = Math.abs(c.low - breakoutLevel) <= retestZone ||
                      Math.abs(c.high - breakoutLevel) <= retestZone ||
                      Math.abs(c.close - breakoutLevel) <= retestZone;
    if (!nearLevel) continue;

    // Did it close back through? → failed retest
    const closedThrough =
      direction === 'bullish' ? c.close < breakoutLevel - retestZone :
      direction === 'bearish' ? c.close > breakoutLevel + retestZone :
      false;

    if (closedThrough) {
      return {
        hasRetest: true, retestBar: i, retestPrice: c.close,
        retestSuccess: false, retestFailed: true};
    }

    // Bounced from the level (close still on breakout side) → successful retest
    const bouncedFromLevel =
      direction === 'bullish' ? c.close > breakoutLevel :
      direction === 'bearish' ? c.close < breakoutLevel :
      false;

    if (bouncedFromLevel) {
      return {
        hasRetest: true, retestBar: i, retestPrice: c.close,
        retestSuccess: true, retestFailed: false};
    }
  }

  return {
    hasRetest: false, retestBar: null, retestPrice: null,
    retestSuccess: false, retestFailed: false};
}

// ── Check whether a pattern has expired ──────────────────────────────────────
// A detected pattern expires if the expected move does not materialise
// within maxAgeBars. Confirmed patterns do NOT expire (the move already happened).
// Failed patterns do NOT expire (they are already terminal).
export function isExpired(
  detectedAtBar: number,
  currentBar:    number,
  maxAgeBars:    number,
  status:        PatternStatus,
): boolean {
  if (status === 'CONFIRMED' || status === 'FAILED' || status === 'EXPIRED') return false;
  return (currentBar - detectedAtBar) >= maxAgeBars;
}

// ── Determine lifecycle status ────────────────────────────────────────────────
// The final state given all the evidence.
export function determineLifecycleStatus(
  geometryStatus: PatternStatus,
  breakout:       BreakoutState,
  retest:         RetestState,
): PatternStatus {
  // Not even detected yet
  if (geometryStatus === 'FORMING') return 'FORMING';

  // Detected but no breakout yet
  if (!breakout.hasBreakout) return 'DETECTED';

  // False breakout → immediately fail
  if (breakout.falseBreakout) return 'FAILED';

  // Failed retest → fail after breakout
  if (retest.retestFailed) return 'FAILED';

  // Successful breakout (+ optional successful retest) → confirmed
  return 'CONFIRMED';
}
