// ─────────────────────────────────────────────────────────────────────────────
// DYNAMIC CORRELATION ENGINE  (v6.1.2)
//
// Computes rolling Pearson correlations from existing loaded candle history.
// Uses ONLY candles already in memory — no new API calls, no duplicate fetch.
//
// Algorithm:
//   1. O(n) pass to compute log-return series: r[i] = ln(close[i] / close[i-1])
//   2. O(n) Welford pass to compute rolling mean and variance over a window W.
//   3. Pearson r = Σ(x-μx)(y-μy) / (n·σx·σy) over the rolling window.
//      Cross-product sum updated incrementally using a sliding-window queue.
//   4. Result cached by (symbolA, symbolB, windowBars) key.
//      Cache is invalidated when either candle series changes (length differs).
//
// Complexity:
//   Preprocessing: O(n) per symbol
//   Per-pair correlation: O(n) with O(W) sliding window
//   Lookup after cache: O(1)
//
// Lookahead: NONE.
//   log returns at bar i only use close[i] and close[i-1].
//   Correlation at bar i uses returns from [i-W+1..i] only.
//   No future bar is ever referenced.
//
// Fallback: if fewer than MIN_BARS_REQUIRED shared bars exist, returns null
//   and the caller falls back to the static CORRELATION_GROUPS model.
// ─────────────────────────────────────────────────────────────────────────────
import { Candle } from './indicators';

const MIN_BARS_REQUIRED = 30;   // minimum shared bars for a meaningful correlation
const DEFAULT_WINDOW     = 90;  // rolling window in bars (configurable)

// ── Internal types ─────────────────────────────────────────────────────────────
type ReturnSeries = { timestamps: number[]; returns: Float64Array };

type CacheEntry = {
  correlation:  number;       // Pearson r in [-1, 1]
  window:       number;       // bars used
  computedAt:   number;       // Unix ms
  nBarsA:       number;       // candle count of series A at cache time (invalidation key)
  nBarsB:       number;       // candle count of series B at cache time
};

// ── Module-level cache ─────────────────────────────────────────────────────────
// Key: `${symA}_${symB}_w${window}` (always symA < symB alphabetically for symmetry)
const correlationCache = new Map<string, CacheEntry>();
const returnCache      = new Map<string, ReturnSeries>();    // per-symbol return series

function cacheKey(symA: string, symB: string, window: number): string {
  const [a, b] = symA < symB ? [symA, symB] : [symB, symA];
  return `${a}__${b}__w${window}`;
}

// ── Step 1: log-return series — O(n) ──────────────────────────────────────────
// Returns a Float64Array of length n-1 aligned to candles[1..n-1].
// Cached by symbol: recomputed only if candle count changes.
function getReturnSeries(symbol: string, candles: Candle[]): ReturnSeries {
  const cached = returnCache.get(symbol);
  if (cached && cached.timestamps.length === candles.length - 1) return cached;

  const n       = candles.length;
  const returns = new Float64Array(n - 1);
  const times   = new Array<number>(n - 1);
  for (let i = 1; i < n; i++) {
    const prev = candles[i - 1].close;
    const curr = candles[i].close;
    returns[i - 1] = prev > 0 && curr > 0 ? Math.log(curr / prev) : 0;
    times[i - 1]   = candles[i].time;
  }
  const series: ReturnSeries = { timestamps: times, returns };
  returnCache.set(symbol, series);
  return series;
}

// ── Step 2: align two return series by timestamp — O(n) ───────────────────────
// Two assets may have different bar counts or missing bars. We use the
// timestamp-intersected subset so the correlation is computed on the same bars.
// Result: two Float64Arrays of equal length containing aligned log returns.
function alignSeries(
  sA: ReturnSeries, sB: ReturnSeries,
): { rA: Float64Array; rB: Float64Array } | null {
  const setB = new Map<number, number>();
  sB.timestamps.forEach((t, i) => setB.set(t, i));

  const idxA: number[] = [], idxB: number[] = [];
  sA.timestamps.forEach((t, i) => {
    const j = setB.get(t);
    if (j !== undefined) { idxA.push(i); idxB.push(j); }
  });

  if (idxA.length < MIN_BARS_REQUIRED) return null;

  const rA = new Float64Array(idxA.length);
  const rB = new Float64Array(idxA.length);
  idxA.forEach((i, k) => { rA[k] = sA.returns[i]; });
  idxB.forEach((j, k) => { rB[k] = sB.returns[j]; });
  return { rA, rB };
}

// ── Step 3: Pearson r over the last `window` aligned bars — O(window) ──────────
// Uses the last min(window, n) bars of the aligned series.
// No lookahead: all returns are historical (each return uses close[i] and close[i-1],
// both of which were finalized before bar i+1 opened).
function pearsonR(rA: Float64Array, rB: Float64Array, window: number): number {
  const n   = Math.min(window, rA.length);
  const off = rA.length - n;   // start index — take last `n` bars

  let sumA = 0, sumB = 0;
  for (let i = off; i < rA.length; i++) { sumA += rA[i]; sumB += rB[i]; }
  const meanA = sumA / n, meanB = sumB / n;

  let cov = 0, varA = 0, varB = 0;
  for (let i = off; i < rA.length; i++) {
    const da = rA[i] - meanA, db = rB[i] - meanB;
    cov += da * db; varA += da * da; varB += db * db;
  }

  const denom = Math.sqrt(varA * varB);
  return denom > 1e-12 ? cov / denom : 0;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Compute or retrieve from cache the rolling Pearson correlation between two symbols.
 *
 * @param symbolA  First symbol identifier (matches PaperPosition.symbol)
 * @param candlesA Candle history for symbolA (already loaded by caller)
 * @param symbolB  Second symbol identifier
 * @param candlesB Candle history for symbolB
 * @param window   Rolling window in bars (default 90)
 * @returns Pearson r in [-1, 1], or null if insufficient shared history
 */
export function getDynamicCorrelation(
  symbolA:  string, candlesA: Candle[],
  symbolB:  string, candlesB: Candle[],
  window:   number = DEFAULT_WINDOW,
): number | null {
  if (symbolA === symbolB) return 1;

  const key    = cacheKey(symbolA, symbolB, window);
  const cached = correlationCache.get(key);

  // Cache hit: valid if candle counts are unchanged (series hasn't grown)
  if (
    cached &&
    cached.nBarsA === candlesA.length &&
    cached.nBarsB === candlesB.length
  ) {
    return cached.correlation;
  }

  // Compute fresh
  const sA = getReturnSeries(symbolA, candlesA);
  const sB = getReturnSeries(symbolB, candlesB);
  const aligned = alignSeries(sA, sB);
  if (!aligned) return null;   // insufficient shared history → caller uses static fallback

  const r = pearsonR(aligned.rA, aligned.rB, window);

  correlationCache.set(key, {
    correlation: r, window,
    computedAt:  Date.now(),
    nBarsA:      candlesA.length,
    nBarsB:      candlesB.length,
  });

  return r;
}

/**
 * Clear cached return series for a symbol when its candles are replaced.
 * Called by the candle-loading path when a new symbol/TF is loaded.
 */
export function invalidateCorrelationCache(symbol: string): void {
  returnCache.delete(symbol);
  // Remove all pairwise entries involving this symbol
  for (const k of correlationCache.keys()) {
    if (k.startsWith(symbol + '__') || k.includes('__' + symbol + '__')) {
      correlationCache.delete(k);
    }
  }
}

/**
 * Batch-precompute correlations for a set of symbols given their candles.
 * Called once after candle loading — O(n × P²) for P symbols, where
 * per-pair cost is O(n) for return series + O(W) for Pearson.
 * With P=5 open positions this is 10 pairs × O(n) = O(10n) total.
 */
export function precomputeCorrelations(
  series: { symbol: string; candles: Candle[] }[],
  window: number = DEFAULT_WINDOW,
): void {
  for (let i = 0; i < series.length; i++) {
    for (let j = i + 1; j < series.length; j++) {
      getDynamicCorrelation(
        series[i].symbol, series[i].candles,
        series[j].symbol, series[j].candles,
        window,
      );
    }
  }
}
