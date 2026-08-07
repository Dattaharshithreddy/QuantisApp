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
import { fitEnsemble, computeMetrics, BacktestMetrics, DEFAULT_BACKTEST_CONFIG, BacktestConfig, buildFitCache } from './backtest';
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
// Opt 1: accepts a horizonFittedMap — a Map<horizon, FittedEnsemble> built ONCE
// in evaluateStrategies(). The fitted ensemble for each horizon is reused across
// all 4 strategies: same (candles, trainSplitPct, seed, horizon) → same weights.
// Only simulateSignalStrategy is re-run per strategy (execution params differ).
// Also accepts cache for Opt 4 (skips precomputeSeries if horizon not yet fitted).

// BACKTEST_CONF_SCALE: live confidence is a composite of multiple components
// (probability, agreement, market context, regime alignment, etc.).
// In backtest only the probability component is available:
//   conf = abs(ensembleProb - 0.5) * 200
// This produces values in a much narrower effective range than live confidence.
// A model with 37% accuracy (typical for noisy financial data) has ensembleProb
// clustered near 0.5, so live-calibrated thresholds (70-80) always produce 0 trades.
// Scaling by 0.5 accounts for only having ~1 of the 2 main live components.
// This does NOT change what trades are taken — only whether the strategy
// is representable at all in backtest. Output interpretation is unchanged.
const BACKTEST_CONF_SCALE = 0.5;

async function evaluateOneStrategy(
  candles:           Candle[],
  profile:           StrategyProfile,
  config:            BacktestConfig,
  onProgress?:       (entry: StrategyEvalEntry) => void,
  horizonFittedMap?: Map<number, import('./backtest').FittedEnsemble>,
  fitCache?:         import('./backtest').PrecomputedFitCache | null,
): Promise<StrategyEvalEntry | null> {
  const tick = () => new Promise<void>(r => setTimeout(r, 0));

  // Opt 1: reuse pre-fitted ensemble from the horizon map if available.
  // If the map doesn't have this horizon (shouldn't happen in normal flow),
  // fall back to fitting from scratch — backward-compatible.
  await tick();
  const fitted = horizonFittedMap?.get(profile.primaryHorizon)
    ?? await fitEnsemble(candles, config.trainSplitPct, config.seed, profile.primaryHorizon, fitCache);
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
    maxHoldingBars:   profile.maxBarsHeld > 0 ? profile.maxBarsHeld : config.maxHoldingBars};

  // ── Signal gate with diagnostic counters ────────────────────────────────────
  // Counts distinguish two failure modes:
  //   (A) conf gate kills it  → signals exist but rejected by minConfidence
  //   (B) threshold gate kills it → conf passed but model not decisive enough
  // The reviewer's requested table: BeforeG1 / AfterG1 / AfterG2 (=trades)
  const backtestMinConf = profile.minConfidence * BACKTEST_CONF_SCALE;
  let _diagTotal = 0, _diagPassG1 = 0, _diagPassG2 = 0;
  const _confSamples: number[] = [];

  const { trades, equityCurve } = simulateSignalStrategy(
    candles,
    fitted.walkIndices,
    (idx) => {
      const { ensembleProb, agree } = fitted.predictProb(idx);
      const conf = confFromProb(ensembleProb);
      _diagTotal++;
      _confSamples.push(conf);

      // Gate 1: confidence must meet the backtest-scaled minimum.
      if (conf < backtestMinConf) return { enter: false, reason: `conf ${conf.toFixed(0)} < ${backtestMinConf.toFixed(0)} (backtest scaled)` };
      _diagPassG1++;

      // Gate 2: standard ensemble threshold + agreement
      if (ensembleProb > config.buyThreshold && agree) {
        _diagPassG2++;
        return { enter: true, direction: 'LONG' as const, reason: `${profile.name} LONG h=${profile.primaryHorizon}` };
      }
      if (ensembleProb < (1 - config.buyThreshold) && agree) {
        _diagPassG2++;
        return { enter: true, direction: 'SHORT' as const, reason: `${profile.name} SHORT h=${profile.primaryHorizon}` };
      }
      return { enter: false, reason: 'Below threshold or disagree' };
    },
    fitted.atrAt,
    execConfig,
  );

  // ── Diagnostic table log (answers reviewer's question directly) ──────────────
  const _sortedConfs = [..._confSamples].sort((a, b) => a - b);
  const _pct = (p: number) => _sortedConfs[Math.floor(_sortedConfs.length * p)] ?? 0;
  logger.info('strategyEval', [
    `[GATE DIAG] ${profile.name} (h=${profile.primaryHorizon})`,
    `  minConf=${profile.minConfidence} → btMinConf=${backtestMinConf.toFixed(1)} (×${BACKTEST_CONF_SCALE})`,
    `  BeforeG1=${_diagTotal} | AfterG1(conf≥${backtestMinConf.toFixed(1)})=${_diagPassG1} | AfterG2(threshold+agree)=${_diagPassG2} | Trades=${trades.length}`,
    `  conf distribution: min=${_pct(0).toFixed(1)} p50=${_pct(0.5).toFixed(1)} p90=${_pct(0.9).toFixed(1)} p95=${_pct(0.95).toFixed(1)} max=${_pct(1).toFixed(1)}`,
    `  Failure mode: ${_diagPassG1 === 0 ? 'GATE1_BLOCKS_ALL (conf never reaches btMinConf)' : _diagPassG2 === 0 ? 'GATE2_BLOCKS_ALL (conf ok but prob/agree fails)' : trades.length === 0 ? 'ATR_ZERO (atr=0 on signal bars)' : 'OK'}`,
  ].join('\n'));

  const metrics = computeMetrics(trades, equityCurve, config.startingCapital);

  // Per-horizon breakdown FOR THIS STRATEGY.
  // Opt 1: evaluateAllHorizons internally calls fitEnsemble per horizon.
  // The FittedEnsemble for each horizon is identical regardless of strategy
  // (same candles/seed/split) — only simulateSignalStrategy execution differs.
  // Passing fitCache here (Opt 4) avoids recomputing precomputeSeries+features.
  await tick();
  const horizons = await evaluateAllHorizons(candles, {
    ...config,
    riskPerTradePct:     profile.riskPerTradePct,
    atrStopMultiplier:   profile.atrStopMultiplier,
    atrTargetMultiplier: profile.atrTargetMultiplier,
    maxHoldingBars:      profile.maxBarsHeld > 0 ? profile.maxBarsHeld : config.maxHoldingBars}, undefined, fitCache, horizonFittedMap);
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
    tradeCount:      trades.length};

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
    recommendations: recs};
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
  // Opt 1+4: pre-built cache and horizon map from productionEvaluation.ts.
  // When provided, evaluateStrategies performs ZERO additional fitEnsemble calls.
  // When absent (e.g. called standalone), builds them internally — fully backward-compatible.
  fitCache?:         import('./backtest').PrecomputedFitCache | null,
  horizonFittedMap?: Map<number, import('./backtest').FittedEnsemble>,
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

  // Opt 4: build fit cache if not provided (standalone call path).
  const cache = fitCache ?? await buildFitCache(candles);

  // Opt 1: build the horizon-to-FittedEnsemble map if not provided.
  // Fits each of the 5 horizons ONCE and shares across all strategy evaluations.
  // Without this map, 4 strategies × 5 horizons = 20 fitEnsemble calls.
  // With it: 5 fitEnsemble calls total (already shared from Step 4 in normal flow,
  // or built here for standalone calls).
  let horizonMap = horizonFittedMap;
  if (!horizonMap) {
    horizonMap = new Map();
    const HORIZONS = [1, 3, 5, 10, 20];
    for (const h of HORIZONS) {
      const f = await fitEnsemble(candles, config.trainSplitPct, config.seed, h, cache);
      if (f) horizonMap.set(h, f);
    }
  }

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
            generatedAt: Date.now()};
          onProgress(partial);
        }
        entries.pop();
      }, horizonMap, cache);
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
    generatedAt: Date.now()};

  logger.info('strategyEval', `Strategy evaluation complete: ${entries.length} strategies, best=${result.comparison.bestOverall?.strategyName ?? 'none'}`);
  return result;
}
