// THE single Trade Quality / Opportunity scoring formula — extracted into
// its own dependency-free module during the production audit. Previously
// this lived inside opportunityRanking.ts, which created a genuine
// circular dependency: opportunityRanking -> consensusEngine ->
// multiTimeframeEvaluator -> watchlistScanner -> paperTradingEngine ->
// tradeQuality -> opportunityRanking (back to the start). Both
// opportunityRanking.ts and tradeQuality.ts now depend on THIS file
// instead of on each other, and this file depends on nothing in that
// chain — breaking the cycle at its root rather than patching one edge.
//
// Deliberately defines its own minimal structural input type instead of
// importing OpportunitySignal from opportunityRanking.ts — that would
// have just moved the cycle by one file rather than eliminating it.

export type CompositeScoreInput = {
  consensus: { overallConfidence: number; agreementPct: number; trendStrength: number | null };
  modelAgree: boolean;
  walkForwardAccuracy: number;
  riskScore: number;
  volumeRatio: number | null;
};

export function computeCompositeScore(o: CompositeScoreInput): number {
  const confidenceComp = o.consensus.overallConfidence;
  const agreementComp = o.consensus.agreementPct;
  const modelAgreeComp = o.modelAgree ? 100 : 40;
  const wfComp = Math.max(0, Math.min(100, o.walkForwardAccuracy));
  const riskComp = Math.max(0, 100 - o.riskScore);
  const trendComp = o.consensus.trendStrength != null ? Math.min(100, o.consensus.trendStrength * 2) : 50;
  const volComp = o.volumeRatio != null ? Math.min(100, o.volumeRatio * 50) : 50;

  const weights = { confidence: 0.25, agreement: 0.20, modelAgree: 0.10, wf: 0.20, risk: 0.15, trend: 0.05, volume: 0.05 };
  const score = confidenceComp * weights.confidence + agreementComp * weights.agreement + modelAgreeComp * weights.modelAgree +
    wfComp * weights.wf + riskComp * weights.risk + trendComp * weights.trend + volComp * weights.volume;
  return Math.max(0, Math.min(100, score));
}
