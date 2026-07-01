import { Candle } from './indicators';
import { fitEnsemble, computeMetrics, BacktestMetrics } from './backtest';
import { simulateSignalStrategy, ExecConfig } from './strategyExecutor';

// Evaluates EVERY prediction horizon independently in actual TRADING terms
// (return, profit factor, win rate) — not just classification accuracy.
// This requires a full retrain per horizon, since the horizon defines the
// LABEL itself (price up in N bars), unlike SL/TP/risk/threshold which only
// affect execution on top of an already-trained model. There's no way to
// avoid retraining here without changing what's actually being measured.

export type HorizonEvalEntry = { horizon: number; metrics: BacktestMetrics; trainSampleCount: number };

const HORIZONS_TO_TEST = [1, 3, 5, 10, 20];

export function evaluateAllHorizons(candles: Candle[], execConfig: ExecConfig & { trainSplitPct: number; buyThreshold: number; seed: number }): HorizonEvalEntry[] {
  const results: HorizonEvalEntry[] = [];

  for (const horizon of HORIZONS_TO_TEST) {
    const fitted = fitEnsemble(candles, execConfig.trainSplitPct, execConfig.seed, horizon);
    if (!fitted) continue;

    const { trades, equityCurve } = simulateSignalStrategy(
      candles, fitted.walkIndices,
      (idx) => {
        const { ensembleProb, agree } = fitted.predictProb(idx);
        return { enter: ensembleProb > execConfig.buyThreshold && agree, reason: `horizon=${horizon}` };
      },
      fitted.atrAt, execConfig
    );

    const metrics = computeMetrics(trades, equityCurve, execConfig.startingCapital);
    results.push({ horizon, metrics, trainSampleCount: fitted.trainSampleCount });
  }

  return results;
}

// Shared by both horizon and threshold selection (Model Improvement Phase)
// — extracted here so the SAME profit-factor+win-rate scoring philosophy
// is used for both, rather than two independently-invented criteria.
export function scoreMetrics(m: BacktestMetrics): number {
  return (m.profitFactor === Infinity ? 5 : m.profitFactor) * 0.6 + (m.winRate / 100) * 0.4;
}

// Picks the best horizon by a combined score (profit factor + win rate),
// NOT by raw return alone — raw return can be dominated by a small number
// of trades catching a lucky move, while profit factor and win rate are
// more stable indicators of a repeatable edge. This is a deliberate choice
// to avoid "optimizing for historical performance" in the way explicitly
// warned against.
export function pickBestHorizon(entries: HorizonEvalEntry[]): HorizonEvalEntry | null {
  const withTrades = entries.filter(e => e.metrics.numTrades >= 5); // too few trades isn't a meaningful comparison
  if (!withTrades.length) return null;
  return withTrades.reduce((best, e) => scoreMetrics(e.metrics) > scoreMetrics(best.metrics) ? e : best);
}
