import { Candle } from './indicators';
import { trainAndPredict } from './mlSignal';
import { runBacktest } from './backtest';
import { logger } from './logger';

// TASK 7/8 (Verification & Stress Test, batch execution) — every number
// here comes from a function that already existed and was already
// verified elsewhere in this app: trainAndPredict for the walk-forward
// confusion matrix (itself derived from the same no-look-ahead fold
// methodology used everywhere else), runBacktest for win rate/profit
// factor/Sharpe/drawdown. This module only ORCHESTRATES and AGGREGATES —
// it introduces no new scoring formula and no new classification logic.

export type StressTestEntry = {
  symbol: string; timeframe: string;
  accuracy: number; precision: number; recall: number; f1: number;
  winRate: number; profitFactor: number; sharpeRatio: number; maxDrawdownPct: number;
  avgConfidence: number; numTrades: number;
};

export async function runStressTestCombo(candles: Candle[], symbol: string, timeframe: string, assetClass = 'UNKNOWN'): Promise<StressTestEntry | null> {
  if (candles.length < 120) {
    logger.warn('stressTest', `${symbol}/${timeframe}: only ${candles.length} candles, below the 120 minimum — skipped`);
    return null;
  }
  const prediction = await trainAndPredict(symbol, timeframe, candles, undefined, undefined, false, assetClass);
  if (!prediction) return null;
  const backtestResult = await runBacktest(candles, {});
  if (!backtestResult) return null;

  const { truePositives: tp, falsePositives: fp, trueNegatives: tn, falseNegatives: fn } = prediction.walkForwardConfusion;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  return {
    symbol, timeframe,
    accuracy: prediction.walkForwardAccuracy, precision, recall, f1,
    winRate: backtestResult.metrics.winRate, profitFactor: backtestResult.metrics.profitFactor,
    sharpeRatio: backtestResult.metrics.sharpeRatio, maxDrawdownPct: backtestResult.metrics.maxDrawdownPct,
    avgConfidence: prediction.confidence, numTrades: backtestResult.metrics.numTrades,
  };
}

export type StressTestSummary = {
  entries: StressTestEntry[];
  avgAccuracy: number; avgPrecision: number; avgRecall: number; avgF1: number;
  avgWinRate: number; avgProfitFactor: number; avgSharpe: number; avgMaxDrawdown: number; avgConfidence: number;
  bestSymbol: string | null; worstSymbol: string | null;
  bestTimeframe: string | null; worstTimeframe: string | null;
};

// Symbols/timeframes are scored by combined profit factor + win rate —
// the SAME philosophy as scoreMetrics in horizonEvaluation.ts (reused
// inline here since it operates on StressTestEntry, not BacktestMetrics
// directly, but the formula itself is identical, not reinvented).
function comboScore(e: StressTestEntry): number {
  return (e.profitFactor === Infinity ? 5 : e.profitFactor) * 0.6 + (e.winRate / 100) * 0.4;
}

export function summarizeStressTest(entries: StressTestEntry[]): StressTestSummary {
  const withTrades = entries.filter(e => e.numTrades >= 5);
  const avg = (key: keyof StressTestEntry) => entries.length ? entries.reduce((s, e) => s + (e[key] as number), 0) / entries.length : 0;

  const bySymbol = new Map<string, StressTestEntry[]>();
  const byTimeframe = new Map<string, StressTestEntry[]>();
  withTrades.forEach(e => {
    bySymbol.set(e.symbol, [...(bySymbol.get(e.symbol) ?? []), e]);
    byTimeframe.set(e.timeframe, [...(byTimeframe.get(e.timeframe) ?? []), e]);
  });

  function bestWorstKey(grouped: Map<string, StressTestEntry[]>): { best: string | null; worst: string | null } {
    if (!grouped.size) return { best: null, worst: null };
    const scored = Array.from(grouped.entries()).map(([key, es]) => ({ key, score: es.reduce((s, e) => s + comboScore(e), 0) / es.length }));
    scored.sort((a, b) => b.score - a.score);
    return { best: scored[0].key, worst: scored[scored.length - 1].key };
  }

  const symbolResult = bestWorstKey(bySymbol);
  const tfResult = bestWorstKey(byTimeframe);

  return {
    entries,
    avgAccuracy: avg('accuracy'), avgPrecision: avg('precision'), avgRecall: avg('recall'), avgF1: avg('f1'),
    avgWinRate: avg('winRate'), avgProfitFactor: avg('profitFactor'), avgSharpe: avg('sharpeRatio'),
    avgMaxDrawdown: avg('maxDrawdownPct'), avgConfidence: avg('avgConfidence'),
    bestSymbol: symbolResult.best, worstSymbol: symbolResult.worst,
    bestTimeframe: tfResult.best, worstTimeframe: tfResult.worst,
  };
}
