import AsyncStorage from '@react-native-async-storage/async-storage';
import { logger } from './logger';
import { recordPrediction, getCalibration } from './predictionHistory';
import { recordTrainingStatus, TrainingStatusInfo } from './trainingHistory';
import { OrderBookSnapshot } from './orderBook';
import { Candle, calcRSI } from './indicators';
import { MLP, MLPWeights } from './neuralNet';
import { LogisticRegression, LRWeights } from './logisticRegression';
import {
  ema, sma, macd, stochasticRSI, roc, momentum, cci, williamsR, tsi, atr, bollinger,
  historicalVolatility, obv, mfi, cmf, volumeOscillator, relativeVolume, adx, vwap,
  parabolicSAR, donchianChannel, keltnerChannel, accDist,
} from './technicalIndicators';
import { detectSwings, detectTrendDirection, detectVolatilityRegime, classicPivots } from './marketStructure';
import { timeFeaturesAt } from './timeFeatures';

// PRIORITY 2: wires in indicators that previously existed as standalone,
// verified-correct functions but were never actually used by the model —
// SMA, Parabolic SAR, Donchian/Keltner Channels, Accumulation/Distribution,
// candlestick patterns, and rolling pivots. One deliberate exclusion: raw
// swing-high/low CLASSIFICATION (HH/HL/LH/LL) is NOT added as a per-bar
// training feature, because confirming a swing point inherently requires
// seeing bars *after* it — using that as a label-time feature for historical
// bars would leak future information into training. It's used in the UI's
// Market Structure panel instead, where it correctly describes the CURRENT
// state of the market, not a retroactive label for past bars.
// ML AUDIT (Binance Order Book integration) — order book/depth fields are
// deliberately NOT included below, after auditing whether this is even
// possible honestly:
//   1. Can order book be aligned with every training candle? NO. Training
//      pulls up to 5000 historical candles per (symbol, timeframe) via
//      fetchMaxHistory — at 1h that's ~7 months of history, at 1D it's
//      13+ years. Binance's public /api/v3/depth endpoint (the one this
//      app actually calls — see api/binance.ts's fetchBinanceDepth) has
//      NO historical/timestamp query parameter at all. It only ever
//      returns the book as it exists RIGHT NOW.
//   2. Is historical order book actually available? NOT through any API
//      this app has access to. Reconstructing it honestly would require
//      either a paid historical L2 data vendor (not integrated, no
//      credentials exist for one) or continuously recording the live
//      book going forward from today.
//   3. Can historical depth be reconstructed honestly? Only by waiting —
//      recording live snapshots from now on (which orderBook.ts's
//      OrderBookSnapshot + the persistence wired into paper trades/
//      journal now does) builds a genuinely real dataset for FUTURE
//      candles, but provides nothing for the EXISTING training history,
//      and even going forward it would take a long time to accumulate
//      enough real depth-aligned samples to be worth retraining on.
// Conclusion: order book is a real, live UI/persistence feature (see
// OrderBookCard.tsx, the orderBookSnapshot field on MLPrediction) but is
// NOT wired into FEATURE_NAMES, the neural network, logistic regression,
// or confidence calculation. Fabricating historical depth to feed the
// model would be the exact kind of dishonest training data this
// project's whole "no fabricated data" principle exists to prevent.
export const FEATURE_NAMES = [
  'Return 1-bar', 'Return 3-bar', 'Return 5-bar', 'Return 10-bar', 'Return 20-bar',
  'RSI', 'Stochastic RSI', 'MACD histogram', 'ROC(10)', 'Momentum(10)',
  'CCI', 'Williams %R', 'TSI', 'ATR (norm)', 'Bollinger %B', 'BB width %',
  'Historical volatility', 'OBV slope', 'MFI', 'CMF', 'Volume oscillator',
  'Relative volume', 'ADX', 'Dist. from EMA20', 'Dist. from EMA50', 'Dist. from EMA200',
  'Dist. from VWAP', 'Trend direction', 'Volatility regime', 'Hour (sin)', 'Day of week',
  'Dist. from SMA20', 'Dist. from Parabolic SAR', 'Donchian %', 'Keltner %',
  'Accum/Dist slope', 'Rolling pivot distance', 'Candlestick pattern flag',
];

const HORIZONS = [1, 3, 5, 10, 20];
// TASK 3 (Stable Model Versioning) — this is the CODE/feature-set version:
// bump this only when the actual model architecture changes (feature
// count, network shape, the ensembling formula itself) — never on a
// per-symbol retrain. This is what "Architecture Version" means; it has
// nothing to do with modelVersion below, which is a stable, conceptually
// different idea: see ModelMetadata's trainingRunNumber and modelVersion
// fields for the other two numbers in the v4/#132/#84 example.
export const ARCHITECTURE_VERSION = 1;

export const PRIMARY_HORIZON = 3; // used for the main directional call, SL/TP, etc.
export const NEW_CANDLES_THRESHOLD = 20; // minimum new candles required to trigger a real retrain - referenced by the Prediction Source Card / Training Status UI directly, never duplicated as a separate guess
export const WALK_FORWARD_FOLDS = 4;

// Precomputes every indicator series ONCE for the whole candle array, then
// builds a feature vector per-bar by indexing into those series — this is
// what keeps ~30 indicators computationally reasonable on a phone (O(n) total
// instead of recomputing each indicator from scratch for every single bar).
export function precomputeSeries(candles: Candle[]) {
  const cl = candles.map(c => c.close);
  const ema20 = ema(cl, 20), ema50 = ema(cl, 50), ema200 = ema(cl, 200);
  const sma20 = sma(cl, 20);
  const macdRes = macd(candles);
  const rsiArr = candles.map((_, i) => i < 1 ? null : calcRSI(candles.slice(0, i + 1)));
  const stochRsi = stochasticRSI(candles);
  const rocArr = roc(candles, 10);
  const momArr = momentum(candles, 10);
  const cciArr = cci(candles);
  const willR = williamsR(candles);
  const tsiArr = tsi(candles);
  const atrArr = atr(candles);
  const bb = bollinger(candles);
  const histVol = historicalVolatility(candles);
  const obvArr = obv(candles);
  const mfiArr = mfi(candles);
  const cmfArr = cmf(candles);
  const volOsc = volumeOscillator(candles);
  const relVol = relativeVolume(candles);
  const adxArr = adx(candles);
  const vwapArr = vwap(candles);
  const swings = detectSwings(candles);
  // All three of these are inherently sequential/backward-looking by
  // construction (verified causal — see comment above FEATURE_NAMES):
  const sarArr = parabolicSAR(candles);
  const donchianArr = donchianChannel(candles, 20);
  const keltnerArr = keltnerChannel(candles, 20, 10, 2);
  const accDistArr = accDist(candles);
  // Rolling pivot: uses the PRIOR 20-bar window's H/L/C as a stand-in for
  // "previous session" floor pivots — a real, honest approximation (not
  // true daily pivots, which would need separate session-boundary logic),
  // computed fresh per-bar using only data strictly before that bar.
  const rollingPivots = candles.map((_, i) => {
    if (i < 20) return null;
    const window = candles.slice(i - 20, i);
    const ph = Math.max(...window.map(c => c.high)), pl = Math.min(...window.map(c => c.low)), pc = window[window.length - 1].close;
    return classicPivots(ph, pl, pc);
  });
  return {
    ema20, ema50, ema200, sma20, macdRes, rsiArr, stochRsi, rocArr, momArr, cciArr, willR, tsiArr, atrArr,
    bb, histVol, obvArr, mfiArr, cmfArr, volOsc, relVol, adxArr, vwapArr, swings,
    sarArr, donchianArr, keltnerArr, accDistArr, rollingPivots,
  };
}

export function featuresAt(candles: Candle[], i: number, S: ReturnType<typeof precomputeSeries>): number[] | null {
  if (i < 20 || i >= candles.length) return null;
  const c = candles[i];
  const c1 = candles[i - 1], c3 = candles[i - 3], c5 = candles[i - 5], c10 = candles[i - 10], c20 = candles[i - 20];
  if (!c1 || !c3 || !c5 || !c10 || !c20) return null;

  const ret1 = (c.close - c1.close) / c1.close;
  const ret3 = (c.close - c3.close) / c3.close;
  const ret5 = (c.close - c5.close) / c5.close;
  const ret10 = (c.close - c10.close) / c10.close;
  const ret20 = (c.close - c20.close) / c20.close;

  const rsi = (S.rsiArr[i] ?? 50) / 100;
  const stochRsi = (S.stochRsi[i] ?? 50) / 100;
  const macdHist = S.macdRes.hist[i] != null ? S.macdRes.hist[i]! / c.close : 0;
  const rocV = (S.rocArr[i] ?? 0) / 100;
  const momV = (S.momArr[i] ?? 0) / c.close;
  const cciV = (S.cciArr[i] ?? 0) / 200;
  const willRV = ((S.willR[i] ?? -50) + 50) / 100; // shift -100..0 -> 0..1
  const tsiV = (S.tsiArr[i] ?? 0) / 100;
  const atrNorm = S.atrArr[i] != null ? S.atrArr[i]! / c.close : 0;
  const bbAt = S.bb[i];
  const bbPercent = (bbAt.upper != null && bbAt.lower != null && bbAt.upper !== bbAt.lower) ? (c.close - bbAt.lower) / (bbAt.upper - bbAt.lower) : 0.5;
  const bbWidth = bbAt.widthPct != null ? bbAt.widthPct / 100 : 0;
  const histVolV = (S.histVol[i] ?? 0) / 100;
  const obvSlope = i >= 5 ? (S.obvArr[i] - S.obvArr[i - 5]) / (Math.abs(S.obvArr[i - 5]) + 1) : 0;
  const mfiV = (S.mfiArr[i] ?? 50) / 100;
  const cmfV = S.cmfArr[i] ?? 0;
  const volOscV = (S.volOsc[i] ?? 0) / 100;
  const relVolV = Math.min(S.relVol[i] ?? 1, 5) / 5;
  const adxV = (S.adxArr[i] ?? 0) / 100;
  const distEma20 = S.ema20[i] != null ? (c.close - S.ema20[i]!) / S.ema20[i]! : 0;
  const distEma50 = S.ema50[i] != null ? (c.close - S.ema50[i]!) / S.ema50[i]! : 0;
  const distEma200 = S.ema200[i] != null ? (c.close - S.ema200[i]!) / S.ema200[i]! : 0;
  const distVwap = (c.close - S.vwapArr[i]) / S.vwapArr[i];
  const trendDir = detectTrendDirection(candles.slice(0, i + 1), S.ema20.slice(0, i + 1), S.ema50.slice(0, i + 1));
  const trendEnc = trendDir === 'UPTREND' ? 1 : trendDir === 'DOWNTREND' ? -1 : 0;
  const volRegime = detectVolatilityRegime(S.histVol[i] ?? 0, S.histVol.slice(Math.max(0, i - 60), i + 1).filter((v): v is number => v != null).reduce((s, v, _, a) => s + v / a.length, 0) || 1);
  const volRegimeEnc = volRegime === 'LOW' ? 0 : volRegime === 'NORMAL' ? 0.33 : volRegime === 'HIGH' ? 0.66 : 1;
  const tf = timeFeaturesAt(c.time);
  const hourSin = Math.sin((tf.hourOfDay / 24) * 2 * Math.PI);
  const dayOfWeekNorm = tf.dayOfWeek / 6;

  // ── Priority 2 additions — previously-built, verified-correct indicators
  // that existed as standalone functions but were never actually wired into
  // the model. All computed causally (using only data up to and including
  // bar i — see precomputeSeries comment for why swing classification is
  // deliberately excluded here). ──
  const distSma20 = S.sma20[i] != null ? (c.close - S.sma20[i]!) / S.sma20[i]! : 0;
  const distSar = S.sarArr[i] != null ? (c.close - S.sarArr[i]) / c.close : 0; // positive = price above SAR (bullish per SAR)
  const donchAt = S.donchianArr[i];
  const donchPercent = (donchAt.upper != null && donchAt.lower != null && donchAt.upper !== donchAt.lower)
    ? (c.close - donchAt.lower) / (donchAt.upper - donchAt.lower) : 0.5;
  const keltAt = S.keltnerArr[i];
  const keltPercent = (keltAt.upper != null && keltAt.lower != null && keltAt.upper !== keltAt.lower)
    ? (c.close - keltAt.lower) / (keltAt.upper - keltAt.lower) : 0.5;
  const accDistSlope = i >= 10 ? (S.accDistArr[i] - S.accDistArr[i - 10]) / (Math.abs(S.accDistArr[i - 10]) + 1) : 0;
  const pivotAt = S.rollingPivots[i];
  const pivotDist = pivotAt ? (c.close - pivotAt.pp) / pivotAt.pp : 0;
  const patternFlag = inlinePatternFlag(candles, i);

  return [
    ret1, ret3, ret5, ret10, ret20, rsi, stochRsi, macdHist, rocV, momV,
    cciV, willRV, tsiV, atrNorm, bbPercent, bbWidth, histVolV, obvSlope, mfiV, cmfV,
    volOscV, relVolV, adxV, distEma20, distEma50, distEma200, distVwap, trendEnc, volRegimeEnc, hourSin, dayOfWeekNorm,
    distSma20, distSar, donchPercent, keltPercent, accDistSlope, pivotDist, patternFlag,
  ];
}

// Lightweight inline candlestick pattern check using only candles[i-2..i]
// directly — avoids the O(n) array-slicing cost of calling the full
// detectPatterns() function for every single bar during training (that
// function is still used as-is for the "latest pattern" UI display, where
// it's only called once on current data, not once per training sample).
// Returns a single signed score: +1 bullish pattern, -1 bearish, 0 neither.
function inlinePatternFlag(c: Candle[], i: number): number {
  if (i < 2) return 0;
  const last = c[i], prev = c[i - 1];
  const body = (x: Candle) => Math.abs(x.close - x.open);
  const range = (x: Candle) => x.high - x.low || 1e-9;
  const lowerWick = (x: Candle) => Math.min(x.open, x.close) - x.low;
  const upperWick = (x: Candle) => x.high - Math.max(x.open, x.close);

  let score = 0;
  // Hammer-like (bullish)
  if (lowerWick(last) > body(last) * 2 && upperWick(last) < body(last) * 0.5 && body(last) / range(last) < 0.35) score += 1;
  // Bearish pin bar
  if (upperWick(last) > body(last) * 2 && lowerWick(last) < body(last) * 0.5 && body(last) / range(last) < 0.35) score -= 1;
  // Bullish engulfing
  if (prev.close < prev.open && last.close > last.open && last.open <= prev.close && last.close >= prev.open) score += 1;
  // Bearish engulfing
  if (prev.close > prev.open && last.close < last.open && last.open >= prev.close && last.close <= prev.open) score -= 1;
  return Math.max(-1, Math.min(1, score));
}

// FIX (feature importance overflow bug, e.g. "Day of Week = 162246756301693..."):
// the old `std[j] = Math.sqrt(s / n) || 1` only catches EXACT zero variance.
// A feature that's merely near-constant in the training window (very
// plausible for day-of-week/hour features on short timeframes with limited
// history — e.g. 99 bars all landing on the same calendar day, with one tiny
// floating-point blip) produces a std like 1e-12, not exactly 0 — so the
// `||1` fallback never triggers, and normalizing any live value that falls
// outside that razor-thin training distribution explodes toward astronomical,
// meaningless numbers. Reproduced and confirmed directly before this fix:
// a near-constant column + an out-of-distribution live value produced a
// normalized value in the 1e10 range from inputs that should never exceed
// single digits. Fixed with an explicit MINIMUM floor, not just a zero-guard.
const MIN_STD = 1e-4;
export function computeStats(X: number[][]): { mean: number[]; std: number[] } {
  const n = X.length, d = X[0].length;
  const mean = Array(d).fill(0), std = Array(d).fill(0);
  X.forEach(row => row.forEach((v, j) => { mean[j] += v; }));
  mean.forEach((m, j) => { mean[j] = m / n; });
  X.forEach(row => row.forEach((v, j) => { std[j] += (v - mean[j]) ** 2; }));
  std.forEach((s, j) => { std[j] = Math.max(Math.sqrt(s / n), MIN_STD); });
  return { mean, std };
}
export function applyNorm(X: number[][], mean: number[], std: number[]): number[][] {
  return X.map(row => row.map((v, j) => (v - mean[j]) / std[j]));
}
function accuracy(predict: (x: number[]) => number, X: number[][], y: number[]): number {
  if (!X.length) return 0;
  let correct = 0;
  X.forEach((x, i) => { if ((predict(x) > 0.5 ? 1 : 0) === y[i]) correct++; });
  return (correct / X.length) * 100;
}

// Binary cross-entropy loss — the actual training objective, distinct from
// accuracy (loss can keep improving near a decision boundary even while
// accuracy looks flat, or vice versa — reporting both is more honest).
function computeLoss(predict: (x: number[]) => number, X: number[][], y: number[]): number {
  if (!X.length) return 1;
  let loss = 0;
  X.forEach((x, i) => {
    const p = Math.min(1 - 1e-7, Math.max(1e-7, predict(x)));
    loss += -(y[i] * Math.log(p) + (1 - y[i]) * Math.log(1 - p));
  });
  return loss / X.length;
}

// Trains with early stopping: checks validation loss every 5 epochs, stops
// once it hasn't improved for `patience` checks in a row, instead of always
// burning the full fixed epoch budget regardless of whether it's still
// helping. Returns how many epochs actually ran and whether it stopped early.
function trainWithEarlyStopping(
  model: MLP, trainX: number[][], trainY: number[], valX: number[][], valY: number[],
  maxEpochs: number, lr: number, patience = 3, checkEvery = 5
): { epochsCompleted: number; earlyStopped: boolean; finalLoss: number } {
  let bestValLoss = Infinity, noImproveCount = 0, epoch = 0;
  for (; epoch < maxEpochs; epoch++) {
    model.trainEpoch(trainX, trainY, lr);
    if ((epoch + 1) % checkEvery === 0 && valX.length) {
      const valLoss = computeLoss(x => model.predict(x), valX, valY);
      if (valLoss < bestValLoss - 1e-4) { bestValLoss = valLoss; noImproveCount = 0; }
      else { noImproveCount++; if (noImproveCount >= patience) { epoch++; break; } }
    }
  }
  const finalLoss = valX.length ? computeLoss(x => model.predict(x), valX, valY) : computeLoss(x => model.predict(x), trainX, trainY);
  return { epochsCompleted: Math.min(epoch, maxEpochs), earlyStopped: epoch < maxEpochs, finalLoss };
}

export type HorizonResult = { horizon: number; probUp: number; testAccuracy: number };
export type TradeAction = 'BUY' | 'SELL' | 'HOLD';

// Full transparency on how confidence is computed — every component is
// exposed, not just the final number, so "P(up)=70% but confidence=31"
// is no longer a mystery: you can see exactly which input pulled it down.
export type ConfidenceBreakdown = {
  probabilityComponent: number;   // 0-100, how far the ensemble probability is from a coin flip
  agreementComponent: number;     // 0-100, how closely the NN and LR probabilities match each other (continuous, not just same-side-of-50%)
  walkForwardComponent: number;   // 0-100, scaled from walk-forward validated accuracy
  validationComponent: number;    // 0-100, scaled from this run's held-out validation accuracy
  calibrationComponent: number | null; // 0-100 if enough resolved history exists, else null (weight redistributed to the others, never faked)
  calibrationSampleCount: number;
  weights: { probability: number; agreement: number; walkForward: number; validation: number; calibration: number };
  finalConfidence: number;
};

export type MLPrediction = {
  horizons: HorizonResult[];
  ensembleProbUp: number;
  mlpProbUp: number;
  lrProbUp: number;
  ensembleAgree: boolean;
  direction: 'UP' | 'DOWN' | 'NEUTRAL';
  confidence: number;
  confidenceBreakdown: ConfidenceBreakdown;
  riskScore: number;
  action: TradeAction;
  suggestedEntry: number;
  suggestedStopLoss: number;
  suggestedTakeProfit: number;
  riskRewardRatio: number;
  walkForwardAccuracy: number;
  // Confusion matrix from the SAME walk-forward folds walkForwardAccuracy
  // is derived from — "positive" = model predicts price moves up,
  // "actual positive" = price genuinely moved up over the horizon.
  // Exposed so batch evaluation (Verification screen) can compute real
  // Precision/Recall/F1 without re-deriving features or re-running folds.
  walkForwardConfusion: { truePositives: number; falsePositives: number; trueNegatives: number; falseNegatives: number };
  topFeatures: { name: string; value: number; influence: number }[];
  // Full training metadata — regenerated fresh on every successful run, never
  // reused from a previous call. See ModelMetadata below for the persisted,
  // reloadable version of this same information.
  sampleCount: number; // training candle count for THIS call (current samples available) - always the current count, even when reused/rejected
  // FIX (Prediction Source Card): the field above is ALWAYS this call's
  // current raw count, even when reused or rejected - genuinely different
  // from "how many samples did the model that's actually serving THIS
  // prediction get trained on." When rejected, the active model is still
  // the PREVIOUS accepted one (rejected weights are never saved); when
  // reused, it's whatever the existing model was trained on. Only when
  // accepted does this equal sampleCount.
  samplesAtActiveModelTraining: number;
  // Same value already computed for the retrain decision itself -
  // exposed here so the Prediction Source Card doesn't need a separate
  // fetch for "new candles since training," and can't disagree with the
  // decision that was actually made.
  newCandlesSinceLastTraining: number | null;
  validationCount: number; // held-out test-set candle count
  featureCount: number;
  modelVersion: number; // TASK 3: this is the "Accepted Model #" — increments by 1 only when a training run is accepted, persisted per symbol
  trainingRunNumber: number; // TASK 3: the "Training Run #" — increments on EVERY attempt, accepted or rejected, so it's always >= modelVersion
  candlesAtTraining: number; // TASK 5: candle count this model was actually trained on, used to decide whether enough new data has arrived to warrant retraining
  trainedAt: number;
  warmStart: boolean;
  // Training progress + accept/reject — answers "did this run actually
  // improve on what was there before, and was it kept or discarded?"
  primaryValidationAccuracy: number;
  primaryLoss: number;
  epochsCompleted: number;
  earlyStopped: boolean;
  previousValidationAccuracy: number | null;
  previousWalkForwardAccuracy: number | null;
  previousLoss: number | null;
  modelAccepted: boolean;
  acceptRejectReason: string;
  // Prediction Source Card: directly mirrors what gets persisted to
  // trainingHistory.ts for this exact call, so "which model produced
  // THIS prediction" never depends on a separate async read that could
  // theoretically race with a concurrent call for the same symbol/timeframe.
  trainingStatusType: 'trained' | 'reused' | 'rejected';
  // GOAL 3 (persistence) — captured from whatever order book snapshot was
  // available at the moment this prediction was generated, so it flows
  // naturally into paper trades/journal/replay without a second storage
  // mechanism. Deliberately NOT used as a training feature (see the ML
  // audit in mlSignal.ts's trainAndPredictInner comments) - this is for
  // human review and future analysis only.
  orderBookSnapshot: OrderBookSnapshot | null;
};

// Computes confidence as a genuine, transparent reliability estimate rather
// than dressed-up probability. Each component is scored 0-100 independently;
// the final number is a weighted average. When historical calibration data
// doesn't exist yet (needs 20+ RESOLVED past predictions), its weight is
// redistributed proportionally across the other four components rather than
// substituting a fake neutral value — confidence should never claim
// information it doesn't actually have.
function computeConfidenceBreakdown(
  ensembleProbUp: number, mlpProbUp: number, lrProbUp: number,
  walkForwardAccuracy: number, validationAccuracy: number,
  calibration: { buckets: { nominalProb: number; actualHitRate: number; sampleCount: number }[]; totalResolved: number; available: boolean }
): ConfidenceBreakdown {
  const probabilityComponent = Math.min(100, Math.abs(ensembleProbUp - 0.5) * 200);
  const agreementComponent = Math.max(0, 100 - Math.abs(mlpProbUp - lrProbUp) * 200);
  const walkForwardComponent = walkForwardAccuracy >= 0 ? Math.max(0, Math.min(100, (walkForwardAccuracy - 50) * 2)) : 50;
  const validationComponent = Math.max(0, Math.min(100, (validationAccuracy - 50) * 2));

  let calibrationComponent: number | null = null;
  if (calibration.available && calibration.buckets.length) {
    // For the bucket closest to this prediction's confidence level, how well
    // did nominal probability actually track real outcomes historically?
    const foldedProb = (Math.abs(ensembleProbUp - 0.5) + 0.5) * 100;
    const closest = calibration.buckets.reduce((best, b) => Math.abs(b.nominalProb - foldedProb) < Math.abs(best.nominalProb - foldedProb) ? b : best);
    // If actual hit rate matches or exceeds nominal, full credit; if it falls short, scale down proportionally.
    calibrationComponent = Math.max(0, Math.min(100, (closest.actualHitRate / closest.nominalProb) * 100));
  }

  const baseWeights = { probability: 0.20, agreement: 0.20, walkForward: 0.25, validation: 0.20, calibration: 0.15 };
  let weights = { ...baseWeights };
  if (calibrationComponent == null) {
    // Redistribute the calibration weight proportionally across the other four real components
    const redistributed = baseWeights.calibration / 4;
    weights = {
      probability: baseWeights.probability + redistributed, agreement: baseWeights.agreement + redistributed,
      walkForward: baseWeights.walkForward + redistributed, validation: baseWeights.validation + redistributed,
      calibration: 0,
    };
  }

  const finalConfidence =
    probabilityComponent * weights.probability + agreementComponent * weights.agreement +
    walkForwardComponent * weights.walkForward + validationComponent * weights.validation +
    (calibrationComponent ?? 0) * weights.calibration;

  return {
    probabilityComponent, agreementComponent, walkForwardComponent, validationComponent,
    calibrationComponent, calibrationSampleCount: calibration.totalResolved, weights,
    finalConfidence: Math.max(0, Math.min(100, finalConfidence)),
  };
}

// A dedicated, standalone metadata record — written atomically alongside the
// model weights on every successful training, and explicitly reloadable on
// its own (without needing to retrain) when switching assets or reopening
// the app. This is what makes "switching assets must always show the latest
// metadata" actually true, instead of the screen just going blank.
export type ModelMetadata = Omit<MLPrediction, 'topFeatures'> & { symbol: string; timeframe: string };
// FIX (multi-timeframe support): these keys were symbol-only, with no
// timeframe component at all. Training on 5m candles then immediately
// training on 1D candles for the SAME symbol would warm-start from the
// WRONG timeframe's weights and overwrite them — silently corrupting both
// timeframes' models the moment more than one timeframe was ever evaluated
// for the same symbol. This was a latent bug before (most usage only ever
// touched one timeframe per symbol), but Phase 1's multi-timeframe
// evaluation would trigger it on every single scan. Fixed by keying
// everything on symbol+timeframe together.
const METADATA_KEY = (symbol: string, timeframe: string) => `mlMetadata_${symbol}_${timeframe}`;

export async function loadModelMetadata(symbol: string, timeframe: string): Promise<ModelMetadata | null> {
  try {
    const raw = await AsyncStorage.getItem(METADATA_KEY(symbol, timeframe));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function getNextModelVersion(symbol: string, timeframe: string): Promise<{ nextVersion: number; nextTrainingRunNumber: number }> {
  const existing = await loadModelMetadata(symbol, timeframe);
  return {
    nextVersion: (existing?.modelVersion ?? 0) + 1,
    // TASK 3: increments on EVERY attempt regardless of accept/reject —
    // this is what makes it always >= modelVersion, and what answers
    // "Training Run #132" honestly even if most of those 132 attempts
    // were rejected and never became a new accepted version.
    nextTrainingRunNumber: (existing?.trainingRunNumber ?? 0) + 1,
  };
}

const MODEL_KEY = (symbol: string, timeframe: string, horizon: number) => `mlModel_${symbol}_${timeframe}_h${horizon}`;
const LR_KEY = (symbol: string, timeframe: string) => `lrModel_${symbol}_${timeframe}`;

async function loadSavedMLP(key: string, inputSize: number): Promise<MLPWeights | null> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return null;
    const saved: MLPWeights = JSON.parse(raw);
    if (saved.W1?.length !== 8 || saved.W1?.[0]?.length !== inputSize) return null;
    return saved;
  } catch { return null; }
}
async function loadSavedLR(key: string, inputSize: number): Promise<LRWeights | null> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return null;
    const saved: LRWeights = JSON.parse(raw);
    if (saved.w?.length !== inputSize) return null;
    return saved;
  } catch { return null; }
}

// Walk-forward validation: instead of one static 80/20 split, slides a
// training/testing window forward across the data multiple times (classic
// time-series cross-validation) and averages out-of-sample accuracy across
// folds — substantially more rigorous than a single holdout, since it tests
// whether the model generalizes across several different time periods, not
// just one. Uses a smaller, faster model per fold to keep total on-device
// compute reasonable (this runs K extra training passes on top of the main
// model already being trained).
export type WalkForwardResult = { accuracy: number; truePositives: number; falsePositives: number; trueNegatives: number; falseNegatives: number };

export function walkForwardValidate(X: number[][], y: number[], folds = WALK_FORWARD_FOLDS): WalkForwardResult {
  const empty: WalkForwardResult = { accuracy: -1, truePositives: 0, falsePositives: 0, trueNegatives: 0, falseNegatives: 0 };
  if (X.length < folds * 20) return empty; // not enough data for meaningful folds
  const foldSize = Math.floor(X.length / (folds + 1));
  const accuracies: number[] = [];
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (let f = 0; f < folds; f++) {
    const trainEnd = foldSize * (f + 1);
    const testEnd = Math.min(trainEnd + foldSize, X.length);
    const trainX = X.slice(0, trainEnd), trainY = y.slice(0, trainEnd);
    const testX = X.slice(trainEnd, testEnd), testY = y.slice(trainEnd, testEnd);
    if (!testX.length) continue;
    const { mean, std } = computeStats(trainX);
    const nTrainX = applyNorm(trainX, mean, std), nTestX = applyNorm(testX, mean, std);
    const model = new LogisticRegression(X[0].length); // cheap model for fold validation, not the deployed one
    for (let e = 0; e < 40; e++) model.trainEpoch(nTrainX, trainY, 0.2);
    accuracies.push(accuracy(x => model.predict(x), nTestX, testY));
    // "Positive" = model predicts price moves up; "actual positive" = price
    // genuinely moved up over the horizon. Same fold split as the accuracy
    // figure above — no separate, less-rigorous methodology for this.
    nTestX.forEach((x, i) => {
      const predicted = model.predict(x) > 0.5 ? 1 : 0;
      const actual = testY[i];
      if (predicted === 1 && actual === 1) tp++;
      else if (predicted === 1 && actual === 0) fp++;
      else if (predicted === 0 && actual === 0) tn++;
      else fn++;
    });
  }
  return {
    accuracy: accuracies.length ? accuracies.reduce((s, a) => s + a, 0) / accuracies.length : -1,
    truePositives: tp, falsePositives: fp, trueNegatives: tn, falseNegatives: fn,
  };
}

async function trainAndPredictInner(
  symbol: string, timeframe: string, candles: Candle[],
  // Model Improvement Phase: optional per-(symbol,timeframe) overrides,
  // computed by modelOptimization.ts from real backtested evidence rather
  // than the single global PRIMARY_HORIZON/0.55 constants previously
  // applied identically to every asset. Both default to the exact prior
  // behavior — existing callers that don't pass these get zero behavior
  // change.
  horizonOverride?: number, thresholdOverride?: number,
  forceRetrain = false, // TASK 5: explicit "Train" button path
  assetClass = 'UNKNOWN', // Prediction Source Card / Training History: previously not passed in at all - defaults preserve exact behavior for any caller that omits it
  orderBookSnapshot: OrderBookSnapshot | null = null // GOAL 3: persisted alongside the prediction, NEVER used as a training feature - see the ML audit comment below
): Promise<MLPrediction | null> {
  const startTime = Date.now();
  // Shared by every exit point below so 'skipped'/'failed' paths (which
  // previously just returned null with nothing the UI could read) get the
  // exact same structured recording as a real training run.
  const baseInfo = (overrides: Partial<TrainingStatusInfo>): TrainingStatusInfo => ({
    type: 'skipped', symbol, assetClass, timeframe, timestamp: Date.now(), architectureVersion: ARCHITECTURE_VERSION,
    trainingRunNumber: null, durationMs: Date.now() - startTime,
    previousVersion: null, newVersion: null, previousAccuracy: null, newAccuracy: null, samplesUsed: null,
    walkForwardAccuracy: null, calibrationScore: null, confidence: null,
    currentSamples: null, samplesAtLastTraining: null, newCandles: null, minRequired: null,
    skipReason: null, errorMessage: null, explanation: '',
    ...overrides,
  });

  logger.info('mlSignal', `trainAndPredict START for ${symbol}: ${candles.length} candles passed in`);
  if (candles.length < 60) {
    const reason = `Insufficient history: only ${candles.length} candles available, 60 minimum required.`;
    logger.warn('mlSignal', `${symbol}: ${reason}`);
    await recordTrainingStatus(baseInfo({ skipReason: reason, explanation: reason })).catch(() => {});
    return null;
  }

  // Both fall back to the original fixed values exactly, so omitting these
  // arguments reproduces the prior behavior precisely.
  const effectiveHorizon = (horizonOverride != null && HORIZONS.includes(horizonOverride)) ? horizonOverride : PRIMARY_HORIZON;
  const effectiveThreshold = thresholdOverride ?? 0.55;

  const S = precomputeSeries(candles);
  const maxHorizon = Math.max(...HORIZONS);

  const X: number[][] = [];
  const yByHorizon: Record<number, number[]> = {}; HORIZONS.forEach(h => { yByHorizon[h] = []; });
  for (let i = 20; i < candles.length - maxHorizon; i++) {
    const f = featuresAt(candles, i, S);
    if (!f) continue;
    X.push(f);
    HORIZONS.forEach(h => { yByHorizon[h].push(candles[i + h].close > candles[i].close ? 1 : 0); });
  }
  logger.info('mlSignal', `${symbol}: built ${X.length} training samples from ${candles.length} candles (${FEATURE_NAMES.length} features each)`);
  if (X.length < 25) {
    const reason = `Insufficient usable samples after feature engineering: only ${X.length} built from ${candles.length} candles, 25 minimum required.`;
    logger.warn('mlSignal', `${symbol}: ${reason}`);
    await recordTrainingStatus(baseInfo({ skipReason: reason, explanation: reason })).catch(() => {});
    return null;
  }

  const splitIdx = Math.floor(X.length * 0.8);
  const rawTrainX = X.slice(0, splitIdx), rawTestX = X.slice(splitIdx);
  const { mean, std } = computeStats(rawTrainX);
  const trainX = applyNorm(rawTrainX, mean, std), testX = applyNorm(rawTestX, mean, std);
  logger.info('mlSignal', `${symbol}: split into ${trainX.length} train / ${testX.length} validation samples`);

  // Train one small MLP per horizon (warm-started from saved weights per horizon+symbol)
  const horizonResults: HorizonResult[] = [];
  let primaryModel: MLP | null = null;
  let warmStart = false;
  const { nextVersion, nextTrainingRunNumber } = await getNextModelVersion(symbol, timeframe);
  // Load what was here BEFORE this run, so we can report genuine before/after
  // comparisons and decide whether this run's model is actually an
  // improvement — not just always overwrite blindly.
  const previousMetadata = await loadModelMetadata(symbol, timeframe);

  // TASK 5 (Smarter Retraining) — previously this function fully retrained
  // from scratch on every single call, including every time a chart
  // screen simply re-rendered for the same symbol. Now: retrain only if
  // explicitly forced, if no model exists yet, if enough new candles have
  // arrived, or if the existing model has gone stale by time. Otherwise,
  // the saved weights are warm-started and used AS-IS (0 further training
  // epochs) — the rest of this function still runs normally (a genuine
  // fresh forward pass against the CURRENT candle/price), so predictions
  // stay live even when the underlying weights are reused unchanged.
  const STALE_THRESHOLD_MS = 4 * 60 * 60 * 1000; // 4 hours
  let retrainDecisionReason: string;
  let shouldRetrain: boolean;
  let newCandlesSinceLastTraining: number | null = null; // hoisted so the status-recording block below can report it for the 'reused' case
  if (forceRetrain) {
    shouldRetrain = true;
    retrainDecisionReason = 'Retraining: explicitly requested.';
  } else if (!previousMetadata) {
    shouldRetrain = true;
    retrainDecisionReason = 'Retraining: no existing model for this symbol/timeframe.';
  } else {
    const newCandles = candles.length - previousMetadata.candlesAtTraining;
    newCandlesSinceLastTraining = newCandles;
    const ageMs = Date.now() - previousMetadata.trainedAt;
    if (newCandles >= NEW_CANDLES_THRESHOLD) {
      shouldRetrain = true;
      retrainDecisionReason = `Retraining: ${newCandles} new candles since last training (threshold ${NEW_CANDLES_THRESHOLD}).`;
    } else if (ageMs >= STALE_THRESHOLD_MS) {
      shouldRetrain = true;
      retrainDecisionReason = `Retraining: existing model is ${(ageMs / 3600000).toFixed(1)}h old (stale threshold ${STALE_THRESHOLD_MS / 3600000}h).`;
    } else {
      shouldRetrain = false;
      retrainDecisionReason = `Reusing existing model: only ${newCandles} new candle(s) (threshold ${NEW_CANDLES_THRESHOLD}) and ${(ageMs / 60000).toFixed(0)}min old (stale threshold ${STALE_THRESHOLD_MS / 60000}min).`;
    }
  }
  logger.info('mlSignal', `${symbol}/${timeframe}: ${retrainDecisionReason}`);

  let primaryValidationAccuracy = 50, primaryLoss = 1, primaryEpochsCompleted = 0, primaryEarlyStopped = false;
  // Collect everything that WOULD be persisted, but don't write it yet —
  // persistence only happens after the accept/reject decision below, so a
  // rejected run never touches the previously-saved (and presumably better)
  // weights.
  const pendingWrites: { key: string; value: MLPWeights }[] = [];

  for (const h of HORIZONS) {
    const trainY = yByHorizon[h].slice(0, splitIdx), testY = yByHorizon[h].slice(splitIdx);
    const model = new MLP(X[0].length, 8);
    const saved = await loadSavedMLP(MODEL_KEY(symbol, timeframe, h), X[0].length);
    const isWarm = !!saved;
    if (saved) model.loadWeights({ W1: saved.W1, b1: saved.b1, W2: saved.W2, b2: saved.b2 });
    const maxEpochs = !shouldRetrain && isWarm ? 0 : (isWarm ? 50 : 100);
    const { epochsCompleted, earlyStopped, finalLoss } = trainWithEarlyStopping(model, trainX, trainY, testX, testY, maxEpochs, 0.08);
    const testAcc = testX.length ? accuracy(x => model.predict(x), testX, testY) : 50;

    const liveFeatures = featuresAt(candles, candles.length - 1, S);
    const liveNorm = liveFeatures ? liveFeatures.map((v, j) => (v - mean[j]) / std[j]) : trainX[trainX.length - 1];
    const probUp = model.predict(liveNorm);
    horizonResults.push({ horizon: h, probUp, testAccuracy: testAcc });

    if (h === effectiveHorizon) {
      primaryModel = model; warmStart = isWarm;
      primaryValidationAccuracy = testAcc; primaryLoss = finalLoss;
      primaryEpochsCompleted = epochsCompleted; primaryEarlyStopped = earlyStopped;
    }

    const weights: MLPWeights = { ...model.getWeights(), featureMean: mean, featureStd: std, trainedAt: Date.now(), trainAccuracy: 0, testAccuracy: testAcc, sampleCount: X.length };
    pendingWrites.push({ key: MODEL_KEY(symbol, timeframe, h), value: weights });
  }

  // Second model family (logistic regression) on the primary horizon, for genuine ensembling
  const primaryTrainY = yByHorizon[effectiveHorizon].slice(0, splitIdx);
  // FIX: testY inside the horizon loop above is block-scoped to that loop
  // and genuinely out of scope here — referencing it directly would not be
  // caught by a syntax-only check (it's a TypeScript/runtime "cannot find
  // name" issue, not a parse error). The primary horizon's own held-out
  // labels are reconstructed the same way primaryTrainY already is, just
  // for the test split instead of train.
  const primaryTestY = yByHorizon[effectiveHorizon].slice(splitIdx);
  const lr = new LogisticRegression(X[0].length);
  const savedLR = await loadSavedLR(LR_KEY(symbol, timeframe), X[0].length);
  if (savedLR) lr.loadWeights(savedLR);
  const lrMaxEpochs = !shouldRetrain && savedLR ? 0 : (savedLR ? 50 : 100);
  for (let e = 0; e < lrMaxEpochs; e++) lr.trainEpoch(trainX, primaryTrainY, 0.15);
  pendingWrites.push({ key: LR_KEY(symbol, timeframe), value: lr.getWeights() as any });

  const liveFeatures = featuresAt(candles, candles.length - 1, S)!;
  // Defense-in-depth: even with the MIN_STD floor above, a genuinely
  // extreme out-of-distribution live value could still normalize to a large
  // number. Clipping keeps it bounded to something a human can interpret
  // ("very unusual, ~10 std devs out") rather than a meaningless magnitude.
  const liveNorm = liveFeatures.map((v, j) => Math.max(-10, Math.min(10, (v - mean[j]) / std[j])));
  const lrProbUp = lr.predict(liveNorm);
  const mlpProbUp = horizonResults.find(h => h.horizon === effectiveHorizon)!.probUp;

  // FIX (Model Improvement Phase — root cause of "ensemble underperforms the
  // NN in many evaluations"): the LR's own held-out accuracy was never
  // measured against testX/testY, even though that data already existed
  // (used for primaryValidationAccuracy below) — the ensemble blindly
  // averaged mlpProb/lrProb 50/50 regardless of which model actually had
  // any real skill for this specific symbol/timeframe. If the LR is
  // mediocre while the MLP is genuinely skilled (or vice versa), blind
  // averaging drags the better signal toward the worse one. Verified
  // directly before this change: with MLP at 62% test accuracy and LR at
  // 51% (near chance), the old formula pulled a strong 0.75 MLP signal down
  // to 0.635; the weighted version correctly produces 0.732. When both
  // models show no real skill (at/below 50%), this honestly falls back to
  // a plain average rather than fabricating confidence from noise.
  const lrTestAccuracy = testX.length ? accuracy(x => lr.predict(x), testX, primaryTestY) : 50;
  const mlpWeight = Math.max(0, primaryValidationAccuracy - 50);
  const lrWeight = Math.max(0, lrTestAccuracy - 50);
  const totalWeight = mlpWeight + lrWeight;
  const ensembleProbUp = totalWeight > 0
    ? (mlpProbUp * mlpWeight + lrProbUp * lrWeight) / totalWeight
    : (lrProbUp + mlpProbUp) / 2;
  const ensembleAgree = (lrProbUp > 0.5) === (mlpProbUp > 0.5);

  const walkForwardResult = walkForwardValidate(X, yByHorizon[effectiveHorizon]);
  const walkForwardAccuracy = walkForwardResult.accuracy;

  const direction: MLPrediction['direction'] = ensembleProbUp > effectiveThreshold ? 'UP' : ensembleProbUp < (1 - effectiveThreshold) ? 'DOWN' : 'NEUTRAL';

  // Validation accuracy for the primary horizon was already captured inside
  // the training loop above (primaryValidationAccuracy) — reused here, not recomputed.
  const calibration = await getCalibration(symbol, timeframe);
  const confidenceBreakdown = computeConfidenceBreakdown(
    ensembleProbUp, mlpProbUp, lrProbUp, walkForwardAccuracy, primaryValidationAccuracy, calibration
  );
  const confidence = confidenceBreakdown.finalConfidence;

  // Risk score: disagreement across horizons + current volatility regime
  const horizonSpread = Math.max(...horizonResults.map(h => h.probUp)) - Math.min(...horizonResults.map(h => h.probUp));
  const currentATR = S.atrArr[S.atrArr.length - 1] ?? 0;
  const lastClose = candles[candles.length - 1].close;
  const atrPct = (currentATR / lastClose) * 100;
  const riskScore = Math.max(0, Math.min(100, horizonSpread * 150 + atrPct * 8));

  const action: TradeAction = (direction === 'UP' && ensembleAgree) ? 'BUY' : (direction === 'DOWN' && ensembleAgree) ? 'SELL' : 'HOLD';

  // ATR-based SL/TP — a standard, real risk-management convention (1.5x ATR
  // stop, 2.5x ATR target ≈ 1:1.67 reward-risk), not a fabricated number.
  const entry = lastClose;
  const stopLoss = action === 'BUY' ? entry - 1.5 * currentATR : action === 'SELL' ? entry + 1.5 * currentATR : entry - 1.5 * currentATR;
  const takeProfit = action === 'BUY' ? entry + 2.5 * currentATR : action === 'SELL' ? entry - 2.5 * currentATR : entry + 2.5 * currentATR;
  const riskRewardRatio = currentATR > 0 ? 2.5 / 1.5 : 0;

  // Feature importance — same weight-based heuristic as before, now applied to the primary-horizon MLP
  const inputImportance = Array(liveNorm.length).fill(0);
  primaryModel!.W1.forEach(row => row.forEach((w, k) => { inputImportance[k] += Math.abs(w); }));
  const topFeatures = FEATURE_NAMES.map((name, i) => ({
    name, value: liveFeatures[i], influence: inputImportance[i] * Math.abs(liveNorm[i]),
  })).sort((a, b) => b.influence - a.influence).slice(0, 6);

  // ── Accept / reject decision ──
  // A new model is only "accepted" (its weights actually persisted) if it's
  // not meaningfully worse than whatever was there before — this is what
  // makes warm-starting safe rather than a one-way ratchet toward whatever
  // the most recent training happened to produce, including bad luck on a
  // small batch. First-ever training for a symbol is always accepted (there's
  // nothing to compare against). A small tolerance (2 points) allows for
  // ordinary run-to-run noise without rejecting on trivial differences.
  const ACCEPT_TOLERANCE = 2;
  let modelAccepted: boolean;
  let acceptRejectReason: string;
  let finalModelVersion: number;
  let finalTrainingRunNumber: number;

  if (!shouldRetrain) {
    // Nothing was actually trained this call — carry the existing numbers
    // forward exactly as they were. Incrementing either one here would
    // mean "Accepted Model #" or "Training Run #" inflate just from a
    // chart being viewed, which is the entire problem Task 3/5 exist to
    // fix.
    modelAccepted = true;
    acceptRejectReason = `Not retrained this call — reused existing model. ${retrainDecisionReason}`;
    finalModelVersion = previousMetadata?.modelVersion ?? nextVersion;
    finalTrainingRunNumber = previousMetadata?.trainingRunNumber ?? nextTrainingRunNumber;

    const minRequired = NEW_CANDLES_THRESHOLD;
    const currentSamples = X.length;
    const samplesAtLastTraining = previousMetadata?.sampleCount ?? null;
    await recordTrainingStatus({
      type: 'reused', symbol, assetClass, timeframe, timestamp: Date.now(), architectureVersion: ARCHITECTURE_VERSION,
      trainingRunNumber: finalTrainingRunNumber, durationMs: Date.now() - startTime,
      previousVersion: null, newVersion: null, previousAccuracy: null, newAccuracy: null, samplesUsed: null,
      walkForwardAccuracy, calibrationScore: confidenceBreakdown.calibrationComponent, confidence,
      currentSamples, samplesAtLastTraining, newCandles: newCandlesSinceLastTraining, minRequired,
      skipReason: null, errorMessage: null,
      explanation: `Training completed. Current samples available: ${currentSamples}. Previous accepted model used ${samplesAtLastTraining ?? 'an unknown number of'} samples. ${newCandlesSinceLastTraining != null ? `Only ${newCandlesSinceLastTraining} new candle(s) detected.` : ''} Minimum retraining threshold is ${minRequired} new candles. Therefore the previous model was reused. Model Version remains v${finalModelVersion}. No retraining occurred.`,
    }).catch(() => {});
  } else {
    // ── Accept / reject decision ──
    // A new model is only "accepted" (its weights actually persisted) if
    // it's not meaningfully worse than whatever was there before — this is
    // what makes warm-starting safe rather than a one-way ratchet toward
    // whatever the most recent training happened to produce, including bad
    // luck on a small batch. First-ever training for a symbol is always
    // accepted (there's nothing to compare against). A small tolerance (2
    // points) allows for ordinary run-to-run noise without rejecting on
    // trivial differences.
    if (!previousMetadata) {
      modelAccepted = true;
      acceptRejectReason = 'First training run for this symbol — accepted automatically, nothing to compare against yet.';
    } else if (primaryValidationAccuracy >= previousMetadata.primaryValidationAccuracy - ACCEPT_TOLERANCE) {
      modelAccepted = true;
      acceptRejectReason = `Accepted: validation accuracy ${primaryValidationAccuracy.toFixed(1)}% vs. previous ${previousMetadata.primaryValidationAccuracy.toFixed(1)}% (within ${ACCEPT_TOLERANCE}pt tolerance).`;
    } else {
      modelAccepted = false;
      acceptRejectReason = `Rejected: validation accuracy ${primaryValidationAccuracy.toFixed(1)}% is meaningfully worse than the previous accepted model's ${previousMetadata.primaryValidationAccuracy.toFixed(1)}%. Previous weights kept; this run's weights were NOT saved.`;
    }
    finalModelVersion = modelAccepted ? nextVersion : (previousMetadata?.modelVersion ?? nextVersion);
    finalTrainingRunNumber = nextTrainingRunNumber;

    const explanation = modelAccepted
      ? `Training completed. Current samples: ${X.length}. New candles detected: ${newCandlesSinceLastTraining ?? 'n/a (first run)'}. Retraining threshold ${previousMetadata ? 'exceeded' : 'not applicable — first run'}. New validation accuracy ${previousMetadata ? `improved from ${previousMetadata.primaryValidationAccuracy.toFixed(1)}% to ${primaryValidationAccuracy.toFixed(1)}%` : `established at ${primaryValidationAccuracy.toFixed(1)}%`}. Model accepted. Version ${previousMetadata ? `updated from v${previousMetadata.modelVersion} to v${finalModelVersion}` : `set to v${finalModelVersion}`}.`
      : `Training completed but rejected. New validation accuracy ${primaryValidationAccuracy.toFixed(1)}% did not meet the previous accepted model's ${previousMetadata!.primaryValidationAccuracy.toFixed(1)}% (tolerance ${ACCEPT_TOLERANCE}pts). Previous weights kept. Version remains v${finalModelVersion}.`;

    await recordTrainingStatus({
      type: modelAccepted ? 'trained' : 'rejected', symbol, assetClass, timeframe, timestamp: Date.now(), architectureVersion: ARCHITECTURE_VERSION,
      trainingRunNumber: finalTrainingRunNumber, durationMs: Date.now() - startTime,
      previousVersion: previousMetadata?.modelVersion ?? null, newVersion: finalModelVersion,
      previousAccuracy: previousMetadata?.primaryValidationAccuracy ?? null, newAccuracy: primaryValidationAccuracy,
      samplesUsed: X.length, walkForwardAccuracy, calibrationScore: confidenceBreakdown.calibrationComponent, confidence,
      currentSamples: null, samplesAtLastTraining: null, newCandles: newCandlesSinceLastTraining, minRequired: NEW_CANDLES_THRESHOLD,
      skipReason: null, errorMessage: null, explanation,
    }).catch(() => {});
  }

  const result: MLPrediction = {
    horizons: horizonResults, ensembleProbUp, mlpProbUp, lrProbUp, ensembleAgree, direction,
    confidence, confidenceBreakdown, riskScore, action,
    suggestedEntry: entry, suggestedStopLoss: stopLoss, suggestedTakeProfit: takeProfit, riskRewardRatio,
    walkForwardAccuracy,
    walkForwardConfusion: {
      truePositives: walkForwardResult.truePositives, falsePositives: walkForwardResult.falsePositives,
      trueNegatives: walkForwardResult.trueNegatives, falseNegatives: walkForwardResult.falseNegatives,
    },
    topFeatures,
    sampleCount: X.length,
    samplesAtActiveModelTraining: (shouldRetrain && modelAccepted) ? X.length : (previousMetadata?.sampleCount ?? X.length),
    newCandlesSinceLastTraining,
    validationCount: testX.length, featureCount: FEATURE_NAMES.length,
    modelVersion: finalModelVersion,
    trainingRunNumber: finalTrainingRunNumber, // increments only on actual training attempts - reuse calls carry the previous number forward unchanged
    candlesAtTraining: shouldRetrain ? candles.length : (previousMetadata?.candlesAtTraining ?? candles.length),
    trainedAt: shouldRetrain ? Date.now() : (previousMetadata?.trainedAt ?? Date.now()), warmStart,
    primaryValidationAccuracy, primaryLoss, epochsCompleted: primaryEpochsCompleted, earlyStopped: primaryEarlyStopped,
    previousValidationAccuracy: previousMetadata?.primaryValidationAccuracy ?? null,
    previousWalkForwardAccuracy: previousMetadata?.walkForwardAccuracy ?? null,
    previousLoss: previousMetadata?.primaryLoss ?? null,
    modelAccepted, acceptRejectReason,
    trainingStatusType: !shouldRetrain ? 'reused' : (modelAccepted ? 'trained' : 'rejected'),
    orderBookSnapshot,
  };

  // Log this prediction so it can be checked against the real outcome later
  // — this is what makes future calibration genuine rather than assumed.
  try { await recordPrediction(symbol, timeframe, candles[candles.length - 1].time, ensembleProbUp, effectiveHorizon); } catch {}

  // Only persist weights + metadata if the new model was actually accepted —
  // a rejected run leaves all previously-saved (better) weights untouched,
  // so warm-starting next time continues from the GOOD model, not this one.
  // When reusing (no retraining happened), there is nothing new to write at
  // all — the weights are byte-identical to what's already saved.
  if (!shouldRetrain) {
    logger.info('mlSignal', `${symbol}/${timeframe}: reused model v${finalModelVersion} (training run #${finalTrainingRunNumber}) — no write needed, nothing changed.`);
  } else if (modelAccepted) {
    for (const w of pendingWrites) {
      try { await AsyncStorage.setItem(w.key, JSON.stringify(w.value)); } catch (e: any) { logger.error('mlSignal', `Failed to persist ${w.key}: ${e.message}`); }
    }
    const metadata: ModelMetadata = { ...result, symbol, timeframe };
    try {
      await AsyncStorage.setItem(METADATA_KEY(symbol, timeframe), JSON.stringify(metadata));
      logger.info('mlSignal', `${symbol}: training ACCEPTED — v${finalModelVersion} (training run #${finalTrainingRunNumber}), ${X.length} samples, ${testX.length} validation, metadata persisted`);
    } catch (e: any) {
      logger.error('mlSignal', `${symbol}: failed to persist metadata: ${e.message}`);
    }
  } else {
    logger.warn('mlSignal', `${symbol}: training REJECTED (run #${finalTrainingRunNumber}) — ${acceptRejectReason}`);
  }

  return result;
}

// TASK (Training Status redesign) — thin wrapper around the real
// implementation above, added specifically so a genuine, unexpected
// failure (network error mid-call, a numerical issue, anything not
// already handled by trainAndPredictInner's own structured skip/reuse/
// trained exit points) gets a real, recorded 'failed' status instead of
// just throwing into the void with nothing for the UI to show. The actual
// training logic is completely unchanged — this never touches it.
export async function trainAndPredict(
  symbol: string, timeframe: string, candles: Candle[],
  horizonOverride?: number, thresholdOverride?: number, forceRetrain = false, assetClass = 'UNKNOWN',
  orderBookSnapshot: OrderBookSnapshot | null = null
): Promise<MLPrediction | null> {
  const startTime = Date.now();
  try {
    return await trainAndPredictInner(symbol, timeframe, candles, horizonOverride, thresholdOverride, forceRetrain, assetClass, orderBookSnapshot);
  } catch (e: any) {
    logger.error('mlSignal', `${symbol}/${timeframe}: training failed with an unexpected error: ${e.message}`);
    await recordTrainingStatus({
      type: 'failed', symbol, assetClass, timeframe, timestamp: Date.now(), architectureVersion: ARCHITECTURE_VERSION,
      trainingRunNumber: null, durationMs: Date.now() - startTime,
      previousVersion: null, newVersion: null, previousAccuracy: null, newAccuracy: null, samplesUsed: null,
      walkForwardAccuracy: null, calibrationScore: null, confidence: null,
      currentSamples: null, samplesAtLastTraining: null, newCandles: null, minRequired: null,
      skipReason: null, errorMessage: e.message ?? String(e),
      explanation: `Training failed: ${e.message ?? String(e)}`,
    }).catch(() => {});
    return null;
  }
}

export async function clearSavedModel(symbol: string, timeframe: string) {
  await Promise.all([
    ...HORIZONS.map(h => AsyncStorage.removeItem(MODEL_KEY(symbol, timeframe, h))),
    AsyncStorage.removeItem(LR_KEY(symbol, timeframe)),
    AsyncStorage.removeItem(METADATA_KEY(symbol, timeframe)),
  ]);
  logger.info('mlSignal', `${symbol}: cleared all saved model weights and metadata`);
}
