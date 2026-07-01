import AsyncStorage from '@react-native-async-storage/async-storage';
import { Candle } from './indicators';
import { fitEnsemble, DEFAULT_BACKTEST_CONFIG } from './backtest';
import { evaluateAllHorizons, pickBestHorizon, HorizonEvalEntry } from './horizonEvaluation';
import { evaluateThresholds, pickBestThreshold, ThresholdEvalEntry } from './thresholdEvaluation';
import { logger } from './logger';

// Model Improvement Phase — closes the loop between diagnosis and
// treatment. evaluateAllHorizons/pickBestHorizon and
// evaluateThresholds/pickBestThreshold already existed (built during the
// Production Model Evaluation phase) but were ONLY ever used for one-off
// analysis in a screen — their findings were never fed back into the live
// trading decision. This is the root cause behind two of the reported
// symptoms: PRIMARY_HORIZON=3 and buyThreshold=0.55 were single global
// constants applied identically to every asset and timeframe, regardless
// of what each one's own data actually supported. This module computes a
// genuine per-(symbol, timeframe) optimum using the EXISTING evaluation
// tools (zero new evaluation logic) and persists it so the live pipeline
// can actually use it.

export type OptimalConfig = {
  symbol: string;
  timeframe: string;
  bestHorizon: number;
  bestHorizonEvidence: { returnPct: number; profitFactor: number; winRate: number; numTrades: number };
  bestThreshold: number;
  bestThresholdEvidence: { returnPct: number; profitFactor: number; winRate: number; numTrades: number };
  computedAt: number;
};

const KEY = (symbol: string, timeframe: string) => `optimalConfig_${symbol}_${timeframe}`;

export async function getOptimalConfig(symbol: string, timeframe: string): Promise<OptimalConfig | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY(symbol, timeframe));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function toEvidence(e: { metrics: { totalReturnPct: number; profitFactor: number; winRate: number; numTrades: number } }) {
  return { returnPct: e.metrics.totalReturnPct, profitFactor: e.metrics.profitFactor, winRate: e.metrics.winRate, numTrades: e.metrics.numTrades };
}

// Honest about cost: this runs a full horizon sweep (5 retrains) plus a
// threshold sweep (cheap — same fitted model, different cutoffs) against
// REAL candles for ONE (symbol, timeframe) pair. Not something to run on
// every scan cycle — an explicit, occasional optimization step.
export async function computeOptimalConfig(candles: Candle[], symbol: string, timeframe: string): Promise<OptimalConfig | null> {
  const baseConfig = { ...DEFAULT_BACKTEST_CONFIG };

  const horizonResults: HorizonEvalEntry[] = evaluateAllHorizons(candles, baseConfig);
  const bestHorizonEntry = pickBestHorizon(horizonResults);
  if (!bestHorizonEntry) {
    logger.warn('modelOptimization', `${symbol}/${timeframe}: no horizon produced enough trades to evaluate — cannot determine an optimum honestly.`);
    return null;
  }

  const fitted = fitEnsemble(candles, baseConfig.trainSplitPct, baseConfig.seed, bestHorizonEntry.horizon);
  if (!fitted) return null;

  const thresholdResults: ThresholdEvalEntry[] = evaluateThresholds(fitted, baseConfig);
  const bestThresholdEntry = pickBestThreshold(thresholdResults);
  if (!bestThresholdEntry) {
    logger.warn('modelOptimization', `${symbol}/${timeframe}: no threshold produced enough trades to evaluate at the optimal horizon.`);
    return null;
  }

  const config: OptimalConfig = {
    symbol, timeframe,
    bestHorizon: bestHorizonEntry.horizon, bestHorizonEvidence: toEvidence(bestHorizonEntry),
    bestThreshold: bestThresholdEntry.threshold, bestThresholdEvidence: toEvidence(bestThresholdEntry),
    computedAt: Date.now(),
  };

  await AsyncStorage.setItem(KEY(symbol, timeframe), JSON.stringify(config));
  logger.info('modelOptimization', `${symbol}/${timeframe}: optimal horizon=${config.bestHorizon}, threshold=${config.bestThreshold} (PF ${config.bestThresholdEvidence.profitFactor.toFixed(2)}, ${config.bestThresholdEvidence.numTrades} trades)`);
  return config;
}
