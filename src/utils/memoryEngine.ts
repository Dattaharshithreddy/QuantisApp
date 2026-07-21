// ─────────────────────────────────────────────────────────────────────────────
// MARKET MEMORY ENGINE  v1.0.0
// Module 2 of the Market Intelligence upgrade.
//
// Implements experience-based confidence adjustment using historical episodes
// extracted from the same candle data the ML model already trains on.
// No new data sources required. No paper trade history required.
//
// DESIGN:
//   1. EPISODE STORE — after each training run, label historical bars with
//      forward return outcomes and cache alongside model weights.
//
//   2. SIMILARITY SEARCH — at inference time, compute hybrid similarity
//      between the current feature vector and all stored episodes.
//      Hybrid metric: cosine(continuous) × regime_match × volatility_penalty.
//
//   3. CONFIDENCE ADJUSTMENT — top-K similar episodes produce a win rate.
//      If it diverges from base win rate, adjust displayed confidence.
//      Capped at ±15 points. Never flips direction.
//
//   4. MINIMUM THRESHOLD — if best similarity < 0.70, return null adjustment.
//      "No relevant memory" is better than low-confidence memory.
//
//   5. EPISODE VERSIONING — each episode store is tagged with the model's
//      architecture version + feature count. If either changes, the store
//      is invalidated and rebuilt on next training run. Prevents stale
//      embeddings from polluting the similarity search.
//
// REGIME SIMILARITY MATRIX:
//   Hand-coded 11×11 matrix reflecting known relationships between regime
//   labels. TREND_BULL is similar to BREAKOUT (momentum-driven) but
//   dissimilar to RANGING. MEAN_REVERSION is similar to RANGING.
//   This is deterministic, transparent, and tunable.
//
// ATTRIBUTION — "why did similar cases work or fail?":
//   Each episode stores episodicContext (macro state at signal time).
//   Top-K episodes can be grouped by shared context attributes to surface
//   recurring failure patterns (e.g. "74% of losses had FOMC week=true").
//   This is correlation-based attribution, explicitly NOT causal — labelled
//   as "pattern" not "reason" in the UI to avoid misleading users.
// ─────────────────────────────────────────────────────────────────────────────

import AsyncStorage             from '@react-native-async-storage/async-storage';
import type { Candle }          from './indicators';
import type { EpisodicContext } from './contextFeatures';
import { logger }               from './logger';

// ── Types ─────────────────────────────────────────────────────────────────────

export type EpisodeOutcome = 'WIN' | 'LOSS' | 'NEUTRAL';

export type Episode = {
  // Feature vector at the bar (full vector: base + context features)
  features:      number[];
  // Regime label at this bar (from regime engine, stored separately from features
  // for fast regime-match scoring without indexing into the feature array)
  regimeLabel:   string;
  // Volatility at this bar (ATR normalised, index 13 in feature vector)
  atrNorm:       number;
  // Labelled outcome
  outcome:       EpisodeOutcome;
  returnPct:     number;   // actual % return over primaryHorizon bars
  cleanMove:     boolean;  // price reached TP before SL equivalent
  // Macro context at signal time (for attribution)
  context:       EpisodicContext | null;
  // Bar index in the original candle array (for debugging only)
  barIndex:      number;
};

export type EpisodeStore = {
  version:         number;   // ARCHITECTURE_VERSION at build time
  featureCount:    number;   // FEATURE_NAMES.length at build time
  symbol:          string;
  timeframe:       string;
  episodes:        Episode[];
  builtAt:         number;
  primaryHorizon:  number;
};

export type MemoryQueryResult = {
  // Whether the memory engine had enough similar history to produce a result
  available:         boolean;
  similarCount:      number;
  topKWinRate:       number;    // 0–1
  topKAvgReturn:     number;    // average % return of top-K
  regimeMatchRate:   number;    // fraction of top-K with same regime
  bestSimilarity:    number;    // highest individual similarity score
  confidenceAdjust:  number;    // points to add/subtract from displayed confidence (-15 to +15)
  // Attribution: recurring context patterns among top-K losses
  failurePatterns:   FailurePattern[];
  // The top-K episodes themselves (for UI detail view)
  topEpisodes:       Array<{ episode: Episode; similarity: number }>;
};

export type FailurePattern = {
  attribute:    string;   // e.g. "FOMC week", "Fear & Greed < 25", "FII selling"
  lossRate:     number;   // fraction of episodes with this attribute that lost
  sampleCount:  number;
};

// ── Constants ─────────────────────────────────────────────────────────────────

const EPISODE_STORE_KEY = (s: string, tf: string) => `memoryEngine_episodes_${s}_${tf}`;
const TOP_K             = 10;
const MIN_SIMILARITY    = 0.70;   // below this → "insufficient similar history"
const MAX_CONFIDENCE_ADJUST = 15; // points, always

// ── Regime similarity matrix ───────────────────────────────────────────────────
// 11×11 symmetric matrix (RegimeLabel → RegimeLabel → similarity 0..1)
// Designed so: trending regimes are similar to each other,
// ranging/mean-reversion are similar to each other, breakout bridges both.

const REGIME_LABELS = [
  'TREND_BULL', 'TREND_BEAR', 'RANGING', 'BREAKOUT',
  'MEAN_REVERSION', 'HIGH_VOLATILITY', 'LOW_VOLATILITY',
  'ACCUMULATION', 'DISTRIBUTION', 'CRISIS', 'UNKNOWN',
] as const;

type RegimeLabel = typeof REGIME_LABELS[number];

// Build the matrix as a flat map for O(1) lookup
const REGIME_SIMILARITY: Map<string, number> = new Map();

function rs(a: RegimeLabel, b: RegimeLabel, v: number) {
  REGIME_SIMILARITY.set(`${a}|${b}`, v);
  REGIME_SIMILARITY.set(`${b}|${a}`, v);
}

// Self-similarity
REGIME_LABELS.forEach(r => rs(r, r, 1.0));

// Trending regimes
rs('TREND_BULL', 'TREND_BEAR',     0.2);  // opposites
rs('TREND_BULL', 'BREAKOUT',       0.8);  // momentum-aligned
rs('TREND_BULL', 'ACCUMULATION',   0.7);  // both bullish structure
rs('TREND_BULL', 'RANGING',        0.2);
rs('TREND_BULL', 'MEAN_REVERSION', 0.1);
rs('TREND_BULL', 'HIGH_VOLATILITY',0.4);
rs('TREND_BULL', 'LOW_VOLATILITY', 0.5);
rs('TREND_BULL', 'DISTRIBUTION',   0.2);
rs('TREND_BULL', 'CRISIS',         0.05);
rs('TREND_BULL', 'UNKNOWN',        0.3);

rs('TREND_BEAR', 'BREAKOUT',       0.5);  // breakouts can be bearish
rs('TREND_BEAR', 'DISTRIBUTION',   0.7);
rs('TREND_BEAR', 'RANGING',        0.2);
rs('TREND_BEAR', 'MEAN_REVERSION', 0.1);
rs('TREND_BEAR', 'HIGH_VOLATILITY',0.5);
rs('TREND_BEAR', 'LOW_VOLATILITY', 0.4);
rs('TREND_BEAR', 'ACCUMULATION',   0.2);
rs('TREND_BEAR', 'CRISIS',         0.5);
rs('TREND_BEAR', 'UNKNOWN',        0.3);

rs('RANGING',        'MEAN_REVERSION', 0.8);
rs('RANGING',        'LOW_VOLATILITY', 0.6);
rs('RANGING',        'ACCUMULATION',   0.4);
rs('RANGING',        'DISTRIBUTION',   0.4);
rs('RANGING',        'HIGH_VOLATILITY',0.2);
rs('RANGING',        'BREAKOUT',       0.3);
rs('RANGING',        'CRISIS',         0.1);
rs('RANGING',        'UNKNOWN',        0.3);

rs('BREAKOUT',       'HIGH_VOLATILITY',0.6);
rs('BREAKOUT',       'DISTRIBUTION',   0.4);
rs('BREAKOUT',       'ACCUMULATION',   0.4);
rs('BREAKOUT',       'MEAN_REVERSION', 0.2);
rs('BREAKOUT',       'LOW_VOLATILITY', 0.2);
rs('BREAKOUT',       'CRISIS',         0.3);
rs('BREAKOUT',       'UNKNOWN',        0.3);

rs('MEAN_REVERSION', 'LOW_VOLATILITY', 0.5);
rs('MEAN_REVERSION', 'HIGH_VOLATILITY',0.2);
rs('MEAN_REVERSION', 'ACCUMULATION',   0.3);
rs('MEAN_REVERSION', 'DISTRIBUTION',   0.3);
rs('MEAN_REVERSION', 'CRISIS',         0.1);
rs('MEAN_REVERSION', 'UNKNOWN',        0.3);

rs('HIGH_VOLATILITY','CRISIS',         0.6);
rs('HIGH_VOLATILITY','DISTRIBUTION',   0.4);
rs('HIGH_VOLATILITY','ACCUMULATION',   0.3);
rs('HIGH_VOLATILITY','LOW_VOLATILITY', 0.1);
rs('HIGH_VOLATILITY','UNKNOWN',        0.3);

rs('LOW_VOLATILITY', 'ACCUMULATION',   0.5);
rs('LOW_VOLATILITY', 'DISTRIBUTION',   0.3);
rs('LOW_VOLATILITY', 'CRISIS',         0.05);
rs('LOW_VOLATILITY', 'UNKNOWN',        0.3);

rs('ACCUMULATION',   'DISTRIBUTION',   0.3);
rs('ACCUMULATION',   'CRISIS',         0.1);
rs('ACCUMULATION',   'UNKNOWN',        0.3);

rs('DISTRIBUTION',   'CRISIS',         0.4);
rs('DISTRIBUTION',   'UNKNOWN',        0.3);

rs('CRISIS',         'UNKNOWN',        0.2);

function regimeSimilarity(a: string, b: string): number {
  return REGIME_SIMILARITY.get(`${a}|${b}`) ?? 0.3; // default for unknown labels
}

// ── Cosine similarity ─────────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const mag = Math.sqrt(magA) * Math.sqrt(magB);
  return mag < 1e-10 ? 0 : dot / mag;
}

// ── Hybrid similarity ─────────────────────────────────────────────────────────
// Combines cosine (continuous features) with regime match and volatility proximity.

function hybridSimilarity(
  current:        number[],
  episode:        Episode,
  currentRegime:  string,
  currentAtrNorm: number,
): number {
  // 1. Cosine similarity on full feature vector (60% weight)
  const cos = cosineSimilarity(current, episode.features);

  // 2. Regime similarity from hand-coded matrix (25% weight)
  const regSim = regimeSimilarity(currentRegime, episode.regimeLabel);

  // 3. Volatility divergence penalty (15% weight)
  //    If current ATR differs significantly from episode ATR, penalise.
  //    Penalty = 1 - |delta| / 0.5  (0.5 ATR difference = full penalty)
  const atrDelta = Math.abs(currentAtrNorm - episode.atrNorm);
  const volScore = Math.max(0, 1 - atrDelta / 0.5);

  return cos * 0.60 + regSim * 0.25 + volScore * 0.15;
}

// ── Episode labelling ─────────────────────────────────────────────────────────
// Labels a bar at index i with its actual forward return.
// primaryHorizon: number of bars forward to measure (same as ML primary horizon)
// winThreshold: minimum return (in ATR multiples) to call it a WIN

function labelEpisode(
  candles:        Candle[],
  i:              number,
  primaryHorizon: number,
  direction:      'BUY' | 'SELL' | 'HOLD',
  atrNorm:        number,
): { outcome: EpisodeOutcome; returnPct: number; cleanMove: boolean } {
  if (direction === 'HOLD' || i + primaryHorizon >= candles.length) {
    return { outcome: 'NEUTRAL', returnPct: 0, cleanMove: false };
  }

  const entry  = candles[i].close;
  const future = candles[i + primaryHorizon].close;
  if (entry === 0) return { outcome: 'NEUTRAL', returnPct: 0, cleanMove: false };

  const rawReturn = (future - entry) / entry; // positive = price went up
  const returnPct = direction === 'BUY' ? rawReturn * 100 : -rawReturn * 100;

  // Outcome: WIN if return > 0.3%, LOSS if < -0.3%, else NEUTRAL
  // 0.3% threshold covers typical spread + slippage for most instruments
  const WIN_THRESHOLD  =  0.3;
  const LOSS_THRESHOLD = -0.3;
  const outcome: EpisodeOutcome =
    returnPct >  WIN_THRESHOLD  ? 'WIN'  :
    returnPct <  LOSS_THRESHOLD ? 'LOSS' : 'NEUTRAL';

  // "Clean move": price moved at least 1× ATR in the right direction
  // Proxy: abs(returnPct) > atrNorm * 100 * 0.5
  const cleanMove = Math.abs(returnPct) > (atrNorm * 100 * 0.5);

  return { outcome, returnPct, cleanMove };
}

// ── Episode store build ───────────────────────────────────────────────────────

export type EpisodeBuildInput = {
  symbol:          string;
  timeframe:       string;
  candles:         Candle[];
  allFeatures:     number[][];  // featuresAt() for every bar, pre-computed during training
  regimeLabels:    string[];    // one per bar, from regime engine
  predictions:     Array<'BUY' | 'SELL' | 'HOLD'>;  // model's prediction per bar
  primaryHorizon:  number;
  architectureVersion: number;
  featureCount:    number;
  episodicContexts?: Array<EpisodicContext | null>;  // optional macro context per bar
};

export function buildEpisodeStore(input: EpisodeBuildInput): EpisodeStore {
  const {
    symbol, timeframe, candles, allFeatures, regimeLabels,
    predictions, primaryHorizon, architectureVersion, featureCount,
    episodicContexts,
  } = input;

  const episodes: Episode[] = [];

  // Stop before the last primaryHorizon bars — we need future bars to label
  const limit = candles.length - primaryHorizon - 1;

  for (let i = 5; i < limit; i++) {
    const features  = allFeatures[i];
    if (!features || features.length !== featureCount) continue;

    const direction = predictions[i];
    if (direction === 'HOLD') continue; // only store actionable episodes

    // ATR normalised is feature index 13 ('ATR (norm)')
    const atrNorm    = features[13] ?? 0;
    const regimeLabel = regimeLabels[i] ?? 'UNKNOWN';
    const { outcome, returnPct, cleanMove } = labelEpisode(candles, i, primaryHorizon, direction, atrNorm);

    episodes.push({
      features,
      regimeLabel,
      atrNorm,
      outcome,
      returnPct,
      cleanMove,
      context: episodicContexts?.[i] ?? null,
      barIndex: i,
    });
  }

  logger.info('memoryEngine', `${symbol}/${timeframe}: built ${episodes.length} episodes from ${candles.length} candles`);

  return {
    version:        architectureVersion,
    featureCount,
    symbol,
    timeframe,
    episodes,
    builtAt:        Date.now(),
    primaryHorizon,
  };
}

// ── Persistence ────────────────────────────────────────────────────────────────

export async function saveEpisodeStore(store: EpisodeStore): Promise<void> {
  try {
    await AsyncStorage.setItem(
      EPISODE_STORE_KEY(store.symbol, store.timeframe),
      JSON.stringify(store),
    );
  } catch (e: any) {
    logger.warn('memoryEngine', `Failed to save episode store: ${e.message}`);
  }
}

export async function loadEpisodeStore(
  symbol:             string,
  timeframe:          string,
  architectureVersion: number,
  featureCount:       number,
): Promise<EpisodeStore | null> {
  try {
    const raw = await AsyncStorage.getItem(EPISODE_STORE_KEY(symbol, timeframe));
    if (!raw) return null;
    const store: EpisodeStore = JSON.parse(raw);

    // Version gate: invalidate if architecture or feature count changed
    if (store.version !== architectureVersion || store.featureCount !== featureCount) {
      logger.info('memoryEngine', `${symbol}/${timeframe}: episode store invalidated (version/feature count changed)`);
      return null;
    }

    return store;
  } catch { return null; }
}

// ── Confidence adjustment formula ─────────────────────────────────────────────
// Pure function — given top-K win rate and base win rate, compute adjustment.
// Capped at ±MAX_CONFIDENCE_ADJUST points.

function computeConfidenceAdjust(
  topKWinRate:   number,  // 0–1
  baseWinRate:   number,  // 0–1, model's historical accuracy
  regimeMatchRate: number, // 0–1
): number {
  const deviation = topKWinRate - baseWinRate;

  // Scale: 0.15 deviation → full ±15pt adjustment
  let adjust = (deviation / 0.15) * MAX_CONFIDENCE_ADJUST;
  adjust = Math.max(-MAX_CONFIDENCE_ADJUST, Math.min(MAX_CONFIDENCE_ADJUST, adjust));

  // Additional regime mismatch penalty: if top-K episodes are mostly from
  // different regimes, their win rates are less reliable for THIS situation
  if (regimeMatchRate < 0.4) {
    const penalty = (0.4 - regimeMatchRate) / 0.4 * 8; // up to 8 extra points penalty
    adjust -= penalty;
  }

  // Floor/ceiling
  return Math.max(-MAX_CONFIDENCE_ADJUST, Math.min(MAX_CONFIDENCE_ADJUST, Math.round(adjust)));
}

// ── Attribution: failure patterns ─────────────────────────────────────────────

function extractFailurePatterns(topEpisodes: Array<{ episode: Episode; similarity: number }>): FailurePattern[] {
  const losses = topEpisodes.filter(e => e.episode.outcome === 'LOSS');
  if (losses.length < 2) return [];

  const patterns: FailurePattern[] = [];
  const checks: Array<{ label: string; test: (ctx: EpisodicContext) => boolean }> = [
    { label: 'FOMC week',          test: c => c.isFOMCWeek },
    { label: 'RBI MPC week',       test: c => c.isRBIWeek },
    { label: 'Expiry week',        test: c => c.isExpiryWeek },
    { label: 'Critical event <3d', test: c => c.daysToCritical < 3 },
    { label: 'Extreme Fear (<25)', test: c => (c.fearGreed ?? 50) < 25 },
    { label: 'Extreme Greed (>75)',test: c => (c.fearGreed ?? 50) > 75 },
    { label: 'High funding rate',  test: c => (c.fundingRate ?? 0) > 0.0005 },
    { label: 'FII selling',        test: c => c.fiiBias === 'FII_SELL' },
    { label: 'FII buying',         test: c => c.fiiBias === 'FII_BUY' },
    { label: 'High VIX',          test: c => (c.vixRegime === 'HIGH' || c.vixRegime === 'EXTREME') },
    { label: 'Contrarian bear PCR',test: c => c.pcrSentiment === 'EXTREME_BEARISH' },
  ];

  for (const { label, test } of checks) {
    const withAttr = losses.filter(e => e.episode.context && test(e.episode.context));
    if (withAttr.length < 2) continue;
    const lossRate = withAttr.length / losses.length;
    if (lossRate >= 0.5) { // only surface if 50%+ of losses share this attribute
      patterns.push({ attribute: label, lossRate, sampleCount: withAttr.length });
    }
  }

  return patterns.sort((a, b) => b.lossRate - a.lossRate).slice(0, 3);
}

// ── Main query ─────────────────────────────────────────────────────────────────

/**
 * Query the memory engine for similar historical episodes.
 *
 * @param currentFeatures   Full feature vector for the current bar
 * @param currentRegime     Regime label at current bar (from regimeEngine)
 * @param currentAtrNorm    ATR normalised at current bar (feature index 13)
 * @param store             Pre-loaded episode store (null → return unavailable)
 * @param baseWinRate       Model's historical accuracy (0–1), from MLPrediction
 */
export function queryMemory(
  currentFeatures:  number[],
  currentRegime:    string,
  currentAtrNorm:   number,
  store:            EpisodeStore | null,
  baseWinRate:      number,
): MemoryQueryResult {
  const unavailable: MemoryQueryResult = {
    available: false, similarCount: 0,
    topKWinRate: 0, topKAvgReturn: 0,
    regimeMatchRate: 0, bestSimilarity: 0,
    confidenceAdjust: 0, failurePatterns: [], topEpisodes: [],
  };

  if (!store || store.episodes.length < 10) return unavailable;
  if (currentFeatures.length !== store.featureCount) return unavailable;

  // Score all episodes
  const scored = store.episodes.map(episode => ({
    episode,
    similarity: hybridSimilarity(currentFeatures, episode, currentRegime, currentAtrNorm),
  }));

  // Sort descending by similarity
  scored.sort((a, b) => b.similarity - a.similarity);
  const topK = scored.slice(0, TOP_K);

  const bestSimilarity = topK[0]?.similarity ?? 0;

  // Minimum threshold gate — if even the best match is below 0.70, don't adjust
  if (bestSimilarity < MIN_SIMILARITY) return unavailable;

  // Only use episodes above the threshold
  const qualifiedK = topK.filter(e => e.similarity >= MIN_SIMILARITY);
  if (qualifiedK.length < 3) return unavailable; // need at least 3 qualified matches

  const wins       = qualifiedK.filter(e => e.episode.outcome === 'WIN').length;
  const topKWinRate = wins / qualifiedK.length;
  const topKAvgReturn = qualifiedK.reduce((s, e) => s + e.episode.returnPct, 0) / qualifiedK.length;
  const regimeMatches = qualifiedK.filter(e => e.episode.regimeLabel === currentRegime).length;
  const regimeMatchRate = regimeMatches / qualifiedK.length;

  const confidenceAdjust = computeConfidenceAdjust(topKWinRate, baseWinRate, regimeMatchRate);
  const failurePatterns  = extractFailurePatterns(qualifiedK);

  return {
    available:        true,
    similarCount:     qualifiedK.length,
    topKWinRate,
    topKAvgReturn,
    regimeMatchRate,
    bestSimilarity,
    confidenceAdjust,
    failurePatterns,
    topEpisodes:      qualifiedK,
  };
}

// ── Utility: format memory result for display ─────────────────────────────────

export function formatMemoryResult(result: MemoryQueryResult): {
  headline:     string;
  subtitle:     string;
  adjustLabel:  string;
  patterns:     string[];
} {
  if (!result.available) {
    return {
      headline:    'No similar history',
      subtitle:    'Insufficient matching episodes in memory',
      adjustLabel: '',
      patterns:    [],
    };
  }

  const wr = (result.topKWinRate * 100).toFixed(0);
  const ret = result.topKAvgReturn >= 0
    ? `+${result.topKAvgReturn.toFixed(2)}%`
    : `${result.topKAvgReturn.toFixed(2)}%`;
  const regMatch = (result.regimeMatchRate * 100).toFixed(0);

  const headline = `${result.similarCount} similar setups · Win rate ${wr}%`;
  const subtitle = `Avg return ${ret} · Regime match ${regMatch}%`;

  const adj = result.confidenceAdjust;
  const adjustLabel = adj === 0 ? '' :
    adj > 0 ? `Memory adds +${adj}pts confidence` :
              `Memory reduces confidence ${adj}pts`;

  const patterns = result.failurePatterns.map(p =>
    `${p.attribute}: ${(p.lossRate * 100).toFixed(0)}% of similar losses`
  );

  return { headline, subtitle, adjustLabel, patterns };
}
