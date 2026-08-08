import { MLPrediction } from './mlSignal';
import { IndicatorSnapshot } from './liveIndicatorSnapshot';
import { computeCompositeScore } from './scoringFormula';
import type { OpportunitySignal } from './opportunityRanking';
import { generateExplanation } from './aiExplanation';
import { Candle } from './indicators';

// THE single Trade Quality Score implementation for the entire app.
// computeCompositeScore (opportunityRanking.ts) is the ONLY scoring
// formula anywhere — this module only presents that score as a
// grade/stars/risk-badge/breakdown, through exactly two entry points:
//   - fromOpportunity(): when a real multi-timeframe OpportunitySignal
//     already exists, takes its compositeScore DIRECTLY — zero
//     recomputation, so Opportunity Ranking and Trade Quality can never
//     drift apart.
//   - fromSinglePrediction(): when only one timeframe's prediction is
//     available (the regular live chart), builds the same scoring
//     function's expected input from what a single prediction actually
//     has, honestly approximating the multi-timeframe-specific fields
//     rather than fabricating real consensus data that doesn't exist.
// Both funnel through the same scoreToGrade/scoreToStars/riskBadge below.

export type TradeQuality = { score: number; grade: string; stars: string; riskBadge: 'Low' | 'Medium' | 'High' };
export type TradeQualityBreakdown = { strengths: string[]; weaknesses: string[] };

// THE single formatter for displaying a Trade Quality score anywhere in
// the app. Purely presentational — never touches the underlying score
// computed by computeCompositeScore, only how it's rendered. Whole
// numbers show no decimals; otherwise up to 2 decimal places with
// trailing zeros stripped (so 82.50 -> "82.5", not "82.50").
export function formatTradeQualityScore(score: number): string {
  const rounded = Math.round(score * 100) / 100; // clamp to at most 2 decimal places of precision before formatting
  if (Number.isInteger(rounded)) return String(rounded);
  return rounded.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

// Unified grade scale — matches confidenceScore.ts and validationEngine.ts
// so the same letter means the same quality level throughout the app.
export function scoreToGrade(score: number): string {
  if (score >= 80) return 'A+';
  if (score >= 70) return 'A';
  if (score >= 55) return 'B';
  if (score >= 40) return 'C';
  if (score >= 25) return 'D';
  return 'F';
}

export function scoreToStars(score: number): string {
  const stars = Math.max(1, Math.min(5, Math.round(score / 20)));
  return '★'.repeat(stars) + '☆'.repeat(5 - stars);
}

// Matches the exact thresholds already used elsewhere in the app (e.g.
// ChartScreen's risk-score coloring) — not a new risk taxonomy.
export function riskScoreToBadge(riskScore: number): TradeQuality['riskBadge'] {
  return riskScore <= 40 ? 'Low' : riskScore <= 70 ? 'Medium' : 'High';
}

// Shared by both entry points — verified directly before writing this
// against the spec's own worked example (walk-forward 62, R:R 1.8,
// ADX 30, HIGH volatility, matching regime -> reproduces "High walk-forward
// accuracy / Good risk/reward / Strong ADX / Bullish regime" as strengths
// and "Slightly elevated volatility" as the sole weakness, matching the
// example's exact wording).
function buildCommonBreakdown(opts: {
  walkForwardAccuracy: number | null; riskRewardRatio: number | null; trendStrength: number | null;
  volRegimeLabel: string | null; // 'HIGH' | 'EXTREME' | 'LOW' | 'NORMAL' | null
  regimeMatches: boolean | null; isBuy: boolean;
}): TradeQualityBreakdown {
  const strengths: string[] = [], weaknesses: string[] = [];
  const { walkForwardAccuracy, riskRewardRatio, trendStrength, volRegimeLabel, regimeMatches, isBuy } = opts;

  if (walkForwardAccuracy != null) {
    if (walkForwardAccuracy >= 58) strengths.push('High walk-forward accuracy');
    else if (walkForwardAccuracy < 50) weaknesses.push('Weak walk-forward accuracy');
  }
  if (riskRewardRatio != null) {
    if (riskRewardRatio >= 1.5) strengths.push('Good risk/reward');
    else if (riskRewardRatio < 1.0) weaknesses.push('Poor risk/reward');
  }
  if (trendStrength != null && trendStrength >= 25) strengths.push('Strong ADX');
  if (volRegimeLabel === 'HIGH') weaknesses.push('Slightly elevated volatility');
  else if (volRegimeLabel === 'EXTREME') weaknesses.push('Significantly elevated volatility');
  if (regimeMatches === true) strengths.push(isBuy ? 'Bullish regime' : 'Bearish regime');
  else if (regimeMatches === false) weaknesses.push('Regime does not support this direction');

  return { strengths, weaknesses };
}

function volRegimeFromLabel(label: string | null | undefined): string | null {
  // Guard: label may be undefined if called with a Promise (async called without await)
  if (!label || typeof label !== 'string') return 'NORMAL';
  if (label.includes('Extreme')) return 'EXTREME';
  if (label.includes('High')) return 'HIGH';
  if (label.includes('Low')) return 'LOW';
  return 'NORMAL';
}

// Multi-timeframe path — reuses an already-ranked OpportunitySignal's own
// compositeScore directly. This is what guarantees Opportunity Ranking and
// Trade Quality stay internally consistent: there is nothing to recompute.
export function fromOpportunity(o: OpportunitySignal): { quality: TradeQuality; breakdown: TradeQualityBreakdown } {
  const quality: TradeQuality = {
    score: o.compositeScore, grade: scoreToGrade(o.compositeScore), stars: scoreToStars(o.compositeScore),
    riskBadge: riskScoreToBadge(o.riskScore)};

  const isBuy = o.consensus.overallDirection === 'BUY';
  const common = buildCommonBreakdown({
    walkForwardAccuracy: o.walkForwardAccuracy, riskRewardRatio: o.riskRewardRatio, trendStrength: o.consensus.trendStrength,
    volRegimeLabel: volRegimeFromLabel(o.currentRegime),
    regimeMatches: o.currentRegime === 'Bull' ? isBuy : o.currentRegime === 'Bear' ? !isBuy : null,
    isBuy});

  // Multi-timeframe-specific items the single-prediction path can't know:
  // real cross-timeframe agreement, not an approximation.
  const agreeing = o.consensus.perTimeframe.filter(t => t.action === o.consensus.overallDirection).length;
  const total = o.consensus.perTimeframe.length;
  const strengths = [...common.strengths];
  const weaknesses = [...common.weaknesses];
  if (total > 0) {
    const mtfLine = `${agreeing}/${total} timeframes ${isBuy ? 'bullish' : 'bearish'}`;
    if (o.consensus.agreementPct >= 60) strengths.unshift(mtfLine);
    else weaknesses.unshift(mtfLine);
    if (o.consensus.agreementPct >= 80) strengths.push('Strong multi-timeframe consensus');
    else if (o.consensus.agreementPct < 50) weaknesses.push('Mixed timeframe signals');
  }
  if (o.modelAgree) strengths.push('Neural Network agrees', 'Logistic Regression agrees');
  else weaknesses.push('Neural Network and Logistic Regression disagree');
  if (o.volumeRatio != null && o.volumeRatio > 1.3) strengths.push('Volume expansion');

  return { quality, breakdown: { strengths, weaknesses } };
}

// Single-timeframe path — used wherever only one prediction is available
// (the regular live chart). Reuses generateExplanation's already-computed,
// real indicator checks (not re-derived independently) for the
// indicator-based portion, and approximates the multi-timeframe-specific
// scoring inputs honestly via model agreement rather than fabricating
// cross-timeframe data that doesn't exist in this context.
export function fromSinglePrediction(
  prediction: MLPrediction, candles: Candle[], snapshot: IndicatorSnapshot | null, symbol: string, assetClass: string, currentRegime: string
): { quality: TradeQuality; breakdown: TradeQualityBreakdown } | null {
  if (prediction.action === 'HOLD') return null;
  const isBuy = prediction.action === 'BUY';

  const score = computeCompositeScore({
    symbol, assetClass,
    consensus: {
      overallDirection: prediction.action as 'BUY' | 'SELL' | 'HOLD',
      consensusScore: isBuy ? prediction.confidence : -prediction.confidence,
      agreementPct: prediction.ensembleAgree ? 100 : 50,
      strongestTimeframe: 'current', weakestTimeframe: 'current',
      trendStrength: snapshot?.adxValue ?? null,
      overallConfidence: prediction.confidence,
      conflictingTimeframes: [],
      perTimeframe: []},
    riskRewardRatio: prediction.riskRewardRatio,
    riskScore: prediction.riskScore,
    modelAgree: prediction.ensembleAgree,
    walkForwardAccuracy: prediction.walkForwardAccuracy,
    volumeRatio: snapshot?.relativeVolume ?? null,
    currentRegime});

  const quality: TradeQuality = { score, grade: scoreToGrade(score), stars: scoreToStars(score), riskBadge: riskScoreToBadge(prediction.riskScore) };

  const common = buildCommonBreakdown({
    walkForwardAccuracy: prediction.walkForwardAccuracy, riskRewardRatio: prediction.riskRewardRatio, trendStrength: snapshot?.adxValue ?? null,
    volRegimeLabel: volRegimeFromLabel(currentRegime),
    regimeMatches: currentRegime === 'Bull' ? isBuy : currentRegime === 'Bear' ? !isBuy : null,
    isBuy});

  // Reuses generateExplanation's real indicator checks directly — same
  // EMA200/RSI/MACD/volume logic, not re-derived here.
  const explanation = generateExplanation(prediction, candles, '', currentRegime);
  const indicatorStrengths = explanation?.supportingReasons.map(r => r.text).filter(t => !t.includes('Regime') && !t.includes('agrees')) ?? [];
  const indicatorWeaknesses = explanation?.nonSupportingReasons.map(r => r.text).filter(t => !t.includes('Regime') && !t.includes('agrees')) ?? [];

  const strengths = [...common.strengths, ...indicatorStrengths];
  const weaknesses = [...common.weaknesses, ...indicatorWeaknesses];
  if (prediction.ensembleAgree) strengths.push('Neural Network agrees', 'Logistic Regression agrees');
  else weaknesses.push('Neural Network and Logistic Regression disagree');

  return { quality, breakdown: { strengths, weaknesses } };
}
