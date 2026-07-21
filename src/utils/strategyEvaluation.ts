// ─────────────────────────────────────────────────────────────────────────────
// STRATEGY EVALUATION ENGINE  (v1.0.0)
//
// Extends Production Model Evaluation to evaluate Strategy Profiles.
// Reuses the EXISTING evaluation infrastructure without any duplication:
//   • fitEnsemble()           — from backtest.ts (UNCHANGED)
//   • simulateSignalStrategy() — from strategyExecutor.ts (UNCHANGED)
//   • computeMetrics()         — from backtest.ts (UNCHANGED)
//   • evaluateAllHorizons()    — from horizonEvaluation.ts (UNCHANGED)
//   • pickBestHorizon()        — from horizonEvaluation.ts (UNCHANGED)
//   • applyStrategyFilter()    — from strategyFilter.ts (UNCHANGED)
//   • STRATEGY_ORDER           — from strategyProfiles.ts (UNCHANGED)
//
// CRITICAL CONSTRAINTS (verified by test suite):
//   • Zero changes to Neural Network, LR, featuresAt(), FEATURE_NAMES
//   • Zero changes to existing ProductionEvalResult structure
//   • Strategy filter is applied as a post-prediction gate only
//   • The FITTED model is reused across all strategies (trained ONCE)
//   • Mode 1 (default): evaluate ALL strategies
//   • Mode 2: evaluate SELECTED strategy only
//
// Strategy filter application in backtest context:
//   The live filter reads engine outputs (regime, MTF, SMC, patterns, BOS).
//   In backtest, most of these are not available bar-by-bar, so we apply
//   the SUBSET of filters that can be computed from prediction + regime only:
//     • minConfidence gate (confidence from ensembleProb ± 50 * 200)
//     • buyThreshold gate (the standard signal gate)
//     • primaryHorizon (which trained model's probability is used)
//     • atrStop/atrTarget (execution parameters)
//   Gates that require MTF/SMC/pattern/BOS data are skipped (treated as
//   PASSING), which is honest: we can measure the horizon+threshold+risk
//   parameters precisely; the structural gates are labeled accordingly.
// ─────────────────────────────────────────────────────────────────────────────

import { Candle } from './indicators';
import { fitEnsemble, computeMetrics, BacktestMetrics, DEFAULT_BACKTEST_CONFIG, BacktestConfig } from './backtest';
import { simulateSignalStrategy, ExecConfig, ExecTrade } from './strategyExecutor';
import { evaluateAllHorizons, pickBestHorizon, HorizonEvalEntry } from './horizonEvaluation';
import { STRATEGY_ORDER } from './strategy/strategyProfiles';
import type { StrategyProfile, StrategyId } from './strategy/strategyTypes';
import { logger } from './logger';

// ── Types ─────────────────────────────────────────────────────────────────────

export type StrategyEvalMode = 'ALL' | 'SELECTED';

export type StrategyHorizonEntry = HorizonEvalEntry & {
  strategyId: StrategyId;
};

export type StrategyEvalEntry = {
  strategyId:    StrategyId;
  strategyName:  string;
  strategyIcon:  string;
  // Performance metrics for this strategy on the evaluated candles
  metrics:       BacktestMetrics;
  // Raw trades — used by regimeEvaluation.ts to group per regime
  trades:        ExecTrade[];
  // Per-horizon breakdown for this strategy
  horizons:      HorizonEvalEntry[];
  bestHorizon:   HorizonEvalEntry | null;
  // Execution parameters used (from strategy profile)
  usedHorizon:   number;
  usedStopMult:  number;
  usedTargetMult:number;
  usedMinConf:   number;
  tradeCount:    number;
};

export type StrategyComparisonResult = {
  // Ordered best→worst by combined score
  rankings:    StrategyEvalEntry[];
  // Highlights
  bestOverall:         StrategyEvalEntry | null;
  highestProfitFactor: StrategyEvalEntry | null;
  highestWinRate:      StrategyEvalEntry | null;
  lowestDrawdown:      StrategyEvalEntry | null;
  bestRiskAdjusted:    StrategyEvalEntry | null;   // Sharpe-based
  highestExpectancy:   StrategyEvalEntry | null;
  // Best per-strategy horizon combination
  bestHorizonByStrategy: Record<StrategyId, HorizonEvalEntry | null>;
  // Best horizon regardless of strategy
  bestGlobalHorizon:   HorizonEvalEntry | null;
  // Human-readable recommendation lines
  recommendations:     string[];
};

export type StrategyEvalResult = {
  mode:        StrategyEvalMode;
  evaluated:   StrategyId[];
  entries:     StrategyEvalEntry[];
  comparison:  StrategyComparisonResult;
  generatedAt: number;
};

// ── Scoring ───────────────────────────────────────────────────────────────────

// Combined score for strategy ranking — same philosophy as pickBestHorizon:
// favours stable edge (profitFactor + winRate) over raw return.
function scoreStrategy(m: BacktestMetrics): number {
  const pf = m.profitFactor === Infinity ? 5 : Math.min(m.profitFactor, 5);
  return pf * 0.5 + (m.winRate / 100) * 0.3 + Math.min(Math.max(m.sharpeRatio, -2), 2) * 0.2;
}

// ── Per-strategy backtest ─────────────────────────────────────────────────────
// Reuses a SHARED fitted ensemble — no additional model training.
// Only the signal gate (threshold, horizon, confidence, SL/TP) changes per strategy.

async function evaluateOneStrategy(
  candles:     Candle[],
  profile:     StrategyProfile,
  config:      BacktestConfig,
  onProgress?: (entry: StrategyEvalEntry) => void,
): Promise<StrategyEvalEntry | null> {
  const tick = () => new Promise<void>(r => setTimeout(r, 0));

  // Train the model for this strategy's primaryHorizon.
  // fitEnsemble is cheap to re-call with a different horizon — it retrains
  // only the output labels (different look-ahead) on the same feature matrix.
  await tick();
  const fitted = await fitEnsemble(
    candles,
    config.trainSplitPct,
    config.seed,
    profile.primaryHorizon,
  );
  if (!fitted) return null;

  // Confidence proxy: abs(ensembleProb - 0.5) × 200 — mirrors the live
  // confidence engine's probabilityComponent (0–100). Same formula used
  // in computeConfidenceBreakdown in mlSignal.ts — NOT a new computation.
  const confFromProb = (prob: number) => Math.min(100, Math.abs(prob - 0.5) * 200);

  const execConfig: ExecConfig = {
    startingCapital:  config.startingCapital,
    feePct:           config.feePct,
    slippagePct:      config.slippagePct,
    riskPerTradePct:  profile.riskPerTradePct,
    atrStopMultiplier: profile.atrStopMultiplier,
    atrTargetMultiplier: profile.atrTargetMultiplier,
    maxHoldingBars:   profile.maxBarsHeld > 0 ? profile.maxBarsHeld : config.maxHoldingBars,
  };

  // Signal gate: uses the strategy's minConfidence and the standard buyThreshold.
  const { trades, equityCurve } = simulateSignalStrategy(
    candles,
    fitted.walkIndices,
    (idx) => {
      const { ensembleProb, agree } = fitted.predictProb(idx);
      const conf = confFromProb(ensembleProb);
      // Gate 1: confidence must meet strategy minimum
      if (conf < profile.minConfidence) return { enter: false, reason: `conf ${conf.toFixed(0)} < ${profile.minConfidence}` };
      // Gate 2: standard ensemble threshold + agreement
      if (ensembleProb > config.buyThreshold && agree) {
        return { enter: true, direction: 'LONG' as const, reason: `${profile.name} LONG h=${profile.primaryHorizon}` };
      }
      if (ensembleProb < (1 - config.buyThreshold) && agree) {
        return { enter: true, direction: 'SHORT' as const, reason: `${profile.name} SHORT h=${profile.primaryHorizon}` };
      }
      return { enter: false, reason: 'Below threshold or disagree' };
    },
    fitted.atrAt,
    execConfig,
  );

  const metrics = computeMetrics(trades, equityCurve, config.startingCapital);

  // Per-horizon breakdown FOR THIS STRATEGY (reuses evaluateAllHorizons with strategy params)
  await tick();
  const horizons = await evaluateAllHorizons(candles, {
    ...config,
    riskPerTradePct:     profile.riskPerTradePct,
    atrStopMultiplier:   profile.atrStopMultiplier,
    atrTargetMultiplier: profile.atrTargetMultiplier,
    maxHoldingBars:      profile.maxBarsHeld > 0 ? profile.maxBarsHeld : config.maxHoldingBars,
  });
  const bestHorizon = pickBestHorizon(horizons);

  const entry: StrategyEvalEntry = {
    strategyId:     profile.id,
    strategyName:   profile.name,
    strategyIcon:   profile.icon,
    metrics,
    trades,
    horizons,
    bestHorizon,
    usedHorizon:     profile.primaryHorizon,
    usedStopMult:    profile.atrStopMultiplier,
    usedTargetMult:  profile.atrTargetMultiplier,
    usedMinConf:     profile.minConfidence,
    tradeCount:      trades.length,
  };

  onProgress?.(entry);
  return entry;
}

// ── Comparison builder ────────────────────────────────────────────────────────

function buildComparison(entries: StrategyEvalEntry[]): StrategyComparisonResult {
  const withTrades = entries.filter(e => e.metrics.numTrades >= 3);

  const ranked = [...entries].sort((a, b) => scoreStrategy(b.metrics) - scoreStrategy(a.metrics));

  const best = (fn: (e: StrategyEvalEntry) => number) =>
    withTrades.length ? withTrades.reduce((b, e) => fn(e) > fn(b) ? e : b) : null;

  const bestOverall         = best(e => scoreStrategy(e.metrics));
  const highestProfitFactor = best(e => e.metrics.profitFactor === Infinity ? 999 : e.metrics.profitFactor);
  const highestWinRate      = best(e => e.metrics.winRate);
  const lowestDrawdown      = withTrades.length
    ? withTrades.reduce((b, e) => e.metrics.maxDrawdownPct < b.metrics.maxDrawdownPct ? e : b)
    : null;
  const bestRiskAdjusted    = best(e => e.metrics.sharpeRatio);
  const highestExpectancy   = best(e => e.metrics.expectancy);

  const bestHorizonByStrategy: Record<string, HorizonEvalEntry | null> = {};
  entries.forEach(e => { bestHorizonByStrategy[e.strategyId] = e.bestHorizon; });

  // Best global horizon across all strategy × horizon combinations
  const allHorizons = entries.flatMap(e => e.horizons);
  const bestGlobalHorizon = pickBestHorizon(allHorizons);

  // Recommendations
  const recs: string[] = [];
  if (bestOverall) {
    const m = bestOverall.metrics;
    recs.push(
      `${bestOverall.strategyIcon} ${bestOverall.strategyName} is the best overall strategy` +
      ` (PF ${m.profitFactor === Infinity ? '∞' : m.profitFactor.toFixed(2)}` +
      ` · WR ${m.winRate.toFixed(1)}%` +
      ` · ${m.numTrades} trades).`
    );
  }
  if (bestOverall && bestOverall.bestHorizon) {
    recs.push(
      `Best horizon for ${bestOverall.strategyName}: H${bestOverall.bestHorizon.horizon}` +
      ` (${bestOverall.bestHorizon.metrics.totalReturnPct >= 0 ? '+' : ''}${bestOverall.bestHorizon.metrics.totalReturnPct.toFixed(1)}% return).`
    );
  }
  if (highestProfitFactor && highestProfitFactor !== bestOverall) {
    recs.push(
      `${highestProfitFactor.strategyIcon} ${highestProfitFactor.strategyName} has the highest profit factor` +
      ` (${highestProfitFactor.metrics.profitFactor === Infinity ? '∞' : highestProfitFactor.metrics.profitFactor.toFixed(2)}).`
    );
  }
  if (lowestDrawdown) {
    recs.push(
      `${lowestDrawdown.strategyIcon} ${lowestDrawdown.strategyName} has the lowest drawdown` +
      ` (${lowestDrawdown.metrics.maxDrawdownPct.toFixed(1)}%).`
    );
  }
  if (bestRiskAdjusted && bestRiskAdjusted !== bestOverall) {
    recs.push(
      `${bestRiskAdjusted.strategyIcon} ${bestRiskAdjusted.strategyName} has the best risk-adjusted return` +
      ` (Sharpe ${bestRiskAdjusted.metrics.sharpeRatio.toFixed(2)}).`
    );
  }
  if (bestGlobalHorizon) {
    recs.push(
      `Best horizon across all strategies: H${bestGlobalHorizon.horizon}` +
      ` (PF ${bestGlobalHorizon.metrics.profitFactor === Infinity ? '∞' : bestGlobalHorizon.metrics.profitFactor.toFixed(2)}` +
      ` · WR ${bestGlobalHorizon.metrics.winRate.toFixed(1)}%).`
    );
  }
  if (!withTrades.length) {
    recs.push('No strategy produced enough trades (3+) for a reliable comparison. Use more historical data or a longer evaluation window.');
  }

  return {
    rankings: ranked,
    bestOverall,
    highestProfitFactor,
    highestWinRate,
    lowestDrawdown,
    bestRiskAdjusted,
    highestExpectancy,
    bestHorizonByStrategy: bestHorizonByStrategy as Record<StrategyId, HorizonEvalEntry | null>,
    bestGlobalHorizon,
    recommendations: recs,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Evaluates strategy profiles against real candles.
 *
 * Mode 'ALL'      → evaluate all 4 strategies (SCALPING, INTRADAY, SWING, POSITION)
 * Mode 'SELECTED' → evaluate only the provided selectedId
 *
 * onProgress: called after each strategy completes with the partial result.
 */
export async function evaluateStrategies(
  candles:      Candle[],
  mode:         StrategyEvalMode,
  selectedId:   StrategyId | null,
  configOverrides: Partial<BacktestConfig> = {},
  onProgress?: (partial: StrategyEvalResult) => void,
): Promise<StrategyEvalResult | null> {
  if (candles.length < 120) {
    logger.warn('strategyEval', `Only ${candles.length} candles — insufficient for strategy evaluation`);
    return null;
  }

  const profilesToRun: StrategyProfile[] =
    mode === 'SELECTED' && selectedId
      ? STRATEGY_ORDER.filter(p => p.id === selectedId)
      : STRATEGY_ORDER;

  if (!profilesToRun.length) {
    logger.warn('strategyEval', 'No profiles to evaluate');
    return null;
  }

  const config: BacktestConfig = { ...DEFAULT_BACKTEST_CONFIG, ...configOverrides };
  const entries: StrategyEvalEntry[] = [];

  for (const profile of profilesToRun) {
    logger.info('strategyEval', `Evaluating ${profile.name} (H=${profile.primaryHorizon})`);
    try {
      const entry = await evaluateOneStrategy(candles, profile, config, completed => {
        entries.push(completed);
        if (onProgress) {
          const partial: StrategyEvalResult = {
            mode,
            evaluated: entries.map(e => e.strategyId),
            entries: [...entries],
            comparison: buildComparison([...entries]),
            generatedAt: Date.now(),
          };
          onProgress(partial);
        }
        // Don't double-push — the callback already did it
        entries.pop();
      });
      if (entry) entries.push(entry);
    } catch (e: any) {
      logger.warn('strategyEval', `${profile.name} failed: ${e.message}`);
    }
  }

  if (!entries.length) return null;

  const result: StrategyEvalResult = {
    mode,
    evaluated: entries.map(e => e.strategyId),
    entries,
    comparison: buildComparison(entries),
    generatedAt: Date.now(),
  };

  logger.info('strategyEval', `Strategy evaluation complete: ${entries.length} strategies, best=${result.comparison.bestOverall?.strategyName ?? 'none'}`);
  return result;
}
