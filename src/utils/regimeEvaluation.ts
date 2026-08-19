// ─────────────────────────────────────────────────────────────────────────────
// REGIME EVALUATION ENGINE  (v1.0.0)
//
// Extends Production Model Evaluation to analyze performance by Market Regime.
//
// CRITICAL INVARIANTS:
//   • Zero changes to any ML model, prediction engine, or confidence engine.
//   • Zero duplicate regime detection — reuses FittedEnsemble.regimeLabelAt()
//     which reads from S.regimeData already computed inside fitEnsemble().
//   • Zero duplicate candle loading or indicator computation.
//   • Reuses existing RegimeLabel from regime/regimeTypes.ts — no new types.
//   • Uses the existing regimeAnalysis.ts RegimeLabel set for paper trades,
//     and the regime/regimeTypes.ts RegimeLabel set for backtest trades.
//
// Data flow:
//   fitEnsemble()            → FittedEnsemble (has regimeLabelAt)
//   compareModelsWithTrades() → trades per model
//   evaluateAllHorizonsWithTrades() → trades per horizon
//   strategyEvaluation entries → trades per strategy
//   → regimeEvaluation groups all by regime → RegimeEvalResult
//
// Regime label mapping:
//   The backtest uses the regime/regimeEngine.ts labels (11 labels).
//   regimeAnalysis.ts uses a simplified 5-label set (TRENDING_BULL etc).
//   This module uses the FULL 11-label set from regime/regimeEngine.ts since
//   that's what FittedEnsemble.regimeLabelAt() returns.
//   Display names are mapped to friendly strings for the UI.
// ─────────────────────────────────────────────────────────────────────────────

import { Candle } from './indicators';
import { FittedEnsemble, computeMetrics, BacktestConfig, BacktestMetrics } from './backtest';
import { ExecTrade } from './strategyExecutor';
import { compareModelsWithTrades, ModelComparisonEntryWithTrades } from './modelComparison';
import { evaluateAllHorizonsWithTrades, HorizonEvalEntryWithTrades } from './horizonEvaluation';
import type { StrategyEvalEntry } from './strategyEvaluation';
import type { RegimeLabel } from './regime/regimeTypes';
import { logger } from './logger';

// ── Display mapping ───────────────────────────────────────────────────────────

export const REGIME_DISPLAY_NAMES: Record<RegimeLabel, string> = {
  STRONG_BULL_TREND: 'Strong Bull Trend',
  BULL_TREND:        'Bull Trend',
  WEAK_BULL_TREND:   'Weak Bull Trend',
  SIDEWAYS:          'Sideways',
  MEAN_REVERSION:    'Mean Reversion',
  BREAKOUT:          'Breakout',
  STRONG_BEAR_TREND: 'Strong Bear Trend',
  BEAR_TREND:        'Bear Trend',
  WEAK_BEAR_TREND:   'Weak Bear Trend',
  LOW_VOLATILITY:    'Low Volatility',
  HIGH_VOLATILITY:   'High Volatility',
};

export const REGIME_EMOJI: Record<RegimeLabel, string> = {
  STRONG_BULL_TREND: '🐂🔥',
  BULL_TREND:        '🐂',
  WEAK_BULL_TREND:   '↗️',
  SIDEWAYS:          '↔️',
  MEAN_REVERSION:    '🔄',
  BREAKOUT:          '💥',
  STRONG_BEAR_TREND: '🐻🔥',
  BEAR_TREND:        '🐻',
  WEAK_BEAR_TREND:   '↘️',
  LOW_VOLATILITY:    '😴',
  HIGH_VOLATILITY:   '⚡',
};

// All 11 regimes in display order
export const ALL_REGIME_LABELS: RegimeLabel[] = [
  'STRONG_BULL_TREND', 'BULL_TREND', 'WEAK_BULL_TREND',
  'SIDEWAYS', 'MEAN_REVERSION', 'BREAKOUT',
  'STRONG_BEAR_TREND', 'BEAR_TREND', 'WEAK_BEAR_TREND',
  'LOW_VOLATILITY', 'HIGH_VOLATILITY',
];

// ── Core bucket type ──────────────────────────────────────────────────────────

export type RegimeMetricsBucket = {
  regime:      RegimeLabel;
  displayName: string;
  emoji:       string;
  barCount:    number;       // how many walked bars were in this regime
  metrics:     BacktestMetrics;
};

// ── Per-regime breakdown ──────────────────────────────────────────────────────

export type RegimeModelEntry = {
  modelName: 'Neural Network' | 'Logistic Regression' | 'Ensemble';
  metrics:   BacktestMetrics;
};

export type RegimeHorizonEntry = {
  horizon:  number;
  metrics:  BacktestMetrics;
};

export type RegimeStrategyEntry = {
  strategyId:   string;
  strategyName: string;
  strategyIcon: string;
  metrics:      BacktestMetrics;
};

export type RegimeBreakdown = RegimeMetricsBucket & {
  // Drill-downs — each is [] when no data available (e.g. no trades in regime)
  byModel:    RegimeModelEntry[];
  byHorizon:  RegimeHorizonEntry[];
  byStrategy: RegimeStrategyEntry[];
};

// ── Comparison highlights ─────────────────────────────────────────────────────

export type RegimeComparisonResult = {
  // All regimes with any trades, ordered by combined score
  rankings:         RegimeBreakdown[];
  // Highlights (null when insufficient data)
  bestOverall:      RegimeBreakdown | null;
  worstOverall:     RegimeBreakdown | null;
  highestProfitFactor: RegimeBreakdown | null;
  highestWinRate:   RegimeBreakdown | null;
  lowestDrawdown:   RegimeBreakdown | null;
  mostStable:       RegimeBreakdown | null;   // lowest σ of per-trade returns
  // Best strategy per key regime (regime → strategy name)
  bestStrategyInBull:    string | null;
  bestStrategyInBear:    string | null;
  bestStrategyInSideways:string | null;
  // Best horizon per key regime
  bestHorizonInBull:     number | null;
  bestHorizonInBear:     number | null;
  bestHorizonInSideways: number | null;
  // Best model per key regime
  bestModelInHighVol:    string | null;
  bestModelInLowVol:     string | null;
  // Recommendations
  recommendations:  string[];
};

export type RegimeEvalResult = {
  breakdowns:  RegimeBreakdown[];
  comparison:  RegimeComparisonResult;
  generatedAt: number;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function scoreMetrics(m: BacktestMetrics): number {
  if (m.numTrades < 3) return -Infinity;
  const pf = m.profitFactor === Infinity ? 5 : Math.min(m.profitFactor, 5);
  return pf * 0.5 + (m.winRate / 100) * 0.3 + Math.min(Math.max(m.sharpeRatio, -2), 2) * 0.2;
}

// Groups a list of trades by regime using the fitted ensemble's regimeLabelAt accessor.
// Trade is attributed to the regime at its ENTRY BAR — same policy as regimeAnalysis.ts.
function bucketTradesByFittedRegime(
  trades:  ExecTrade[],
  candles: Candle[],
  fitted:  FittedEnsemble,
): Map<RegimeLabel, ExecTrade[]> {
  const map = new Map<RegimeLabel, ExecTrade[]>();
  for (const regime of ALL_REGIME_LABELS) map.set(regime, []);

  for (const trade of trades) {
    const entryIdx = candles.findIndex(c => c.time === trade.entryTime);
    if (entryIdx < 0) continue;
    const label = fitted.regimeLabelAt(entryIdx);
    if (!label) continue;
    map.get(label)!.push(trade);
  }
  return map;
}

// Counts how many walk-forward bars fall in each regime
function barCountByRegime(fitted: FittedEnsemble): Map<RegimeLabel, number> {
  const counts = new Map<RegimeLabel, number>();
  for (const label of ALL_REGIME_LABELS) counts.set(label, 0);
  for (const idx of fitted.walkIndices) {
    const label = fitted.regimeLabelAt(idx);
    if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return counts;
}

// ── Best entry within a dimension ─────────────────────────────────────────────

function bestIn<T extends { metrics: BacktestMetrics }>(entries: T[]): T | null {
  const withTrades = entries.filter(e => e.metrics.numTrades >= 3);
  if (!withTrades.length) return null;
  return withTrades.reduce((b, e) => scoreMetrics(e.metrics) > scoreMetrics(b.metrics) ? e : b);
}

// ── Build comparison ──────────────────────────────────────────────────────────

function buildComparison(breakdowns: RegimeBreakdown[]): RegimeComparisonResult {
  const withTrades = breakdowns.filter(b => b.metrics.numTrades >= 3);
  const ranked = [...withTrades].sort((a, b) => scoreMetrics(b.metrics) - scoreMetrics(a.metrics));

  const best = (fn: (b: RegimeBreakdown) => number) =>
    withTrades.length ? withTrades.reduce((b, e) => fn(e) > fn(b) ? e : b) : null;

  const bestOverall      = withTrades.length ? ranked[0] ?? null : null;
  const worstOverall     = withTrades.length ? ranked[ranked.length - 1] ?? null : null;
  const highestProfitFactor = best(b => b.metrics.profitFactor === Infinity ? 999 : b.metrics.profitFactor);
  const highestWinRate   = best(b => b.metrics.winRate);
  const lowestDrawdown   = withTrades.length
    ? withTrades.reduce((b, e) => e.metrics.maxDrawdownPct < b.metrics.maxDrawdownPct ? e : b)
    : null;
  const mostStable       = best(b => b.metrics.sharpeRatio);

  // Best strategy per key regime
  const findBestStrategy = (labels: RegimeLabel[]): string | null => {
    const bucket = breakdowns.find(b => labels.includes(b.regime));
    const best = bucket ? bestIn(bucket.byStrategy) : null;
    return best ? `${best.strategyIcon} ${best.strategyName}` : null;
  };
  const bullRegimes: RegimeLabel[]  = ['STRONG_BULL_TREND', 'BULL_TREND'];
  const bearRegimes: RegimeLabel[]  = ['STRONG_BEAR_TREND', 'BEAR_TREND'];
  const sidewaysRegimes: RegimeLabel[] = ['SIDEWAYS', 'MEAN_REVERSION'];

  const bestStrategyInBull     = findBestStrategy(bullRegimes);
  const bestStrategyInBear     = findBestStrategy(bearRegimes);
  const bestStrategyInSideways = findBestStrategy(sidewaysRegimes);

  // Best horizon per key regime
  const findBestHorizon = (labels: RegimeLabel[]): number | null => {
    const bucket = breakdowns.find(b => labels.includes(b.regime));
    const bh = bucket ? bestIn(bucket.byHorizon) : null;
    return bh ? bh.horizon : null;
  };
  const bestHorizonInBull     = findBestHorizon(bullRegimes);
  const bestHorizonInBear     = findBestHorizon(bearRegimes);
  const bestHorizonInSideways = findBestHorizon(sidewaysRegimes);

  // Best model per key regime
  const findBestModel = (labels: RegimeLabel[]): string | null => {
    const bucket = breakdowns.find(b => labels.includes(b.regime));
    const bm = bucket ? bestIn(bucket.byModel) : null;
    return bm ? bm.modelName : null;
  };
  const bestModelInHighVol = findBestModel(['HIGH_VOLATILITY']);
  const bestModelInLowVol  = findBestModel(['LOW_VOLATILITY']);

  // Recommendations
  const recs: string[] = [];
  if (bestOverall) {
    const m = bestOverall.metrics;
    recs.push(
      `${bestOverall.emoji} ${bestOverall.displayName} is the best-performing regime ` +
      `(PF ${m.profitFactor === Infinity ? '∞' : m.profitFactor.toFixed(2)} · WR ${m.winRate.toFixed(1)}% · ${m.numTrades} trades).`
    );
  }
  if (worstOverall && worstOverall !== bestOverall) {
    recs.push(
      `${worstOverall.emoji} ${worstOverall.displayName} is the weakest regime ` +
      `— consider reducing size or skipping trades in this condition.`
    );
  }
  if (bestStrategyInBull)     recs.push(`Best strategy in Bull markets: ${bestStrategyInBull}.`);
  if (bestStrategyInBear)     recs.push(`Best strategy in Bear markets: ${bestStrategyInBear}.`);
  if (bestStrategyInSideways) recs.push(`Best strategy in Sideways markets: ${bestStrategyInSideways}.`);
  if (bestHorizonInBull != null)     recs.push(`Best horizon in Bull markets: H${bestHorizonInBull}.`);
  if (bestHorizonInBear != null)     recs.push(`Best horizon in Bear markets: H${bestHorizonInBear}.`);
  if (bestHorizonInSideways != null) recs.push(`Best horizon in Sideways markets: H${bestHorizonInSideways}.`);
  if (bestModelInHighVol) recs.push(`Best model in High Volatility: ${bestModelInHighVol}.`);
  if (highestProfitFactor) {
    recs.push(`Highest profit factor regime: ${highestProfitFactor.emoji} ${highestProfitFactor.displayName} (PF ${highestProfitFactor.metrics.profitFactor === Infinity ? '∞' : highestProfitFactor.metrics.profitFactor.toFixed(2)}).`);
  }
  if (!withTrades.length) {
    recs.push('No regime produced enough trades (3+) for a reliable comparison. Use more historical data.');
  }

  return {
    rankings: ranked, bestOverall, worstOverall,
    highestProfitFactor, highestWinRate, lowestDrawdown, mostStable,
    bestStrategyInBull, bestStrategyInBear, bestStrategyInSideways,
    bestHorizonInBull, bestHorizonInBear, bestHorizonInSideways,
    bestModelInHighVol, bestModelInLowVol,
    recommendations: recs};
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Evaluates all market regimes using trade data already computed during the
 * main production evaluation. Zero duplicate computation:
 *   - Regime labels come from fitted.regimeLabelAt() — already in S.regimeData
 *   - Model trades from compareModelsWithTrades() — reuses fitted
 *   - Horizon trades from evaluateAllHorizonsWithTrades() — retrains only for
 *     different horizons (unavoidable: horizon changes the label itself)
 *   - Strategy trades from strategyEvalEntries — passed in, already computed
 *
 * @param fitted           The fitted ensemble (has regimeLabelAt, candles)
 * @param primaryTrades    Trades from the primary backtest (h=3, LONG+SHORT)
 * @param modelEntries     Output of compareModelsWithTrades()
 * @param horizonEntries   Output of evaluateAllHorizonsWithTrades()
 * @param strategyEntries  Output of evaluateStrategies() entries (may be [])
 * @param config           BacktestConfig for computeMetrics startingCapital
 */
export async function evaluateRegimes(
  fitted:          FittedEnsemble,
  primaryTrades:   ExecTrade[],
  modelEntries:    ModelComparisonEntryWithTrades[],
  horizonEntries:  HorizonEvalEntryWithTrades[],
  strategyEntries: StrategyEvalEntry[],
  config:          BacktestConfig,
): Promise<RegimeEvalResult> {
  logger.info('regimeEval', `Evaluating ${ALL_REGIME_LABELS.length} regimes on ${fitted.candles.length} candles`);

  const candles    = fitted.candles;
  const barCounts  = barCountByRegime(fitted);

  // Primary trade map by regime
  const primaryMap = bucketTradesByFittedRegime(primaryTrades, candles, fitted);

  // Model trade maps by regime
  const modelMaps  = modelEntries.map(e => ({
    modelName: e.modelName,
    byRegime:  bucketTradesByFittedRegime(e.trades, candles, fitted)}));

  // Horizon trade maps by regime
  const horizonMaps = horizonEntries.map(e => ({
    horizon:  e.horizon,
    byRegime: bucketTradesByFittedRegime(e.trades, candles, fitted)}));

  // Strategy trade maps by regime
  const strategyMaps = strategyEntries.map(e => ({
    strategyId:   e.strategyId,
    strategyName: e.strategyName,
    strategyIcon: e.strategyIcon,
    byRegime:     bucketTradesByFittedRegime(e.trades, candles, fitted)}));

  const breakdowns: RegimeBreakdown[] = ALL_REGIME_LABELS.map(regime => {
    const trades    = primaryMap.get(regime) ?? [];
    const barCount  = barCounts.get(regime) ?? 0;
    const equity    = trades.map((t, i) => ({ time: t.exitTime, equity: config.startingCapital + trades.slice(0, i + 1).reduce((s, x) => s + x.pnl, 0) }));
    const metrics   = computeMetrics(trades, equity, config.startingCapital);

    const byModel: RegimeModelEntry[] = modelMaps.map(m => {
      const mTrades  = m.byRegime.get(regime) ?? [];
      const mEquity  = mTrades.map((t, i) => ({ time: t.exitTime, equity: config.startingCapital + mTrades.slice(0, i + 1).reduce((s, x) => s + x.pnl, 0) }));
      return { modelName: m.modelName, metrics: computeMetrics(mTrades, mEquity, config.startingCapital) };
    });

    const byHorizon: RegimeHorizonEntry[] = horizonMaps.map(h => {
      const hTrades  = h.byRegime.get(regime) ?? [];
      const hEquity  = hTrades.map((t, i) => ({ time: t.exitTime, equity: config.startingCapital + hTrades.slice(0, i + 1).reduce((s, x) => s + x.pnl, 0) }));
      return { horizon: h.horizon, metrics: computeMetrics(hTrades, hEquity, config.startingCapital) };
    });

    const byStrategy: RegimeStrategyEntry[] = strategyMaps.map(s => {
      const sTrades  = s.byRegime.get(regime) ?? [];
      const sEquity  = sTrades.map((t, i) => ({ time: t.exitTime, equity: config.startingCapital + sTrades.slice(0, i + 1).reduce((s2, x) => s2 + x.pnl, 0) }));
      return { strategyId: s.strategyId, strategyName: s.strategyName, strategyIcon: s.strategyIcon, metrics: computeMetrics(sTrades, sEquity, config.startingCapital) };
    });

    return {
      regime,
      displayName: REGIME_DISPLAY_NAMES[regime],
      emoji:       REGIME_EMOJI[regime],
      barCount,
      metrics,
      byModel,
      byHorizon,
      byStrategy};
  });

  const comparison = buildComparison(breakdowns);
  logger.info('regimeEval', `Regime eval complete. Best regime: ${comparison.bestOverall?.displayName ?? 'none'}`);

  return { breakdowns, comparison, generatedAt: Date.now() };
}
