// ─────────────────────────────────────────────────────────────────────────────
// XAI ENGINE  (v5.3.0)
//
// Consumes EXISTING prediction outputs — no model re-pass, no new features.
// O(F) where F = number of features (116). Zero ML training impact.
//
// Input contract:
//   features: number[]         — raw feature vector (length 116)
//   featureNames: string[]     — FEATURE_NAMES from mlSignal
//   inputImportance: number[]  — |W1| column sums from MLP (already computed)
//   normalizedFeatures: number[]— z-score normalized feature vector
//   prediction: MLPrediction   — existing prediction result
// ─────────────────────────────────────────────────────────────────────────────
import {
  AttributedFeature, FeatureGroup, RiskFlag, XAIExplanation,
  FEATURE_GROUP_MAP,
} from './xaiTypes';
import {
  featureDirection, buildSentence, computeRiskLevel,
  buildRiskSentence, buildConfidenceLines, computeGroupScores,
} from './xaiScore';

// Assign FeatureGroup to a 0-based feature index
function getGroup(idx: number): FeatureGroup {
  for (const [group, [lo, hi]] of Object.entries(FEATURE_GROUP_MAP) as [FeatureGroup, [number,number]][]) {
    if (idx >= lo && idx <= hi) return group;
  }
  return 'Trend'; // fallback
}

// ── Main: generate full XAI explanation ──────────────────────────────────────
// Complexity: O(F log F) — one sort over 116 features.
export function explainPrediction(params: {
  features:           number[];
  featureNames:       string[];
  inputImportance:    number[];
  normalizedFeatures: number[];
  direction:          'UP' | 'DOWN' | 'NEUTRAL';
  probability:        number;
  smcScores?:  { bullOBStrength: number; bearOBStrength: number; obFreshness: number; liquiditySweep: number; stopHuntProb: number; fvgFilledProxy: number };
  fvgFillPct?: number;
  mtfOverall?: number;
  regimeScores?: { volatilityScore: number; meanRevScore: number; confidence: number; breakoutScore: number };
}): XAIExplanation {
  const { features, featureNames, inputImportance, normalizedFeatures,
          direction, probability } = params;

  // ── Step 1: Build attributed features (O(F)) ──────────────────────────────
  const attributed: AttributedFeature[] = featureNames.map((name, i) => {
    const value     = features[i] ?? 0;
    const influence = (inputImportance[i] ?? 0) * Math.abs(normalizedFeatures[i] ?? 0);
    const dir       = featureDirection(name, value);
    const sentence  = buildSentence(name, value);
    return { index: i, name, group: getGroup(i), value, influence, direction: dir, sentence };
  });

  // ── Step 2: Sort by influence, take top 10 ────────────────────────────────
  const sorted = [...attributed].sort((a, b) => b.influence - a.influence);
  const topFeatures = sorted.slice(0, 10);

  // ── Step 3: Split into directional buckets ────────────────────────────────
  const bullishFactors = attributed
    .filter(f => f.direction === 'bullish' && f.influence > 0 && f.sentence)
    .sort((a, b) => b.influence - a.influence)
    .slice(0, 5);
  const bearishFactors = attributed
    .filter(f => f.direction === 'bearish' && f.influence > 0 && f.sentence)
    .sort((a, b) => b.influence - a.influence)
    .slice(0, 5);
  const neutralFactors = topFeatures
    .filter(f => f.direction === 'neutral' && f.sentence)
    .slice(0, 3);

  // ── Step 4: Human-readable summary (XAI_SCORING_V1) ─────────────────────
  // Only sentences from top features, de-duplicated, non-empty
  const primaryFactors = direction === 'UP' ? bullishFactors : direction === 'DOWN' ? bearishFactors : topFeatures;
  const summaryLines = [...new Set(
    primaryFactors
      .map(f => f.sentence)
      .filter(Boolean)
      .slice(0, 5)
  )];

  // ── Step 5: Risk flags (threshold checks — XAI_SCORING_V1) ───────────────
  const flags: RiskFlag[] = [];

  // mtfOverall: |value| < 0.2 → weak HTF agreement
  const mtfOverall = params.mtfOverall ?? (features[106] ?? 0); // feature 107 = MTF overall score (index 106)
  if (Math.abs(mtfOverall) < 0.2) flags.push('WEAK_HTF_AGREE');

  // Counter-trend: signal UP but mtfOverall negative, or DOWN but positive
  if (direction === 'UP'   && mtfOverall < -0.2) flags.push('COUNTER_TREND');
  if (direction === 'DOWN' && mtfOverall >  0.2) flags.push('COUNTER_TREND');

  // High volatility: regime volatility score > 0.7 (feature index 114)
  const regimeVol = params.regimeScores?.volatilityScore ?? (features[114] ?? 0);
  if (regimeVol > 0.7) flags.push('HIGH_VOLATILITY');

  // Breakout env: feature 112 (breakout score, index 112)
  const breakoutScore = params.regimeScores?.breakoutScore ?? (features[112] ?? 0);
  if (breakoutScore > 0.5) flags.push('BREAKOUT_ENV');

  // Mean reversion env: feature 113 (meanRevScore, index 113)
  const meanRevScore = params.regimeScores?.meanRevScore ?? (features[113] ?? 0);
  if (meanRevScore > 0.5) flags.push('MEAN_REVERSION_ENV');

  // Low regime confidence: feature 115 (regimeConfidence, index 115)
  const regimeConf = params.regimeScores?.confidence ?? (features[115] ?? 0);
  if (regimeConf < 0.3) flags.push('LOW_REGIME_CONF');

  // Fresh OB absent: direction = UP but no bullish OB (SMC feature index 65 = bullOBStrength)
  const bullOBStr = params.smcScores?.bullOBStrength ?? (features[65] ?? 0);
  const obFresh   = params.smcScores?.obFreshness    ?? (features[76] ?? 0);
  if (direction === 'UP' && (bullOBStr < 0.15 || obFresh < 0.5)) flags.push('FRESH_OB_ABSENT');

  // FVG filled: FVG fill pct > 0.9 (index 82)
  const fvgFill = params.fvgFillPct ?? (features[82] ?? 0);
  if (fvgFill > 0.9) flags.push('FVG_FILLED');

  // ── Step 6: Group scores ──────────────────────────────────────────────────
  const groupScores = computeGroupScores(attributed);

  // ── Step 7: Risk summary ──────────────────────────────────────────────────
  const riskLevel   = computeRiskLevel(flags);
  const riskSentence = buildRiskSentence(riskLevel, flags);

  // ── Step 8: Confidence ────────────────────────────────────────────────────
  const confidenceLines = buildConfidenceLines(probability, direction);

  return {
    topFeatures, groupScores,
    bullishFactors, bearishFactors, neutralFactors,
    summaryLines, riskLevel, riskFlags: flags,
    riskSentence, confidenceLines,
    direction, probability,
  };
}
