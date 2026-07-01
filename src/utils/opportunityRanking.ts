import AsyncStorage from '@react-native-async-storage/async-storage';
import { Asset } from '../api/assets';
import { evaluateAllTimeframes, TimeframeSignal, ALL_TIMEFRAMES } from './multiTimeframeEvaluator';
import { computeConsensus, ConsensusResult } from './consensusEngine';
import { getIndicatorSnapshot } from './liveIndicatorSnapshot';
import { ScannerStats } from './watchlistScanner';
import { logger } from './logger';

// Phase 3 — Opportunity Ranking. Reuses Phase 1 (multi-timeframe
// evaluation) and Phase 2 (consensus) entirely — this module only scores
// and sorts what they already computed, no new AI calls beyond those two.
//
// IMPORTANT ARCHITECTURAL NOTE, stated honestly rather than silently
// decided: the existing AUTO-trading scan loop (watchlistScanner.ts)
// deliberately stays on a SINGLE timeframe per cycle, every few minutes —
// that's the right design for frequent, lightweight trade-signal checking.
// Full 6-timeframe evaluation per symbol is meaningfully heavier (6x the
// AI calls per symbol), so Opportunity Ranking runs as its own, separate,
// on-demand operation — not silently bolted onto every AUTO-trading cycle,
// which would make routine scanning far slower without anyone asking for that.

export type OpportunitySignal = {
  symbol: string;
  assetClass: string;
  consensus: ConsensusResult;
  riskRewardRatio: number;
  riskScore: number;
  modelAgree: boolean;
  walkForwardAccuracy: number;
  volumeRatio: number | null;
  currentRegime: string; // reused directly from the already-computed TimeframeSignal, not recomputed
  compositeScore: number;
  previousCompositeScore: number | null;
  previousDirection: string | null;
  signalChanged: boolean;
};

const PREVIOUS_RANKING_KEY = 'previousOpportunityRanking';

// Re-exported from scoringFormula.ts (extracted there during the
// production audit to break a circular dependency — see that file's
// comment for the full chain). Re-exporting here preserves the existing
// import path for any caller that still does
// `import { computeCompositeScore } from './opportunityRanking'`.
export { computeCompositeScore } from './scoringFormula';

export async function rankOpportunities(
  assets: Asset[], aoSession: any, avKey: string, stats: ScannerStats,
  timeframes: string[] = ALL_TIMEFRAMES
): Promise<OpportunitySignal[]> {
  const previousRaw = await AsyncStorage.getItem(PREVIOUS_RANKING_KEY);
  const previous: Record<string, { compositeScore: number; direction: string }> = previousRaw ? JSON.parse(previousRaw) : {};

  const results: OpportunitySignal[] = [];

  for (const asset of assets) {
    try {
      const signals: TimeframeSignal[] = await evaluateAllTimeframes(asset, aoSession, avKey, stats, timeframes);
      if (!signals.length) continue;
      const consensus = computeConsensus(signals);
      if (!consensus) continue;

      // Representative single-timeframe details (risk/reward, model
      // agreement, walk-forward) come from the highest-weighted timeframe
      // actually evaluated — the most meaningful single source for these,
      // rather than averaging across timeframes in a way that would blur
      // what any one of them is actually saying.
      const highestTf = signals.reduce((best, s) => s.timeframe === consensus.strongestTimeframe ? s : best, signals[0]);
      const snapshot = getIndicatorSnapshot(highestTf.candles);

      const entry: Omit<OpportunitySignal, 'compositeScore' | 'previousCompositeScore' | 'previousDirection' | 'signalChanged'> = {
        symbol: asset.symbol, assetClass: asset.type, consensus,
        riskRewardRatio: highestTf.prediction.riskRewardRatio,
        riskScore: highestTf.prediction.riskScore,
        modelAgree: highestTf.prediction.ensembleAgree,
        walkForwardAccuracy: highestTf.prediction.walkForwardAccuracy,
        volumeRatio: snapshot?.relativeVolume ?? null,
        currentRegime: highestTf.currentRegime,
      };
      const compositeScore = computeCompositeScore(entry);
      const prev = previous[asset.symbol];

      results.push({
        ...entry, compositeScore,
        previousCompositeScore: prev?.compositeScore ?? null,
        previousDirection: prev?.direction ?? null,
        signalChanged: prev ? prev.direction !== consensus.overallDirection : false,
      });
    } catch (e: any) {
      logger.error('opportunityRanking', `${asset.symbol}: ranking failed: ${e.message}`);
    }
  }

  // Persist this cycle's scores/directions so the NEXT ranking run can
  // compute genuine "most improved" / "recently changed" deltas — without
  // this, those two fields would have nothing real to compare against.
  const toPersist: Record<string, { compositeScore: number; direction: string }> = {};
  results.forEach(r => { toPersist[r.symbol] = { compositeScore: r.compositeScore, direction: r.consensus.overallDirection }; });
  await AsyncStorage.setItem(PREVIOUS_RANKING_KEY, JSON.stringify(toPersist));

  return results.sort((a, b) => b.compositeScore - a.compositeScore);
}

export function topOpportunities(ranked: OpportunitySignal[], n = 10): OpportunitySignal[] { return ranked.slice(0, n); }
export function topLongs(ranked: OpportunitySignal[], n = 10): OpportunitySignal[] { return ranked.filter(r => r.consensus.overallDirection === 'BUY').slice(0, n); }
export function topShorts(ranked: OpportunitySignal[], n = 10): OpportunitySignal[] { return ranked.filter(r => r.consensus.overallDirection === 'SELL').slice(0, n); }
export function highestConfidence(ranked: OpportunitySignal[], n = 10): OpportunitySignal[] { return [...ranked].sort((a, b) => b.consensus.overallConfidence - a.consensus.overallConfidence).slice(0, n); }
export function bestRiskReward(ranked: OpportunitySignal[], n = 10): OpportunitySignal[] { return [...ranked].sort((a, b) => b.riskRewardRatio - a.riskRewardRatio).slice(0, n); }
export function mostImproved(ranked: OpportunitySignal[], n = 10): OpportunitySignal[] {
  return [...ranked]
    .filter(r => r.previousCompositeScore != null)
    .sort((a, b) => (b.compositeScore - b.previousCompositeScore!) - (a.compositeScore - a.previousCompositeScore!))
    .slice(0, n);
}
export function recentlyChangedSignals(ranked: OpportunitySignal[]): OpportunitySignal[] { return ranked.filter(r => r.signalChanged); }
