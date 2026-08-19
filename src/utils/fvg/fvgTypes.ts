// ─────────────────────────────────────────────────────────────────────────────
// FVG TYPES  (v4.9.0)
//
// Detection / Scoring separation enforced (same rule as SMC):
//   DetectedFVG — objective facts from OHLCV only
//   ScoredFVG   — heuristic layer, versioned as FVG_SCORING_V1
// ─────────────────────────────────────────────────────────────────────────────

// ── OBJECTIVE DETECTION ───────────────────────────────────────────────────────
// Bullish FVG: candles[i-2].low > candles[i].high
//   — gap between the low of two bars ago and the high of today
//   — price "missed" this zone going up; it tends to act as support on pullback
// Bearish FVG: candles[i-2].high < candles[i].low
//   — gap between the high of two bars ago and the low of today
//   — price "missed" this zone going down; tends to act as resistance on bounce
// Both definitions are ICT mechanical rules, derivable solely from OHLCV.

export type FVGDirection = 'bullish' | 'bearish';

// Fill status — deterministic:
//   unfilled:  price has not entered the gap at all
//   partial:   price entered but did not close through the opposing boundary
//   filled:    price closed inside or through the entire gap
export type FVGStatus = 'unfilled' | 'partial' | 'filled';

export type DetectedFVG = {
  readonly index:     number;       // bar i where FVG is confirmed (third candle)
  readonly direction: FVGDirection;
  readonly gapHigh:   number;       // top of the gap zone
  readonly gapLow:    number;       // bottom of the gap zone
  readonly gapSize:   number;       // gapHigh - gapLow (absolute)
  // mutable — updated as price advances
  status:         FVGStatus;
  fillPct:        number;           // 0–1, how much of the gap has been covered
  age:            number;           // bars since formation
  // Consecutive FVGs: index of the immediately preceding FVG in same direction
  // null = standalone gap
  readonly prevFVGIndex: number | null;
};

// A cluster: 2+ FVGs in the same direction whose zones overlap or are adjacent
// (gap between them ≤ one ATR). Identified during precomputation.
export type FVGCluster = {
  readonly direction:  FVGDirection;
  readonly clusterHigh:number;
  readonly clusterLow: number;
  readonly count:      number;      // number of FVGs in this cluster
  readonly strength:   number;      // FVG_SCORING_V1 heuristic
};

// ── HEURISTIC SCORING (FVG_SCORING_V1) ───────────────────────────────────────
// Version: FVG_SCORING_V1
// Formula:
//   sizeScore   = min(1, gapSize / (atr * FVG_SIZE_ATR_MULT))
//     — larger gaps relative to ATR are considered more significant
//   freshnessScore = 1 / (1 + age / FVG_HALF_LIFE)
//     — newer FVGs are more relevant (half-life decay)
//   fillScore   = 1 - fillPct
//     — unfilled gaps are more reliable than partially filled ones
//   strength    = sizeScore × 0.45 + freshnessScore × 0.35 + fillScore × 0.20
//   confidence  = strength × (status === 'unfilled' ? 1.0 : 0.6)
//     — partial/filled FVGs get a reliability haircut
//
// Assumptions:
//   - Larger FVGs represent more "imbalance" in price action
//   - Recency matters (institutional memory fades)
//   - Untouched FVGs are more reliable than revisited ones
//
// Configurable thresholds:
//   FVG_SIZE_ATR_MULT = 1.5  (gap must be this fraction of ATR to score as strong)
//   FVG_HALF_LIFE     = 40   (bars at which freshness = 0.5)
//   FVG_CLUSTER_GAP   = 1.0  (ATR multiples — max gap between two FVGs to be clustered)
export type ScoredFVG = DetectedFVG & {
  readonly scoringVersion: 'FVG_SCORING_V1';
  readonly sizeScore:      number;   // 0–1
  readonly freshnessScore: number;   // 0–1
  strength:                number;   // 0–1 (updated each bar as age grows)
  confidence:              number;   // 0–1
};

// ── CONFIG ───────────────────────────────────────────────────────────────────
export type FVGConfig = {
  sizeAtrMult:  number;  // 1.5  — gap/ATR threshold for full sizeScore
  halfLife:     number;  // 40   — freshness half-life in bars
  clusterGapAtr:number;  // 1.0  — max ATR between FVGs to merge into cluster
  maxAge:       number;  // 150  — prune FVGs older than this
  maxActive:    number;  // 40   — max simultaneously tracked FVGs
};

export const DEFAULT_FVG_CONFIG: FVGConfig = {
  sizeAtrMult:  1.5,
  halfLife:     40,
  clusterGapAtr:1.0,
  maxAge:       150,
  maxActive:    40,
};

// ── ML FEATURE SET (8 features, positions 80–87) ─────────────────────────────
export type FVGScores = {
  bullFVGStrength:    number;  // 0–1
  bearFVGStrength:    number;  // 0–1
  nearestFVGDistance: number;  // 0–1 (inverted proximity, normalized by ATR)
  gapFillPct:         number;  // 0–1 (fill % of nearest FVG)
  fvgAge:             number;  // 0–1 (normalized)
  clusterScore:       number;  // 0–1
  fvgConfidence:      number;  // 0–1
  fvgBias:            number;  // -1 to +1 (bull FVG below = +1, bear above = -1)
};

export const FVG_FEATURE_NAMES = [
  'FVG bull strength',     // 80
  'FVG bear strength',     // 81
  'FVG distance',          // 82
  'FVG fill pct',          // 83
  'FVG age',               // 84
  'FVG cluster score',     // 85
  'FVG confidence',        // 86
  'FVG bias',              // 87
] as const;
