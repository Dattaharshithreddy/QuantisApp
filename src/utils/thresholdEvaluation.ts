import { BacktestMetrics, FittedEnsemble, computeMetrics } from './backtest';
import { simulateSignalStrategy, ExecConfig } from './strategyExecutor';
import { scoreMetrics } from './horizonEvaluation';

// Cheap by design: reuses ONE already-trained model and just re-walks
// execution with different confidence thresholds — no retraining needed,
// since the threshold only filters which of the SAME predictions count as
// a signal. Reports how trade frequency, win rate, and profitability shift
// as the bar for "confident enough to trade" is raised.

export type ThresholdEvalEntry = { threshold: number; metrics: BacktestMetrics };

const THRESHOLDS_TO_TEST = [0.55, 0.60, 0.65, 0.70, 0.75, 0.80];

export function evaluateThresholds(fitted: FittedEnsemble, execConfig: ExecConfig): ThresholdEvalEntry[] {
  return THRESHOLDS_TO_TEST.map(threshold => {
    const { trades, equityCurve } = simulateSignalStrategy(
      fitted.candles, fitted.walkIndices,
      (idx) => {
        const { ensembleProb, agree } = fitted.predictProb(idx);
        return { enter: ensembleProb > threshold && agree, reason: `threshold=${threshold}` };
      },
      fitted.atrAt, execConfig
    );
    return { threshold, metrics: computeMetrics(trades, equityCurve, execConfig.startingCapital) };
  });
}

// Picks the best confidence threshold using the EXACT SAME scoring formula
// as pickBestHorizon (horizonEvaluation.ts) — reused, not reinvented, so
// "best" means the same thing whether tuning a horizon or a threshold.
export function pickBestThreshold(entries: ThresholdEvalEntry[]): ThresholdEvalEntry | null {
  const withTrades = entries.filter(e => e.metrics.numTrades >= 5);
  if (!withTrades.length) return null;
  return withTrades.reduce((best, e) => scoreMetrics(e.metrics) > scoreMetrics(best.metrics) ? e : best);
}
