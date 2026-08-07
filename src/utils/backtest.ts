import { Candle } from './indicators';
import { MLP } from './neuralNet';
import { LogisticRegression } from './logisticRegression';
import { precomputeSeries, featuresAt, computeStats, applyNorm, FEATURE_NAMES, PRIMARY_HORIZON } from './mlSignal';
import { createRNG } from './seededRandom';
import { simulateSignalStrategy, ExecConfig, ExecTrade, EquityPoint, ExitReason, simulateAIStrategyWithDiagnostics, DiagnosticExecConfig, BarDecision } from './strategyExecutor';
import { detectVolatilityRegime } from './marketStructure';
import { analyzeSkipReasons, analyzeSignalDistribution, avgConfidenceAtEntry, avgConfidenceAtExit, confidenceDistribution, tradeDurationHistogram, monthlyPerformance, weeklyPerformance, SkipReasonBreakdown, SignalDistribution, ConfidenceBucket, DurationBucket, PeriodSummary } from './tradeAnalytics';
import { logger } from './logger';

// ─────────────────────────────────────────────────
// PROFESSIONAL BACKTESTING ENGINE
// ─────────────────────────────────────────────────
// Design principles, stated explicitly because they matter for correctness:
//
// 1. NO FUTURE LEAKAGE: the model is fit ONCE on a strictly-earlier portion
//    of the data, then walked forward bar-by-bar through the remainder using
//    the model exactly as-is — no peeking, no retraining mid-walk, no
//    recomputing normalization from data inside the walk.
// 2. SAME SIGNALS AS LIVE: identical feature pipeline + same 0.55/0.45
//    ensemble threshold as live prediction.
// 3. ISOLATED FROM YOUR LIVE MODEL: fresh in-memory models, zero AsyncStorage.
// 4. REPRODUCIBLE: model weight initialization uses a seeded PRNG (not JS's
//    non-seedable Math.random()) — rerunning with the same data AND the same
//    seed now gives genuinely identical trades and metrics every time, not
//    just similar ones. This was verified and fixed as part of the
//    Verification & Stress Test Suite.

export type BacktestConfig = ExecConfig & {
  trainSplitPct: number;
  buyThreshold: number;
  seed: number; // fixes model initialization — same seed + same data = identical result, always
};

export const DEFAULT_BACKTEST_CONFIG: BacktestConfig = {
  startingCapital: 100000, feePct: 0.1, slippagePct: 0.05, riskPerTradePct: 2,
  atrStopMultiplier: 1.5, atrTargetMultiplier: 3.0, maxHoldingBars: 40,
  trainSplitPct: 0.5, buyThreshold: 0.55, seed: 42,
};

export type BacktestTrade = ExecTrade;
export { ExitReason, EquityPoint };

export type BacktestMetrics = {
  totalReturnPct: number; netProfit: number;
  winRate: number; lossRate: number;
  profitFactor: number;
  sharpeRatio: number;
  maxDrawdownPct: number;
  avgWin: number; avgLoss: number; avgTrade: number; expectancy: number;
  numTrades: number;
  maxConsecutiveWins: number; maxConsecutiveLosses: number;
  avgHoldingBars: number; avgHoldingMs: number;
};

export function computeMetrics(trades: ExecTrade[], equityCurve: EquityPoint[], startingCapital: number): BacktestMetrics {
  const finalEquity = equityCurve.length ? equityCurve[equityCurve.length - 1].equity : startingCapital;
  const netProfit = finalEquity - startingCapital;
  const totalReturnPct = (netProfit / startingCapital) * 100;

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const winRate = trades.length ? (wins.length / trades.length) * 100 : 0;
  const lossRate = trades.length ? (losses.length / trades.length) * 100 : 0;

  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);

  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
  const avgTrade = trades.length ? trades.reduce((s, t) => s + t.pnl, 0) / trades.length : 0;
  const expectancy = (winRate / 100) * avgWin + (lossRate / 100) * avgLoss;

  const pctReturns = trades.map(t => t.pnlPct);
  const meanRet = pctReturns.length ? pctReturns.reduce((s, r) => s + r, 0) / pctReturns.length : 0;
  const variance = pctReturns.length > 1 ? pctReturns.reduce((s, r) => s + (r - meanRet) ** 2, 0) / (pctReturns.length - 1) : 0;
  const stdRet = Math.sqrt(variance);
  const sharpeRatio = stdRet > 0 ? (meanRet / stdRet) * Math.sqrt(pctReturns.length) : 0;

  let peak = -Infinity, maxDD = 0;
  equityCurve.forEach(p => {
    peak = Math.max(peak, p.equity);
    const dd = ((peak - p.equity) / peak) * 100;
    maxDD = Math.max(maxDD, dd);
  });

  let curWinStreak = 0, curLossStreak = 0, maxWinStreak = 0, maxLossStreak = 0;
  trades.forEach(t => {
    if (t.pnl > 0) { curWinStreak++; curLossStreak = 0; maxWinStreak = Math.max(maxWinStreak, curWinStreak); }
    else { curLossStreak++; curWinStreak = 0; maxLossStreak = Math.max(maxLossStreak, curLossStreak); }
  });

  const avgHoldingBars = trades.length ? trades.reduce((s, t) => s + t.holdingBars, 0) / trades.length : 0;
  const avgHoldingMs = trades.length ? trades.reduce((s, t) => s + t.holdingMs, 0) / trades.length : 0;

  return {
    totalReturnPct, netProfit, winRate, lossRate, profitFactor, sharpeRatio, maxDrawdownPct: maxDD,
    avgWin, avgLoss, avgTrade, expectancy, numTrades: trades.length,
    maxConsecutiveWins: maxWinStreak, maxConsecutiveLosses: maxLossStreak, avgHoldingBars, avgHoldingMs};
}

// A fitted, reusable ensemble — separates "train the model" from "execute
// trades with given risk parameters" so sensitivity analysis can cheaply
// re-run execution with different SL/TP/risk/threshold WITHOUT retraining
// (only retraining actually needs to happen once; varying execution
// parameters afterward is just re-walking the SAME predictions).
export type FittedEnsemble = {
  predictProb: (idx: number) => { mlpProb: number; lrProb: number; ensembleProb: number; agree: boolean };
  atrAt: (idx: number) => number;
  isExtremeVolatilityAt: (idx: number) => boolean;
  // Returns the regime label at bar idx using the SAME precomputed S already
  // used by featuresAt(). Zero additional precomputeSeries calls.
  regimeLabelAt: (idx: number) => import('./regime/regimeTypes').RegimeLabel | null;
  walkIndices: number[];
  trainSampleCount: number;
  candles: Candle[];
  horizon: number;
  // Exposed for LEAK-SAFE feature contribution analysis (permutation
  // importance must only ever touch the held-out test set, never training
  // data or labels) — testX/testY are the model's own validation split,
  // already normalized with TRAIN-ONLY mean/std.
  testX: number[][];
  testY: number[];
  mean: number[];
  std: number[];
  mlp: MLP;
  lr: LogisticRegression;
}

// ── Opt 4: precomputed cache type ─────────────────────────────────────────────
// Allows callers to compute precomputeSeries + allFeatures ONCE and pass them
// into every fitEnsemble call. Results are mathematically identical because
// precomputeSeries and featuresAt are pure functions of candles only.
export type PrecomputedFitCache = {
  S:             Awaited<ReturnType<typeof precomputeSeries>>;
  allFeatures:   number[][];
  validIndices:  number[];
};

export async function buildFitCache(candles: Candle[]): Promise<PrecomputedFitCache | null> {
  if (candles.length < 120) return null;
  const S = await precomputeSeries(candles);
  const validIndices: number[] = [];
  const allFeatures:  number[][] = [];
  for (let i = 20; i < candles.length; i++) {
    const f = featuresAt(candles, i, S);
    if (!f) continue;
    validIndices.push(i);
    allFeatures.push(f);
  }
  if (allFeatures.length < 60) return null;
  return { S, allFeatures, validIndices };
}

// Yield interval for training loops inside fitEnsemble.
// Controls how often the JS thread yields to the event loop during training.
// Lower = more responsive UI, more overhead per fit.
// Higher = less overhead, UI updates less frequently during long evaluations.
// 25 is the production default — reduces yield count from 20 to 8 per fitEnsemble.
// Set to 10 for debugging if you need finer-grained progress feedback.
const FIT_YIELD_INTERVAL = 25;

export async function fitEnsemble(
  candles:      Candle[],
  trainSplitPct: number,
  seed:          number,
  horizon:       number = PRIMARY_HORIZON,
  // Opt 4: pass pre-built cache to skip precomputeSeries + feature extraction.
  // If null/undefined, falls back to computing from scratch (backward-compatible).
  cache?:        PrecomputedFitCache | null,
): Promise<FittedEnsemble | null> {
  if (candles.length < 120) {
    logger.warn('backtest', `Only ${candles.length} candles — need at least 120`);
    return null;
  }
  // Use provided cache or compute from scratch (identical result either way)
  const S            = cache?.S            ?? await precomputeSeries(candles);
  const validIndices = cache?.validIndices ?? (() => {
    const idx: number[] = [];
    for (let i = 20; i < candles.length; i++) { if (featuresAt(candles, i, S)) idx.push(i); }
    return idx;
  })();
  const allFeatures  = cache?.allFeatures  ?? (() => {
    const feats: number[][] = [];
    for (let i = 20; i < candles.length; i++) {
      const f = featuresAt(candles, i, S);
      if (f) feats.push(f);
    }
    return feats;
  })();

  const maxHorizon = horizon;
  if (allFeatures.length < 60) {
    logger.warn('backtest', `Only ${allFeatures.length} valid feature samples — insufficient`);
    return null;
  }

  // FIX (found via mechanics testing): this used to carve a "test set" out
  // of whatever thin buffer was left over from trimming training labels
  // away from the walk-forward boundary — that buffer is often only a few
  // bars wide (just enough to cover the horizon), so the exposed test set
  // for permutation importance frequently came out EMPTY (0 samples, NaN
  // accuracy) even though nothing crashed. Restructured into a genuine
  // three-way split: train / validation (properly sized, ~15% of the
  // pre-walk data) / walk-forward — each boundary still trimmed so no
  // label resolves across it.
  const rawSplit = Math.floor(allFeatures.length * trainSplitPct);
  const valFraction = 0.15;
  const rawValStart = Math.floor(rawSplit * (1 - valFraction));

  let trainEnd = rawValStart;
  while (trainEnd > 0 && validIndices[trainEnd - 1] + maxHorizon >= validIndices[rawValStart]) trainEnd--;

  let valEnd = rawSplit;
  while (valEnd > rawValStart && validIndices[valEnd - 1] + maxHorizon >= validIndices[rawSplit]) valEnd--;

  const trainX = allFeatures.slice(0, trainEnd);
  const trainY = trainX.map((_, k) => {
    const idx = validIndices[k];
    return candles[idx + maxHorizon].close > candles[idx].close ? 1 : 0;
  });
  logger.info('backtest', `Train samples: ${trainX.length}, horizon=${horizon}`);

  const { mean, std } = computeStats(trainX);
  const normTrainX = applyNorm(trainX, mean, std);

  // The held-out validation set for permutation importance — now a genuinely
  // sized slice (~15% of pre-walk data, minus the same leakage trim), not an
  // accidental near-empty remainder.
  const testX_raw = allFeatures.slice(trainEnd, valEnd);
  const testY = testX_raw.map((_, k) => {
    const idx = validIndices[trainEnd + k];
    return candles[idx + maxHorizon].close > candles[idx].close ? 1 : 0;
  });
  const testX = applyNorm(testX_raw, mean, std);
  logger.info('backtest', `Validation samples: ${testX.length} (for permutation importance)`);

  // Seeded RNG → genuinely reproducible: same candles + same seed always
  // produces the same trained weights, the same trades, the same metrics.
  const rng = createRNG(seed);
  const _fitT0 = Date.now();
  const mlp = new MLP(trainX[0].length, 8, rng);
  for (let e = 0; e < 100; e++) {
    mlp.trainEpoch(normTrainX, trainY, 0.08);
    if (e % FIT_YIELD_INTERVAL === FIT_YIELD_INTERVAL - 1) await new Promise<void>(r => setTimeout(r, 0));
  }
  logger.info('backtest:perf', `[FIT] h=${horizon} MLP 100ep: ${Date.now()-_fitT0}ms (N=${trainX.length},D=${trainX[0].length})`);
  const _lrT0 = Date.now();
  const lr = new LogisticRegression(trainX[0].length, rng);
  for (let e = 0; e < 100; e++) {
    lr.trainEpoch(normTrainX, trainY, 0.15);
    if (e % FIT_YIELD_INTERVAL === FIT_YIELD_INTERVAL - 1) await new Promise<void>(r => setTimeout(r, 0));
  }
  logger.info('backtest:perf', `[FIT] h=${horizon} LR  100ep: ${Date.now()-_lrT0}ms`);

  const walkIndices = validIndices.slice(rawSplit);
  const indexToFeatureIdx = new Map(validIndices.map((idx, k) => [idx, k]));

  // Average historical volatility across the walk window — the baseline
  // detectVolatilityRegime compares each bar against to classify LOW/NORMAL/HIGH/EXTREME.
  const volSamples = walkIndices.map(i => S.histVol[i]).filter((v): v is number => v != null);
  const avgVol = volSamples.length ? volSamples.reduce((s, v) => s + v, 0) / volSamples.length : 1;

  const mlpTestAcc = testX.length
    ? (() => {
        let correct = 0;
        testX.forEach((x, i) => { if ((mlp.predict(x) > 0.5 ? 1 : 0) === testY[i]) correct++; });
        return testX.length ? (correct / testX.length) * 100 : 0;
      })()
    : 50;
  const lrTestAcc = testX.length
    ? (() => {
        let correct = 0;
        testX.forEach((x, i) => { if ((lr.predict(x) > 0.5 ? 1 : 0) === testY[i]) correct++; });
        return testX.length ? (correct / testX.length) * 100 : 0;
      })()
    : 50;

  // AUDIT FIX: previously this used 50/50 averaging unconditionally, while
  // the live engine (mlSignal.ts line 719-721) uses accuracy-weighted
  // averaging where each model's weight = max(0, validation_accuracy - 50).
  // This meant the backtest was measuring a different strategy than live.
  const mlpWeight = Math.max(0, mlpTestAcc - 50);
  const lrWeight = Math.max(0, lrTestAcc - 50);
  const totalEnsembleWeight = mlpWeight + lrWeight;

  return {
    predictProb: (idx: number) => {
      const k = indexToFeatureIdx.get(idx)!;
      const norm = allFeatures[k].map((v, j) => (v - mean[j]) / std[j]);
      const mlpProb = mlp.predict(norm);
      const lrProb = lr.predict(norm);
      // Accuracy-weighted ensemble — matches mlSignal.ts exactly.
      // Falls back to 50/50 when both models are at/below chance level
      // (same fallback condition as live), rather than fabricating a
      // meaningful weighted signal from two models with no real skill.
      const ensembleProb = totalEnsembleWeight > 0
        ? (mlpProb * mlpWeight + lrProb * lrWeight) / totalEnsembleWeight
        : (mlpProb + lrProb) / 2;
      return { mlpProb, lrProb, ensembleProb, agree: (mlpProb > 0.5) === (lrProb > 0.5) };
    },
    atrAt: (idx: number) => S.atrArr[idx] ?? 0,
    isExtremeVolatilityAt: (idx: number) => detectVolatilityRegime(S.histVol[idx] ?? avgVol, avgVol) === 'EXTREME',
    regimeLabelAt: (idx: number) => S.regimeData?.regimeArr?.[idx]?.label ?? null,
    walkIndices, trainSampleCount: trainX.length, candles, horizon,
    testX, testY, mean, std, mlp, lr};
}

// Opt 3: BacktestResult now carries the fitted ensemble so evaluateProductionModel
// can reuse it for Steps 3–8 without a second fitEnsemble() call.
// The fitted field is optional so all existing callers that only use BacktestResult
// fields (trades, metrics, etc.) are unaffected — backward compatible.
export type BacktestResult = {
  trades: BacktestTrade[];
  equityCurve: EquityPoint[];
  metrics: BacktestMetrics;
  trainSampleCount: number;
  walkedBars: number;
  featureCount: number;
  fitted?: FittedEnsemble;  // Opt 3: exposed for reuse, never changes the result values
};

export async function runBacktest(
  candles:         Candle[],
  configOverrides: Partial<BacktestConfig> = {},
  cache?:          PrecomputedFitCache | null,  // Opt 4: optional pre-built cache
): Promise<BacktestResult | null> {
  const config: BacktestConfig = { ...DEFAULT_BACKTEST_CONFIG, ...configOverrides };
  logger.info('backtest', `Starting backtest on ${candles.length} candles, seed=${config.seed}`);

  const fitted = await fitEnsemble(candles, config.trainSplitPct, config.seed, PRIMARY_HORIZON, cache);
  if (!fitted) return null;

  const { trades, equityCurve } = simulateSignalStrategy(
    candles, fitted.walkIndices,
    (idx) => {
      const { ensembleProb, agree } = fitted.predictProb(idx);
      if (ensembleProb > config.buyThreshold && agree) {
        return { enter: true, direction: 'LONG', reason: `Ensemble P(up)=${(ensembleProb * 100).toFixed(1)}%, models agree, signal matches live Buy threshold` };
      }
      if (ensembleProb < (1 - config.buyThreshold) && agree) {
        return { enter: true, direction: 'SHORT', reason: `Ensemble P(up)=${(ensembleProb * 100).toFixed(1)}%, models agree, signal matches live Sell threshold` };
      }
      return { enter: false, reason: 'Below threshold or models disagree' };
    },
    fitted.atrAt,
    config
  );

  const metrics = computeMetrics(trades, equityCurve, config.startingCapital);
  logger.info('backtest', `Complete: ${trades.length} trades, ${metrics.totalReturnPct.toFixed(2)}% return, ${metrics.winRate.toFixed(1)}% win rate`);

  return {
    trades, equityCurve, metrics,
    trainSampleCount: fitted.trainSampleCount, walkedBars: fitted.walkIndices.length,
    featureCount: FEATURE_NAMES.length,
    fitted,  // Opt 3: returned for reuse, no change to any result field
  };
}

// ─────────────────────────────────────────────────
// COMPREHENSIVE BACKTEST — Phase 2: full diagnostics, trade analytics,
// skip-reason breakdown, and honest reporting of what isn't implemented.
// ─────────────────────────────────────────────────
// Reuses fitEnsemble exactly as-is (no duplicate training logic), routes
// through the new diagnostic-aware executor instead of the plain one, and
// derives every requested analytic from the resulting trades + bar-by-bar
// decision stream via tradeAnalytics.ts. Nothing here recomputes anything
// that regimeAnalysis.ts, tradeAnalytics.ts, or computeMetrics already do
// correctly — it composes them.

export type ComprehensiveBacktestConfig = BacktestConfig & {
  useVolatilityFilter?: boolean;
  maxConsecutiveLosses?: number;
};

export type ComprehensiveBacktestResult = {
  trades: (ExecTrade & { entryConfidence: number; exitConfidence: number })[];
  equityCurve: EquityPoint[];
  metrics: BacktestMetrics;
  barDecisions: BarDecision[];
  signalDistribution: SignalDistribution;
  skipReasons: { breakdown: SkipReasonBreakdown[]; totalSkipped: number };
  avgEntryConfidence: number;
  avgExitConfidence: number;
  confidenceDistribution: ConfidenceBucket[];
  durationHistogram: DurationBucket[];
  monthly: PeriodSummary[];
  weekly: PeriodSummary[];
  // SHORT trades are now actually simulated (previously explicitly
  // deferred — see git history / prior audit reports for the honest
  // disclosure that used to live here). buyTrades/sellTrades are real
  // counts of trades by direction, not a fabricated or hardcoded value.
  buyTrades: number;
  sellTrades: number;
  shortingImplemented: true;
  trainSampleCount: number;
  walkedBars: number;
  featureCount: number;
};

export async function runComprehensiveBacktest(candles: Candle[], configOverrides: Partial<ComprehensiveBacktestConfig> = {}): Promise<ComprehensiveBacktestResult | null> {
  const config: ComprehensiveBacktestConfig = { ...DEFAULT_BACKTEST_CONFIG, ...configOverrides };
  const fitted = await fitEnsemble(candles, config.trainSplitPct, config.seed);
  if (!fitted) return null;

  const execConfig: DiagnosticExecConfig = config;
  const { trades, equityCurve, barDecisions } = simulateAIStrategyWithDiagnostics(
    candles, fitted.walkIndices,
    (idx) => {
      const p = fitted.predictProb(idx);
      // Lightweight, fast confidence proxy for per-bar diagnostics — NOT the
      // full live ConfidenceBreakdown (which needs an async calibration
      // lookup per call; doing that for every walked bar would be far too
      // slow). Distinct by design, consistent in spirit: distance from a
      // coin flip, discounted when the two models disagree.
      const confidence = Math.min(100, Math.abs(p.ensembleProb - 0.5) * 200) * (p.agree ? 1 : 0.5);
      return { ...p, confidence };
    },
    fitted.atrAt,
    config.useVolatilityFilter ? fitted.isExtremeVolatilityAt : null,
    execConfig,
    config.buyThreshold
  );

  const metrics = computeMetrics(trades, equityCurve, config.startingCapital);

  return {
    trades, equityCurve, metrics, barDecisions,
    signalDistribution: analyzeSignalDistribution(barDecisions),
    skipReasons: analyzeSkipReasons(barDecisions),
    avgEntryConfidence: avgConfidenceAtEntry(trades),
    avgExitConfidence: avgConfidenceAtExit(trades),
    confidenceDistribution: confidenceDistribution(barDecisions),
    durationHistogram: tradeDurationHistogram(trades),
    monthly: monthlyPerformance(trades),
    weekly: weeklyPerformance(trades),
    buyTrades: trades.filter(t => t.direction !== 'SHORT').length,
    sellTrades: trades.filter(t => t.direction === 'SHORT').length,
    shortingImplemented: true,
    trainSampleCount: fitted.trainSampleCount, walkedBars: fitted.walkIndices.length, featureCount: FEATURE_NAMES.length};
}
