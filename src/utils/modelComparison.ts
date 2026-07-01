import { FittedEnsemble, computeMetrics, BacktestMetrics } from './backtest';
import { simulateSignalStrategy, ExecConfig } from './strategyExecutor';

// Compares Neural Net alone, Logistic Regression alone, and the Ensemble —
// all three run through the IDENTICAL execution core on the SAME already-
// trained model instances, so any performance difference comes purely from
// the signal source, never from different risk treatment. This directly
// answers "does the ensemble genuinely improve results, or is it just two
// models that happen to agree with each other most of the time."

export type ModelComparisonEntry = { modelName: 'Neural Network' | 'Logistic Regression' | 'Ensemble'; metrics: BacktestMetrics };

export function compareModels(fitted: FittedEnsemble, execConfig: ExecConfig & { buyThreshold: number }): ModelComparisonEntry[] {
  const variants: { name: ModelComparisonEntry['modelName']; pick: (idx: number) => boolean }[] = [
    { name: 'Neural Network', pick: (idx) => fitted.predictProb(idx).mlpProb > execConfig.buyThreshold },
    { name: 'Logistic Regression', pick: (idx) => fitted.predictProb(idx).lrProb > execConfig.buyThreshold },
    { name: 'Ensemble', pick: (idx) => { const p = fitted.predictProb(idx); return p.ensembleProb > execConfig.buyThreshold && p.agree; } },
  ];

  return variants.map(v => {
    const { trades, equityCurve } = simulateSignalStrategy(
      fitted.candles, fitted.walkIndices,
      (idx) => ({ enter: v.pick(idx), reason: v.name }),
      fitted.atrAt, execConfig
    );
    return { modelName: v.name, metrics: computeMetrics(trades, equityCurve, execConfig.startingCapital) };
  });
}

// Determines whether the ensemble GENUINELY adds value, vs. just being
// cosmetically different from its best individual component.
export function ensembleGenuinelyHelps(entries: ModelComparisonEntry[]): { helps: boolean; reasoning: string } {
  const ensemble = entries.find(e => e.modelName === 'Ensemble')!;
  const bestIndividual = entries.filter(e => e.modelName !== 'Ensemble').reduce((best, e) =>
    e.metrics.profitFactor > best.metrics.profitFactor ? e : best
  );
  const ensembleScore = ensemble.metrics.profitFactor === Infinity ? 10 : ensemble.metrics.profitFactor;
  const bestIndividualScore = bestIndividual.metrics.profitFactor === Infinity ? 10 : bestIndividual.metrics.profitFactor;
  const helps = ensembleScore > bestIndividualScore * 1.05; // require a non-trivial improvement, not just noise
  return {
    helps,
    reasoning: helps
      ? `Ensemble profit factor (${ensembleScore.toFixed(2)}) meaningfully exceeds the best individual model, ${bestIndividual.modelName} (${bestIndividualScore.toFixed(2)}).`
      : `Ensemble (${ensembleScore.toFixed(2)}) does NOT meaningfully beat the best individual model, ${bestIndividual.modelName} (${bestIndividualScore.toFixed(2)}) — the ensemble may not be earning its complexity on this data.`,
  };
}
