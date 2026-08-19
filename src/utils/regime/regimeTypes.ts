// ─────────────────────────────────────────────────────────────────────────────
// REGIME TYPES  (v5.2.0)
// ─────────────────────────────────────────────────────────────────────────────

// Mutually-exclusive regime label (deterministic from indicator thresholds)
export type RegimeLabel =
  | 'STRONG_BULL_TREND'
  | 'BULL_TREND'
  | 'WEAK_BULL_TREND'
  | 'SIDEWAYS'
  | 'MEAN_REVERSION'
  | 'BREAKOUT'
  | 'STRONG_BEAR_TREND'
  | 'BEAR_TREND'
  | 'WEAK_BEAR_TREND'
  | 'LOW_VOLATILITY'
  | 'HIGH_VOLATILITY';

// Raw indicator readings at bar i — objective, deterministic from OHLCV
// (all sourced from precomputeSeries, zero re-computation)
export type RegimeInputs = {
  adx:          number;   // 0–100, from S.adxArr[i]
  atr:          number;   // raw ATR, from S.atrArr[i]
  atrNorm:      number;   // ATR / close (normalised)
  bbWidth:      number;   // (BB upper - BB lower) / BB mid — from S.bb[i]
  donchWidth:   number;   // (Donchian upper - lower) / mid — from S.donchianArr[i]
  histVol:      number;   // from S.histVol[i]
  histVolMean:  number;   // 60-bar rolling mean — from S.histVolMean60[i]
  trendStrength:number;   // MS engine trendStrength — from S.msStructure.scoresArr[i]
  mtfOverall:   number;   // MTF overall alignment — from S.mtfData.mtfScoresArr[i]
  // patternBias: confirmed-pattern directional bias, scaled by confidence.
  // = (dir === 'bullish' ? 1 : dir === 'bearish' ? -1 : 0) × (confidence / 100)
  // Only CONFIRMED patterns contribute. Unconfirmed / FORMING = 0.
  // Example: Double Top BEARISH 58/100 → -0.58
  patternBias:  number;   // -1..+1, defaults to 0 when no confirmed pattern
};

// ── REGIME_SCORING_V1 (all heuristics in regimeScore.ts) ─────────────────────
// Detection rule — objective threshold table:
//   ADX ≥ 35  → trending (not sideways)
//   ADX 20–35 → moderate trend
//   ADX < 20  → weak or no trend (sideways / low-vol candidate)
//   bbWidthPct < 0.5 ATR → low volatility / squeeze
//   histVol / histVolMean > 1.8 → high volatility / breakout
//   Both conditions combined with directional bias → final label

// Scored output — every field is heuristic, computed in regimeScore.ts
export type RegimeResult = {
  label:           RegimeLabel;
  bullScore:       number;   // 0–1
  bearScore:       number;   // 0–1
  trendScore:      number;   // 0–1 (signed trend strength, abs)
  sidewaysScore:   number;   // 0–1
  breakoutScore:   number;   // 0–1
  meanRevScore:    number;   // 0–1
  volatilityScore: number;   // 0–1 (high = volatile)
  confidence:      number;   // 0–1
};

// ── ML features (8, positions 109–116) ───────────────────────────────────────
export type RegimeScores = {
  bullScore:       number;   // 0–1
  bearScore:       number;   // 0–1
  trendRegime:     number;   // -1 to +1
  sidewaysScore:   number;   // 0–1
  breakoutScore:   number;   // 0–1
  meanRevScore:    number;   // 0–1
  volatilityScore: number;   // 0–1
  regimeConfidence:number;   // 0–1
};

export const REGIME_FEATURE_NAMES = [
  'Regime bull score',    // 109
  'Regime bear score',    // 110
  'Regime trend',         // 111
  'Regime sideways',      // 112
  'Regime breakout',      // 113
  'Regime mean revert',   // 114
  'Regime volatility',    // 115
  'Regime confidence',    // 115
] as const;

export type RegimeConfig = {
  adxTrendThreshold:   number;  // 35  — ADX above this = strong trend
  adxModThreshold:     number;  // 20  — ADX above this = moderate trend
  bbWidthSqueezeAtr:   number;  // 0.5 — bbWidth < ATR*this = squeeze
  volExpansionMult:    number;  // 1.8 — histVol/mean above this = expansion
  volContractionMult:  number;  // 0.6 — histVol/mean below this = contraction
  mtfAlignThreshold:   number;  // 0.3 — |mtfOverall| above this = aligned
};

export const DEFAULT_REGIME_CONFIG: RegimeConfig = {
  adxTrendThreshold:  35,
  adxModThreshold:    20,
  bbWidthSqueezeAtr:  0.5,
  volExpansionMult:   1.8,
  volContractionMult: 0.6,
  mtfAlignThreshold:  0.3,
};
