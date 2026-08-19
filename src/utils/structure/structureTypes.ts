// ─────────────────────────────────────────────────────────────────────────────
// STRUCTURE TYPES — shared type definitions consumed by every structure module.
// Other modules import FROM here; this file imports nothing from QUANTIS itself
// (only the Candle primitive from indicators).
// ─────────────────────────────────────────────────────────────────────────────

// ── Swing ─────────────────────────────────────────────────────────────────────
export type SwingType = 'high' | 'low';

export type Swing = {
  index: number;           // bar index in full candle array
  price: number;           // c[index].high (for highs) or c[index].low (for lows)
  type: SwingType;
  strength: number;        // 0–1  (reaction distance / ATR)
  volumeScore: number;     // 0–1  (volume at swing relative to 20-bar avg)
  age: number;             // bars since this swing was confirmed (i - index)
  touches: number;         // how many times price returned to within 0.5 ATR
  confirmationBars: number;// how many bars after the point confirm it as a swing
};

// ── Structure Labels ──────────────────────────────────────────────────────────
export type StructureLabel = 'HH' | 'HL' | 'LH' | 'LL' | 'HEH' | 'LEL' | 'NONE';
//  HEH = Higher Equal High, LEL = Lower Equal Low (within 0.1% tolerance)

export type StructureBreak = {
  index: number;
  type: 'BOS_BULL' | 'BOS_BEAR' | 'CHOCH_BULL' | 'CHOCH_BEAR';
  breakPrice: number;      // the swing level that was broken
  closePrice: number;      // the close that broke it
  breakStrength: number;   // 0–1  (distance beyond level / ATR)
  volumeConfirmation: number; // 0–1 (volume vs 20-bar avg)
  momentumConfirmation: number; // 0–1 (rate of change at break bar)
  falseBreakProbability: number; // 0–1 (higher = more likely false break)
  confidence: number;      // 0–1 composite
};

// ── Trend Classification ──────────────────────────────────────────────────────
export type TrendClass =
  | 'STRONG_BULL' | 'BULL' | 'WEAK_BULL'
  | 'SIDEWAYS'
  | 'WEAK_BEAR' | 'BEAR' | 'STRONG_BEAR';

export type TrendState = {
  direction: TrendClass;
  strength: number;        // 0–1
  persistence: number;     // 0–1 (how long the trend has been intact)
  acceleration: number;    // -1 to +1 (is trend strengthening or weakening?)
  confidence: number;      // 0–1
  age: number;             // bars since the current trend started
  quality: number;         // 0–1 (clean HH/HL sequence = 1, messy = 0)
};

// ── Full Structure Snapshot at bar i ─────────────────────────────────────────
export type StructureSnapshot = {
  // Swing sequence labels (last two swings of each type)
  highLabel: StructureLabel;   // HH / LH / HEH / NONE
  lowLabel: StructureLabel;    // HL / LL / LEL / NONE

  // HH/HL/LH/LL scores (-1 to +1, signed by direction)
  hhScore: number;   // +strength if HH, else 0
  hlScore: number;   // +strength if HL, else 0
  lhScore: number;   // -strength if LH, else 0
  llScore: number;   // -strength if LL, else 0

  // Structure-based trend
  trend: TrendState;

  // Latest BOS / CHoCH (null if none in recent lookback)
  latestBOS: StructureBreak | null;
  latestCHoCH: StructureBreak | null;

  // Internal vs External structure
  // External: defined by major (lookback=5) swing sequence
  // Internal: defined by minor (lookback=3) swing sequence within the last leg
  externalHighLabel: StructureLabel;
  externalLowLabel: StructureLabel;
  internalHighLabel: StructureLabel;
  internalLowLabel: StructureLabel;

  // Swing failure flag (swing point taken out within N bars = failed swing)
  swingFailure: boolean;
  swingFailureDirection: 'bull' | 'bear' | null;

  // Structure continuation vs reversal probability
  continuationScore: number;   // 0–1
  reversalScore: number;       // 0–1

  // Quality metrics
  structureQuality: number;    // 0–1 (clean / consistent structure)
  structureConfidence: number; // 0–1

  // Age of current structure sequence
  structureAge: number;        // bars since current trend context started
};

// ── Precomputed array stored in S (precomputeSeries return) ──────────────────
export type StructureScores = {
  // ML features (normalized, no lookahead)
  hhScore: number;
  hlScore: number;
  lhScore: number;
  llScore: number;
  trendStrength: number;        // -1 to +1
  trendConfidence: number;      // 0–1
  trendPersistence: number;     // 0–1
  trendAcceleration: number;    // -1 to +1
  bosDetected: number;          // 0 or 1
  bosStrength: number;          // 0–1
  bosConfidence: number;        // 0–1
  chochDetected: number;        // 0 or 1
  chochStrength: number;        // 0–1
  chochConfidence: number;      // 0–1
  swingStrength: number;        // 0–1 (last swing's strength)
  structureQuality: number;     // 0–1
  internalTrend: number;        // -1 to +1
  externalTrend: number;        // -1 to +1
  structureAge: number;         // 0–1 normalized
};
