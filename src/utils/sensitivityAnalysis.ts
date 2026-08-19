import { FittedEnsemble, computeMetrics } from './backtest';
import { simulateSignalStrategy, ExecConfig } from './strategyExecutor';

// Tests how performance changes as individual risk parameters vary — using
// the SAME already-trained model (no retraining per variant, since SL/TP/
// risk%/threshold only affect EXECUTION and entry filtering, not what the
// model itself learned). This keeps the analysis fast and, more importantly,
// keeps every variant directly comparable: differences come from the
// parameter being tested, not from a different random training run.
//
// Per the explicit goal stated for this suite: this is NOT about finding
// which setting maximizes historical return (that's how you overfit to one
// specific history). It's about finding which settings are ROBUST — i.e.
// performance doesn't swing wildly between adjacent values. A parameter
// region where returns are wildly sensitive to small changes is a red flag
// that any single "best" value found there is likely a historical accident,
// not a real edge.

export type SensitivityPoint = { paramValue: number; totalReturnPct: number; profitFactor: number; numTrades: number; maxDrawdownPct: number };
export type SensitivityResult = { paramName: string; points: SensitivityPoint[]; coefficientOfVariation: number; robust: boolean };

function runVariant(fitted: FittedEnsemble, execConfig: ExecConfig, buyThreshold: number): SensitivityPoint {
  const { trades, equityCurve } = simulateSignalStrategy(
    fitted.candles, fitted.walkIndices,
    (idx) => {
      const { ensembleProb, agree } = fitted.predictProb(idx);
      return { enter: ensembleProb > buyThreshold && agree, reason: 'sensitivity test' };
    },
    fitted.atrAt, execConfig
  );
  const m = computeMetrics(trades, equityCurve, execConfig.startingCapital);
  return { paramValue: 0, totalReturnPct: m.totalReturnPct, profitFactor: m.profitFactor === Infinity ? 999 : m.profitFactor, numTrades: m.numTrades, maxDrawdownPct: m.maxDrawdownPct };
}

function coefficientOfVariation(values: number[]): number {
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  if (mean === 0) return values.some(v => v !== 0) ? Infinity : 0;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.abs(Math.sqrt(variance) / mean);
}

export function runSensitivityAnalysis(fitted: FittedEnsemble, baseConfig: ExecConfig & { buyThreshold: number }): SensitivityResult[] {
  const results: SensitivityResult[] = [];

  // 1. ATR Stop multiplier
  const slValues = [1.0, 1.5, 2.0, 2.5, 3.0];
  const slPoints = slValues.map(v => ({ ...runVariant(fitted, { ...baseConfig, atrStopMultiplier: v }, baseConfig.buyThreshold), paramValue: v }));
  results.push({ paramName: 'ATR Stop Multiplier', points: slPoints, coefficientOfVariation: coefficientOfVariation(slPoints.map(p => p.totalReturnPct)), robust: false });

  // 2. ATR Target multiplier
  const tpValues = [1.5, 2.0, 2.5, 3.0, 3.5];
  const tpPoints = tpValues.map(v => ({ ...runVariant(fitted, { ...baseConfig, atrTargetMultiplier: v }, baseConfig.buyThreshold), paramValue: v }));
  results.push({ paramName: 'ATR Target Multiplier', points: tpPoints, coefficientOfVariation: coefficientOfVariation(tpPoints.map(p => p.totalReturnPct)), robust: false });

  // 3. Risk per trade %
  const riskValues = [0.5, 1, 2, 3, 5];
  const riskPoints = riskValues.map(v => ({ ...runVariant(fitted, { ...baseConfig, riskPerTradePct: v }, baseConfig.buyThreshold), paramValue: v }));
  results.push({ paramName: 'Risk Per Trade %', points: riskPoints, coefficientOfVariation: coefficientOfVariation(riskPoints.map(p => p.totalReturnPct)), robust: false });

  // 4. Buy threshold (confidence threshold)
  const threshValues = [0.52, 0.55, 0.58, 0.60, 0.65];
  const threshPoints = threshValues.map(v => ({ ...runVariant(fitted, baseConfig, v), paramValue: v }));
  results.push({ paramName: 'Confidence Threshold', points: threshPoints, coefficientOfVariation: coefficientOfVariation(threshPoints.map(p => p.totalReturnPct)), robust: false });

  // Mark "robust" where the coefficient of variation across return outcomes
  // is low (performance doesn't swing wildly with small parameter changes).
  // CoV < 1 is a reasonable rule-of-thumb cutoff — not a rigorous statistical
  // test, but flags the strategies most worth distrusting at a glance.
  results.forEach(r => { r.robust = r.coefficientOfVariation < 1 && isFinite(r.coefficientOfVariation); });

  return results;
}
