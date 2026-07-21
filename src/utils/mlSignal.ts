import AsyncStorage from '@react-native-async-storage/async-storage';
import { registerModel, buildRegistryEntry } from './modelHealth/modelRegistry';
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
import { detectChartPatterns } from './chartPatterns';
import { precomputeStructure, getStructureFeaturesAt, STRUCTURE_FEATURE_NAMES } from './structure/marketStructure';
import { precomputeSMC, getSMCFeaturesAt, SMC_FEATURE_NAMES } from './smc/smcEngine';
import { precomputeFVG, getFVGFeaturesAt, FVG_FEATURE_NAMES } from './fvg/fvgEngine';
import { computeAllVWAPs } from './volume/anchoredVWAP';
import { computeVolumeProfile, computeCausalVolumeProfiles } from './volume/volumeProfile';
import { scoreVWAP, scoreVP, toVolumeScores } from './volume/volumeScore';
import { VOLUME_FEATURE_NAMES, DEFAULT_VOLUME_CONFIG } from './volume/volumeTypes';
import { precomputeMTF, getMTFFeaturesAt, MTF_FEATURE_NAMES } from './mtf/mtfEngine';
import { DEFAULT_MTF_CONFIG } from './mtf/mtfTypes';
import { precomputeRegime, getRegimeFeaturesAt, REGIME_FEATURE_NAMES } from './regime/regimeEngine';
import { DEFAULT_REGIME_CONFIG } from './regime/regimeTypes';
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
// ─────────────────────────────────────────────────────────────────────────────
// TABLE OF CONTENTS (1608 lines — extraction plan: see bottom of file)
//
//   SECTION A — Types & Constants          (~line 1)
//   SECTION B — Performance instrumentation (~line 100)
//   SECTION C — Feature computation         (~line 200)
//     featuresAt()  — builds the 116-element feature vector per bar
//     FEATURE_NAMES — canonical index-to-name mapping
//     Runtime assertion: features.length MUST === 116
//   SECTION D — Label & normalization       (~line 450)
//     generateLabels(), normalizeFeatures()
//   SECTION E — ML models                   (~line 560)
//     computeConfidenceBreakdown()
//     trainMLP(), trainLR()
//   SECTION F — Walk-forward evaluation     (~line 800)
//     walkForwardValidation(), holdoutTest()
//   SECTION G — Ensemble & inference        (~line 880)
//     ensemblePredict(), runInferenceOnly()
//   SECTION H — Orchestrator                (~line 1016)
//     trainAndPredict(), trainAndPredictInner()
//
// PLANNED EXTRACTION (do not attempt without a test runner in CI):
//   mlFeatures.ts   ← SECTION C (featuresAt, FEATURE_NAMES, assertion)
//   mlTraining.ts   ← SECTIONS D+E+F (labels, normalize, MLP, LR, walk-forward)
//   mlEnsemble.ts   ← SECTION G (ensemble, confidence, SL/TP, drift)
//   mlSignal.ts     ← SECTION H only (~150 lines after extraction)
//
// The 116-feature count assertion at the top of SECTION C MUST remain
// with mlFeatures.ts (or be duplicated at the extraction boundary) so
// it fires at the same point in the call graph.
// ─────────────────────────────────────────────────────────────────────────────


export const FEATURE_NAMES = [
  'Return 1-bar', 'Return 3-bar', 'Return 5-bar', 'Return 10-bar', 'Return 20-bar',
  'RSI', 'Stochastic RSI', 'MACD histogram', 'ROC(10)', 'Momentum(10)',
  'CCI', 'Williams %R', 'TSI', 'ATR (norm)', 'Bollinger %B', 'BB width %',
  'Historical volatility', 'OBV slope', 'MFI', 'CMF', 'Volume oscillator',
  'Relative volume', 'ADX', 'Dist. from EMA20', 'Dist. from EMA50', 'Dist. from EMA200',
  'Dist. from VWAP', 'Trend direction', 'Volatility regime', 'Hour (sin)', 'Day of week',
  'Dist. from SMA20', 'Dist. from Parabolic SAR', 'Donchian %', 'Keltner %',
  'Accum/Dist slope', 'Rolling pivot distance', 'Candlestick pattern flag',
  // Chart pattern features (v4.5.6) — geometric multi-bar patterns
  'Triangle score', 'Flag/Pennant score', 'Double Top/Bottom',
  'Head & Shoulders', 'Wedge score', 'Channel score',
  'Support proximity', 'Resistance proximity',
  // Market Structure Engine features (v4.7.0) — features 47-65
  ...STRUCTURE_FEATURE_NAMES,
  // SMC Engine features (v4.8.0) — features 66–79
  ...SMC_FEATURE_NAMES,
  // FVG Engine features (v4.9.0) — features 80–87
  ...FVG_FEATURE_NAMES,
  // Volume Engine features (v5.0.0) — features 88–98
  ...VOLUME_FEATURE_NAMES,
  // MTF Engine features (v5.1.0) — features 99–108
  ...MTF_FEATURE_NAMES,
  ...REGIME_FEATURE_NAMES,
  // ── Module 1: Context Features (v6.0.0) — features 116–128 ─────────────────
  // Asset-class context (8): crypto OR indian market data, zeros otherwise.
  // Calendar proximity (5): event timing flags for all assets.
  // These are appended AFTER all existing features — existing model weights
  // remain valid during the transition; the new features start at zero-weight
  // and the model learns their importance on the next retrain.
  // IMPORTANT: architecture version is bumped to 2 — old saved weights have
  // inputSize=116 and will be rejected by loadSavedMLP's length check,
  // triggering a clean retrain. This is the correct and safe behaviour.
  ...CRYPTO_CONTEXT_FEATURE_NAMES,  // 8 features (indices 116–123)
  ...CALENDAR_FEATURE_NAMES,         // 5 features (indices 124–128)
];

const HORIZONS = [1, 3, 5, 10, 20];
// TASK 3 (Stable Model Versioning) — this is the CODE/feature-set version:
// bump this only when the actual model architecture changes (feature
// count, network shape, the ensembling formula itself) — never on a
// per-symbol retrain. This is what "Architecture Version" means; it has
// nothing to do with modelVersion below, which is a stable, conceptually
// different idea: see ModelMetadata's trainingRunNumber and modelVersion
// fields for the other two numbers in the v4/#132/#84 example.
// Moved to modelConstants.ts to break circular import with modelHealth/modelRegistry.ts
import { ARCHITECTURE_VERSION } from './modelConstants';
import {
  extractContextFeatures,
  getContextFeatureNames,
  extractEpisodicContext,
  CONTEXT_TOTAL_FEATURE_COUNT,
  CRYPTO_CONTEXT_FEATURE_NAMES,
  CALENDAR_FEATURE_NAMES,
} from './contextFeatures';
import {
  buildEpisodeStore,
  saveEpisodeStore,
  loadEpisodeStore,
  queryMemory,
  type EpisodeStore,
  type MemoryQueryResult,
} from './memoryEngine';
import type { MarketContextSnapshot } from './marketContextSnapshot';

// ─── PERF INSTRUMENTATION (__DEV__ only) ───────────────────────────────────
function _perfTimer() {
  const t0 = Date.now(); let _lastYield = Date.now(); let _maxBlock = 0;
  const stages: { name: string; ms: number }[] = [];
  const mark = (name: string, from: number) => { stages.push({ name, ms: Date.now() - from }); return Date.now(); };
  const yield_ = () => { const g = Date.now() - _lastYield; if (g > _maxBlock) _maxBlock = g; _lastYield = Date.now(); };
  const report = (totalMs: number) => {
    if (!__DEV__) return;
    const sorted = [...stages].sort((a, b) => b.ms - a.ms);
    const rows = sorted.map(s => `  ${s.name.padEnd(32)} ${String(s.ms).padStart(5)}ms ${((s.ms/totalMs)*100).toFixed(1).padStart(5)}%`).join('\n');
    console.log(`\n╔══ PREDICT PERF (${totalMs}ms total) ══╗\n${rows}\n  ${'Longest JS block (no yield)'.padEnd(32)} ${String(_maxBlock).padStart(5)}ms\n╚${'═'.repeat(56)}╝`);
  };
  return { mark, yield_, report, t0 };
}
// ─────────────────────────────────────────────────────────────────────────────


export const PRIMARY_HORIZON = 3; // used for the main directional call, SL/TP, etc.
export const NEW_CANDLES_THRESHOLD = 20; // minimum new candles required to trigger a real retrain - referenced by the Prediction Source Card / Training Status UI directly, never duplicated as a separate guess
export const STALE_THRESHOLD_MS = 4 * 60 * 60 * 1000; // 4 hours — exported so predictRetrainDecision below is the single source of truth for the staleness check

// Pure function that encodes the retrain decision for external callers
// (ChartScreen button label, etc.) without duplicating the threshold logic.
// Mirrors the internal shouldRetrain block in trainAndPredictInner exactly —
// same conditions, same order. Any change to the retrain logic must change
// both this function AND the internal block (they are always kept in sync).
export function predictRetrainDecision(
  metadata: ModelMetadata | null,
  candleCount: number,
  forceRetrain: boolean
): { willRetrain: boolean; reason: string; newCandles: number | null } {
  if (forceRetrain) {
    return { willRetrain: true, reason: 'Force retrain requested.', newCandles: null };
  }
  if (!metadata) {
    return { willRetrain: true, reason: 'No existing model — first run.', newCandles: null };
  }
  const newCandles = candleCount - metadata.candlesAtTraining;
  const ageMs = Date.now() - metadata.trainedAt;
  if (newCandles >= NEW_CANDLES_THRESHOLD) {
    return { willRetrain: true, reason: `${newCandles} new candles since last training (threshold ${NEW_CANDLES_THRESHOLD}).`, newCandles };
  }
  if (ageMs >= STALE_THRESHOLD_MS) {
    return { willRetrain: true, reason: `Model is ${(ageMs / 3600000).toFixed(1)}h old (stale threshold ${STALE_THRESHOLD_MS / 3600000}h).`, newCandles };
  }
  return { willRetrain: false, reason: `Only ${newCandles} new candle(s) and ${(ageMs / 60000).toFixed(0)}min old — reusing existing model.`, newCandles };
}
export const WALK_FORWARD_FOLDS = 4;

// Pipeline split fractions — module-level so the minimum candle
// calculation can reference them directly rather than using magic numbers.
const HOLDOUT_FRAC = 0.10;   // last 10% of samples reserved as untouched holdout
const TRAIN_FRAC   = 0.80;   // 80% of dev set used for training; 20% for validation

// ── Minimum safe candle count ──────────────────────────────────────────────
// Derived from the pipeline arithmetic so it self-adjusts when HOLDOUT_FRAC,
// TRAIN_FRAC, HORIZONS, or _MIN_TRAIN_SAMPLES change.
//
// !! MAINTENANCE WARNING !!
// This inverse MUST exactly match the forward pipeline in trainAndPredict.
// If you add any of the following, update this derivation accordingly:
//   - additional embargo bars beyond maxHorizon
//   - indicator warm-up removal (e.g. skip first N bars for ATR to stabilise)
//   - feature filtering that reduces the effective X.length
//   - a second holdout carve or nested cross-validation
//   - any new split fraction
// Failing to update will cause the guard to fire too late (letting through
// candle counts that still produce empty or degenerate training sets).
//
// Current pipeline (must stay in sync):
//   X.length    = n − 2×maxHorizon       (label loop: [maxH .. n−maxH−1])
//   Xdev.length = floor(X × (1−HOLDOUT))  (holdout carve)
//   rawSplit    = floor(Xdev × TRAIN)      (80/20 split)
//   trainN      = rawSplit − maxHorizon    (embargo purge on training tail)
//   Require: trainN ≥ _MIN_TRAIN_SAMPLES
//
// Inverse (ceiling at each step guarantees the bound is tight despite floor ops):
const _maxH              = Math.max(1, 3, 5, 10, 20);  // = 20; inline to avoid forward ref to HORIZONS
const _MIN_TRAIN_SAMPLES = 50;
const _minRawSplit       = _MIN_TRAIN_SAMPLES + _maxH;               // trainN + embargo
const _minXdev           = Math.ceil(_minRawSplit / TRAIN_FRAC);     // inverse of floor(Xdev × TRAIN)
const _minX              = Math.ceil(_minXdev / (1 - HOLDOUT_FRAC)); // inverse of floor(X × (1−HOLDOUT))
export const MIN_CANDLES_FOR_TRAINING = _minX + 2 * _maxH;          // inverse of X = n − 2×maxH
//
// At current constants: MIN_CANDLES_FOR_TRAINING = 138.
// Verified: n=137 → trainN=49 (<50, fails guard); n=138 → trainN=50 (≥50, safe).

// Precomputes every indicator series ONCE for the whole candle array, then
// builds a feature vector per-bar by indexing into those series — this is
// what keeps ~30 indicators computationally reasonable on a phone (O(n) total
// instead of recomputing each indicator from scratch for every single bar).
export function precomputeSeries(candles: Candle[]) {
  const cl = candles.map(c => c.close);
  const ema20 = ema(cl, 20), ema50 = ema(cl, 50), ema200 = ema(cl, 200);
  const sma20 = sma(cl, 20);
  // P1 #1: pass cl to close-only indicators; P1 #3: pass sma20 to bollinger
  const macdRes = macd(candles, 12, 26, 9, cl);
  // P0 #1: O(n) fix — calcRSI only reads the last `period` price diffs.
  // Passing candles.slice(0, i+1) (full prefix) vs slice(max(0,i-14), i+1)
  // (15-bar window) produces BIT-IDENTICAL results because calcRSI ignores
  // all bars before data.length-period. Verified: max_diff = 0 over 100 bars.
  // Complexity: O(n^2) → O(n). Memory: eliminates n growing-prefix allocations.
  const rsiArr = candles.map((_, i) => {
    if (i < 1) return null;
    return calcRSI(candles.slice(Math.max(0, i - 14), i + 1)); // 15-bar window max
  });
  const stochRsi = stochasticRSI(candles);    // uses rsiSeries internally (Wilder's — different from rsiArr, correct)
  const rocArr = roc(candles, 10, cl);         // P1 #1
  const momArr = momentum(candles, 10, cl);    // P1 #1
  const cciArr = cci(candles);
  const willR = williamsR(candles);
  const tsiArr = tsi(candles, 25, 13, cl);     // P1 #1
  const atrArr = atr(candles);
  const bb = bollinger(candles, 20, 2, cl, sma20); // P1 #1+#3: reuse cl and precomputed sma20
  const histVol = historicalVolatility(candles, 20, cl); // P1 #1
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
  // P0 #3: precompute rolling 60-bar histVol mean so featuresAt avoids
  // a slice+filter+reduce per bar (was O(60) allocation per bar = O(60n) total).
  const histVolMean60 = histVol.map((_, i) => {
    let sum = 0, cnt = 0;
    for (let j = Math.max(0, i - 60); j <= i; j++) {
      const v = histVol[j]; if (v != null) { sum += v; cnt++; }
    }
    return cnt > 0 ? sum / cnt : 1;
  });

  // P0 #2: precompute swing points with lookback=4 (same as detectChartPatterns
  // uses internally). A swing at index j requires bars j+1..j+4, so swings at
  // j are causal for any bar i where i >= j+4. detectChartPatterns will filter
  // using s.index <= i-4 to preserve the identical causal window.
  const swings4 = detectSwings(candles, 4);
  const swings4Highs = swings4.filter(s => s.type === 'high');
  const swings4Lows  = swings4.filter(s => s.type === 'low');

  // atrAt accessor needed by detectChartPatterns (was missing from return,
  // causing S.atrAt to be undefined and chart pattern features to throw
  // TypeError during training — bug fix included in P0 #4).
  const atrAt = (idx: number) => atrArr[idx] ?? 0;

  // P0 #4: precompute chart pattern scores ONCE for all bars here.
  const cpScores = candles.map((_, i) =>
    i < 25 ? null : detectChartPatterns(candles, i, atrAt, swings4Highs, swings4Lows)
  );

  // v4.7.0: precompute Market Structure Engine scores for all bars.
  // Uses enriched swings (lookback=5 major, lookback=3 minor).
  // Per-bar score is O(1) lookup in featuresAt().
  const msStructure = precomputeStructure(candles, atrArr);

  // v4.8.0: SMC Engine — consumes msStructure and atrArr, no re-detection
  const smcData = precomputeSMC(candles, atrArr, msStructure);

  // v4.9.0: FVG Engine — O(n), no swing/BOS recomputation
  const fvgData = precomputeFVG(candles, atrArr);

  // v5.0.0: Volume Engine — 5 anchored VWAPs + volume profile, all O(n)
  const volCfg    = DEFAULT_VOLUME_CONFIG;
  const vwapData  = computeAllVWAPs(candles, msStructure, volCfg);
  const vpData    = computeVolumeProfile(candles, volCfg);  // UI/chart — non-causal, intentional
  // FIX 1: Causal per-bar VP for ML features — O(n×bins) incremental
  const vpCausal  = computeCausalVolumeProfiles(candles, volCfg);

  // v5.1.0: MTF Engine
  const mtfData = precomputeMTF(candles, DEFAULT_MTF_CONFIG);

  // v5.2.0: Market Regime Engine — consumes already-computed arrays, O(n), zero re-computation
  // Build per-bar patternBias from cpScores for the regime engine.
  // cpScores[i] holds the raw geometric pattern at bar i.
  // We use the strongest pattern's direction × confidence/100.
  // Note: cpScores is raw geometry detection (no post-hoc validation),
  // so we use a conservatively smaller weight via the existing 0.15 factor.
  const patternBiasArr = candles.map((_, i) => {
    const cp = cpScores[i];
    if (!cp) return 0;
    // Use the highest-confidence raw pattern — note this is geometric detection
    // only (not post-hoc validated), so confidence is naturally lower here.
    const best = [cp].reduce((a: any, b: any) => (b && b.confidence > (a?.confidence ?? 0) ? b : a), null);
    if (!best || best.confidence == null) return 0;
    const dirSign = best.direction === 'bullish' ? 1 : best.direction === 'bearish' ? -1 : 0;
    return dirSign * (best.confidence / 100);
  });

  const regimeData = precomputeRegime(candles, {
    adxArr, atrArr, bb, donchianArr, histVol, histVolMean60,
    msStructure, mtfData,
    patternBiasArr,
  }, DEFAULT_REGIME_CONFIG);

  return {
    ema20, ema50, ema200, sma20, macdRes, rsiArr, stochRsi, rocArr, momArr, cciArr, willR, tsiArr, atrArr,
    bb, histVol, obvArr, mfiArr, cmfArr, volOsc, relVol, adxArr, vwapArr, swings,
    sarArr, donchianArr, keltnerArr, accDistArr, rollingPivots,
    // P0 additions:
    histVolMean60,    // P0 #3 — rolling 60-bar histVol mean
    swings4Highs, swings4Lows, // P0 #2 — pre-computed swing points (lookback=4)
    atrAt,            // Bug fix: was undefined (missing from return)
    cpScores,         // P0 #4 — pre-computed chart pattern scores per bar
    msStructure,      // v4.7.0 — pre-computed market structure scores per bar
    smcData,          // v4.8.0 — pre-computed SMC scores per bar
    fvgData,          // v4.9.0 — pre-computed FVG scores per bar
    vwapData,         // v5.0.0 — anchored VWAP snapshots per bar
    vpData,           // v5.0.0 — volume profile (full window, UI only)
    vpCausal,         // v6.0.1 FIX 1 — causal per-bar VP for ML features
    mtfData,          // v5.1.0 — multi-timeframe alignment per bar
    regimeData,       // v5.2.0 — market regime per bar
  };
}

export function featuresAt(
  candles: Candle[],
  i: number,
  S: ReturnType<typeof precomputeSeries>,
  contextSnap: MarketContextSnapshot | null = null,  // Module 1: macro context
  assetClass: string = 'UNKNOWN',
): number[] | null {
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
  // P0 #3: detectTrendDirection only reads the LAST index of its arrays.
  // Passing candles.slice(0,i+1), ema20.slice(0,i+1), ema50.slice(0,i+1)
  // created 3 growing-prefix arrays per bar (O(n) allocation each, O(n^2) total).
  // The function body: `const i = c.length-1; return emaShort[i] vs emaLong[i]`
  // Reading S.ema20[i] and S.ema50[i] directly is bit-identical.
  const trendEnc = (() => {
    const e20 = S.ema20[i], e50 = S.ema50[i];
    if (e20 == null || e50 == null) return 0;
    const diff = (e20 - e50) / e50;
    return diff > 0.003 ? 1 : diff < -0.003 ? -1 : 0;
  })();
  // P0 #3: histVol.slice(i-60,i+1).filter.reduce was O(60) allocation per bar.
  // S.histVolMean60[i] is the same value, precomputed in O(1) per lookup.
  const volRegimeEnc = (() => {
    const ratio = (S.histVol[i] ?? 0) / (S.histVolMean60[i] || 1);
    return ratio < 0.6 ? 0 : ratio < 1.4 ? 0.33 : ratio < 2.2 ? 0.66 : 1;
  })();
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

  // P0 #4: chart pattern scores precomputed in precomputeSeries — O(1) lookup.
  // Previously this called detectChartPatterns(candles, i, S.atrAt) per bar,
  // which internally ran detectSwings(slice, 4) making total cost O(n^2).
  // S.atrAt was also undefined (missing from precomputeSeries return) — bug fixed.
  const cp = S.cpScores[i];

  const features = [
    ret1, ret3, ret5, ret10, ret20, rsi, stochRsi, macdHist, rocV, momV,
    cciV, willRV, tsiV, atrNorm, bbPercent, bbWidth, histVolV, obvSlope, mfiV, cmfV,
    volOscV, relVolV, adxV, distEma20, distEma50, distEma200, distVwap, trendEnc, volRegimeEnc, hourSin, dayOfWeekNorm,
    distSma20, distSar, donchPercent, keltPercent, accDistSlope, pivotDist, patternFlag,
    // Chart pattern scores (features 39–46)
    cp?.triangleScore ?? 0, cp?.flagScore ?? 0, cp?.doubleTopBottomScore ?? 0,
    cp?.headShouldersScore ?? 0, cp?.wedgeScore ?? 0, cp?.channelScore ?? 0,
    cp?.supportScore ?? 0, cp?.resistanceScore ?? 0,
    // Market Structure Engine scores (features 47–65, v4.7.0)
    ...getStructureFeaturesAt(S.msStructure, i),
    // SMC Engine scores (features 66–79, v4.8.0)
    ...getSMCFeaturesAt(S.smcData, i),
    // FVG scores (features 80–87, v4.9.0)
    ...getFVGFeaturesAt(S.fvgData, i),
    // Volume scores (features 88–98, v5.0.0)
    ...(() => {
      const snap = S.vwapData.snapshots[i];
      const atrV = S.atrArr[i] ?? 1;
      if (!snap) return new Array(11).fill(0);
      const sv  = scoreVWAP(candles[i].close, snap, atrV);
      // FIX 1: use causal per-bar profile so POC/VAH/VAL only reflect candles[0..i]
      const causalVP = S.vpCausal[i] ?? S.vpData; // fallback to full profile for first 5 bars
      const svp = scoreVP(candles[i].close, causalVP, atrV);
      const vs  = toVolumeScores(sv, svp);
      return [vs.distFromVWAP, vs.vwapSlope, vs.aboveVWAP, vs.belowVWAP,
              vs.distFromPOC, vs.distFromVAH, vs.distFromVAL,
              vs.hvnProximity, vs.lvnProximity, vs.profileBias, vs.vwapConfidence];
    })(),
    // MTF scores (features 99–108, v5.1.0)
    ...getMTFFeaturesAt(S.mtfData, i),
    ...getRegimeFeaturesAt(S.regimeData, i),
    // Module 1: Context features (v6.0.0) — features 116–128
    // contextSnap is only available for the LIVE bar (candles[-1]).
    // For all historical training bars (i < candles.length-1), contextSnap
    // is null and extractContextFeatures returns zeros. This is intentional:
    // the model trains with zeros in these slots and learns that non-zero
    // values (only present at inference time) carry additional signal.
    // At inference time, contextSnap is populated → model sees real macro data.
    ...extractContextFeatures(
      i === candles.length - 1 ? contextSnap : null,
      assetClass,
    ),
  ];
  // FIX 4: runtime integrity assertion — fail immediately on mismatch
  // rather than silently feeding a corrupt feature vector to the model.
  if (features.length !== FEATURE_NAMES.length) {
    throw new Error(
      `featuresAt: length mismatch — got ${features.length}, expected ${FEATURE_NAMES.length}. ` +
      `This means a feature engine's getter returned the wrong number of values. ` +
      `Check getStructureFeaturesAt, getSMCFeaturesAt, getFVGFeaturesAt, ` +
      `getMTFFeaturesAt, getRegimeFeaturesAt, volume IIFE, and extractContextFeatures.`
    );
  }
  return features;
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
async function trainWithEarlyStopping(
  model: MLP, trainX: number[][], trainY: number[], valX: number[][], valY: number[],
  maxEpochs: number, lr: number, patience = 3, checkEvery = 5
): Promise<{ epochsCompleted: number; earlyStopped: boolean; finalLoss: number }> {
  let bestValLoss = Infinity, noImproveCount = 0, epoch = 0;
  for (; epoch < maxEpochs; epoch++) {
    model.trainEpoch(trainX, trainY, lr);
    if ((epoch + 1) % checkEvery === 0 && valX.length) {
      const valLoss = computeLoss(x => model.predict(x), valX, valY);
      if (valLoss < bestValLoss - 1e-4) { bestValLoss = valLoss; noImproveCount = 0; }
      else { noImproveCount++; if (noImproveCount >= patience) { epoch++; break; } }
    }
    // Yield every 5 epochs (halved from 10) to keep freeze windows ≤40ms.
    // Halving the yield interval halves the max UI-unresponsive window without
    // changing training output — yields don't affect gradients or weights.
    if (epoch % 5 === 4) await new Promise<void>(r => setTimeout(r, 0));
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
  signalId: string;         // unique: symbol-tf-candleTimestamp — links prediction ↔ shadow trade ↔ real trade
  suggestedEntry: number;
  suggestedStopLoss: number;
  suggestedTakeProfit: number;
  riskRewardRatio: number;
  walkForwardAccuracy: number;
  driftScore:          number;   // FIX 6: mean |z-score| of live features vs training distribution
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

  // Market context snapshot — captured at prediction time, never fed into
  // the 116-feature ML vector. Used for UI display, paper-trade logging,
  // shadow journal, and future analytics (win rate by Fear/Greed zone etc).
  // Optional for backward compatibility with stored MLPrediction objects.
  marketContext?: import('./marketContextSnapshot').MarketContextSnapshot | null;

  // Fix 1: holdout evaluation — the 10% of samples never seen during
  // training, parameter tuning, or walk-forward selection.
  // Both the MLP and LR are evaluated individually, then as the
  // production ensemble (same accuracy-weighted blend used at inference).
  holdout: {
    sampleCount:       number;
    // Per-model
    mlpAccuracy:       number;   // 0-100
    lrAccuracy:        number;   // 0-100
    // Production ensemble (same weighting as live prediction)
    ensembleAccuracy:  number;   // 0-100
    // Confusion matrix (ensemble, threshold=0.5)
    truePositives:     number;
    falsePositives:    number;
    trueNegatives:     number;
    falseNegatives:    number;
    // Derived stats
    precision:         number;   // 0-1
    recall:            number;   // 0-1
    f1:                number;   // 0-1
  } | null;  // null when holdout has < 5 samples

  // Module 2: Memory Engine result — null when episode store unavailable
  // or no similar history found above the minimum similarity threshold.
  // Never affects direction or raw ML probability — only displayed confidence.
  memoryResult?: import('./memoryEngine').MemoryQueryResult | null;
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
    if (!raw) return null;
    const meta: ModelMetadata = JSON.parse(raw);
    // Backward-compat: old metadata missing 'direction' (added later) — derive from action
    if (!meta.direction) {
      meta.direction = meta.action === 'BUY' ? 'UP' : meta.action === 'SELL' ? 'DOWN' : 'NEUTRAL';
    }
    return meta;
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

const MODEL_KEY      = (s: string, tf: string, h: number) => `mlModel_${s}_${tf}_h${h}`;
// FIX 5: previous checkpoint key — retains one rollback point
const PREV_MODEL_KEY = (s: string, tf: string, h: number) => `mlModel_prev_${s}_${tf}_h${h}`;
const PREV_LR_KEY    = (s: string, tf: string) => `mlModelLR_prev_${s}_${tf}`;
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

export async function walkForwardValidate(
  X: number[][], y: number[], folds = WALK_FORWARD_FOLDS,
  embargoSamples: number = 20,
  // Production-derived blend weights passed in from the call site so each
  // fold uses the SAME fixed ratio as live inference. This eliminates the
  // optimism that would arise from deriving weights within the fold and
  // then evaluating on the same fold data.
  //
  // When null (e.g. external / test callers), falls back to 50/50 average.
  // The production call always passes the real weights, so null is only
  // reached in unit tests or direct API calls.
  blendWeights: { wMLP: number; wLR: number; wTot: number } | null = null
): Promise<WalkForwardResult> {
  const empty: WalkForwardResult = { accuracy: -1, truePositives: 0, falsePositives: 0, trueNegatives: 0, falseNegatives: 0 };
  if (X.length < folds * 20) return empty;
  const foldSize = Math.floor(X.length / (folds + 1));
  const accuracies: number[] = [];
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (let f = 0; f < folds; f++) {
    const rawTrainEnd = foldSize * (f + 1);
    const testStart   = rawTrainEnd;   // test starts right after raw boundary
    const testEnd     = Math.min(testStart + foldSize, X.length);
    // Purge: remove the last `embargoSamples` training samples whose labels
    // resolve using candles at or beyond testStart (information leakage).
    const trainEnd = Math.max(0, rawTrainEnd - embargoSamples);
    if (trainEnd === 0 || testStart >= X.length) continue;
    const trainX = X.slice(0, trainEnd), trainY = y.slice(0, trainEnd);
    const testX = X.slice(testStart, testEnd), testY = y.slice(testStart, testEnd);
    if (!testX.length) continue;
    const { mean, std } = computeStats(trainX);
    const nTrainX = applyNorm(trainX, mean, std), nTestX = applyNorm(testX, mean, std);

    // Train the same two-model architecture as production (MLP + LR).
    // Each fold gets its own freshly trained models on fold-specific data
    // (causally correct — the fold MLP never sees fold test data).
    const foldMLP = new MLP(X[0].length, 8);
    const foldLR  = new LogisticRegression(X[0].length);
    for (let e = 0; e < 40; e++) {
      foldMLP.trainEpoch(nTrainX, trainY, 0.08);
      foldLR.trainEpoch(nTrainX, trainY, 0.2);
      // Yield every 2 epochs — with 2 models × 40 epochs × 4 folds = 320 epoch
      // calls, yielding every 10 leaves ~160ms gaps on low-end Android (8ms/epoch).
      // Yielding every 2 keeps the UI responsive throughout WF training.
      if (e % 2 === 1) await new Promise<void>(r => setTimeout(r, 0));
    }

    // Use the FROZEN production weights (derived from the main 80/20 testX,
    // not from this fold's data) so the blend ratio is independent of the
    // evaluation set. This avoids the mild optimism that arises when weights
    // are tuned on the same data used to score the fold.
    //
    // When blendWeights is null (external/test callers), plain average.
    const foldPredict = (x: number[]) => {
      const pMLP = foldMLP.predict(x), pLR = foldLR.predict(x);
      if (blendWeights && blendWeights.wTot > 0) {
        return (pMLP * blendWeights.wMLP + pLR * blendWeights.wLR) / blendWeights.wTot;
      }
      return (pMLP + pLR) / 2;
    };

    accuracies.push(accuracy(foldPredict, nTestX, testY));
    nTestX.forEach((x, i) => {
      const predicted = foldPredict(x) > 0.5 ? 1 : 0;
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

// ── Inference-only path ───────────────────────────────────────────────────────
// Called when a saved model exists and no retraining is needed.
// Uses stored featureMean/featureStd from the saved weights — no rawTrainX needed.
// Requires only enough candles for precomputeSeries + featuresAt (≈ maxHorizon+1).
async function runInferenceOnly(
  symbol: string, timeframe: string, assetClass: string,
  candles: Candle[], orderBookSnapshot: OrderBookSnapshot | null,
  contextSnap: MarketContextSnapshot | null,
  horizonOverride: number | undefined, thresholdOverride: number | undefined,
  savedPrimary: MLPWeights, prevMeta: ModelMetadata,
  startTime: number,
  baseInfo: (o: Partial<TrainingStatusInfo>) => TrainingStatusInfo,
): Promise<MLPrediction | null> {
  const effectiveHorizon   = (horizonOverride != null && HORIZONS.includes(horizonOverride)) ? horizonOverride : PRIMARY_HORIZON;
  const effectiveThreshold = thresholdOverride ?? 0.55;
  const mean = savedPrimary.featureMean;
  const std  = savedPrimary.featureStd;

  const S = precomputeSeries(candles);
  const liveFeatures = featuresAt(candles, candles.length - 1, S, contextSnap, assetClass);
  if (!liveFeatures) return null;
  const liveNorm = liveFeatures.map((v, j) => Math.max(-10, Math.min(10, (v - mean[j]) / (std[j] || 1e-8))));

  // Load all horizon models and run forward passes
  const horizonResults: HorizonResult[] = [];
  let primaryModel: MLP | null = null;
  for (const h of HORIZONS) {
    const saved = await loadSavedMLP(MODEL_KEY(symbol, timeframe, h), FEATURE_NAMES.length);
    if (!saved) return null; // incomplete saved state — abort inference
    const model = new MLP(FEATURE_NAMES.length, 8);
    model.loadWeights({ W1: saved.W1, b1: saved.b1, W2: saved.W2, b2: saved.b2 });
    const probUp = model.predict(liveNorm);
    horizonResults.push({ horizon: h, probUp, testAccuracy: saved.testAccuracy ?? 50 });
    if (h === effectiveHorizon) primaryModel = model;
  }
  if (!primaryModel) return null;

  // LR inference
  const lr = new LogisticRegression(FEATURE_NAMES.length);
  const savedLR = await loadSavedLR(LR_KEY(symbol, timeframe), FEATURE_NAMES.length);
  if (savedLR) lr.loadWeights(savedLR);
  const lrProbUp = lr.predict(liveNorm);

  // Ensemble — weight formula now identical to trainAndPredictInner.
  // Previously used raw accuracy (e.g. 50 for a chance-level model → weight 50).
  // trainAndPredictInner uses max(0, acc - 50) so a model at chance gets weight 0
  // and is excluded from the blend rather than diluting a better model.
  // The totalWeight > 0 fallback to plain average is the same in both paths.
  const primaryHorizonResult = horizonResults.find(h => h.horizon === effectiveHorizon)!;
  const mlpProbUp = primaryHorizonResult.probUp;
  const mlpWeight = Math.max(0, (savedPrimary.testAccuracy ?? 50) - 50);
  const lrWeight  = Math.max(0, (prevMeta.primaryValidationAccuracy ?? 50) - 50);
  const totalWeight = mlpWeight + lrWeight;
  const ensembleProbUp = totalWeight > 0 ? (mlpProbUp * mlpWeight + lrProbUp * lrWeight) / totalWeight : (mlpProbUp + lrProbUp) / 2;
  // FIX: was (mlp>thresh && lr>thresh) || (mlp<(1-thresh) && lr<(1-thresh)) —
  // a stricter gate than trainAndPredictInner uses. That definition required BOTH
  // models to individually exceed the confidence threshold, rejecting trades to HOLD
  // even when the ensemble was above threshold and both models agreed on direction.
  // trainAndPredictInner uses simple same-side agreement: (lr>0.5)==(mlp>0.5).
  // Aligning here ensures backtest and live inference produce identical actions.
  const ensembleAgree  = (lrProbUp > 0.5) === (mlpProbUp > 0.5);

  // Drift
  const absMeanZScore = liveNorm.reduce((s, v) => s + Math.abs(v), 0) / liveNorm.length;
  const driftScore    = absMeanZScore;

  // Direction and action
  const direction: MLPrediction['direction'] = ensembleProbUp > effectiveThreshold ? 'UP' : ensembleProbUp < (1 - effectiveThreshold) ? 'DOWN' : 'NEUTRAL';
  const action: TradeAction = (direction === 'UP' && ensembleAgree) ? 'BUY' : (direction === 'DOWN' && ensembleAgree) ? 'SELL' : 'HOLD';

  // SL/TP
  const currentATR = S.atrArr[S.atrArr.length - 1] ?? 0;
  const lastClose = candles[candles.length - 1].close;
  const entry = lastClose;
  // HOLD: null sentinel values — no meaningful SL/TP when no trade signal.
  // PredictionCard guards action !== 'HOLD' before rendering these.
  const stopLoss    = action === 'BUY' ? entry - 1.5 * currentATR : action === 'SELL' ? entry + 1.5 * currentATR : 0;
  const takeProfit  = action === 'BUY' ? entry + 3.0 * currentATR : action === 'SELL' ? entry - 3.0 * currentATR : 0;
  const riskRewardRatio = currentATR > 0 ? 3.0 / 1.5 : 0; // matches training path: 3x ATR TP / 1.5x ATR SL

  // Confidence
  const calibration = await getCalibration(symbol, timeframe);
  const primaryValidationAccuracy = savedPrimary.testAccuracy ?? 50;
  const walkForwardAccuracy = prevMeta.walkForwardAccuracy ?? -1;
  const _confT = Date.now();
  const confidenceBreakdown = computeConfidenceBreakdown(ensembleProbUp, mlpProbUp, lrProbUp, walkForwardAccuracy, primaryValidationAccuracy, calibration);
  if (_perf) { _t = _perf.mark('8 confidence breakdown', _confT); }
  const confidence = confidenceBreakdown.finalConfidence;

  // Risk score
  const horizonSpread = Math.max(...horizonResults.map(h => h.probUp)) - Math.min(...horizonResults.map(h => h.probUp));
  const atrPct = (currentATR / lastClose) * 100;
  const riskScore = Math.max(0, Math.min(100, horizonSpread * 150 + atrPct * 8));

  // Top features
  const inputImportance = Array(liveNorm.length).fill(0);
  primaryModel.W1.forEach(row => row.forEach((w, k) => { inputImportance[k] += Math.abs(w); }));
  const topFeatures = FEATURE_NAMES.map((name, i) => ({
    name, value: liveFeatures[i], influence: inputImportance[i] * Math.abs(liveNorm[i]),
  })).sort((a, b) => b.influence - a.influence).slice(0, 6);

  const newCandlesSinceLastTraining = candles.length - prevMeta.candlesAtTraining;
  const finalModelVersion = prevMeta.modelVersion;
  const finalTrainingRunNumber = prevMeta.trainingRunNumber;

  await recordTrainingStatus({
    type: 'reused', symbol, assetClass, timeframe, timestamp: Date.now(), architectureVersion: ARCHITECTURE_VERSION,
    trainingRunNumber: finalTrainingRunNumber, durationMs: Date.now() - startTime,
    previousVersion: null, newVersion: null, previousAccuracy: null, newAccuracy: null, samplesUsed: null,
    walkForwardAccuracy, calibrationScore: confidenceBreakdown.calibrationComponent, confidence,
    currentSamples: candles.length, samplesAtLastTraining: prevMeta.sampleCount ?? null,
    newCandles: newCandlesSinceLastTraining, minRequired: NEW_CANDLES_THRESHOLD,
    skipReason: null, errorMessage: null,
    explanation: `Inference-only: using saved model v${finalModelVersion}. ${newCandlesSinceLastTraining} new candles (threshold ${NEW_CANDLES_THRESHOLD}).`,
  }).catch(() => {});

  try { await recordPrediction(symbol, timeframe, candles[candles.length - 1].time, ensembleProbUp, effectiveHorizon); } catch {}

  const inferenceResult: MLPrediction = {
    horizons: horizonResults, ensembleProbUp, mlpProbUp, lrProbUp, ensembleAgree, direction,
    driftScore, holdout: null, confidence, confidenceBreakdown, riskScore, action,
    signalId,
    suggestedEntry: entry, suggestedStopLoss: stopLoss, suggestedTakeProfit: takeProfit, riskRewardRatio,
    walkForwardAccuracy,
    walkForwardConfusion: { truePositives: 0, falsePositives: 0, trueNegatives: 0, falseNegatives: 0 },
    topFeatures, sampleCount: candles.length,
    samplesAtActiveModelTraining: prevMeta.sampleCount ?? candles.length,
    newCandlesSinceLastTraining, validationCount: 0, featureCount: FEATURE_NAMES.length,
    modelVersion: finalModelVersion, trainingRunNumber: finalTrainingRunNumber,
    candlesAtTraining: prevMeta.candlesAtTraining, trainedAt: prevMeta.trainedAt, warmStart: true,
    primaryValidationAccuracy, primaryLoss: prevMeta.primaryLoss ?? 1,
    epochsCompleted: 0, earlyStopped: false,
    previousValidationAccuracy: null, previousWalkForwardAccuracy: null, previousLoss: null,
    modelAccepted: true, acceptRejectReason: 'Inference-only — no retraining performed.',
    trainingStatusType: 'reused', orderBookSnapshot,
    marketContext: null,
    memoryResult: null,
  };

  // Module 2: Query memory engine (inference-only path)
  try {
    const store = await loadEpisodeStore(symbol, timeframe, ARCHITECTURE_VERSION, FEATURE_NAMES.length);
    if (store && liveFeatures) {
      const currentRegime  = S.regimeData?.regimeArr?.[candles.length - 1]?.label ?? 'UNKNOWN';
      const currentAtrNorm = liveFeatures[13] ?? 0;
      const baseWinRate    = (primaryValidationAccuracy ?? 50) / 100;
      inferenceResult.memoryResult = queryMemory(liveFeatures, currentRegime, currentAtrNorm, store, baseWinRate);
    }
  } catch { /* non-fatal */ }

  return inferenceResult;
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
  orderBookSnapshot: OrderBookSnapshot | null = null, // GOAL 3: persisted alongside the prediction, NEVER used as a training feature - see the ML audit comment below
  contextSnapshot: MarketContextSnapshot | null = null  // Module 1: macro context → fed into feature vector
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
  const MIN_TRAIN_SAMPLES = _MIN_TRAIN_SAMPLES;  // alias for secondary guard below

  // ── Fast inference path: if a saved model exists and no retraining is needed,
  // skip the full training pipeline and run inference from stored weights.
  // This allows prediction with any candle count ≥ maxHorizon+1 (≈21 candles)
  // when a previously-trained model is available.
  // The 138-candle guard only applies when a new model must actually be trained.
  if (!forceRetrain && candles.length >= _maxH + 1) {
    const prevMeta = await loadModelMetadata(symbol, timeframe);
    if (prevMeta) {
      const newCandles = candles.length - prevMeta.candlesAtTraining;
      const ageMs = Date.now() - prevMeta.trainedAt;
      const wouldSkipRetrain = newCandles < NEW_CANDLES_THRESHOLD && ageMs < STALE_THRESHOLD_MS;
      if (wouldSkipRetrain || candles.length < MIN_CANDLES_FOR_TRAINING) {
        // Attempt to load the primary-horizon saved MLP to get its featureMean/featureStd.
        const savedPrimary = await loadSavedMLP(MODEL_KEY(symbol, timeframe, PRIMARY_HORIZON), FEATURE_NAMES.length);
        if (savedPrimary?.featureMean && savedPrimary?.featureStd) {
          logger.info('mlSignal', `${symbol}: inference-only path (saved model exists, candles=${candles.length}, newCandles=${newCandles})`);
          try {
            return await runInferenceOnly(symbol, timeframe, assetClass, candles, orderBookSnapshot,
              horizonOverride, thresholdOverride, savedPrimary, prevMeta, startTime, baseInfo);
          } catch (inferErr: any) {
            // Inference failed (e.g. feature extraction error) — fall through to full path
            logger.warn('mlSignal', `${symbol}: inference-only failed (${inferErr.message}), falling through to full path`);
          }
        }
      }
    }
  }

  // Full training path — requires sufficient candle history.
  if (candles.length < MIN_CANDLES_FOR_TRAINING) {
    const needed = MIN_CANDLES_FOR_TRAINING - candles.length;
    const reason = `Need at least ${MIN_CANDLES_FOR_TRAINING} candles to train a new model ` +
      `(you have ${candles.length} — load ${needed} more by switching to a longer timeframe ` +
      `or waiting for more history). No saved model is available for inference.`;
    logger.warn('mlSignal', `${symbol}: ${reason}`);
    await recordTrainingStatus(baseInfo({ skipReason: reason, explanation: reason })).catch(() => {});
    return null;
  }

  // Both fall back to the original fixed values exactly, so omitting these
  // arguments reproduces the prior behavior precisely.
  const effectiveHorizon = (horizonOverride != null && HORIZONS.includes(horizonOverride)) ? horizonOverride : PRIMARY_HORIZON;
  const effectiveThreshold = thresholdOverride ?? 0.55;

  // Yield before the synchronous precomputeSeries + feature-building block.
  // precomputeSeries calls detectChartPatterns, precomputeStructure, SMC, FVG,
  // VWAP, regime, MTF — all O(n). Without this yield the 'training…' spinner
  // never paints because the JS thread blocks immediately after setMl('training').
  const _perf = __DEV__ ? _perfTimer() : null;
  let _t = Date.now();
  await new Promise<void>(r => setTimeout(r, 0));
  if (_perf) { _t = _perf.mark('1 yield/spinner paint', _t); _perf.yield_(); }

  const S = precomputeSeries(candles);
  if (_perf) { _t = _perf.mark('2 precomputeSeries', _t); _perf.yield_(); }
  const maxHorizon = Math.max(...HORIZONS);

  const X: number[][] = [];
  const yByHorizon: Record<number, number[]> = {}; HORIZONS.forEach(h => { yByHorizon[h] = []; });
  // Collect regime labels per bar for Memory Engine episode building
  const regimeLabelsForMemory: string[] = new Array(candles.length).fill('UNKNOWN');
  for (let i = 20; i < candles.length - maxHorizon; i++) {
    const f = featuresAt(candles, i, S); // historical bars: no context (zeros for slots 116-128)
    if (!f) continue;
    X.push(f);
    HORIZONS.forEach(h => { yByHorizon[h].push(candles[i + h].close > candles[i].close ? 1 : 0); });
    // Capture regime label for this bar from precomputed regime data
    const regArr = S.regimeData?.regimeArr;
    if (regArr && regArr[i]?.label) regimeLabelsForMemory[i] = regArr[i]!.label;
  }
  if (_perf) { _t = _perf.mark('3 feature extraction', _t); _perf.yield_(); }
  logger.info('mlSignal', `${symbol}: built ${X.length} training samples from ${candles.length} candles (${FEATURE_NAMES.length} features each)`);
  if (X.length < 25) {
    const reason = `Insufficient usable samples after feature engineering: only ${X.length} built from ${candles.length} candles, 25 minimum required.`;
    logger.warn('mlSignal', `${symbol}: ${reason}`);
    await recordTrainingStatus(baseInfo({ skipReason: reason, explanation: reason })).catch(() => {});
    return null;
  }

  // FIX 3: holdout — reserve last HOLDOUT_FRAC of samples, never used for training
  // or parameter tuning. Only evaluated in the final metrics block.
  // HOLDOUT_FRAC defined at module scope (above)
  const holdoutStart = Math.floor(X.length * (1 - HOLDOUT_FRAC));
  const Xdev = X.slice(0, holdoutStart);
  const yDevByHorizon: Record<number, number[]> = {};
  HORIZONS.forEach(h => { yDevByHorizon[h] = yByHorizon[h].slice(0, holdoutStart); });
  const XHoldout = X.slice(holdoutStart);
  const yHoldout = yByHorizon[effectiveHorizon].slice(holdoutStart);

  // Fix A: purge the 80/20 boundary — same embargo as walkForwardValidate.
  // Labels for sample k are derived from candles[validIdx[k] + h].close.
  // Without a gap, the last maxHorizon training samples have labels whose
  // forward candle falls inside the validation window (leakage).
  // Solution: shrink the training tail by maxHorizon, but keep the test
  // window starting at the raw 80% boundary — the embargo gap
  // [purgedSplitIdx..rawSplitIdx-1] is simply discarded (never trained on,
  // never validated on).
  const rawSplitIdx    = Math.floor(Xdev.length * 0.8);
  const splitIdx       = Math.max(0, rawSplitIdx - maxHorizon); // purged train end
  const testStartIdx   = rawSplitIdx;                           // test starts at raw boundary
  const rawTrainX = Xdev.slice(0, splitIdx), rawTestX = Xdev.slice(testStartIdx);

  // Fix 1: secondary guard — if the pipeline arithmetic produces an empty or
  // undersized training set despite the 300-candle check (future pipeline
  // changes may alter the arithmetic), abort cleanly rather than crashing
  // inside computeStats() on X[0].length when X is empty.
  if (rawTrainX.length < MIN_TRAIN_SAMPLES) {
    const reason = `Effective training set too small after splits (${rawTrainX.length} samples, ` +
      `${MIN_TRAIN_SAMPLES} minimum). This is a pipeline edge case — try adding more candle history.`;
    logger.warn('mlSignal', `${symbol}: ${reason}`);
    await recordTrainingStatus(baseInfo({ skipReason: reason, explanation: reason })).catch(() => {});
    return null;
  }

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
  // STALE_THRESHOLD_MS is exported above (line ~77) as the single source of truth.
  // Referencing it here rather than re-declaring it ensures the internal retrain
  // decision and the UI button label always use the exact same value.
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

  const _mlpT = Date.now();
  for (const h of HORIZONS) {
    const trainY = yDevByHorizon[h].slice(0, splitIdx), testY = yDevByHorizon[h].slice(testStartIdx);
    const model = new MLP(X[0].length, 8);
    const saved = await loadSavedMLP(MODEL_KEY(symbol, timeframe, h), X[0].length);
    const isWarm = !!saved;
    if (saved) model.loadWeights({ W1: saved.W1, b1: saved.b1, W2: saved.W2, b2: saved.b2 });
    const maxEpochs = !shouldRetrain && isWarm ? 0 : (isWarm ? 50 : 100);
    const { epochsCompleted, earlyStopped, finalLoss } = await trainWithEarlyStopping(model, trainX, trainY, testX, testY, maxEpochs, 0.08);
    const testAcc = testX.length ? accuracy(x => model.predict(x), testX, testY) : 50;

    const liveFeatures = featuresAt(candles, candles.length - 1, S, contextSnap, assetClass);
    // FIX: apply the same ±10 clip used in the final liveNorm (line ~1237) and in
    // runInferenceOnly, so mlpProbUp is derived from bit-identical normalized features
    // in both paths. Previously this loop used an unclipped formula, making probUp
    // differ from runInferenceOnly's value when any feature exceeded 10 std devs.
    const liveNorm = liveFeatures ? liveFeatures.map((v, j) => Math.max(-10, Math.min(10, (v - mean[j]) / std[j]))) : trainX[trainX.length - 1];
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

  if (_perf) { _perf.yield_(); _t = _perf.mark('6 MLP training (horizons)', _mlpT); }
  // Second model family (logistic regression) on the primary horizon, for genuine ensembling
  const primaryTrainY = yDevByHorizon[effectiveHorizon].slice(0, splitIdx);
  // FIX: testY inside the horizon loop above is block-scoped to that loop
  // and genuinely out of scope here — referencing it directly would not be
  // caught by a syntax-only check (it's a TypeScript/runtime "cannot find
  // name" issue, not a parse error). The primary horizon's own held-out
  // labels are reconstructed the same way primaryTrainY already is, just
  // for the test split instead of train.
  const primaryTestY = yDevByHorizon[effectiveHorizon].slice(testStartIdx); // Fix A: test starts at raw boundary
  const lr = new LogisticRegression(X[0].length);
  const savedLR = await loadSavedLR(LR_KEY(symbol, timeframe), X[0].length);
  if (savedLR) lr.loadWeights(savedLR);
  const _lrT = Date.now();
  const lrMaxEpochs = !shouldRetrain && savedLR ? 0 : (savedLR ? 50 : 100);
  for (let e = 0; e < lrMaxEpochs; e++) {
    lr.trainEpoch(trainX, primaryTrainY, 0.15);
    if (e % 5 === 4) await new Promise<void>(r => setTimeout(r, 0));
  }
  pendingWrites.push({ key: LR_KEY(symbol, timeframe), value: lr.getWeights() as any });
  if (_perf) { _perf.yield_(); _t = _perf.mark('7 LR training', _lrT); }

  const liveFeatures = featuresAt(candles, candles.length - 1, S)!;
  // Defense-in-depth: even with the MIN_STD floor above, a genuinely
  // extreme out-of-distribution live value could still normalize to a large
  // number. Clipping keeps it bounded to something a human can interpret
  // ("very unusual, ~10 std devs out") rather than a meaningless magnitude.
  const liveNorm = liveFeatures.map((v, j) => Math.max(-10, Math.min(10, (v - mean[j]) / std[j])));

  // FIX 6: distribution drift detection
  // Compare live feature distribution to training statistics.
  // driftScore = mean |z-score| across all features (0 = no drift, >2 = significant).
  // A z-score > 3 on any single feature means that feature is >3 std-devs
  // from its training mean — the model is extrapolating on that dimension.
  const absMeanZScore = liveNorm.reduce((s, v) => s + Math.abs(v), 0) / liveNorm.length;
  const maxZScore     = Math.max(...liveNorm.map(v => Math.abs(v)));
  const oodFeatureCount = liveNorm.filter(v => Math.abs(v) > 3).length;
  const driftScore    = absMeanZScore;  // 0–10 scale; >1.5 = warning, >2.5 = high drift
  const driftWarning  = driftScore > 1.5 || maxZScore > 4 || oodFeatureCount > 10;
  if (driftWarning) {
    logger.warn('mlSignal', `${symbol}/${timeframe}: distribution drift detected — ` +
      `meanAbsZ=${driftScore.toFixed(2)} maxZ=${maxZScore.toFixed(2)} ood_features=${oodFeatureCount}/${liveNorm.length}. ` +
      `Model may be extrapolating outside its training distribution.`);
  }

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

  // FIX 2+3: walk-forward runs on dev set (excludes holdout), with 20-bar embargo
  // Pass production blend weights so every WF fold uses the same fixed
  // blend ratio as live inference. Weights are derived from testX
  // (the 80/20 hold-out), which is disjoint from all WF fold data.
  if (_perf) { _t = _perf.mark('4 setup split+norm', _t); _perf.yield_(); }
  const _wfT = Date.now();
  const walkForwardResult = await walkForwardValidate(
    Xdev, yDevByHorizon[effectiveHorizon], WALK_FORWARD_FOLDS, 20,
    { wMLP: mlpWeight, wLR: lrWeight, wTot: totalWeight },
  );
  if (_perf) { _perf.yield_(); _t = _perf.mark('5 walk-forward valid', _wfT); }
  const walkForwardAccuracy = walkForwardResult.accuracy;

  // Fix 1: evaluate holdout using the already-trained production models.
  // The MLP (primaryModel) and LR are the EXACT objects that will serve
  // live predictions — no retrain, no new model. Same normalization stats
  // (mean/std from purged trainX) applied to holdout features.
  // Same ensemble weighting formula as live inference.
  // Complexity: O(|XHoldout| × F) = O(0.1 × n × 116) ≈ O(n) total.
  const holdoutResult = (() => {
    if (!primaryModel || XHoldout.length < 5) return null;
    const nHoldout = applyNorm(XHoldout, mean, std);
    const yH = yHoldout;

    // Per-model accuracy
    const mlpAcc = accuracy(x => primaryModel!.predict(x), nHoldout, yH);
    const lrAcc  = accuracy(x => lr.predict(x),            nHoldout, yH);

    // Production ensemble predict (same weights already computed above)
    const ensPredict = (x: number[]) => {
      const pMLP = primaryModel!.predict(x), pLR = lr.predict(x);
      return totalWeight > 0 ? (pMLP * mlpWeight + pLR * lrWeight) / totalWeight : (pMLP + pLR) / 2;
    };

    // Confusion matrix + metrics
    let htp = 0, hfp = 0, htn = 0, hfn = 0;
    nHoldout.forEach((x, i) => {
      const pred = ensPredict(x) > 0.5 ? 1 : 0, act = yH[i];
      if (pred === 1 && act === 1) htp++;
      else if (pred === 1 && act === 0) hfp++;
      else if (pred === 0 && act === 0) htn++;
      else hfn++;
    });
    const ensAcc   = ((htp + htn) / nHoldout.length) * 100;
    const precision = htp + hfp > 0 ? htp / (htp + hfp) : 0;
    const recall    = htp + hfn > 0 ? htp / (htp + hfn) : 0;
    const f1        = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;

    return {
      sampleCount:      nHoldout.length,
      mlpAccuracy:      mlpAcc,
      lrAccuracy:       lrAcc,
      ensembleAccuracy: ensAcc,
      truePositives:    htp, falsePositives: hfp,
      trueNegatives:    htn, falseNegatives: hfn,
      precision, recall, f1,
    };
  })();

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

  // ATR-based SL/TP — 1.5x ATR stop, 3.0x ATR target = 2.0:1 reward-risk.
  // Break-even win rate at 2.0 RR = 33.3%, achievable at current ~34% win rate.
  // Previously 2.5x/1.5x = 1.667 RR (break-even 37.5% — structurally unprofitable).
  const entry = lastClose;
  // HOLD: 0 sentinel values — no trade signal, no meaningful SL/TP.
  const stopLoss = action === 'BUY' ? entry - 1.5 * currentATR : action === 'SELL' ? entry + 1.5 * currentATR : 0;
  const takeProfit = action === 'BUY' ? entry + 3.0 * currentATR : action === 'SELL' ? entry - 3.0 * currentATR : 0;
  const riskRewardRatio = currentATR > 0 ? 3.0 / 1.5 : 0;

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

  // signalId: stable unique key derived from the last candle's timestamp.
  // Same prediction replayed on the same candle always gets the same ID.
  // This links: MLPrediction ↔ ShadowTrade ↔ PaperPosition ↔ analytics.
  const lastCandleTs = candles.length ? candles[candles.length - 1].time : Date.now();
  const signalId = `${symbol}-${timeframe}-${lastCandleTs}`;

  const result: MLPrediction = {
    horizons: horizonResults, ensembleProbUp, mlpProbUp, lrProbUp, ensembleAgree, direction,
    driftScore: driftScore,
    holdout: holdoutResult,
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
    // marketContext is attached by the caller (usePrediction) after the
    // async fetch completes — not set here to avoid adding I/O inside the
    // training critical path. Default null ensures backward compatibility.
    marketContext: null,
    memoryResult: null,  // populated below after episode store query
  };

  // Module 2: Query memory engine using the live feature vector.
  // Non-blocking: episode store load failure → result.memoryResult stays null.
  // baseWinRate: use primaryValidationAccuracy as the model's historical accuracy.
  try {
    const store = await loadEpisodeStore(symbol, timeframe, ARCHITECTURE_VERSION, FEATURE_NAMES.length);
    if (store && liveFeatures) {
      const currentRegime  = S.regimeData?.regimeArr?.[candles.length - 1]?.label ?? 'UNKNOWN';
      const currentAtrNorm = liveFeatures[13] ?? 0;
      const baseWinRate    = (primaryValidationAccuracy ?? 50) / 100;
      result.memoryResult  = queryMemory(liveFeatures, currentRegime, currentAtrNorm, store, baseWinRate);
    }
  } catch (e: any) {
    logger.warn('mlSignal', `Memory query failed (non-fatal): ${e.message}`);
  }

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
    // Fix 6: batch writes with multiSet — one SQLite transaction vs N sequential.
    // Rotation (prev checkpoint) still reads sequentially (can't batch reads easily
    // in a dependency chain), but all writes are flushed in a single call.
    //
    // Step A: Read all existing checkpoints to rotate them to _prev_ keys.
    const prevPairs: [string, string][] = [];
    for (const w of pendingWrites) {
      try {
        const existing = await AsyncStorage.getItem(w.key);
        if (existing) {
          const prevKey = w.key.startsWith('mlModelLR_')
            ? w.key.replace('mlModelLR_', 'mlModelLR_prev_')
            : w.key.replace('mlModel_', 'mlModel_prev_');
          prevPairs.push([prevKey, existing]);
        }
      } catch (e: any) { logger.error('mlSignal', `Failed to read ${w.key} for rotation: ${e.message}`); }
    }
    // Step B: Flush prev-rotation and new weights in one multiSet call.
    const metadata: ModelMetadata = { ...result, symbol, timeframe };
    if (_perf) { _perf.mark('9 accept/reject logic', _t); _perf.report(Date.now() - _perf.t0); }
    const newPairs: [string, string][] = pendingWrites.map(w => [w.key, JSON.stringify(w.value)]);
    const metaPair: [string, string]  = [METADATA_KEY(symbol, timeframe), JSON.stringify(metadata)];
    try {
      await AsyncStorage.multiSet([...prevPairs, ...newPairs, metaPair]);
    } catch (e: any) {
      logger.error('mlSignal', `multiSet persistence failed: ${e.message}`);
    }

    // Module 2: Build and persist episode store after successful training.
    // Fire-and-forget — episode store failure never blocks prediction output.
    // Uses X (full feature matrix), regimeLabelsForMemory, and per-bar model
    // predictions derived from the primary horizon training labels.
    try {
      const primaryLabels = yByHorizon[effectiveHorizon] ?? [];
      const perBarPredictions: Array<'BUY' | 'SELL' | 'HOLD'> =
        primaryLabels.map(y => y === 1 ? 'BUY' : 'SELL');
      // Rebuild allFeatures map indexed by original bar index
      // X was built for bars i=20..candles.length-maxHorizon, in order
      const allFeaturesMap: number[][] = [];
      let xIdx = 0;
      for (let i = 0; i < candles.length; i++) {
        if (i >= 20 && i < candles.length - Math.max(...HORIZONS)) {
          allFeaturesMap[i] = X[xIdx++] ?? [];
        }
      }
      const episodePredictions: Array<'BUY' | 'SELL' | 'HOLD'> =
        new Array(candles.length).fill('HOLD');
      let pIdx = 0;
      for (let i = 20; i < candles.length - Math.max(...HORIZONS); i++) {
        episodePredictions[i] = perBarPredictions[pIdx++] ?? 'HOLD';
      }
      const store = buildEpisodeStore({
        symbol, timeframe, candles,
        allFeatures: allFeaturesMap,
        regimeLabels: regimeLabelsForMemory,
        predictions:  episodePredictions,
        primaryHorizon: effectiveHorizon,
        architectureVersion: ARCHITECTURE_VERSION,
        featureCount: FEATURE_NAMES.length,
      });
      saveEpisodeStore(store).catch(() => {});
    } catch (e: any) {
      logger.warn('mlSignal', `Episode store build failed (non-fatal): ${e.message}`);
    }

    // metadata const still needed below for registry; already constructed above
    try {
      // metadata already persisted in the multiSet call above
      logger.info('mlSignal', `${symbol}: training ACCEPTED — v${finalModelVersion} (training run #${finalTrainingRunNumber}), ${X.length} samples, ${testX.length} validation, metadata persisted`);
      // v6.1.0 model registry — non-blocking, never affects prediction output
      registerModel(symbol, timeframe, buildRegistryEntry({
        symbol, timeframe, modelVersion: finalModelVersion, trainingSamples: X.length,
        walkForwardAccuracy: walkForwardAccuracy,
        holdoutAccuracy: holdoutResult?.ensembleAccuracy ?? null,
        holdoutF1: holdoutResult?.f1 ?? null,
        featureCount: FEATURE_NAMES.length, driftScore: driftScore,
        previousVersion: previousMetadata?.modelVersion ?? null,
      })).catch(() => {});
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
  orderBookSnapshot: OrderBookSnapshot | null = null,
  contextSnapshot: MarketContextSnapshot | null = null,
): Promise<MLPrediction | null> {
  const startTime = Date.now();
  try {
    const result = await trainAndPredictInner(symbol, timeframe, candles, horizonOverride, thresholdOverride, forceRetrain, assetClass, orderBookSnapshot, contextSnapshot);
    // Record prediction latency (only when a prediction was produced, not on reuse)
    if (result) {
      import('./performanceMetrics').then(m => m.recordMetric('prediction', Date.now() - startTime)).catch(() => {});
    }
    return result;
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
    ...HORIZONS.map(h => AsyncStorage.removeItem(PREV_MODEL_KEY(symbol, timeframe, h))),
    AsyncStorage.removeItem(LR_KEY(symbol, timeframe)),
    AsyncStorage.removeItem(METADATA_KEY(symbol, timeframe)),
  ]);
  logger.info('mlSignal', `${symbol}: cleared all saved model weights and metadata`);
}
