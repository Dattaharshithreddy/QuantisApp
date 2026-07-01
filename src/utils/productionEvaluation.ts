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
  configOverrides: Partial<BacktestConfig> = {}
): Promise<ProductionEvalResult | null> {
  logger.info('productionEval', `Starting evaluation: ${symbol} on ${timeframe}, ${candles.length} candles provided`);

  if (candles.length < 120) {
    logger.warn('productionEval', `${symbol}/${timeframe}: only ${candles.length} candles — insufficient, skipping`);
    return null;
  }

  const config: BacktestConfig = { ...DEFAULT_BACKTEST_CONFIG, ...configOverrides };

  // 1. Primary backtest (production defaults: horizon=3, threshold=0.55)
  const primaryResult = await runBacktest(candles, config);
  if (!primaryResult) {
    logger.warn('productionEval', `${symbol}/${timeframe}: could not fit a model`);
    return null;
  }

  // 2. Fit once for the analyses that reuse a single trained model
  const fitted = fitEnsemble(candles, config.trainSplitPct, config.seed);
  if (!fitted) return null;

  // 3. Regime breakdown (real data, causal classification)
  const regimes = bucketTradesByRegime(candles, fitted.walkIndices, primaryResult.trades, config.startingCapital);

  // 4. Horizon evaluation (requires retraining per horizon — real cost, real necessity)
  const horizons = evaluateAllHorizons(candles, config);
  const bestHorizon = pickBestHorizon(horizons);

  // 5. Threshold sweep (cheap — reuses the single fitted model)
  const thresholds = evaluateThresholds(fitted, config);

  // 6. Model comparison: NN alone vs LR alone vs Ensemble
  const modelComparison = compareModels(fitted, config);
  const ensembleHelps = ensembleGenuinelyHelps(modelComparison);

  // 7. Feature contribution (leak-safe — test set only)
  const rng = createRNG(config.seed + 1);
  const featureContribution = analyzeFeatureContribution(fitted, rng);

  // 8. Baseline comparison — same execution core, same real data
  const atrArr = candles.map((_, i) => fitted.atrAt(i));
  const baselines = ALL_BASELINES.map(name => {
    const result = runBaseline(name, candles, fitted.walkIndices, atrArr, config);
    return { name, metrics: computeMetrics(result.trades, result.equityCurve, config.startingCapital) };
  });

  const beatsAllBaselines = baselines.every(b =>
    primaryResult.metrics.totalReturnPct > b.metrics.totalReturnPct
  );

  logger.info('productionEval', `${symbol}/${timeframe} complete: ${primaryResult.trades.length} trades, ${primaryResult.metrics.totalReturnPct.toFixed(2)}% return, beats all baselines: ${beatsAllBaselines}`);

  return {
    symbol, timeframe, candleCount: candles.length,
    primaryMetrics: primaryResult.metrics, regimes, horizons, bestHorizon, thresholds,
    modelComparison, ensembleHelps, featureContribution, baselines, beatsAllBaselines,
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

  const beatsBaselinesCount = validResults.filter(r => r.beatsAllBaselines).length;
  const needsMoreData = validResults.length < results.length * 0.5; // most combinations didn't even have enough trades
  const readyForPaperTrading = beatsBaselinesCount >= Math.ceil(validResults.length * 0.6) && !needsMoreData;

  reasoning.push(`The AI beat every baseline in ${beatsBaselinesCount}/${validResults.length} evaluated combinations.`);
  reasoning.push(readyForPaperTrading
    ? 'A majority of combinations show the AI outperforming all simple baselines — cautiously consistent with a real edge, though paper trading should still come before any real capital.'
    : 'The AI did not consistently beat simple baselines across evaluated combinations — this does not yet demonstrate a reliable edge. Paper trading with real capital expectations is not recommended yet.');

  return { recommendedHorizon, recommendedThreshold, featuresToConsiderRemoving, needsMoreData, readyForPaperTrading, reasoning };
}
