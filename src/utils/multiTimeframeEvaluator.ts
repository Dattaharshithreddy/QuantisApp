import { Asset } from '../api/assets';
import { Candle } from './indicators';
import { trainAndPredict, MLPrediction } from './mlSignal';
import { getOptimalConfig } from './modelOptimization';
import { fetchCandlesForAsset, ScannerStats } from './watchlistScanner';
import { checkRegimeFilter } from './regimeFilter';
import { logger } from './logger';

// Phase 1 — Multi-Timeframe AI. Reuses, never duplicates:
//  - trainAndPredict (now correctly timeframe-keyed — see the prerequisite
//    fix) for the actual AI pipeline. Each timeframe gets its OWN
//    warm-started model under its own key, exactly as a genuinely separate
//    timeframe model should, with zero cross-contamination.
//  - fetchCandlesForAsset (watchlistScanner.ts) for cache-aware, retried
//    candle fetching — "avoid duplicate downloads" is already solved there,
//    not rebuilt here.
//  - checkRegimeFilter (regimeFilter.ts), called with mode DISABLED, purely
//    to get the human-readable currentRegime label for free — no new
//    regime classification logic.
//
// "Do not retrain unnecessarily" is satisfied by trainAndPredict's own
// existing warm-start + min-retrain-interval gating inside the scanner —
// this evaluator does not bypass or duplicate that, it just calls
// trainAndPredict once per timeframe, the same as any other caller would.

export const ALL_TIMEFRAMES = ['5m', '15m', '30m', '1h', '4h', '1D'];

export type TimeframeSignal = {
  timeframe: string;
  prediction: MLPrediction;
  currentRegime: string;
  candleCount: number;
  candles: Candle[]; // needed by both the Consensus Engine (real ADX trend strength) and the AI Explanation generator (real indicator readings) — stored here once rather than re-fetched by each consumer
};

export async function evaluateAllTimeframes(
  asset: Asset, aoSession: any, avKey: string, stats: ScannerStats,
  timeframes: string[] = ALL_TIMEFRAMES
): Promise<TimeframeSignal[]> {
  const results: TimeframeSignal[] = [];

  for (const tf of timeframes) {
    try {
      const candles: Candle[] = await fetchCandlesForAsset(asset, tf, aoSession, avKey, stats);
      if (candles.length < 60) {
        logger.warn('multiTimeframeEvaluator', `${asset.symbol}/${tf}: only ${candles.length} candles, skipping`);
        continue;
      }

      // FIX (verification pass): every other trainAndPredict caller
      // (watchlistScanner.ts, ChartScreen.tsx) was wired to the
      // per-(symbol,timeframe) optimal config from the Model Improvement
      // Phase; this one was missed. Not a crash — both new parameters are
      // optional and default safely — but it meant Opportunity Ranking
      // and the Consensus Engine silently kept using the global
      // horizon=3/threshold=0.55 defaults while the Scanner's actual
      // entry decisions used the optimized per-asset values, a real
      // inconsistency between what Ranking displays and what trading
      // actually acts on.
      const optimalConfig = await getOptimalConfig(asset.symbol, tf);
      const prediction = await trainAndPredict(asset.symbol, tf, candles, optimalConfig?.bestHorizon, optimalConfig?.bestThreshold, false, asset.type);
      if (!prediction) continue;

      const regimeCheck = checkRegimeFilter(candles, 'DISABLED');
      results.push({ timeframe: tf, prediction, currentRegime: regimeCheck.currentRegime, candleCount: candles.length, candles });
    } catch (e: any) {
      logger.error('multiTimeframeEvaluator', `${asset.symbol}/${tf}: evaluation failed: ${e.message}`);
    }
  }

  return results;
}
