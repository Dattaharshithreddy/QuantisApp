// ─────────────────────────────────────────────────────────────────────────────
// PATTERN VALIDATION FRAMEWORK — Public Entry Point  (v6.3.18)
//
// This is the ONLY function consumers call. Everything else in this folder
// is internal implementation.
//
// Usage:
//   import { validatePattern } from './patternValidation/validatePattern';
//
//   const result = validatePattern(geometry, candles, {
//     candles, currentBar, atr,
//     precomputed: { rsi, macdHist, adxValue, obv, cmf } // optional
//   });
//
// The framework is COMPLETELY GENERIC:
//   - Geometry detectors only need to return PatternResult (chartPatterns.ts type)
//   - All 8 validation components, lifecycle, and risk management run automatically
//   - Adding a new pattern: implement its geometry detector, call validatePattern()
//   - No changes to this file or any other framework file are needed
//
// Architecture:
//   PatternResult (geometry) ─→ patternLifecycle.ts (FORMING/DETECTED/CONFIRMED/FAILED)
//                             ─→ patternValidationEngine.ts (8-component weighted scorer)
//                             ─→ patternRiskEngine.ts (entry/SL/TP/RR)
//                             ─→ ValidatedPattern (returned to caller)
// ─────────────────────────────────────────────────────────────────────────────

import { PatternResult } from '../chartPatterns';
import { atr as atrFn } from '../technicalIndicators';
import {
  ValidatedPattern, PatternValidationContext,
  confidenceTier, VALIDATION_WEIGHTS,
  PATTERN_VALIDATION_VERSION, PATTERN_EXPIRY_BARS, DEFAULT_PATTERN_EXPIRY_BARS,
  ConfidenceSnapshot, ComponentScores,
} from './patternValidationTypes';
import {
  evaluateDetected, detectBreakout, detectRetest, determineLifecycleStatus, isExpired,
} from './patternLifecycle';
import { computeValidationBreakdown } from './patternValidationEngine';
import { computePatternRisk } from './patternRiskEngine';

// Minimum confidence to be tradeable (IGNORE tier below this)
export const MIN_TRADEABLE_CONFIDENCE = 60;

// ── Build stable patternId ──────────────────────────────────────────────────
// Uses the anchor bar timestamp (oldest keyPoint) so the ID is stable across
// re-runs. If no keyPoints exist, falls back to detectedAtBar timestamp.
// Format: SYMBOL-TIMEFRAME-PatternName-timestamp
// Example: BTCUSDT-15m-DoubleBottom-1720602000
function buildPatternId(
  patternName: string,
  candles:     { time: number }[],
  bar:         number,
  symbol:      string,
  timeframe:   string,
  keyPoints?:  { barIndex: number }[],
): string {
  const anchorBar = keyPoints && keyPoints.length > 0
    ? Math.min(...keyPoints.map(p => p.barIndex))
    : bar;
  const anchorTs  = candles[Math.min(anchorBar, candles.length - 1)]?.time ?? 0;
  // Normalise pattern name: spaces → underscores, & → and
  const safeName  = patternName.replace(/&/g, 'and').replace(/[^A-Za-z0-9]+/g, '_');
  return `${symbol}-${timeframe}-${safeName}-${anchorTs}`;
}

// ── Internal: compute 20-bar volume average at a given bar ────────────────────
function vol20Avg(candles: { volume: number }[], bar: number): number {
  const start = Math.max(0, bar - 19);
  let sum = 0;
  for (let i = start; i <= bar; i++) sum += candles[i].volume;
  return sum / (bar - start + 1) || 1;
}

// ── Internal: extract breakout level from geometry ───────────────────────────
// Derives the breakout level from the geometry's keyPoints or stopLevel.
// Neckline = the price level the pattern needs to close beyond.
function extractBreakoutLevel(geometry: PatternResult): number | null {
  const kp = geometry.keyPoints ?? [];

  // Prefer neckline keypoints (named in geometry detectors)
  const nkLeft  = kp.find(p => p.role === 'necklineLeft');
  const nkRight = kp.find(p => p.role === 'necklineRight');
  if (nkLeft && nkRight) {
    // Use the most recent (right) neckline as the breakout level
    return nkRight.price;
  }

  // For triangles / channels: use the relevant trendline at current bar
  const upperEnd = kp.find(p => p.role === 'upperEnd');
  const lowerEnd = kp.find(p => p.role === 'lowerEnd');
  if (geometry.direction === 'bullish' && upperEnd) return upperEnd.price;
  if (geometry.direction === 'bearish' && lowerEnd) return lowerEnd.price;
  if (geometry.direction === 'bullish' && lowerEnd) return lowerEnd.price; // ascending triangle support

  // Cup & Handle: rim level
  const cupRimRight = kp.find(p => p.role === 'cupRimRight');
  if (cupRimRight) return cupRimRight.price;

  // Flag / pennant: use pattern target reduced to the pole tip
  const poleTip = kp.find(p => p.role === 'poleTip');
  if (poleTip) return poleTip.price;

  // Fallback: use the geometry's stopLevel as the breakout reference
  return geometry.stopLevel ?? null;
}

// ── Main export ────────────────────────────────────────────────────────────────
/**
 * Validates a detected chart pattern geometry through the full 8-component
 * pipeline and returns a complete ValidatedPattern result.
 *
 * @param geometry   The PatternResult from any geometry detector (chartPatterns.ts)
 * @param ctx        Context: candles, currentBar, ATR, optional pre-computed values
 * @returns          ValidatedPattern with confidence, lifecycle, risk, and breakdown
 */
export function validatePattern(
  geometry:  PatternResult,
  ctx:       PatternValidationContext,
  symbol:    string = 'UNKNOWN',
  timeframe: string = 'UNKNOWN',
): ValidatedPattern {
  const { candles, currentBar } = ctx;
  const bar  = Math.min(currentBar, candles.length - 1);
  const price = candles[bar].close;

  // ── ATR: use provided or compute on-the-fly ──────────────────────────────
  const atrArr = atrFn(candles.slice(0, bar + 1));
  const atr    = ctx.atr > 0 ? ctx.atr : (atrArr[atrArr.length - 1] ?? price * 0.01);

  // ── Step 1: geometry → lifecycle (FORMING / DETECTED) ───────────────────
  const geometryStatus  = evaluateDetected(geometry);
  const breakoutLevel   = extractBreakoutLevel(geometry);

  // ── Step 2: detect breakout ──────────────────────────────────────────────
  const volAvg    = vol20Avg(candles, bar);
  const breakout  = breakoutLevel != null
    ? detectBreakout(candles, bar, breakoutLevel, geometry.direction, atr, volAvg)
    : {
        hasBreakout: false, breakoutBar: null, breakoutPrice: null,
        breakoutStrength: 0, isCloseBreakout: false,
        volumeAtBreakout: null, falseBreakout: false};

  // ── Step 3: detect retest (only relevant post-breakout) ─────────────────
  const retest = (breakout.hasBreakout && breakoutLevel != null && breakout.breakoutBar != null)
    ? detectRetest(candles, breakout.breakoutBar, breakoutLevel, geometry.direction, atr, bar)
    : { hasRetest: false, retestBar: null, retestPrice: null, retestSuccess: false, retestFailed: false };

  // ── Step 4: final lifecycle state ────────────────────────────────────────
  const status = determineLifecycleStatus(geometryStatus, breakout, retest);

  // ── Step 5: 8-component confidence scoring ───────────────────────────────
  const { breakdown, totalConfidence } = computeValidationBreakdown(
    geometry, breakoutLevel, breakout, retest, { ...ctx, currentBar: bar, atr },
  );

  // ── Step 6: false-breakout penalty on confidence ─────────────────────────
  const confidence = status === 'FAILED'
    ? Math.min(totalConfidence, 15)  // hard cap on failed patterns
    : totalConfidence;

  // ── Step 6b: expiry ──────────────────────────────────────────────────────
  const maxAgeBars    = PATTERN_EXPIRY_BARS[geometry.name] ?? DEFAULT_PATTERN_EXPIRY_BARS;
  const detectedAtBar = bar; // bar at which this geometry was first seen
  const expiresAtBar  = detectedAtBar + maxAgeBars;
  const expired       = isExpired(detectedAtBar, bar, maxAgeBars, status);
  const finalStatus   = expired ? 'EXPIRED' : status;

  // ── Step 6c: patternId ────────────────────────────────────────────────────
  const patternId = buildPatternId(
    geometry.name, candles, bar, symbol, timeframe, geometry.keyPoints,
  );

  // ── Step 6d: componentScores (for AI explainability) ─────────────────────
  const componentScores: ComponentScores = {
    trend:          Math.round(breakdown.trend.weightedScore),
    volume:         Math.round(breakdown.volume.weightedScore),
    breakout:       Math.round(breakdown.breakout.weightedScore),
    retest:         Math.round(breakdown.retest.weightedScore),
    momentum:       Math.round(breakdown.momentum.weightedScore),
    candlestick:    Math.round(breakdown.candlestick.weightedScore),
    supportResist:  Math.round(breakdown.supportResist.weightedScore),
    patternQuality: Math.round(breakdown.patternQuality.weightedScore)};

  // ── Step 6e: confidence snapshot (caller accumulates history) ────────────
  const currentSnapshot: ConfidenceSnapshot = {
    bar:        bar,
    confidence,
    status:     finalStatus,
    timestamp:  Date.now()};

  // ── Step 7: risk management ──────────────────────────────────────────────
  // Only compute risk when:
  //   - Pattern is at least DETECTED
  //   - Confidence ≥ MIN_TRADEABLE_CONFIDENCE
  const risk = (finalStatus === 'DETECTED' || finalStatus === 'CONFIRMED') && confidence >= MIN_TRADEABLE_CONFIDENCE
    ? computePatternRisk(geometry, breakout, atr, price)
    : null;

  // ── Step 8: directional probabilities ────────────────────────────────────
  const confNorm = confidence / 100;
  const bullishProbability = geometry.direction === 'bullish' ? confNorm
    : geometry.direction === 'bearish' ? 1 - confNorm
    : 0.5;
  const bearishProbability = 1 - bullishProbability;

  // ── Step 9: aggregate reasons and failed conditions ───────────────────────
  const allReasons: string[]  = [];
  const allFailed:  string[]  = [];
  for (const comp of Object.values(breakdown)) {
    allReasons.push(...comp.reasons);
    allFailed.push(...comp.failedConditions);
  }

  // ── Assemble result ───────────────────────────────────────────────────────
  return {
    patternName:  geometry.name,
    direction:    geometry.direction,
    patternId,
    patternValidationVersion: PATTERN_VALIDATION_VERSION,
    status:       finalStatus,
    confidence,
    tier:         confidenceTier(confidence),
    bullishProbability: Math.round(bullishProbability * 1000) / 1000,
    bearishProbability: Math.round(bearishProbability * 1000) / 1000,
    breakout,
    retest,
    risk,
    maxAgeBars,
    expiresAtBar,
    scoreHistory:    [currentSnapshot],
    componentScores,
    breakoutLevel,
    stopLoss:     geometry.stopLevel ?? null,
    reasons:      allReasons,
    failedConditions: allFailed,
    validationBreakdown: breakdown,
    metadata: {
      geometryStrength:   geometry.strength,
      geometryScore:      geometry.score,
      detectedAtBar:      bar,
      patternAgeInBars:   (geometry.keyPoints?.length ?? 0) > 0
        ? bar - Math.min(...(geometry.keyPoints ?? []).map(p => p.barIndex))
        : 0,
      keyPointCount:      geometry.keyPoints?.length ?? 0,
      // validationDuration: bars from FORMING to CONFIRMED.
      // Only set when finalStatus === 'CONFIRMED'. Uses ctx.formingBar when
      // the caller knows it; otherwise estimated from oldest keyPoint bar.
      validationDuration: finalStatus === 'CONFIRMED'
        ? bar - (ctx.formingBar ?? (
            (geometry.keyPoints?.length ?? 0) > 0
              ? Math.min(...(geometry.keyPoints ?? []).map(p => p.barIndex))
              : bar
          ))
        : null}};
}

// ── Batch validation: validate all detected patterns in a ChartPatternSummary ──
/**
 * Validates every pattern returned by detectChartPatterns() in one call.
 * Returns patterns sorted by confidence (highest first).
 * Patterns with status FAILED or confidence < MIN_TRADEABLE_CONFIDENCE are
 * still returned (with their status) so the UI can show why they were rejected.
 */
export function validateAllPatterns(
  patterns:  PatternResult[],
  ctx:       PatternValidationContext,
  symbol:    string = 'UNKNOWN',
  timeframe: string = 'UNKNOWN',
): ValidatedPattern[] {
  return patterns
    .map(p => validatePattern(p, ctx, symbol, timeframe))
    .sort((a, b) => b.confidence - a.confidence);
}

// ── Weight sanity check (run once at import time in development) ───────────────
if (__DEV__) {
  const weightSum = Object.values(VALIDATION_WEIGHTS).reduce((s, v) => s + v, 0);
  const diff = Math.abs(weightSum - 1.0);
  if (diff > 0.001) {
    console.warn(
      `[PatternValidation] VALIDATION_WEIGHTS sum = ${weightSum.toFixed(4)}, expected 1.0. ` +
      `Adjust weights in patternValidationTypes.ts.`
    );
  }
}
