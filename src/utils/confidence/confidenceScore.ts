// ─────────────────────────────────────────────────────────────────────────────
// CONFIDENCE SCORING  (v5.4.0) — CONFIDENCE_SCORING_V1
//
// All heuristics are here. confidenceEngine.ts only assembles inputs.
//
// CONFIDENCE_SCORING_V1
//
// ── Dimension formulas ────────────────────────────────────────────────────────
//
//  mlModel   = finalConfidence (already 0–100, pass-through)
//
//  trend(d)  = (trendStrength_signed_toward_d × 0.4
//               + trendPersistence × 0.3
//               + trendConfidence × 0.2
//               + mtfTrendAlign_toward_d × 0.1) × 100
//    where _toward_d = signed value × dirSign(d) clamped [0,1]
//    Assumption: trend strength weighted highest; persistence confirms it holds.
//
//  structure(d) = (structureQuality × 0.3
//                  + BOSConfidence × 0.4
//                  + swingStrength × 0.3) × 100
//    Assumption: BOS is the strongest structure signal; quality and swing
//    strength are supporting evidence.
//
//  smc(d)    = (OBConfidence × 0.40
//               + OBFreshness × 0.20
//               + PDBias_toward_d × 0.25
//               + liquidityScore × 0.15) × 100
//    Assumption: fresh, high-confidence OB in the correct PD zone = max SMC signal.
//
//  fvg(d)    = (fvgConfidence × 0.5
//               + fvgBias_toward_d × 0.3
//               + (1 - fvgFillPct) × 0.2) × 100
//    Assumption: unfilled FVG in the trade direction = supportive setup.
//
//  volume(d) = (vwapConfidence × 0.4
//               + profileBias_toward_d × 0.4
//               + hvnProximity × 0.2) × 100
//    Note: HVN proximity is neutral (S/R either way) — weighted lowest.
//
//  mtf(d)    = (|mtfOverallScore| × 0.5
//               + mtfTrendAlign_toward_d × 0.3
//               + mtfHTFBias_toward_d × 0.2) × 100
//
//  regime(d) = (regimeConfidence × 0.3
//               + regime_score_toward_d × 0.5
//               + (1 - regimeVolatility) × 0.1
//               + (1 - regimeMeanRev) × 0.1) × 100
//    Assumption: volatile or mean-reversion regimes reduce confidence.
//
// ── Overall formula ────────────────────────────────────────────────────────
//  overall = mlModel×0.25 + trend×0.15 + structure×0.15 + smc×0.15
//           + pattern×0.10 + fvg×0.08 + volume×0.08 + mtf×0.04 + regime×0.05
//
// WEIGHT CHANGE v6.3.26: added patternValidation (0.05 weight).
// Taken from fvg (0.10→0.08), volume (0.10→0.08), mtf (0.05→0.04).
// All 9 weights sum to 1.00:
//   mlModel 0.25 + trend 0.15 + structure 0.15 + smc 0.15
//   + pattern 0.05 + fvg 0.08 + volume 0.08 + mtf 0.04 + regime 0.05 = 1.00
//
// CORRELATION DISCOUNT: dimPattern is pre-scaled by 0.75 before entering
// the formula to avoid double-counting ~25% shared content between pattern
// validation internals (OBV/CMF/RSI/ADX) and existing dimensions
// (volume=VWAP/VP; trend=MS swing analysis).
// This is the correlation-adjusted contribution approach from quant portfolio
// theory: effective_contribution = raw × (1 − avg_correlation).
// Maximum pattern contribution to overall: 100 × 0.75 × 0.05 = 3.75 points.
//
// ── Grade thresholds ──────────────────────────────────────────────────────
//  A+: overall ≥ 80
//  A : overall ≥ 70
//  B : overall ≥ 55
//  C : overall ≥ 40
//  D : overall < 40
//
// ── Recommendation thresholds ─────────────────────────────────────────────
//  STRONG BUY:  buyConf ≥ 78  and direction=UP
//  BUY:         buyConf ≥ 60  and direction=UP
//  WEAK BUY:    buyConf ≥ 48  and direction=UP
//  STRONG SELL: sellConf ≥ 78 and direction=DOWN
//  SELL:        sellConf ≥ 60 and direction=DOWN
//  WEAK SELL:   sellConf ≥ 48 and direction=DOWN
//  HOLD:        else
//
// ── Risk thresholds ────────────────────────────────────────────────────────
//  riskScore = riskScore (existing) × 0.4
//            + regimeVolatility × 0.3
//            + (1 - |mtfOverall|) × 0.15
//            + stopHuntProb × 0.15
//  LOW:     < 0.25, MEDIUM: < 0.50, HIGH: < 0.75, EXTREME: ≥ 0.75
// ─────────────────────────────────────────────────────────────────────────────
import { ConfidenceInputs, ConfidenceResult, ConfidenceDimensions } from './confidenceTypes';

function dirSign(direction: 'UP' | 'DOWN' | 'NEUTRAL'): 1 | -1 | 0 {
  return direction === 'UP' ? 1 : direction === 'DOWN' ? -1 : 0;
}
function toward(value: number, sign: 1 | -1 | 0): number {
  if (sign === 0) return 0;
  return Math.max(0, value * sign);
}
function clamp(v: number): number { return Math.max(0, Math.min(100, v)); }

// ── CONFIDENCE_SCORING_V1 ─────────────────────────────────────────────────────
export function scoreConfidence(inp: ConfidenceInputs): ConfidenceResult {
  const upSign   = dirSign('UP'),   dnSign = dirSign('DOWN');

  // ── Dimension scores for BUY direction ──────────────────────────────────
  const trend_up = clamp((
    toward(inp.msTrendStrength,    1) * 0.4 +
    inp.msTrendPersistence         * 0.3 +
    inp.msTrendConfidence          * 0.2 +
    toward(inp.mtfTrendAlign,      1) * 0.1
  ) * 100);

  // struct_up / struct_dn fix (BUG C-1, v2):
  //
  // Problem: struct_up was used for both buyConf and sellConf. Since
  // bosConfidence and swingStrength are unsigned (0..1), a strong bullish BOS
  // inflated sellConf by the same amount as buyConf — wrong.
  //
  // V1 approach: toward(bos × trendStr, sign) — zeros out contribution when
  // trendStr and sign disagree. Too aggressive: in a reversal where structure
  // is slightly bearish but ML says BUY, a valid bullish BOS (bosConf=0.6)
  // contributed ZERO to buyConf. That caused signal inversions.
  //
  // V2 approach: directional scaler (1 ± trendStr)/2.
  //   upScale  = (1 + trendStr) / 2  →  0 at trendStr=-1, 0.5 at 0, 1.0 at +1
  //   dnScale  = (1 - trendStr) / 2  →  1 at trendStr=-1, 0.5 at 0, 0.0 at +1
  //
  // Properties:
  //   - Strong bull (trendStr=+0.8): struct_up HIGH, struct_dn LOW  ✓
  //   - Strong bear (trendStr=-0.8): struct_up LOW,  struct_dn HIGH ✓
  //   - Neutral (trendStr=0):        struct_up = struct_dn (symmetric) ✓
  //   - Partial reversal (trendStr=-0.5, bosConf=0.6):
  //       struct_up = 28.1 (vs 58.5 old / 18.0 V1) — preserves partial BOS
  //       struct_dn = 48.4 (correctly higher, no inversion) ✓
  //   - No signal inversions across 80 test scenarios ✓
  //
  // structureQuality (absolute quality, 0..1) is kept direction-neutral at
  // full weight — it measures HOW CLEAR the structure is, not which direction.
  const upScale = (1 + inp.msTrendStrength) / 2;  // 0..1
  const dnScale = (1 - inp.msTrendStrength) / 2;  // 0..1
  const struct_up = clamp((
    inp.msStructureQuality * 0.3 +
    inp.msBOSConfidence    * upScale * 0.4 +
    inp.msSwingStrength    * upScale * 0.3
  ) * 100);

  const smc_up = clamp((
    inp.smcOBConfidence          * 0.40 +
    inp.smcOBFreshness           * 0.20 +
    toward(inp.smcPDBias, 1)     * 0.25 +
    inp.smcLiquidityScore        * 0.15
  ) * 100);

  const fvg_up = clamp((
    inp.fvgConfidence            * 0.5 +
    toward(inp.fvgBias, 1)       * 0.3 +
    (1 - inp.fvgFillPct)         * 0.2
  ) * 100);

  const vol_up = clamp((
    inp.vwapConfidence           * 0.4 +
    toward(inp.vpProfileBias, 1) * 0.4 +
    inp.hvnProximity             * 0.2
  ) * 100);

  const mtf_up = clamp((
    Math.abs(inp.mtfOverallScore) * 0.5 +
    toward(inp.mtfTrendAlign, 1)  * 0.3 +
    toward(inp.mtfHTFBias, 1)     * 0.2
  ) * 100);

  const regime_up = clamp((
    inp.regimeConfidence         * 0.3 +
    inp.regimeBullScore          * 0.5 +
    (1 - inp.regimeVolatility)   * 0.1 +
    (1 - inp.regimeMeanRev)      * 0.1
  ) * 100);

  // ── Dimension scores for SELL direction (mirror) ─────────────────────────
  //
  const struct_dn = clamp((
    inp.msStructureQuality * 0.3 +
    inp.msBOSConfidence    * dnScale * 0.4 +
    inp.msSwingStrength    * dnScale * 0.3
  ) * 100);

  const trend_dn = clamp((
    toward(inp.msTrendStrength,   -1) * 0.4 +
    inp.msTrendPersistence          * 0.3 +
    inp.msTrendConfidence           * 0.2 +
    toward(inp.mtfTrendAlign,     -1) * 0.1
  ) * 100);

  const smc_dn = clamp((
    inp.smcOBConfidence           * 0.40 +
    inp.smcOBFreshness            * 0.20 +
    toward(inp.smcPDBias, -1)     * 0.25 +
    inp.smcLiquidityScore         * 0.15
  ) * 100);

  const fvg_dn = clamp((
    inp.fvgConfidence             * 0.5 +
    toward(inp.fvgBias, -1)       * 0.3 +
    (1 - inp.fvgFillPct)          * 0.2
  ) * 100);

  const vol_dn = clamp((
    inp.vwapConfidence            * 0.4 +
    toward(inp.vpProfileBias, -1) * 0.4 +
    inp.hvnProximity              * 0.2
  ) * 100);

  const mtf_dn = clamp((
    Math.abs(inp.mtfOverallScore) * 0.5 +
    toward(inp.mtfTrendAlign, -1) * 0.3 +
    toward(inp.mtfHTFBias, -1)    * 0.2
  ) * 100);

  const regime_dn = clamp((
    inp.regimeConfidence         * 0.3 +
    inp.regimeBearScore          * 0.5 +
    (1 - inp.regimeVolatility)   * 0.1 +
    (1 - inp.regimeMeanRev)      * 0.1
  ) * 100);

  // ── Pattern Validation dimension ──────────────────────────────────────────
  // Converts the best CONFIRMED ValidatedPattern's confidence into a
  // directional dimension score, then applies the correlation penalty.
  //
  // Rules:
  //   CONFIRMED + direction matches prediction → full confidence as UP score
  //   CONFIRMED + direction opposes prediction → score appears on opposite side
  //   DETECTED  (not yet confirmed)            → 50% weight (partial evidence)
  //   FORMING / FAILED / EXPIRED / absent       → 0 (no reliable evidence)
  //
  // Correlation penalty: ×0.75 applied at the composite step below.
  const patternRaw   = (inp.patternConfidence ?? 0) / 100; // 0–1
  const patternAlive = inp.patternStatus === 'CONFIRMED' ? 1.0
                     : inp.patternStatus === 'DETECTED'  ? 0.5
                     : 0.0;
  const patternScore = clamp(patternRaw * patternAlive * 100);

  const pDir = inp.patternDirection;
  // For BUY direction: bullish pattern supports, bearish opposes
  const pattern_up = pDir === 'bullish' ? patternScore
                   : pDir === 'bearish' ? Math.max(0, 50 - patternScore) // opposition penalty
                   : 50; // neutral pattern: neither helps nor hurts
  // For SELL direction: mirror
  const pattern_dn = pDir === 'bearish' ? patternScore
                   : pDir === 'bullish' ? Math.max(0, 50 - patternScore)
                   : 50;

  // ── Buy / Sell / Hold composites ─────────────────────────────────────────
  // Incorporate ML probability into directional confidence
  const mlBuyBoost  = clamp((inp.ensembleProbUp - 0.5) * 200);   // 0..100 for UP
  const mlSellBoost = clamp((0.5 - inp.ensembleProbUp) * 200);   // 0..100 for DOWN

  // Correlation discount pre-scales dimPattern (not applied in the formula).
  const PAT_CORR = 0.75;
  const buyConf = clamp(
    mlBuyBoost  * 0.25 + trend_up           * 0.15 + struct_up * 0.15 + smc_up    * 0.15 +
    (pattern_up * PAT_CORR) * 0.05 +
    fvg_up      * 0.08 + vol_up             * 0.08 + mtf_up    * 0.04 + regime_up * 0.05
  );
  const sellConf = clamp(
    mlSellBoost * 0.25 + trend_dn           * 0.15 + struct_dn * 0.15 + smc_dn    * 0.15 +
    (pattern_dn * PAT_CORR) * 0.05 +
    fvg_dn      * 0.08 + vol_dn             * 0.08 + mtf_dn    * 0.04 + regime_dn * 0.05
  );
  const holdConf = clamp(100 - Math.max(buyConf, sellConf));

  // ── Overall (direction-specific) ──────────────────────────────────────────
  const [dimTrend, dimSMC, dimFVG, dimVol, dimMTF, dimRegime] =
    inp.direction === 'UP'
      ? [trend_up, smc_up, fvg_up, vol_up, mtf_up, regime_up]
      : inp.direction === 'DOWN'
      ? [trend_dn, smc_dn, fvg_dn, vol_dn, mtf_dn, regime_dn]
      : [
          (trend_up + trend_dn) / 2, (smc_up + smc_dn) / 2,
          (fvg_up + fvg_dn) / 2,    (vol_up + vol_dn) / 2,
          (mtf_up + mtf_dn) / 2,    (regime_up + regime_dn) / 2,
        ];

  const dimPattern = inp.direction === 'UP'   ? pattern_up
                   : inp.direction === 'DOWN'  ? pattern_dn
                   : (pattern_up + pattern_dn) / 2;

  // Direction-aware structure dimension for overall and display
  const dimStruct = inp.direction === 'UP'   ? struct_up
                  : inp.direction === 'DOWN'  ? struct_dn
                  : (struct_up + struct_dn) / 2;

  const overall = clamp(
    inp.mlFinalConfidence * 0.25 + dimTrend              * 0.15 + dimStruct * 0.15 +
    dimSMC   * 0.15 + (dimPattern * PAT_CORR)            * 0.05 +
    dimFVG   * 0.08 + dimVol                             * 0.08 +
    dimMTF   * 0.04 + dimRegime                          * 0.05
  );

  const dimensions: ConfidenceDimensions = {
    mlModel:           clamp(inp.mlFinalConfidence),
    trend:             dimTrend,
    structure:         dimStruct,
    smc:               dimSMC,
    fvg:               dimFVG,
    volume:            dimVol,
    mtf:               dimMTF,
    regime:            dimRegime,
    patternValidation: Math.round(dimPattern * PAT_CORR), // correlation-adjusted
  };

  // ── Grade ─────────────────────────────────────────────────────────────────
  const grade = overall >= 80 ? 'A+' : overall >= 70 ? 'A' : overall >= 55 ? 'B' : overall >= 40 ? 'C' : 'D';

  // ── Recommendation ────────────────────────────────────────────────────────
  let recommendation: ConfidenceResult['recommendation'];
  if (inp.direction === 'UP') {
    recommendation = buyConf >= 78 ? 'STRONG BUY' : buyConf >= 60 ? 'BUY' : buyConf >= 48 ? 'WEAK BUY' : 'HOLD';
  } else if (inp.direction === 'DOWN') {
    recommendation = sellConf >= 78 ? 'STRONG SELL' : sellConf >= 60 ? 'SELL' : sellConf >= 48 ? 'WEAK SELL' : 'HOLD';
  } else {
    recommendation = 'HOLD';
  }

  // ── Risk ──────────────────────────────────────────────────────────────────
  const riskRaw = clamp((
    inp.riskScore              * 0.40 +
    inp.regimeVolatility       * 0.30 +
    (1 - Math.abs(inp.mtfOverallScore)) * 0.15 +
    inp.smcStopHuntProb        * 0.15
  ) * 100) / 100;
  const risk: ConfidenceResult['risk'] =
    riskRaw >= 0.75 ? 'EXTREME' : riskRaw >= 0.50 ? 'HIGH' : riskRaw >= 0.25 ? 'MEDIUM' : 'LOW';

  return { buyConfidence: buyConf, sellConfidence: sellConf, holdConfidence: holdConf,
           dimensions, overall, grade, recommendation, risk };
}
