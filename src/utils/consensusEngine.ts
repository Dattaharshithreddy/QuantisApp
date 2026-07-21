import { TimeframeSignal } from './multiTimeframeEvaluator';
import { getIndicatorSnapshot } from './liveIndicatorSnapshot';

// Phase 2 — Consensus Engine. Combines TimeframeSignal[] (from Phase 1,
// each entry already a REAL trainAndPredict result) into one overall view.
// Nothing here re-runs the AI — it's pure aggregation of already-computed
// per-timeframe predictions.

// Higher timeframes get more weight — a clean, fixed, explainable
// progression (not derived from anything hidden): 5m=1, 15m=1.5, 30m=2,
// 1h=2.5, 4h=3, 1D=3.5. Each step up in timeframe carries 0.5 more weight
// than the one below it, so longer-term signals matter more without
// completely dominating shorter-term ones.
export const TIMEFRAME_WEIGHTS: Record<string, number> = { '5m': 1, '15m': 1.5, '30m': 2, '1h': 2.5, '4h': 3, '1D': 3.5 };

export type ConsensusResult = {
  overallDirection: 'BUY' | 'SELL' | 'HOLD';
  consensusScore: number;       // -100 (max bearish) to +100 (max bullish)
  agreementPct: number;         // % of timeframes whose action matches overallDirection
  strongestTimeframe: string;   // highest |signed score| — most confident in its own direction
  weakestTimeframe: string;     // lowest |signed score|
  trendStrength: number | null; // real ADX reading from the highest available timeframe — a genuinely different signal from consensusScore (trend STRENGTH regardless of direction, vs. consensusScore's directional AGREEMENT)
  overallConfidence: number;    // weighted average confidence, dampened when timeframes disagree
  conflictingTimeframes: string[];
  perTimeframe: { timeframe: string; action: string; confidence: number; signedScore: number; weight: number }[];
};

function signedScore(action: string, confidence: number): number {
  const sign = action === 'BUY' ? 1 : action === 'SELL' ? -1 : 0;
  return sign * (confidence / 100);
}

export function computeConsensus(signals: TimeframeSignal[]): ConsensusResult | null {
  if (!signals.length) return null;

  const weighted = signals.map(s => ({
    timeframe: s.timeframe, action: s.prediction.action, confidence: s.prediction.confidence,
    weight: TIMEFRAME_WEIGHTS[s.timeframe] ?? 1,
    signedScore: signedScore(s.prediction.action, s.prediction.confidence),
  }));

  const totalWeight = weighted.reduce((s, w) => s + w.weight, 0);
  // The core consensus calculation: a WEIGHTED AVERAGE of each timeframe's
  // signed, confidence-scaled direction, scaled to a -100..+100 range. A
  // unanimous, fully-confident BUY across every timeframe approaches +100;
  // a unanimous fully-confident SELL approaches -100; disagreement or low
  // confidence pulls it toward 0.
  const consensusScore = (weighted.reduce((s, w) => s + w.signedScore * w.weight, 0) / totalWeight) * 100;

  // A small dead-zone around 0 avoids flip-flopping to BUY/SELL on noise
  // when the weighted signal is only marginally on one side.
  const overallDirection: ConsensusResult['overallDirection'] = consensusScore > 15 ? 'BUY' : consensusScore < -15 ? 'SELL' : 'HOLD';

  const agreeing = weighted.filter(w => w.action === overallDirection);
  const agreementPct = (agreeing.length / weighted.length) * 100;

  const strongest = weighted.reduce((best, w) => Math.abs(w.signedScore) > Math.abs(best.signedScore) ? w : best);
  const weakest = weighted.reduce((worst, w) => Math.abs(w.signedScore) < Math.abs(worst.signedScore) ? w : worst);
  const conflicting = overallDirection === 'HOLD' ? [] : weighted.filter(w => w.action !== 'HOLD' && w.action !== overallDirection).map(w => w.timeframe);

  // Trend strength: a REAL ADX reading (genuinely different information
  // from consensusScore — ADX measures how strong a trend is, independent
  // of direction, while consensusScore measures directional agreement).
  // Taken from the highest-timeframe signal that has candles available,
  // since longer-timeframe ADX is the more meaningful "is this a real
  // trending market" read.
  const highestTf = signals.reduce((best, s) => (TIMEFRAME_WEIGHTS[s.timeframe] ?? 1) > (TIMEFRAME_WEIGHTS[best.timeframe] ?? 1) ? s : best);
  const snapshot = getIndicatorSnapshot(highestTf.candles);
  const trendStrength = snapshot?.adxValue ?? null;

  // Overall confidence: weighted average of each timeframe's own
  // confidence, then DAMPENED by how much the timeframes actually agree —
  // six timeframes all saying BUY at 60% confidence should read as more
  // trustworthy overall than six timeframes split 3-3 at 60% each, even
  // though the raw average confidence is identical in both cases.
  const avgConfidence = weighted.reduce((s, w) => s + w.confidence * w.weight, 0) / totalWeight;
  const overallConfidence = avgConfidence * (agreementPct / 100);

  return {
    overallDirection, consensusScore, agreementPct,
    strongestTimeframe: strongest.timeframe, weakestTimeframe: weakest.timeframe,
    trendStrength, overallConfidence, conflictingTimeframes: conflicting,
    perTimeframe: weighted.map(w => ({ timeframe: w.timeframe, action: w.action, confidence: w.confidence, signedScore: w.signedScore, weight: w.weight })),
  };
}
