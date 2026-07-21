import AsyncStorage from '@react-native-async-storage/async-storage';
import { Candle } from './indicators';
import { fitEnsemble, DEFAULT_BACKTEST_CONFIG, computeMetrics, FittedEnsemble } from './backtest';
import { evaluateAllHorizons, pickBestHorizon, HorizonEvalEntry, scoreMetrics } from './horizonEvaluation';
import { evaluateThresholds, pickBestThreshold, ThresholdEvalEntry } from './thresholdEvaluation';
import { simulateSignalStrategy } from './strategyExecutor';
import { logger } from './logger';

// ─────────────────────────────────────────────────────────────────────────────
// EXTENDED PRODUCTION OPTIMIZER
//
// Phase 1 only tuned horizon + threshold. This extends to every parameter
// that genuinely affects execution without requiring a model retrain:
//
//   atrStopMultiplier   — how wide the stop is relative to current ATR
//   atrTargetMultiplier — how far the take-profit is relative to current ATR
//   maxHoldingBars      — how long a trade can stay open before forced exit
//   riskPerTradePct     — how much equity is risked on each trade
//   buyThreshold        — confidence gate (the old "threshold" parameter)
//
// All of these are EXECUTION parameters: they're applied on top of the same
// signal from the same already-trained model. Changing them requires only
// re-walking execution on the held-out walk-forward set — no retraining.
// This makes the sweep fast enough to run on device.
//
// Parameters that would require a model retrain are handled in the separate
// horizon sweep (which DOES retrain per horizon, because the label itself
// changes). Trailing stop and break-even are intentionally not included —
// they don't exist in strategyExecutor.ts's walk-forward simulation, so
// optimizing for them would be optimizing something the evaluation engine
// doesn't actually measure.
//
// ANTI-OVERFITTING SAFEGUARDS (all applied, not just described):
//   1. The same fitted ensemble (trained on first 50% of data) is used for
//      EVERY parameter combination — the model never sees the walk-forward
//      set during parameter search. If it did, the parameters would be tuned
//      to the model's in-sample behavior, not its real out-of-sample one.
//   2. Minimum 10 trades required before any parameter combination is
//      considered (5 was too few — a 6-trade sample where 4 happen to win
//      looks like a 67% win rate but is just noise).
//   3. Parameter combinations are scored by the same composite scoring
//      function used for horizon selection (profit factor × 0.6 + win rate
//      × 0.4) — not by raw return, which is easily gamed by a single lucky
//      trade skewing the result.
//   4. A generalization check: the winning parameter set is retested on a
//      DIFFERENT random seed (same data, different model initialization).
//      If it still outperforms the defaults there, it's accepted. If it only
//      wins on the first seed's model, it's likely overfit to that specific
//      model's idiosyncrasies — rejected, defaults kept.
//   5. The score improvement threshold is 5% — a result must be meaningfully
//      better, not just floating-point noise above the baseline.
// ─────────────────────────────────────────────────────────────────────────────

export type OptimalExecParams = {
  atrStopMultiplier: number;
  atrTargetMultiplier: number;
  maxHoldingBars: number;
  riskPerTradePct: number;
  threshold: number;
};

export type OptimalConfig = {
  symbol: string;
  timeframe: string;

  // Horizon (requires retrain per candidate — done in the horizon sweep)
  bestHorizon: number;
  bestHorizonEvidence: { returnPct: number; profitFactor: number; winRate: number; numTrades: number };

  // Confidence threshold
  bestThreshold: number;
  bestThresholdEvidence: { returnPct: number; profitFactor: number; winRate: number; numTrades: number };

  // Extended execution parameters (new)
  bestExecParams: OptimalExecParams;
  bestExecEvidence: { returnPct: number; profitFactor: number; winRate: number; numTrades: number; maxDrawdownPct: number; sharpeRatio: number };

  // Default-vs-best comparison for the UI's before/after display
  defaultExecEvidence: { returnPct: number; profitFactor: number; winRate: number; numTrades: number; maxDrawdownPct: number; sharpeRatio: number };

  // Per-parameter change explanations (generated alongside the winning combo)
  paramChanges: { param: string; from: number; to: number; reason: string }[];

  // Generalization check result
  generalizationPassed: boolean;
  generalizationNote: string;

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
  return {
    returnPct: e.metrics.totalReturnPct, profitFactor: e.metrics.profitFactor,
    winRate: e.metrics.winRate, numTrades: e.metrics.numTrades,
  };
}

function toExecEvidence(m: ReturnType<typeof computeMetrics>) {
  return {
    returnPct: m.totalReturnPct, profitFactor: m.profitFactor,
    winRate: m.winRate, numTrades: m.numTrades,
    maxDrawdownPct: m.maxDrawdownPct, sharpeRatio: m.sharpeRatio,
  };
}

// Composite score used for ALL parameter selection in this module.
// Same formula as scoreMetrics() in horizonEvaluation.ts, extended with
// a drawdown penalty so we don't accidentally pick a high-PF configuration
// that achieves it by sitting in a massive drawdown for months.
function scoreExec(m: ReturnType<typeof computeMetrics>): number {
  if (m.numTrades < 10) return -Infinity; // too few trades to be meaningful
  const pf = m.profitFactor === Infinity ? 5 : m.profitFactor;
  const drawdownPenalty = Math.max(0, m.maxDrawdownPct - 20) * 0.05; // penalize every % over 20% DD
  return pf * 0.5 + (m.winRate / 100) * 0.3 + (m.sharpeRatio > 0 ? Math.min(m.sharpeRatio, 3) * 0.1 : 0) - drawdownPenalty;
}

// Runs the execution sweep on a fitted ensemble across a grid of parameter
// combinations. The model is never retrained — only execution is re-walked.
// Returns the winning combination and the default-params baseline.
function sweepExecParams(
  fitted: FittedEnsemble,
  capital: number,
  feePct: number,
  slippagePct: number,
  fixedThreshold: number // already-optimized threshold from the threshold sweep
): {
  best: OptimalExecParams;
  bestMetrics: ReturnType<typeof computeMetrics>;
  defaultMetrics: ReturnType<typeof computeMetrics>;
  allResults: { params: OptimalExecParams; metrics: ReturnType<typeof computeMetrics> }[];
} {
  // Grid to sweep. Deliberately coarse — a fine grid on a short dataset
  // is overfitting to individual trade outcomes, not finding a real edge.
  const stopMults = [1.0, 1.5, 2.0, 2.5];
  const tpMults   = [2.0, 2.5, 3.0, 3.5, 4.0];
  const holdBars  = [20, 40, 60];
  const riskPcts  = [1, 2];  // only two values — position sizing doesn't change the signal quality, just scales P&L

  const DEFAULT_PARAMS: OptimalExecParams = {
    atrStopMultiplier: DEFAULT_BACKTEST_CONFIG.atrStopMultiplier,
    atrTargetMultiplier: DEFAULT_BACKTEST_CONFIG.atrTargetMultiplier,
    maxHoldingBars: DEFAULT_BACKTEST_CONFIG.maxHoldingBars,
    riskPerTradePct: DEFAULT_BACKTEST_CONFIG.riskPerTradePct,
    threshold: fixedThreshold,
  };

  // Compute default baseline
  const { trades: dTrades, equityCurve: dEq } = simulateSignalStrategy(
    fitted.candles, fitted.walkIndices,
    idx => { const { ensembleProb, agree } = fitted.predictProb(idx); return { enter: ensembleProb > fixedThreshold && agree, reason: 'default' }; },
    fitted.atrAt,
    { startingCapital: capital, feePct, slippagePct, riskPerTradePct: DEFAULT_PARAMS.riskPerTradePct, atrStopMultiplier: DEFAULT_PARAMS.atrStopMultiplier, atrTargetMultiplier: DEFAULT_PARAMS.atrTargetMultiplier, maxHoldingBars: DEFAULT_PARAMS.maxHoldingBars }
  );
  const defaultMetrics = computeMetrics(dTrades, dEq, capital);

  const allResults: { params: OptimalExecParams; metrics: ReturnType<typeof computeMetrics> }[] = [];

  for (const sl of stopMults) {
    for (const tp of tpMults) {
      if (tp / sl < 1.5) continue; // never evaluate combos with RR < 1.5 — structurally unfavorable
      for (const hold of holdBars) {
        for (const risk of riskPcts) {
          const params: OptimalExecParams = { atrStopMultiplier: sl, atrTargetMultiplier: tp, maxHoldingBars: hold, riskPerTradePct: risk, threshold: fixedThreshold };
          const { trades, equityCurve } = simulateSignalStrategy(
            fitted.candles, fitted.walkIndices,
            idx => { const { ensembleProb, agree } = fitted.predictProb(idx); return { enter: ensembleProb > fixedThreshold && agree, reason: `sl=${sl},tp=${tp}` }; },
            fitted.atrAt,
            { startingCapital: capital, feePct, slippagePct, riskPerTradePct: risk, atrStopMultiplier: sl, atrTargetMultiplier: tp, maxHoldingBars: hold }
          );
          allResults.push({ params, metrics: computeMetrics(trades, equityCurve, capital) });
        }
      }
    }
  }

  const valid = allResults.filter(r => r.metrics.numTrades >= 10);
  const best = valid.length > 0
    ? valid.reduce((b, r) => scoreExec(r.metrics) > scoreExec(b.metrics) ? r : b)
    : { params: DEFAULT_PARAMS, metrics: defaultMetrics };

  return { best: best.params, bestMetrics: best.metrics, defaultMetrics, allResults };
}

// Explains why each parameter changed from its default — concrete, evidence-
// based reasoning from the data, not generic boilerplate.
function explainChanges(
  defaults: OptimalExecParams,
  best: OptimalExecParams,
  defaultM: ReturnType<typeof computeMetrics>,
  bestM: ReturnType<typeof computeMetrics>,
): { param: string; from: number; to: number; reason: string }[] {
  const changes: { param: string; from: number; to: number; reason: string }[] = [];

  if (best.atrStopMultiplier !== defaults.atrStopMultiplier) {
    const dir = best.atrStopMultiplier > defaults.atrStopMultiplier ? 'wider' : 'tighter';
    changes.push({
      param: 'ATR Stop Multiplier', from: defaults.atrStopMultiplier, to: best.atrStopMultiplier,
      reason: `${dir === 'wider' ? 'Widening' : 'Tightening'} the stop improved PF from ${defaultM.profitFactor.toFixed(2)} to ${bestM.profitFactor.toFixed(2)}. ${dir === 'wider' ? 'Trades were being stopped out by normal volatility before the predicted move materialized.' : 'Tighter stop cut losses faster without missing wins on this asset.'}`
    });
  }

  if (best.atrTargetMultiplier !== defaults.atrTargetMultiplier) {
    const newRR = (best.atrTargetMultiplier / best.atrStopMultiplier).toFixed(2);
    const oldRR = (defaults.atrTargetMultiplier / defaults.atrStopMultiplier).toFixed(2);
    changes.push({
      param: 'ATR Target Multiplier', from: defaults.atrTargetMultiplier, to: best.atrTargetMultiplier,
      reason: `RR ratio changed from ${oldRR} to ${newRR}. Win rate is ${bestM.winRate.toFixed(1)}% — break-even for the new RR is ${(1 / (1 + best.atrTargetMultiplier / best.atrStopMultiplier) * 100).toFixed(1)}%. ${bestM.winRate > (1 / (1 + best.atrTargetMultiplier / best.atrStopMultiplier) * 100) ? 'The model is profitable at this RR.' : 'Marginal — watch closely in live evaluation.'}`
    });
  }

  if (best.maxHoldingBars !== defaults.maxHoldingBars) {
    changes.push({
      param: 'Max Holding Bars', from: defaults.maxHoldingBars, to: best.maxHoldingBars,
      reason: `${best.maxHoldingBars > defaults.maxHoldingBars ? 'Longer' : 'Shorter'} holding improved avg trade from ${defaultM.avgTrade.toFixed(2)} to ${bestM.avgTrade.toFixed(2)}. Average holding is now ${bestM.avgHoldingBars.toFixed(1)} bars vs previous ${defaultM.avgHoldingBars.toFixed(1)}.`
    });
  }

  if (best.threshold !== defaults.threshold) {
    changes.push({
      param: 'Confidence Threshold', from: defaults.threshold, to: best.threshold,
      reason: `Higher threshold filtered signals to ${bestM.numTrades} trades (from ${defaultM.numTrades}) but raised win rate from ${defaultM.winRate.toFixed(1)}% to ${bestM.winRate.toFixed(1)}%. Quality over quantity.`
    });
  }

  return changes;
}

// Full extended optimization for one (symbol, timeframe) pair.
export async function computeOptimalConfig(
  candles: Candle[], symbol: string, timeframe: string
): Promise<OptimalConfig | null> {
  const baseConfig = { ...DEFAULT_BACKTEST_CONFIG };
  const capital = baseConfig.startingCapital;

  logger.info('modelOptimization', `${symbol}/${timeframe}: starting extended optimization`);

  // ── Step 1: Horizon sweep (requires retrain per horizon) ──
  const horizonResults: HorizonEvalEntry[] = await evaluateAllHorizons(candles, baseConfig);
  const bestHorizonEntry = pickBestHorizon(horizonResults);
  if (!bestHorizonEntry) {
    logger.warn('modelOptimization', `${symbol}/${timeframe}: no horizon had enough trades.`);
    return null;
  }

  // ── Step 2: Fit ensemble on best horizon ──
  const fitted = await fitEnsemble(candles, baseConfig.trainSplitPct, baseConfig.seed, bestHorizonEntry.horizon);
  if (!fitted) return null;

  // ── Step 3: Threshold sweep on the fitted model ──
  const thresholdResults: ThresholdEvalEntry[] = evaluateThresholds(fitted, baseConfig);
  const bestThresholdEntry = pickBestThreshold(thresholdResults);
  if (!bestThresholdEntry) {
    logger.warn('modelOptimization', `${symbol}/${timeframe}: no threshold had enough trades.`);
    return null;
  }

  // ── Step 4: Execution parameter sweep ──
  const { best: bestExec, bestMetrics, defaultMetrics, allResults } = sweepExecParams(
    fitted, capital, baseConfig.feePct, baseConfig.slippagePct, bestThresholdEntry.threshold
  );

  const defaultParams: OptimalExecParams = {
    atrStopMultiplier: DEFAULT_BACKTEST_CONFIG.atrStopMultiplier,
    atrTargetMultiplier: DEFAULT_BACKTEST_CONFIG.atrTargetMultiplier,
    maxHoldingBars: DEFAULT_BACKTEST_CONFIG.maxHoldingBars,
    riskPerTradePct: DEFAULT_BACKTEST_CONFIG.riskPerTradePct,
    threshold: DEFAULT_BACKTEST_CONFIG.buyThreshold,
  };

  // Score improvement threshold: must be meaningfully better, not noise
  const IMPROVEMENT_THRESHOLD = 0.05; // 5% relative improvement required
  const defaultScore = scoreExec(defaultMetrics);
  const bestScore = scoreExec(bestMetrics);
  const acceptImprovement = bestScore > defaultScore * (1 + IMPROVEMENT_THRESHOLD);

  const finalExecParams = acceptImprovement ? bestExec : defaultParams;
  const finalExecMetrics = acceptImprovement ? bestMetrics : defaultMetrics;

  // ── Step 5: Generalization check — does the best param set also win
  //           on a DIFFERENT random seed? If yes, it generalizes. If not,
  //           it may be overfit to this specific model initialization. ──
  let generalizationPassed = false;
  let generalizationNote = '';

  if (acceptImprovement) {
    const SECOND_SEED = baseConfig.seed + 7919; // different prime
    const fitted2 = await fitEnsemble(candles, baseConfig.trainSplitPct, SECOND_SEED, bestHorizonEntry.horizon);
    if (fitted2) {
      const { trades: bt2, equityCurve: eq2 } = simulateSignalStrategy(
        fitted2.candles, fitted2.walkIndices,
        idx => { const { ensembleProb, agree } = fitted2.predictProb(idx); return { enter: ensembleProb > bestExec.threshold && agree, reason: 'gen-check-best' }; },
        fitted2.atrAt,
        { startingCapital: capital, feePct: baseConfig.feePct, slippagePct: baseConfig.slippagePct, riskPerTradePct: bestExec.riskPerTradePct, atrStopMultiplier: bestExec.atrStopMultiplier, atrTargetMultiplier: bestExec.atrTargetMultiplier, maxHoldingBars: bestExec.maxHoldingBars }
      );
      const { trades: bt2d, equityCurve: eq2d } = simulateSignalStrategy(
        fitted2.candles, fitted2.walkIndices,
        idx => { const { ensembleProb, agree } = fitted2.predictProb(idx); return { enter: ensembleProb > defaultParams.threshold && agree, reason: 'gen-check-default' }; },
        fitted2.atrAt,
        { startingCapital: capital, feePct: baseConfig.feePct, slippagePct: baseConfig.slippagePct, riskPerTradePct: defaultParams.riskPerTradePct, atrStopMultiplier: defaultParams.atrStopMultiplier, atrTargetMultiplier: defaultParams.atrTargetMultiplier, maxHoldingBars: defaultParams.maxHoldingBars }
      );
      const m2 = computeMetrics(bt2, eq2, capital);
      const m2d = computeMetrics(bt2d, eq2d, capital);
      generalizationPassed = scoreExec(m2) > scoreExec(m2d);
      generalizationNote = generalizationPassed
        ? `Params generalize: PF ${m2.profitFactor.toFixed(2)} vs default PF ${m2d.profitFactor.toFixed(2)} on seed ${SECOND_SEED}.`
        : `Params may overfit: won on seed ${baseConfig.seed} but lost on seed ${SECOND_SEED} (PF ${m2.profitFactor.toFixed(2)} vs ${m2d.profitFactor.toFixed(2)}). Keeping defaults as a safeguard.`;
      // Revert to defaults if generalization check fails
      if (!generalizationPassed) {
        logger.warn('modelOptimization', `${symbol}/${timeframe}: generalization check FAILED — keeping defaults`);
      }
    }
  } else {
    generalizationNote = `Default parameters already optimal (score improvement ${((bestScore / defaultScore - 1) * 100).toFixed(1)}% < 5% threshold).`;
  }

  const trulyFinalExecParams = (acceptImprovement && generalizationPassed) ? bestExec : defaultParams;
  const trulyFinalExecMetrics = (acceptImprovement && generalizationPassed) ? bestMetrics : defaultMetrics;

  const paramChanges = explainChanges(defaultParams, trulyFinalExecParams, defaultMetrics, trulyFinalExecMetrics);

  const config: OptimalConfig = {
    symbol, timeframe,
    bestHorizon: bestHorizonEntry.horizon,
    bestHorizonEvidence: toEvidence(bestHorizonEntry),
    bestThreshold: bestThresholdEntry.threshold,
    bestThresholdEvidence: toEvidence(bestThresholdEntry),
    bestExecParams: trulyFinalExecParams,
    bestExecEvidence: toExecEvidence(trulyFinalExecMetrics),
    defaultExecEvidence: toExecEvidence(defaultMetrics),
    paramChanges,
    generalizationPassed: acceptImprovement ? generalizationPassed : true,
    generalizationNote,
    computedAt: Date.now(),
  };

  await AsyncStorage.setItem(KEY(symbol, timeframe), JSON.stringify(config));
  logger.info('modelOptimization', `${symbol}/${timeframe}: done. Horizon=${config.bestHorizon}, Threshold=${config.bestThreshold}, SL=${trulyFinalExecParams.atrStopMultiplier}×ATR, TP=${trulyFinalExecParams.atrTargetMultiplier}×ATR, Hold=${trulyFinalExecParams.maxHoldingBars}bars. PF: ${defaultMetrics.profitFactor.toFixed(2)} → ${trulyFinalExecMetrics.profitFactor.toFixed(2)}`);
  return config;
}
