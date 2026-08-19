// ─────────────────────────────────────────────────────────────────────────────
// VOLUME TYPES  (v5.0.0)
//
// Detection / Scoring separation enforced throughout.
// ─────────────────────────────────────────────────────────────────────────────

// ── Anchored VWAP ─────────────────────────────────────────────────────────────
// All VWAP calculations are deterministic from OHLCV — no heuristics here.
// Deviation bands use 1σ of volume-weighted price variance — objective.
export type VWAPAnchorType =
  | 'swing_high'    // anchored to the most recent confirmed major swing high
  | 'swing_low'     // anchored to the most recent confirmed major swing low
  | 'session_open'  // anchored to candles[0] (first bar in loaded series)
  | 'weekly'        // anchored to first bar of the current ISO week
  | 'monthly';      // anchored to first bar of the current calendar month

export type AnchoredVWAPResult = {
  readonly anchorType:  VWAPAnchorType;
  readonly anchorBar:   number;           // bar index where VWAP starts
  readonly vwap:        number[];         // per-bar VWAP from anchor to end
  readonly upperDev1:   number[];         // +1σ band
  readonly lowerDev1:   number[];         // -1σ band
  readonly upperDev2:   number[];         // +2σ band
  readonly lowerDev2:   number[];         // -2σ band
};

// Per-bar snapshot for ML / display (last bar value of each anchor)
export type VWAPSnapshot = {
  sessionVWAP:  number;
  swingHighVWAP:number;
  swingLowVWAP: number;
  weeklyVWAP:   number;
  monthlyVWAP:  number;
  upperDev1:    number;
  lowerDev1:    number;
  // slopes (objective: VWAP[i] - VWAP[i-lookback], normalized by ATR)
  sessionSlope: number;
};

// ── Volume Profile ─────────────────────────────────────────────────────────────
// Fully deterministic from OHLCV — distributes each bar's volume across bins
// proportional to the bar's range. No heuristics in detection.
export type VolumeProfileBin = {
  readonly priceLow:  number;
  readonly priceHigh: number;
  readonly midpoint:  number;
  volume:             number;   // accumulated volume for this bin
};

export type VolumeProfileResult = {
  readonly bins:        VolumeProfileBin[];
  readonly poc:         number;   // price of bin with highest volume (Point of Control)
  readonly vah:         number;   // Value Area High (top of 70% volume zone)
  readonly val:         number;   // Value Area Low  (bottom of 70% volume zone)
  readonly hvnPrices:   number[]; // High Volume Nodes (local maxima in profile)
  readonly lvnPrices:   number[]; // Low Volume Nodes  (local minima in profile)
  readonly totalVolume: number;
};

// ── HEURISTIC SCORING (isolated in volumeScore.ts) ───────────────────────────
// VWAP_SCORING_V1: confidence, bias, proximity score
// VP_SCORING_V1:   HVN/LVN proximity score, profile bias

export type ScoredVWAP = {
  readonly scoringVersion: 'VWAP_SCORING_V1';
  readonly distanceNorm:   number;  // |price - sessionVWAP| / ATR, capped [0,1]
  readonly aboveVWAP:      number;  // 1 if above, 0 if below
  readonly slopeNorm:      number;  // normalized slope [-1, +1]
  readonly confidence:     number;  // see VWAP_SCORING_V1 in volumeScore.ts
  readonly bias:           number;  // -1 to +1
};

export type ScoredVP = {
  readonly scoringVersion:  'VP_SCORING_V1';
  readonly pocDistNorm:     number;  // |price - POC| / ATR, capped [0,1]
  readonly vahDistNorm:     number;
  readonly valDistNorm:     number;
  readonly hvnProximity:    number;  // 0–1 (closest HVN)
  readonly lvnProximity:    number;  // 0–1 (closest LVN)
  readonly profileBias:     number;  // -1 to +1
};

// ── ML feature set (11 features, positions 88–98) ─────────────────────────────
export type VolumeScores = {
  distFromVWAP:   number;  // 0–1
  vwapSlope:      number;  // -1 to +1
  aboveVWAP:      number;  // 0 or 1
  belowVWAP:      number;  // 0 or 1
  distFromPOC:    number;  // 0–1
  distFromVAH:    number;  // 0–1
  distFromVAL:    number;  // 0–1
  hvnProximity:   number;  // 0–1
  lvnProximity:   number;  // 0–1
  profileBias:    number;  // -1 to +1
  vwapConfidence: number;  // 0–1
};

export const VOLUME_FEATURE_NAMES = [
  'Vol dist from VWAP',    // 88
  'Vol VWAP slope',        // 89
  'Vol above VWAP',        // 90
  'Vol below VWAP',        // 91
  'Vol dist from POC',     // 92
  'Vol dist from VAH',     // 93
  'Vol dist from VAL',     // 94
  'Vol HVN proximity',     // 95
  'Vol LVN proximity',     // 96
  'Vol profile bias',      // 97
  'Vol VWAP confidence',   // 98
] as const;

// ── Config ────────────────────────────────────────────────────────────────────
export type VolumeConfig = {
  profileBins:      number;  // 24  — price buckets for volume profile
  valueAreaPct:     number;  // 0.70 — 70% of total volume defines value area
  hvnThresholdPct:  number;  // 1.5  — bin is HVN if volume > mean × this
  lvnThresholdPct:  number;  // 0.5  — bin is LVN if volume < mean × this
  slopeLookback:    number;  // 5    — bars for VWAP slope calculation
  devSlopeLookback: number;  // 3    — deviations lookback for smoothing
};

export const DEFAULT_VOLUME_CONFIG: VolumeConfig = {
  profileBins:     24,
  valueAreaPct:    0.70,
  hvnThresholdPct: 1.5,
  lvnThresholdPct: 0.5,
  slopeLookback:   5,
  devSlopeLookback:3,
};
