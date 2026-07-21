// ─────────────────────────────────────────────────────────────────────────────
// REGIME SCORING  (v5.2.0) — REGIME_SCORING_V1
//
// All heuristics isolated here. regimeEngine.ts contains only data assembly.
// ─────────────────────────────────────────────────────────────────────────────
import { RegimeInputs, RegimeResult, RegimeLabel, RegimeScores, RegimeConfig } from './regimeTypes';

// ── REGIME_SCORING_V1 ─────────────────────────────────────────────────────────
// Version: REGIME_SCORING_V1
//
// Step 1 — Volatility classification (objective thresholds, configurable):
//   volRatio = histVol / histVolMean
//   isHighVol  = volRatio > cfg.volExpansionMult   (default 1.8)
//   isLowVol   = volRatio < cfg.volContractionMult (default 0.6)
//   isSqueeze  = bbWidth < atr × cfg.bbWidthSqueezeAtr (default 0.5)
//
// Step 2 — Trend classification:
//   isStrongTrend   = adx > cfg.adxTrendThreshold (35)
//   isModTrend      = adx > cfg.adxModThreshold   (20)
//   isMTFAligned    = |mtfOverall| > cfg.mtfAlignThreshold (0.3)
//   direction       = sign of trendStrength + mtfOverall
//
// Step 3 — Label assignment (priority order):
//   HIGH_VOLATILITY → breakout candidate if trending, high_vol standalone if not
//   STRONG trend + MTF aligned → STRONG_BULL / STRONG_BEAR
//   STRONG trend alone → BULL / BEAR
//   MOD trend → WEAK_BULL / WEAK_BEAR
//   Squeeze → LOW_VOLATILITY (mean reversion setup)
//   bbWidth contracting + adx < mod → MEAN_REVERSION
//   else → SIDEWAYS
//
// Score formulas (all heuristic proxies):
//   trendScore      = min(1, adx / 50)           — ADX normalised
//   bullScore       = trendScore × max(0, dir)    — directional × strength
//   bearScore       = trendScore × max(0, -dir)
//   breakoutScore   = min(1, volRatio / 3) × (isHighVol ? 1 : 0.3)
//   sidewaysScore   = 1 - trendScore
//   meanRevScore    = isSqueeze ? 1 - volRatio/2 : 0
//   volatilityScore = min(1, volRatio / 2.5)
//   confidence      = adxConfidence × 0.4 + volConfidence × 0.3 + mtfConf × 0.3
//   adxConfidence   = min(1, adx / 40)
//   volConfidence   = 1 - |volRatio - 1| / 2    — confidence peaks at vol=mean
//   mtfConf         = |mtfOverall|               — stronger alignment = more confident
//
// Configurable: all thresholds in RegimeConfig.
export function scoreRegime(inp: RegimeInputs, cfg: RegimeConfig): RegimeResult {
  const volRatio   = inp.histVolMean > 0 ? inp.histVol / inp.histVolMean : 1;
  const isHighVol  = volRatio > cfg.volExpansionMult;
  const isLowVol   = volRatio < cfg.volContractionMult;
  const isSqueeze  = inp.bbWidth > 0 && inp.atr > 0
    ? inp.bbWidth < inp.atr * cfg.bbWidthSqueezeAtr : false;

  const isStrongTrend = inp.adx > cfg.adxTrendThreshold;
  const isModTrend    = inp.adx > cfg.adxModThreshold;
  const isMTFAligned  = Math.abs(inp.mtfOverall) > cfg.mtfAlignThreshold;

  // Directional bias: trendStrength (MS) + MTF alignment + confirmed pattern signal.
  // Weights: 0.60 trend | 0.25 MTF | 0.15 pattern.
  // Using 0.15 for patternBias keeps strong confirmed reversals meaningful
  // without letting every weak pattern flip the regime.
  // patternBias is 0 when no confirmed pattern exists — no effect on dir.
  const dir = inp.trendStrength * 0.60
            + inp.mtfOverall   * 0.25
            + inp.patternBias  * 0.15;

  // ── Label (priority-ordered) ──────────────────────────────────────────────
  let label: RegimeLabel;
  if (isHighVol && isStrongTrend) {
    label = 'BREAKOUT';          // vol expansion + trend = breakout (direction shown by bullScore/bearScore)
  } else if (isHighVol) {
    label = 'HIGH_VOLATILITY';
  } else if (isStrongTrend && isMTFAligned) {
    label = dir > 0.1 ? 'STRONG_BULL_TREND' : dir < -0.1 ? 'STRONG_BEAR_TREND' : 'BULL_TREND';
  } else if (isStrongTrend) {
    label = dir > 0.05 ? 'BULL_TREND' : dir < -0.05 ? 'BEAR_TREND' : 'SIDEWAYS';
  } else if (isModTrend) {
    label = dir > 0.05 ? 'WEAK_BULL_TREND' : dir < -0.05 ? 'WEAK_BEAR_TREND' : 'SIDEWAYS';
  } else if (isSqueeze || isLowVol) {
    label = 'LOW_VOLATILITY';
  } else if (inp.bbWidth > 0 && !isModTrend) {
    label = 'MEAN_REVERSION';
  } else {
    label = 'SIDEWAYS';
  }

  // ── Scores ────────────────────────────────────────────────────────────────
  const trendScore    = Math.min(1, inp.adx / 50);
  const bullScore     = trendScore * Math.max(0, dir);
  const bearScore     = trendScore * Math.max(0, -dir);
  const breakoutScore = Math.min(1, (volRatio / 3)) * (isHighVol ? 1 : 0.3);
  const sidewaysScore = Math.max(0, 1 - trendScore - breakoutScore * 0.5);
  const meanRevScore  = isSqueeze ? Math.max(0, 1 - volRatio * 0.5) : 0;
  const volatilityScore = Math.min(1, volRatio / 2.5);

  const adxConfidence = Math.min(1, inp.adx / 40);
  const volConfidence = Math.max(0, 1 - Math.abs(volRatio - 1) / 2);
  const mtfConf       = Math.min(1, Math.abs(inp.mtfOverall));
  const confidence    = adxConfidence * 0.4 + volConfidence * 0.3 + mtfConf * 0.3;

  return {
    label, confidence,
    bullScore:       Math.min(1, bullScore),
    bearScore:       Math.min(1, bearScore),
    trendScore:      Math.min(1, trendScore),
    sidewaysScore:   Math.min(1, sidewaysScore),
    breakoutScore:   Math.min(1, breakoutScore),
    meanRevScore:    Math.min(1, meanRevScore),
    volatilityScore: Math.min(1, volatilityScore),
  };
}

export function toRegimeScores(r: RegimeResult): RegimeScores {
  const trendRegime = r.bullScore - r.bearScore; // -1..+1
  return {
    bullScore:        r.bullScore,
    bearScore:        r.bearScore,
    trendRegime:      Math.max(-1, Math.min(1, trendRegime)),
    sidewaysScore:    r.sidewaysScore,
    breakoutScore:    r.breakoutScore,
    meanRevScore:     r.meanRevScore,
    volatilityScore:  r.volatilityScore,
    regimeConfidence: r.confidence,
  };
}
