// ─────────────────────────────────────────────────────────────────────────────
// CONFIDENCE ENGINE  (v5.4.0)
//
// Assembles ConfidenceInputs from existing engine outputs and calls scoreConfidence.
// O(1) per prediction call — no model passes, no indicator recomputation.
// ─────────────────────────────────────────────────────────────────────────────
import { ConfidenceInputs, ConfidenceResult, CONFIDENCE_SCORING_VERSION } from './confidenceTypes';
import { scoreConfidence } from './confidenceScore';

// Import types only — the engine receives pre-computed snapshots, not raw candles
import type { ConfidenceBreakdown } from '../mlSignal';
import type { ValidatedPattern } from '../patternValidation/patternValidationTypes';

export type { ConfidenceResult };

// ── Slim snapshot types (only the fields we need) ────────────────────────────
type MSSnapshot   = { scoresArr: ({ trendStrength:number; trendPersistence:number; trendConfidence:number; structureQuality:number; bosConfidence:number; swingStrength:number; bosStrength:number } | null)[] };
type SMCSnapshot  = { bullOBStrength:number; bearOBStrength:number; obConfidence:number; obFreshness:number; pdBias:number; liquidityScore:number; stopHuntProb:number } | null;
type FVGSnapshot  = { fvgConfidence:number; fvgBias:number; gapFillPct:number } | null;
type VWAPSnapshot = { sessionVWAP:number } | null;
type VPSnapshot   = { profileBias:number; hvnProximity:number; vwapConfidence:number } | null;
type MTFSnapshot  = { overallMTFScore:number; trendAlignment:number; htfBias:number } | null;
type RegimeSnap   = { confidence:number; bullScore:number; bearScore:number; volatilityScore:number; breakoutScore:number; meanRevScore:number } | null;

export function computeConfidence(
  // ML outputs
  mlBreakdown:        ConfidenceBreakdown,
  ensembleProbUp:     number,
  direction:          'UP' | 'DOWN' | 'NEUTRAL',
  ensembleAgree:      boolean,
  walkForwardAccuracy:number,
  riskScore:          number,
  // Engine snapshots (last bar)
  msStructure:        MSSnapshot,
  barIndex:           number,
  smcSnap:            SMCSnapshot,
  fvgSnap:            FVGSnapshot,
  vwapSnap:           VWAPSnapshot,
  vpSnap:             VPSnapshot,
  mtfSnap:            MTFSnapshot,
  regimeSnap:         RegimeSnap,
  // Optional: best CONFIRMED (or DETECTED) ValidatedPattern for the current bar.
  // Pass null when validateAllPatterns() has not run yet.
  //
  // v6.3.26 review addressed three concerns:
  // [1] OVERLAP: PAT_CORR=0.75 is an engineering estimate, NOT a measured
  //     statistical correlation. Estimated ~24% weighted-avg conceptual overlap
  //     by inspecting indicator lists: BOS/EMA → structure dim (~70% shared);
  //     OBV/CMF → volume dim (~15% shared); RSI/ADX → trend dim (~25% shared).
  //     45% of pattern weight is structurally independent (breakout detection,
  //     retest confirmation, candlestick quality, geometry quality).
  //     Replace PAT_CORR with 1−pearson(patternScore, dimScore) computed from
  //     PatternFamilyStats once sufficient outcome data is available.
  // [2] MULTI-PATTERN: corroboration weights [1.0, 0.30, 0.15] implemented below.
  //     Second same-direction pattern adds 30%, third adds 15%. Cap at 100.
  //     CAVEAT: patterns on the same chart (e.g. Bull Flag + Ascending Triangle)
  //     often share swing points and underlying price action, so 0.30 may
  //     overstate independence. Revisit once outcome data shows whether
  //     multi-pattern signals actually improve TP1 hit rate vs single-pattern.
  //     Opposing patterns not included (opposition handled in scoreConfidence).
  // [3] FIXED HEURISTIC: PAT_CORR will remain 0.75 until PatternFamilyStats
  //     accumulates 20+ resolved outcomes per pattern type. At that point
  //     it can be replaced with empirical (1 − correlation) from real data.
  validatedPatterns?: ValidatedPattern[] | null
): ConfidenceResult {

  const ms = msStructure.scoresArr[barIndex];

  const inp: ConfidenceInputs = {
    // ML
    mlFinalConfidence:  mlBreakdown.finalConfidence,
    ensembleProbUp,
    direction,
    ensembleAgree,
    walkForwardAccuracy,
    riskScore,

    // Market Structure
    msStructureQuality: ms?.structureQuality   ?? 0,
    msBOSConfidence:    ms?.bosConfidence       ?? 0,
    msSwingStrength:    ms?.swingStrength       ?? 0,
    msTrendStrength:    ms?.trendStrength       ?? 0,
    msTrendPersistence: ms?.trendPersistence    ?? 0,
    msTrendConfidence:  ms?.trendConfidence     ?? 0,

    // SMC
    smcOBConfidence:    smcSnap?.obConfidence   ?? 0,
    smcOBFreshness:     smcSnap?.obFreshness    ?? 0,
    smcPDBias:          smcSnap?.pdBias         ?? 0,
    smcBullOBStrength:  smcSnap?.bullOBStrength ?? 0,
    smcBearOBStrength:  smcSnap?.bearOBStrength ?? 0,
    smcLiquidityScore:  smcSnap?.liquidityScore ?? 0,
    smcStopHuntProb:    smcSnap?.stopHuntProb   ?? 0,

    // FVG
    fvgConfidence:      fvgSnap?.fvgConfidence  ?? 0,
    fvgBias:            fvgSnap?.fvgBias        ?? 0,
    fvgFillPct:         fvgSnap?.gapFillPct     ?? 0,

    // Volume / VWAP
    vwapConfidence:     vpSnap?.vwapConfidence  ?? 0,
    vpProfileBias:      vpSnap?.profileBias     ?? 0,
    hvnProximity:       vpSnap?.hvnProximity    ?? 0,

    // MTF
    mtfOverallScore:    mtfSnap?.overallMTFScore ?? 0,
    mtfTrendAlign:      mtfSnap?.trendAlignment  ?? 0,
    mtfHTFBias:         mtfSnap?.htfBias         ?? 0,

    // Pattern Validation (from validateAllPatterns() — optional)
    // Pick the best non-FAILED/EXPIRED pattern, prefer CONFIRMED over DETECTED.
    ...(() => {
      if (!validatedPatterns?.length) {
        return { patternConfidence: 0, patternDirection: null, patternStatus: null };
      }
      const eligible = validatedPatterns
        .filter(vp => vp.status !== 'FAILED' && vp.status !== 'EXPIRED')
        .sort((a, b) => {
          // CONFIRMED before DETECTED before FORMING, then by confidence
          const rank = (s: string) => s === 'CONFIRMED' ? 2 : s === 'DETECTED' ? 1 : 0;
          return rank(b.status) - rank(a.status) || b.confidence - a.confidence;
        });
      const best = eligible[0];
      if (!best) return { patternConfidence: 0, patternDirection: null, patternStatus: null };

      // Multi-pattern corroboration (Concern 2 from v6.3.26 review):
      // A second same-direction pattern adds 30% of its confidence.
      // A third adds 15%. Beyond three is ignored — corroboration has
      // diminishing returns and all originate from the same price data.
      // Opposing patterns (different direction) are not added — they
      // reduce confidence through the direction logic in confidenceScore.ts.
      // The result is capped at 100 — corroboration cannot push beyond maximum.
      const CORROBORATION_WEIGHTS = [1.0, 0.30, 0.15] as const;
      let combinedConf = 0;
      let idx = 0;
      for (const vp of eligible) {
        if (idx >= CORROBORATION_WEIGHTS.length) break;
        if (vp.direction !== best.direction) continue; // only same-direction corroborates
        combinedConf += vp.confidence * CORROBORATION_WEIGHTS[idx];
        idx++;
      }
      const patternConfidence = Math.min(100, Math.round(combinedConf));

      return {
        patternConfidence,
        patternDirection:  best.direction as 'bullish' | 'bearish' | 'neutral' | null,
        patternStatus:     best.status,
      };
    })(),

    // Regime
    regimeConfidence:   regimeSnap?.confidence     ?? 0,
    regimeBullScore:    regimeSnap?.bullScore       ?? 0,
    regimeBearScore:    regimeSnap?.bearScore       ?? 0,
    regimeVolatility:   regimeSnap?.volatilityScore ?? 0,
    regimeBreakout:     regimeSnap?.breakoutScore   ?? 0,
    regimeMeanRev:      regimeSnap?.meanRevScore     ?? 0,
  };

  const result = scoreConfidence(inp);
  return { ...result, scoringVersion: CONFIDENCE_SCORING_VERSION };
}
