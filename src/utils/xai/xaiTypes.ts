// ─────────────────────────────────────────────────────────────────────────────
// XAI TYPES  (v5.3.0)
//
// No new ML features. No retraining. Consumes existing prediction outputs.
// ─────────────────────────────────────────────────────────────────────────────

// Feature group taxonomy — maps every feature index (1-based) to a group
export type FeatureGroup =
  | 'Returns' | 'Momentum' | 'Volatility' | 'Volume'
  | 'Trend' | 'Time' | 'Price' | 'Pattern'
  | 'Structure' | 'SMC' | 'FVG' | 'VWAP' | 'MTF' | 'Regime';

// Which indices (0-based) belong to each group
export const FEATURE_GROUP_MAP: Record<FeatureGroup, [number, number]> = {
  Returns:   [0,  4],   // features 1–5
  Momentum:  [5,  12],  // features 6–13
  Volatility:[13, 16],  // features 14–17
  Volume:    [17, 21],  // features 18–22
  Trend:     [22, 28],  // features 23–29
  Time:      [29, 30],  // features 30–31
  Price:     [31, 37],  // features 32–38
  Pattern:   [38, 45],  // features 39–46
  Structure: [46, 64],  // features 47–65
  SMC:       [65, 78],  // features 66–79
  FVG:       [79, 86],  // features 80–87
  VWAP:      [87, 97],  // features 88–98
  MTF:       [98, 107], // features 99–108
  Regime:    [108,115], // features 109–116
};

// A single explained feature
export type AttributedFeature = {
  index:     number;   // 0-based
  name:      string;
  group:     FeatureGroup;
  value:     number;   // raw feature value
  influence: number;   // non-negative importance score
  direction: 'bullish' | 'bearish' | 'neutral';
  sentence:  string;   // human-readable explanation (data-driven, no hallucination)
};

// ── Risk flags (objective threshold checks, not heuristic) ───────────────────
export type RiskFlag =
  | 'COUNTER_TREND'     // signal direction opposes MTF alignment
  | 'HIGH_VOLATILITY'   // regime volatility score > 0.7
  | 'LOW_REGIME_CONF'   // regime confidence < 0.3
  | 'WEAK_HTF_AGREE'    // |MTF overall score| < 0.2
  | 'MEAN_REVERSION_ENV'// regime meanRevScore > 0.5
  | 'FRESH_OB_ABSENT'   // direction is BUY but no fresh bullish OB
  | 'FVG_FILLED'        // nearest FVG is fully filled
  | 'BREAKOUT_ENV';     // regime = BREAKOUT (higher risk, both ways)

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'VERY_HIGH';

// ── Full XAI explanation ──────────────────────────────────────────────────────
export type XAIExplanation = {
  // Top contributing features (up to 10), sorted by influence desc
  topFeatures:     AttributedFeature[];
  // Grouped attribution
  groupScores:     Record<FeatureGroup, number>;  // 0–1 group-level influence
  // Directional factors
  bullishFactors:  AttributedFeature[];
  bearishFactors:  AttributedFeature[];
  neutralFactors:  AttributedFeature[];
  // Human-readable summary lines (data-driven only)
  summaryLines:    string[];
  // Risk
  riskLevel:       RiskLevel;
  riskFlags:       RiskFlag[];
  riskSentence:    string;
  // Confidence breakdown
  confidenceLines: string[];
  // Prediction metadata
  direction:       'UP' | 'DOWN' | 'NEUTRAL';
  probability:     number;   // 0–1
};
