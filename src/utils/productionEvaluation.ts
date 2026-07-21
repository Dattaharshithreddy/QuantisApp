import { Candle } from './indicators';
import { fitEnsemble, runBacktest, computeMetrics, BacktestMetrics, DEFAULT_BACKTEST_CONFIG, BacktestConfig } from './backtest';
import { runBaseline, ALL_BASELINES, BaselineName } from './baselineStrategies';
import { bucketTradesByRegime, RegimeBucket } from './regimeAnalysis';
import { evaluateAllHorizons, pickBestHorizon, HorizonEvalEntry } from './horizonEvaluation';
import { evaluateThresholds, ThresholdEvalEntry } from './thresholdEvaluation';
import { compareModels, ensembleGenuinelyHelps, ModelComparisonEntry } from './modelComparison';
import { analyzeFeatureContribution, FeatureContributionReport } from './featureContribution';
import { createRNG } from './seededRandom';
import { logger } from './logger';
import { evaluateStrategies, StrategyEvalResult, StrategyEvalMode } from './strategyEvaluation';
import type { StrategyId } from './strategy/strategyTypes';
import { evaluateRegimes, RegimeEvalResult } from './regimeEvaluation';
import { compareModelsWithTrades } from './modelComparison';
import { evaluateAllHorizonsWithTrades } from './horizonEvaluation';

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
  logger.info('productionEval', `Starting evaluation: ${symbol} on ${timeframe}, ${candles.length} candles provided`);

  if (candles.length < 120) {
    logger.warn('productionEval', `${symbol}/${timeframe}: only ${candles.length} candles — insufficient, skipping`);
    return null;
  }

  const tick = () => new Promise<void>(r => setTimeout(r, 0));

  const config: BacktestConfig = { ...DEFAULT_BACKTEST_CONFIG, ...configOverrides };

  // 1. Primary backtest (production defaults: horizon=3, threshold=0.55)
  // runBacktest calls fitEnsemble synchronously — yields inside keep UI responsive
  await tick();
  const primaryResult = await runBacktest(candles, config);
  if (!primaryResult) {
    logger.warn('productionEval', `${symbol}/${timeframe}: could not fit a model`);
    return null;
  }
  // Stream partial result after primary backtest so UI shows something
  // within the first few minutes instead of waiting for all 5 horizon
  // sweeps, model comparison, and feature contribution to complete.
  if (onProgress) onProgress({
    symbol, timeframe, candleCount: candles.length,
    primaryMetrics: primaryResult.metrics,
    regimes: [], horizons: [], bestHorizon: null,
    thresholds: [], modelComparison: [], ensembleHelps: { helps: false, reasoning: 'Computing…' },
    featureContribution: null,
    baselines: [], beatsAllBaselines: false,
  }, { stage: 'primaryBacktest', percent: 20 });

  // 2. Fit once for the analyses that reuse a single trained model
  await tick();
  const fitted = await fitEnsemble(candles, config.trainSplitPct, config.seed);
  if (!fitted) return null;

  // 3. Regime breakdown
  await tick();
  const regimes = bucketTradesByRegime(candles, fitted.walkIndices, primaryResult.trades, config.startingCapital);

  // 4. Horizon evaluation — now async, yields between each of the 5 model trains
  await tick();
  const horizons = await evaluateAllHorizons(candles, config,
    // Per-horizon progress: fire onProgress after each of the 5 horizon sweeps
    // so the UI updates continuously (not just twice). Percent range: 20-65.
    onProgress ? (horizon, idx, total, entry) => {
      const pct = Math.round(20 + ((idx + 1) / total) * 45);
      const partialHorizons = horizons ? [...horizons] : [];
      partialHorizons[idx] = entry;
      onProgress({
        symbol, timeframe, candleCount: candles.length,
        primaryMetrics: primaryResult.metrics,
        regimes: primaryResult.regimes ?? [], horizons: partialHorizons, bestHorizon: null,
        thresholds: [], modelComparison: [], ensembleHelps: { helps: false, reasoning: 'Computing…' },
        featureContribution: null, baselines: [], beatsAllBaselines: false,
      }, { stage: `horizon${entry.horizon}`, percent: pct });
    } : undefined,
  );
  const bestHorizon = pickBestHorizon(horizons);
  if (onProgress) onProgress({
    symbol, timeframe, candleCount: candles.length,
    primaryMetrics: primaryResult.metrics,
    regimes: primaryResult.regimes ?? [], horizons, bestHorizon,
    thresholds: [], modelComparison: [], ensembleHelps: { helps: false, reasoning: 'Computing…' },
    featureContribution: null,
    baselines: [], beatsAllBaselines: false,
  }, { stage: 'horizonSweep', percent: 65 });

  // 5. Threshold sweep
  await tick();
  const thresholds = evaluateThresholds(fitted, config);

  // 6. Model comparison
  await tick();
  const modelComparison = compareModels(fitted, config);
  const ensembleHelps = ensembleGenuinelyHelps(modelComparison);

  // 7. Feature contribution
  await tick();
  const rng = createRNG(config.seed + 1);
  const featureContribution = analyzeFeatureContribution(fitted, rng);

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

  // 9. Strategy evaluation — runs AFTER all existing steps, shares the same candles.
  // Uses separate fitEnsemble calls per strategy (different horizons/labels).
  // Does NOT change any result from steps 1–8.
  await tick();
  let strategyEval: StrategyEvalResult | null = null;
  try {
    strategyEval = await evaluateStrategies(
      candles,
      strategyMode,
      selectedStrategyId,
      { ...DEFAULT_BACKTEST_CONFIG, ...configOverrides },
      // onProgress for strategy eval: stream partial results into the outer result
      onProgress ? (partial) => {
        onProgress({
          symbol, timeframe, candleCount: candles.length,
          primaryMetrics: primaryResult.metrics,
          regimes: primaryResult.regimes ?? [], horizons, bestHorizon,
          thresholds, modelComparison, ensembleHelps,
          featureContribution: null, baselines, beatsAllBaselines,
          strategyEval: partial,
        }, { stage: 'strategyEval', percent: 90 });
      } : undefined,
    );
  } catch (e: any) {
    logger.warn('productionEval', `Strategy evaluation failed (non-fatal): ${e.message}`);
  }

  // 10. Regime evaluation — groups model/horizon/strategy trades by market regime.
  // Reuses fitted (already computed in step 2) + new trades-carrying variants.
  // compareModelsWithTrades and evaluateAllHorizonsWithTrades reuse fitted internals
  // (regimeLabelAt, predictProb, atrAt) with zero additional precomputeSeries calls.
  // Horizon runs do require fitEnsemble per horizon (different label → must retrain)
  // but those fits are shared with step 4 — there is no way to avoid this.
  await tick();
  let regimeEval: RegimeEvalResult | null = null;
  try {
    const modelEntriesWithTrades  = compareModelsWithTrades(fitted, { ...config, buyThreshold: config.buyThreshold });
    const horizonEntriesWithTrades = await evaluateAllHorizonsWithTrades(candles, config);
    const strategyEntries = strategyEval?.entries ?? [];
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

  logger.info('productionEval', `${symbol}/${timeframe} complete: ${primaryResult.trades.length} trades, ${primaryResult.metrics.totalReturnPct.toFixed(2)}% return, beats all baselines: ${beatsAllBaselines}`);

  return {
    symbol, timeframe, candleCount: candles.length,
    primaryMetrics: primaryResult.metrics, regimes, horizons, bestHorizon, thresholds,
    modelComparison, ensembleHelps, featureContribution, baselines, beatsAllBaselines,
    strategyEval,
    regimeEval,
  };
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
      reasoning: ['No (symbol, timeframe) combination produced enough trades (5+) to draw any conclusion. More historical data or a longer evaluation window is needed before any recommendation can be made.'],
    };
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
