// ─────────────────────────────────────────────────────────────────────────────
// CONFIDENCE TYPES  (v5.4.0)
//
// No new ML features. No retraining. Consumes existing prediction + engine outputs.
// ─────────────────────────────────────────────────────────────────────────────

// ── Scoring version ──────────────────────────────────────────────────────────
// Increment when ANY of the following change:
//   - dimension weights in confidenceScore.ts
//   - PAT_CORR correlation discount
//   - corroboration weights in confidenceEngine.ts
//   - addition or removal of a dimension
//   - grade thresholds
// Every PatternOutcome stores the version that produced its confirmationConfidence.
// This ensures Phase 3 experiments can compare outcomes from the same scoring
// formula without mixing results from different versions.
//
// History:
//   v1 (v6.3.28): baseline — 8 dims + patternValidation(0.05), PAT_CORR=0.75,
//                 corroboration [1.0, 0.30, 0.15], cap 100
export const CONFIDENCE_SCORING_VERSION = 1 as const;

// ── Per-dimension confidence (0–100) ─────────────────────────────────────────
// Each dimension answers: "how much does THIS category of evidence support
// the current directional prediction?"
// All values are 0–100 (percentages).
export type ConfidenceDimensions = {
  mlModel:   number;  // from MLPrediction.confidenceBreakdown.finalConfidence
  trend:     number;  // trendStrength × persistence × MTF trendAlign
  structure: number;  // MS structureQuality × BOS confidence × swing strength
  smc:       number;  // OB confidence × freshness × PD bias alignment
  fvg:       number;  // FVG confidence × fill% × bias alignment
  volume:    number;  // VWAP confidence × profile bias alignment
  mtf:       number;  // |MTF overall score| × 100
  regime:    number;  // regime confidence × regime alignment with direction
};

// ── Overall output ────────────────────────────────────────────────────────────
export type ConfidenceResult = {
  // Per-direction confidence (0–100)
  buyConfidence:  number;
  sellConfidence: number;
  holdConfidence: number;

  // Breakdown
  dimensions: ConfidenceDimensions;
  overall:    number;   // CONFIDENCE_SCORING_V1 weighted composite

  // Trade quality grade
  grade: 'A+' | 'A' | 'B' | 'C' | 'D';

  // Recommendation
  recommendation: 'STRONG BUY' | 'BUY' | 'WEAK BUY' | 'HOLD' | 'WEAK SELL' | 'SELL' | 'STRONG SELL';

  // Risk tier
  risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';
  // Version of the scoring formula that produced this result.
  // Set by computeConfidence() in confidenceEngine.ts, not by scoreConfidence() directly.
  // Optional so scoreConfidence() (pure math) doesn't need to import the constant.
  scoringVersion?: number;
};

// ── Input bag — all consumed from existing outputs ────────────────────────────
export type ConfidenceInputs = {
  // ML model outputs (from MLPrediction)
  mlFinalConfidence:  number;   // 0–100, confidenceBreakdown.finalConfidence
  ensembleProbUp:     number;   // 0–1
  direction:          'UP' | 'DOWN' | 'NEUTRAL';
  ensembleAgree:      boolean;
  walkForwardAccuracy:number;   // 0–100 (%)
  riskScore:          number;   // 0–1 from existing model risk logic

  // Market Structure (from msStructure.scoresArr)
  msStructureQuality: number;   // 0–1
  msBOSConfidence:    number;   // 0–1
  msSwingStrength:    number;   // 0–1
  msTrendStrength:    number;   // -1 to +1
  msTrendPersistence: number;   // 0–1
  msTrendConfidence:  number;   // 0–1

  // SMC (from smcData.smcScoresArr)
  smcOBConfidence:    number;   // 0–1
  smcOBFreshness:     number;   // 0 or 1
  smcPDBias:          number;   // -1 to +1
  smcBullOBStrength:  number;   // 0–1
  smcBearOBStrength:  number;   // 0–1
  smcLiquidityScore:  number;   // 0–1
  smcStopHuntProb:    number;   // 0–1

  // FVG (from fvgData.fvgScoresArr)
  fvgConfidence:      number;   // 0–1
  fvgBias:            number;   // -1 to +1
  fvgFillPct:         number;   // 0–1

  // Volume/VWAP (from vwapData.snapshots + vpData)
  vwapConfidence:     number;   // 0–1
  vpProfileBias:      number;   // -1 to +1
  hvnProximity:       number;   // 0–1

  // MTF (from mtfData.mtfScoresArr)
  mtfOverallScore:    number;   // -1 to +1
  mtfTrendAlign:      number;   // -1 to +1
  mtfHTFBias:         number;   // -1 to +1

  // Regime (from regimeData.scoresArr)
  regimeConfidence:   number;   // 0–1
  regimeBullScore:    number;   // 0–1
  regimeBearScore:    number;   // 0–1
  regimeVolatility:   number;   // 0–1
  regimeBreakout:     number;   // 0–1
  regimeMeanRev:      number;   // 0–1
};
