import { Candle } from './indicators';
import { fitEnsemble, runBacktest, computeMetrics, BacktestMetrics,
         DEFAULT_BACKTEST_CONFIG, BacktestConfig,
         buildFitCache, PrecomputedFitCache } from './backtest';
import { PRIMARY_HORIZON } from './mlSignal'; // OPT A: used to seed horizonFittedMap with h=3 from runBacktest
import { runBaseline, ALL_BASELINES, BaselineName } from './baselineStrategies';
import { bucketTradesByRegime, RegimeBucket } from './regimeAnalysis';
import { HorizonEvalEntry, evaluateAllHorizons, evaluateAllHorizonsWithTrades, pickBestHorizon } from './horizonEvaluation';
import { evaluateThresholds, ThresholdEvalEntry } from './thresholdEvaluation';
import { ModelComparisonEntry, compareModels, compareModelsWithTrades, ensembleGenuinelyHelps } from './modelComparison';
import { analyzeFeatureContribution, FeatureContributionReport } from './featureContribution';
import { createRNG } from './seededRandom';
import { logger } from './logger';
import { evaluateStrategies, StrategyEvalResult, StrategyEvalMode } from './strategyEvaluation';
import type { StrategyId } from './strategy/strategyTypes';
import { evaluateRegimes, RegimeEvalResult } from './regimeEvaluation';

// Orchestrates the full Production Model Evaluation for ONE (symbol,
// timeframe) pair against REAL fetched market data — every sub-analysis
// (regime, horizon, threshold, feature contribution, model comparison,
// baselines) runs on the SAME real candles, never synthetic data.

export type ProductionEvalResult = {
  symbol: string; timeframe: string;
  candleCount: number;
  primaryMetrics: BacktestMetrics;
  regimes: RegimeBucket[];
  horizons: HorizonEvalEntry[];
  bestHorizon: HorizonEvalEntry | null;
  thresholds: ThresholdEvalEntry[];
  modelComparison: ModelComparisonEntry[];
  ensembleHelps: { helps: boolean; reasoning: string };
  featureContribution: FeatureContributionReport | null;
  baselines: { name: BaselineName; metrics: BacktestMetrics }[];
  beatsAllBaselines: boolean;
  // Strategy evaluation — added in v6.9.9. Optional for backward compat with
  // any persisted results. Only present when evaluation ran with strategy mode.
  strategyEval?: StrategyEvalResult | null;
  // Regime evaluation — added in v6.9.9. Optional for backward compat.
  // Groups performance of models, horizons, and strategies by market regime.
  regimeEval?: RegimeEvalResult | null;
};

// FIX (Task 8, asset-class support): previously fetched internally via
// fetchMaxHistory, which is Binance-only — meaning this function could
// never have evaluated a stock, index, or AO-sourced symbol no matter
// what the caller passed in. Now takes pre-fetched candles directly, so
// the caller decides how to fetch them (multiSourceFetch.ts dispatches
// per asset.src) — this function itself no longer cares where the data
// came from, only that it's real.
export async function evaluateProductionModel(
  candles: Candle[], symbol: string, timeframe: string,
  configOverrides: Partial<BacktestConfig> = {},
  // Called after each major step with the partial result + progress metadata.
  // stage: machine-readable step name; percent: 0-100 overall completion estimate.
  onProgress?: (partial: ProductionEvalResult, meta: { stage: string; percent: number }) => void,
  // Strategy evaluation mode — default 'ALL' evaluates all 4 strategy profiles.
  // 'SELECTED' evaluates only the strategy currently active in Settings.
  strategyMode: StrategyEvalMode = 'ALL',
  selectedStrategyId: StrategyId | null = null,
): Promise<ProductionEvalResult | null> {
  // ── Stage timing — logged at INFO level so production builds can diagnose slow runs ──
  // Format: [PERF] symbol/tf  StepName  actual_ms
  const _t0 = Date.now();
  let _tLast = _t0;
  const _stage = (name: string) => {
    const now = Date.now();
    const ms = now - _tLast;
    _tLast = now;
    logger.info('productionEval:perf', `[PERF] ${symbol}/${timeframe}  ${name.padEnd(35)}  ${ms}ms`);
    return now;
  };

  logger.info('productionEval', `Starting evaluation: ${symbol} on ${timeframe}, ${candles.length} candles provided`);

  if (candles.length < 120) {
    logger.warn('productionEval', `${symbol}/${timeframe}: only ${candles.length} candles — insufficient, skipping`);
    return null;
  }

  const tick = () => new Promise<void>(r => setTimeout(r, 0));
  const config: BacktestConfig = { ...DEFAULT_BACKTEST_CONFIG, ...configOverrides };

  // ── Opt 4: build precomputeSeries + allFeatures ONCE ─────────────────────────
  await tick();
  logger.info('productionEval', `${symbol}/${timeframe}: starting buildFitCache, candles=${candles.length}`);
  const fitCache = await buildFitCache(candles);
  logger.info('productionEval', `${symbol}/${timeframe}: buildFitCache done, fitCache=${fitCache ? 'ok' : 'null'}, S=${fitCache ? 'ok' : 'null'}${fitCache ? ', features='+fitCache.allFeatures.length : ''}`);
  _stage('S1 buildFitCache (precomputeSeries + features)');
  if (!fitCache) {
    logger.warn('productionEval', `${symbol}/${timeframe}: could not build fit cache`);
    return null;
  }

  // ── Opt 3: primary backtest exposes fitted ensemble — no second fitEnsemble ──
  await tick();
  const primaryResult = await runBacktest(candles, config, fitCache);
  if (!primaryResult) {
    logger.warn('productionEval', `${symbol}/${timeframe}: could not fit a model`);
    return null;
  }
  const fitted = primaryResult.fitted!;  // Opt 3: reuse — never call fitEnsemble(h=3) again
  _stage('S2 runBacktest (fitEnsemble h=3 + simulation)');

  if (onProgress) onProgress({
    symbol, timeframe, candleCount: candles.length,
    primaryMetrics: primaryResult.metrics,
    regimes: [], horizons: [], bestHorizon: null,
    thresholds: [], modelComparison: [], ensembleHelps: { helps: false, reasoning: 'Computing…' },
    featureContribution: null, baselines: [], beatsAllBaselines: false}, { stage: 'primaryBacktest', percent: 20 });

  // 3. Regime breakdown — reuses `fitted` from Step 1
  await tick();
  const regimes = bucketTradesByRegime(candles, fitted.walkIndices, primaryResult.trades, config.startingCapital);
  _stage('S3 bucketTradesByRegime');

  // ── Opt 1+4: build the horizon map ONCE here for sharing across all consumers ─
  // evaluateAllHorizons (Step 4), evaluateStrategies (Step 9), and
  // evaluateAllHorizonsWithTrades (Step 10) all need fitted ensembles for the
  // same 5 horizons [1,3,5,10,20] on the same (candles, seed, split).
  // Fitting them once and passing the map eliminates all duplicate training.
  // Only simulateSignalStrategy re-runs per consumer (different execConfig).
  //
  // OPT A (duplicate h=3 elimination): runBacktest() in the step above already
  // called fitEnsemble(h=3, PRIMARY_HORIZON). The result is in primaryResult.fitted.
  // Seeding the map with that fitted model before the loop means the h=3 iteration
  // is skipped entirely — saving one complete fitEnsemble call (100 MLP + 100 LR
  // epochs) which is ~17% of total training time per combo.
  // Correctness: identical weights guaranteed because (candles, trainSplitPct, seed,
  // horizon=3, fitCache) are all the same. The map reuses the exact same object.
  // Memory fix: fit one horizon at a time, evaluate immediately, discard.
  // Previous approach built all 5 FittedEnsembles simultaneously → OOM on device.
  // Each FittedEnsemble holds ~272K numbers. 5 at once = 1.4M numbers → native crash.
  _stage('S4+S5 horizon fit+eval (memory-efficient: one at a time)');
  logger.info('productionEval', `${symbol}/${timeframe}: starting horizon evaluation (memory-efficient)`);

  const horizons: HorizonEvalEntry[] = [];
  const ALL_HORIZONS = [1, 3, 5, 10, 20];

  for (let hi = 0; hi < ALL_HORIZONS.length; hi++) {
    const h = ALL_HORIZONS[hi];
    await tick();
    // Reuse h=3 from runBacktest (no re-fit), fit the rest fresh
    const f = h === PRIMARY_HORIZON
      ? fitted
      : await fitEnsemble(candles, config.trainSplitPct, config.seed, h, fitCache);
    if (!f) continue;

    // Evaluate immediately using horizonEvaluation's per-horizon logic
    const entry = await (async () => {
      const { simulateSignalStrategy } = await import('./strategyExecutor');
      const { computeMetrics } = await import('./backtest');
      const execCfg = { startingCapital: config.startingCapital,
        buyThreshold: config.buyThreshold, stopLossPct: config.stopLossPct,
        takeProfitPct: config.takeProfitPct, holdingPeriod: config.holdingPeriod,
        direction: 'LONG' as const, seed: config.seed, feeRate: config.feeRate ?? 0.001 };
      const { trades, equityCurve } = simulateSignalStrategy(
        candles, f.walkIndices,
        (idx) => { const { ensembleProb, agree } = f.predictProb(idx);
          return { enter: ensembleProb > config.buyThreshold && agree, reason: `h=${h}` }; },
        f.atrAt, execCfg);
      const metrics = computeMetrics(trades, equityCurve, config.startingCapital);
      return { horizon: h, metrics, trainSampleCount: f.trainSampleCount, trades };
    })();

    horizons.push(entry);

    // Report incremental progress
    if (onProgress) {
      const pct = Math.round(20 + ((hi + 1) / ALL_HORIZONS.length) * 45);
      onProgress({ symbol, timeframe, candleCount: candles.length,
        primaryMetrics: primaryResult.metrics, regimes: primaryResult.regimes ?? [],
        horizons: [...horizons], bestHorizon: null, thresholds: [],
        modelComparison: [], ensembleHelps: { helps: false, reasoning: 'Computing…' },
        featureContribution: null, baselines: [], beatsAllBaselines: false,
      }, { stage: `horizon${h}`, percent: pct });
    }

    // Explicitly null out non-h3 fitted models so GC can reclaim before next horizon
    if (h !== PRIMARY_HORIZON) { try { (f as any).predictProb = null; (f as any).atrAt = null; } catch {} }
  }

  const bestHorizon = pickBestHorizon(horizons);
  // Minimal map for strategyEvaluation — only h=3 needed downstream
  const horizonFittedMap = new Map<number, import('./backtest').FittedEnsemble>();
  horizonFittedMap.set(PRIMARY_HORIZON, fitted);

  if (onProgress) onProgress({
    symbol, timeframe, candleCount: candles.length,
    primaryMetrics: primaryResult.metrics,
    regimes: primaryResult.regimes ?? [], horizons, bestHorizon,
    thresholds: [], modelComparison: [], ensembleHelps: { helps: false, reasoning: 'Computing…' },
    featureContribution: null,
    baselines: [], beatsAllBaselines: false}, { stage: 'horizonSweep', percent: 65 });

  // 5. Threshold sweep
  await tick();
  const thresholds = evaluateThresholds(fitted, config);
  _stage('S6 evaluateThresholds');

  // 6. Model comparison
  await tick();
  const modelComparison = compareModels(fitted, config);
  const ensembleHelps = ensembleGenuinelyHelps(modelComparison);
  _stage('S7 compareModels + ensembleGenuinelyHelps');

  // 7. Feature contribution
  await tick();
  const rng = createRNG(config.seed + 1);
  const featureContribution = analyzeFeatureContribution(fitted, rng);
  _stage('S8 analyzeFeatureContribution (permutation importance)');

  // 8. Baseline comparison
  await tick();
  const atrArr = candles.map((_, i) => fitted.atrAt(i));
  const baselines = ALL_BASELINES.map(name => {
    const result = runBaseline(name, candles, fitted.walkIndices, atrArr, config);
    return { name, metrics: computeMetrics(result.trades, result.equityCurve, config.startingCapital) };
  });

  const beatsAllBaselines = baselines.every(b =>
    primaryResult.metrics.totalReturnPct > b.metrics.totalReturnPct
  );
  _stage('S9 baseline comparisons');

  // 9. Strategy evaluation — Opt 1: pass horizonFittedMap so evaluateStrategies
  //    reuses pre-fitted ensembles for primary fits.
  //    Opt 4: pass fitCache so per-strategy horizon sweeps skip precomputeSeries.
  //    Total new fitEnsemble calls for strategy eval: 0 (primary fits) + 20 (horizon
  //    sweeps with cache) → ~20 × training-only cost (no precompute overhead).
  await tick();
  let strategyEval: StrategyEvalResult | null = null;
  try {
    strategyEval = await evaluateStrategies(
      candles,
      strategyMode,
      selectedStrategyId,
      { ...DEFAULT_BACKTEST_CONFIG, ...configOverrides },
      onProgress ? (partial) => {
        onProgress({
          symbol, timeframe, candleCount: candles.length,
          primaryMetrics: primaryResult.metrics,
          regimes: primaryResult.regimes ?? [], horizons, bestHorizon,
          thresholds, modelComparison, ensembleHelps,
          featureContribution: null, baselines, beatsAllBaselines,
          strategyEval: partial}, { stage: 'strategyEval', percent: 90 });
      } : undefined,
      fitCache,          // Opt 4
      horizonFittedMap,  // Opt 1
    );
  } catch (e: any) {
    logger.warn('productionEval', `Strategy evaluation failed (non-fatal): ${e.message}`);
  }
  _stage('S10 evaluateStrategies (4 strategies, 20 simulations, 0 new fits)');

  // 10. Regime evaluation — Opt 2: evaluateAllHorizonsWithTrades now returns
  //     from the already-computed horizons array (same data, no new fits).
  //     compareModelsWithTrades reuses `fitted` (already from Step 1).
  await tick();
  let regimeEval: RegimeEvalResult | null = null;
  try {
    const modelEntriesWithTrades   = compareModelsWithTrades(fitted, { ...config, buyThreshold: config.buyThreshold });
    // Opt 2: horizons already contains trades — pass directly, no new fits.
    const horizonEntriesWithTrades = horizons;
    const strategyEntries          = strategyEval?.entries ?? [];
    regimeEval = await evaluateRegimes(
      fitted,
      primaryResult.trades,
      modelEntriesWithTrades,
      horizonEntriesWithTrades,
      strategyEntries,
      config,
    );
  } catch (e: any) {
    logger.warn('productionEval', `Regime evaluation failed (non-fatal): ${e.message}`);
  }
  _stage('S11 evaluateRegimes');

  const _totalMs = Date.now() - _t0;
  logger.info('productionEval:perf',
    `[PERF] ${symbol}/${timeframe}  ${'TOTAL'.padEnd(35)}  ${_totalMs}ms = ${(_totalMs/60000).toFixed(1)}min`);

  logger.info('productionEval', `${symbol}/${timeframe} complete: ${primaryResult.trades.length} trades, ${primaryResult.metrics.totalReturnPct.toFixed(2)}% return, beats all baselines: ${beatsAllBaselines}`);

  return {
    symbol, timeframe, candleCount: candles.length,
    primaryMetrics: primaryResult.metrics, regimes, horizons, bestHorizon, thresholds,
    modelComparison, ensembleHelps, featureContribution, baselines, beatsAllBaselines,
    strategyEval,
    regimeEval};
}

// Generates recommendations MECHANICALLY from measured results across all
// evaluated (symbol, timeframe) combinations — never from preference. Per
// the explicit instruction this suite was built to honor: recommend based
// only on what was actually measured, not on tuning toward a better-looking
// number.
export type ProductionRecommendations = {
  recommendedHorizon: number | null;
  recommendedThreshold: number | null;
  featuresToConsiderRemoving: string[];
  needsMoreData: boolean;
  readyForPaperTrading: boolean;
  reasoning: string[];
};

export function generateRecommendations(results: ProductionEvalResult[]): ProductionRecommendations {
  const reasoning: string[] = [];
  const validResults = results.filter(r => r.primaryMetrics.numTrades >= 5);

  if (!validResults.length) {
    return {
      recommendedHorizon: null, recommendedThreshold: null, featuresToConsiderRemoving: [],
      needsMoreData: true, readyForPaperTrading: false,
      reasoning: ['No (symbol, timeframe) combination produced enough trades (5+) to draw any conclusion. More historical data or a longer evaluation window is needed before any recommendation can be made.']};
  }

  // Recommended horizon: most frequently the "best" pick across all combinations
  const horizonVotes: Record<number, number> = {};
  validResults.forEach(r => { if (r.bestHorizon) horizonVotes[r.bestHorizon.horizon] = (horizonVotes[r.bestHorizon.horizon] || 0) + 1; });
  const recommendedHorizon = Object.keys(horizonVotes).length
    ? parseInt(Object.entries(horizonVotes).sort((a, b) => b[1] - a[1])[0][0], 10) : null;
  if (recommendedHorizon != null) reasoning.push(`Horizon ${recommendedHorizon} was the best-performing horizon in ${horizonVotes[recommendedHorizon]}/${validResults.length} evaluated combinations.`);

  // Recommended threshold: average profit factor per threshold across all combinations
  const threshScores: Record<number, number[]> = {};
  validResults.forEach(r => r.thresholds.forEach(t => {
    if (t.metrics.numTrades < 3) return;
    (threshScores[t.threshold] ||= []).push(t.metrics.profitFactor === Infinity ? 5 : t.metrics.profitFactor);
  }));
  let recommendedThreshold: number | null = null;
  let bestAvg = -Infinity;
  Object.entries(threshScores).forEach(([t, scores]) => {
    const avg = scores.reduce((s, v) => s + v, 0) / scores.length;
    if (avg > bestAvg) { bestAvg = avg; recommendedThreshold = parseFloat(t); }
  });
  if (recommendedThreshold != null) reasoning.push(`Threshold ${recommendedThreshold} had the highest average profit factor (${bestAvg.toFixed(2)}) across combinations with enough trades to measure.`);

  // Features to consider removing: consistently near-zero or negative contribution
  const featureDropCounts: Record<string, number> = {};
  const featureSampleCounts: Record<string, number> = {};
  validResults.forEach(r => {
    r.featureContribution?.entries.forEach(e => {
      featureDropCounts[e.name] = (featureDropCounts[e.name] || 0) + e.baselineAccDrop;
      featureSampleCounts[e.name] = (featureSampleCounts[e.name] || 0) + 1;
    });
  });
  const featuresToConsiderRemoving = Object.keys(featureDropCounts)
    .filter(name => (featureDropCounts[name] / featureSampleCounts[name]) <= 0.5) // average accuracy drop under 0.5 points = contributing almost nothing
    .sort((a, b) => (featureDropCounts[a] / featureSampleCounts[a]) - (featureDropCounts[b] / featureSampleCounts[b]));
  if (featuresToConsiderRemoving.length) reasoning.push(`${featuresToConsiderRemoving.length} feature(s) showed near-zero average contribution (permutation importance) across evaluated combinations.`);

  // Strategy recommendations — aggregate across all results
  const allStrategyComparisons = validResults
    .map(r => r.strategyEval?.comparison)
    .filter(Boolean);
  if (allStrategyComparisons.length) {
    // Vote for best overall strategy across all combinations
    const strategyVotes: Record<string, number> = {};
    allStrategyComparisons.forEach(cmp => {
      if (cmp!.bestOverall) {
        strategyVotes[cmp!.bestOverall.strategyId] = (strategyVotes[cmp!.bestOverall.strategyId] || 0) + 1;
      }
    });
    const topStrategy = Object.entries(strategyVotes).sort((a, b) => b[1] - a[1])[0];
    if (topStrategy) {
      const profile = allStrategyComparisons[0]!.rankings.find(e => e.strategyId === topStrategy[0]);
      if (profile) {
        reasoning.push(
          `${profile.strategyIcon} ${profile.strategyName} was the best-performing strategy ` +
          `in ${topStrategy[1]}/${allStrategyComparisons.length} evaluated combinations.`
        );
      }
    }
    // Best overall horizon across all strategy evaluations
    const globalBests = allStrategyComparisons.map(c => c!.bestGlobalHorizon).filter(Boolean);
    if (globalBests.length) {
      const horizonVotesStrat: Record<number, number> = {};
      globalBests.forEach(h => { horizonVotesStrat[h!.horizon] = (horizonVotesStrat[h!.horizon] || 0) + 1; });
      const topH = Object.entries(horizonVotesStrat).sort((a, b) => b[1] - a[1])[0];
      if (topH) reasoning.push(`Best combined strategy horizon: H${topH[0]} (across all strategy evaluations).`);
    }
  }

  const beatsBaselinesCount = validResults.filter(r => r.beatsAllBaselines).length;
  const needsMoreData = validResults.length < results.length * 0.5; // most combinations didn't even have enough trades
  const readyForPaperTrading = beatsBaselinesCount >= Math.ceil(validResults.length * 0.6) && !needsMoreData;

  reasoning.push(`The AI beat every baseline in ${beatsBaselinesCount}/${validResults.length} evaluated combinations.`);
  reasoning.push(readyForPaperTrading
    ? 'A majority of combinations show the AI outperforming all simple baselines — cautiously consistent with a real edge, though paper trading should still come before any real capital.'
    : 'The AI did not consistently beat simple baselines across evaluated combinations — this does not yet demonstrate a reliable edge. Paper trading with real capital expectations is not recommended yet.');

  return { recommendedHorizon, recommendedThreshold, featuresToConsiderRemoving, needsMoreData, readyForPaperTrading, reasoning };
}
