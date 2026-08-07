// ─────────────────────────────────────────────────────────────────────────────
// CANDLE CACHE  (v2.0.0 — production-grade persistent store)
//
// DESIGN CONTRACT:
//   fetchCandlesWithCache() is the SINGLE entry point for all candle consumers.
//   No screen or utility should call aoCandles / fetchBnKlines / fetchAVKlines
//   directly for historical data — they go through this module instead.
//
// WHAT IT DOES PER CALL:
//   1. Load cached candles from AsyncStorage
//   2. Validate cache format and integrity
//   3. Determine newest cached timestamp
//   4. Fetch ONLY candles newer than that timestamp from the API
//   5. Merge fetched + cached, deduplicate by timestamp
//   6. Sort chronologically, validate ordering
//   7. Save merged result back to cache
//   8. Return merged candles
//
// RESULT OVER TIME:
//   Cache grows beyond API lookback window.
//   After 1 year of daily NIFTY50/1h fetches → 1 year of 1h bars in cache
//   even when AngelOne only returns 60 days per call.
//
// INVARIANTS:
//   - ML logic is NEVER touched — only the candle source changes
//   - Corrupted cache is silently rebuilt from API (never crashes)
//   - Duplicate timestamps are impossible in output (Map dedup)
//   - Output is always sorted ascending by time
//   - fetchedAt is always written after a successful merge
// ─────────────────────────────────────────────────────────────────────────────

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Candle } from './indicators';
import { logger } from './logger';

// ── Cache format version ──────────────────────────────────────────────────────
// Increment when the stored shape changes incompatibly.
// On version mismatch the cache is discarded and rebuilt from the API.
const CACHE_VERSION = 2;

// ── TTL for "is this fresh enough to skip an API call entirely" ───────────────
// Used by the chart path (fast render from cache). NOT used by the
// evaluation/training path (always fetches incremental update regardless of TTL).
const TTL_MS: Record<string, number> = {
  '1m':  1 * 60_000,
  '3m':  2 * 60_000,
  '5m':  3 * 60_000,
  '15m': 5 * 60_000,
  '30m': 10 * 60_000,
  '1h':  15 * 60_000,
  '4h':  30 * 60_000,
  '1D':  60 * 60_000,
  '1W':  4 * 60 * 60_000,
};

// ── AsyncStorage key ──────────────────────────────────────────────────────────
const storageKey = (symbol: string, tf: string) =>
  `candleCache_v${CACHE_VERSION}_${symbol}_${tf}`;

// ── In-memory session cache ───────────────────────────────────────────────────
// Prevents redundant AsyncStorage reads within the same app session.
// Cleared only on app restart. Keyed by storageKey().
const sessionCache = new Map<string, CacheEntry>();

// ── Types ─────────────────────────────────────────────────────────────────────
export type CacheEntry = {
  version:          number;
  candles:          Candle[];
  fetchedAt:        number;  // when the last incremental fetch completed
  symbol:           string;
  tf:               string;
  historyExhausted: boolean; // true = Binance has no older data than what's cached
                             // false / absent = older bars may exist; backfill is safe
};

// ── Validation ────────────────────────────────────────────────────────────────

function isValidCandle(c: any): c is Candle {
  return (
    c && typeof c.time === 'number' && c.time > 0 &&
    typeof c.open  === 'number' && isFinite(c.open)  &&
    typeof c.high  === 'number' && isFinite(c.high)  &&
    typeof c.low   === 'number' && isFinite(c.low)   &&
    typeof c.close === 'number' && isFinite(c.close) &&
    typeof c.volume === 'number' && c.volume >= 0
  );
}

function validateAndSort(candles: Candle[]): Candle[] {
  // Deduplicate by timestamp (newest value wins on conflict)
  const byTime = new Map<number, Candle>();
  for (const c of candles) {
    if (isValidCandle(c)) byTime.set(c.time, c);
  }
  const sorted = Array.from(byTime.values()).sort((a, b) => a.time - b.time);

  // Spike filter: reject candles where high > close * 10.
  // Real intraday range never exceeds 10x the close — anything larger is a
  // corrupt data point (e.g. Binance occasionally emits malformed klines).
  // Also reject candles where open/high/low/close are internally inconsistent.
  return sorted.filter(c => {
    if (c.high > c.close * 10 || c.high > c.open * 10) return false;
    if (c.low  < c.close / 10 || c.low  < c.open  / 10) return false;
    if (c.high < c.low) return false;
    if (c.high < Math.max(c.open, c.close)) return false;
    if (c.low  > Math.min(c.open, c.close)) return false;
    return true;
  });
}

function isCacheEntryValid(raw: any): raw is CacheEntry {
  return (
    raw &&
    raw.version === CACHE_VERSION &&
    typeof raw.fetchedAt === 'number' &&
    typeof raw.symbol    === 'string' &&
    typeof raw.tf        === 'string' &&
    Array.isArray(raw.candles) &&
    raw.candles.length >= 0
    // historyExhausted is optional — old cache entries without it are still valid
  );
}

// ── Core read/write ───────────────────────────────────────────────────────────

async function readCache(symbol: string, tf: string): Promise<CacheEntry | null> {
  const sk = storageKey(symbol, tf);

  // Session cache hit — skip AsyncStorage entirely
  if (sessionCache.has(sk)) return sessionCache.get(sk)!;

  try {
    const raw = await AsyncStorage.getItem(sk);
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    if (!isCacheEntryValid(parsed)) {
      // Corrupted or old version — discard silently
      logger.warn('candleCache', `${symbol}/${tf}: cache invalid/stale, rebuilding`);
      await AsyncStorage.removeItem(sk);
      return null;
    }

    // Validate individual candles — filter out any corrupt entries
    const clean = validateAndSort(parsed.candles);
    if (clean.length < parsed.candles.length) {
      logger.warn('candleCache', `${symbol}/${tf}: dropped ${parsed.candles.length - clean.length} corrupt candles`);
    }

    const entry: CacheEntry = { ...parsed, candles: clean };
    sessionCache.set(sk, entry);
    return entry;
  } catch (e: any) {
    logger.warn('candleCache', `${symbol}/${tf}: read error — ${e.message}`);
    return null;
  }
}

async function writeCache(symbol: string, tf: string, candles: Candle[], historyExhausted = false): Promise<void> {
  const sk = storageKey(symbol, tf);
  // Once historyExhausted is true it stays true — Binance history doesn't grow backward.
  // Preserve any existing true value even when caller passes false (default).
  const existing = sessionCache.get(sk);
  const keepExhausted = historyExhausted || (existing?.historyExhausted === true);
  const entry: CacheEntry = {
    version:          CACHE_VERSION,
    candles:          validateAndSort(candles),
    fetchedAt:        Date.now(),
    symbol,
    tf,
    historyExhausted: keepExhausted};
  sessionCache.set(sk, entry);
  try {
    await AsyncStorage.setItem(sk, JSON.stringify(entry));
  } catch (e: any) {
    // Non-fatal — in-memory session cache still works this session
    logger.warn('candleCache', `${symbol}/${tf}: write error — ${e.message}`);
  }
}

// ── Public: merge utility (used by useChartData for panning) ──────────────────
export function mergeCandles(a: Candle[], b: Candle[]): Candle[] {
  return validateAndSort([...a, ...b]);
}

// ── Public: history-exhausted helpers (for Production Evaluation) ───────────
// Lets the eval engine know whether it has already fetched all available Binance
// history for a symbol+timeframe, so subsequent eval runs skip re-pagination.

/** Returns true if a prior fetchMaxHistory confirmed Binance has no older data. */
export async function isHistoryExhausted(symbol: string, tf: string): Promise<boolean> {
  const entry = await readCache(symbol, tf);
  return entry?.historyExhausted === true;
}

/**
 * Persists historyExhausted=true into the existing cache entry for this symbol/tf.
 * Called after fetchMaxHistory returns historyExhausted=true.
 * No-op if no cache entry exists yet.
 */
export async function markHistoryExhausted(symbol: string, tf: string): Promise<void> {
  const entry = await readCache(symbol, tf);
  if (!entry) return;
  await writeCache(symbol, tf, entry.candles, true);
}

// ── Public: legacy read (used by chart path for instant render) ───────────────
export async function getCachedCandles(
  symbol: string, tf: string,
): Promise<{ candles: Candle[]; isFresh: boolean } | null> {
  const entry = await readCache(symbol, tf);
  if (!entry || !entry.candles.length) return null;
  const ttl = TTL_MS[tf] ?? 5 * 60_000;
  return { candles: entry.candles, isFresh: Date.now() - entry.fetchedAt < ttl };
}

// ── Public: legacy write (used by chart path after fetch) ────────────────────
export async function setCachedCandles(
  symbol: string, tf: string, candles: Candle[],
): Promise<void> {
  return writeCache(symbol, tf, candles);
}

// ── Public: clear one entry (for testing / manual invalidation) ───────────────
export async function clearCachedCandles(symbol: string, tf: string): Promise<void> {
  const sk = storageKey(symbol, tf);
  sessionCache.delete(sk);
  await AsyncStorage.removeItem(sk).catch(() => {});
}

// ── Public: clear all candle cache entries ────────────────────────────────────
export async function clearAllCandleCache(): Promise<void> {
  sessionCache.clear();
  try {
    const allKeys = await AsyncStorage.getAllKeys();
    const cacheKeys = allKeys.filter(k => k.startsWith('candleCache_'));
    if (cacheKeys.length) await AsyncStorage.multiRemove(cacheKeys);
    logger.info('candleCache', `Cleared ${cacheKeys.length} cache entries`);
  } catch (e: any) {
    logger.warn('candleCache', `clearAll error — ${e.message}`);
  }
}

// ── Public: cache stats (for debugging / settings screen) ─────────────────────
export async function getCacheStats(): Promise<{
  entryCount: number;
  totalCandles: number;
  oldestEntry: string | null;
  newestEntry: string | null;
}> {
  try {
    const allKeys = await AsyncStorage.getAllKeys();
    const cacheKeys = allKeys.filter(k => k.startsWith(`candleCache_v${CACHE_VERSION}_`));
    let totalCandles = 0;
    let oldestTs = Infinity, newestTs = 0;
    let oldestLabel: string | null = null, newestLabel: string | null = null;
    for (const k of cacheKeys) {
      const raw = await AsyncStorage.getItem(k);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        if (!isCacheEntryValid(parsed)) continue;
        totalCandles += parsed.candles.length;
        if (parsed.fetchedAt < oldestTs) { oldestTs = parsed.fetchedAt; oldestLabel = `${parsed.symbol}/${parsed.tf}`; }
        if (parsed.fetchedAt > newestTs) { newestTs = parsed.fetchedAt; newestLabel = `${parsed.symbol}/${parsed.tf}`; }
      } catch {}
    }
    return { entryCount: cacheKeys.length, totalCandles, oldestEntry: oldestLabel, newestEntry: newestLabel };
  } catch {
    return { entryCount: 0, totalCandles: 0, oldestEntry: null, newestEntry: null };
  }
}

// ── THE MAIN PUBLIC API ───────────────────────────────────────────────────────
// fetchCandlesWithCache() — single entry point for all candle consumers.
//
// Parameters:
//   symbol   — display symbol e.g. 'NIFTY50'
//   tf       — timeframe string e.g. '5m', '1h', '1D'
//   fetcher  — async function that accepts (newestCachedTime: number | null)
//              and returns Candle[]. The newestCachedTime is the last candle's
//              timestamp from cache (or null if cache is empty), allowing the
//              fetcher to request only NEW candles.
//   options:
//     maxCandles    — cap on total candles returned (default 10000)
//     forceRefresh  — skip TTL check, always fetch (default false for chart,
//                     true for evaluation/training)
//     skipApiIfFresh — if cache is fresh (within TTL), return cache only
//                     (used by chart path for instant render)
//
// Invariant: ML logic is NEVER in this function. It only provides candles.
// The fetcher lambda is provided by the caller and owns any API specifics.
export async function fetchCandlesWithCache(
  symbol:  string,
  tf:      string,
  fetcher: (newestCachedTime: number | null) => Promise<Candle[]>,
  options: {
    maxCandles?:       number;
    forceRefresh?:     boolean;
    skipApiIfFresh?:   boolean;
  } = {},
): Promise<Candle[]> {
  const { maxCandles = 10_000, forceRefresh = false, skipApiIfFresh = false } = options;

  // ── 1. Load cache ──────────────────────────────────────────────────────────
  const cached = await readCache(symbol, tf);
  const cachedCandles = cached?.candles ?? [];
  const newestCachedTime = cachedCandles.length
    ? cachedCandles[cachedCandles.length - 1].time
    : null;

  // ── 2. TTL check — skip API for very fresh cache (chart fast-render path) ──
  if (skipApiIfFresh && cached && !forceRefresh) {
    const ttl = TTL_MS[tf] ?? 5 * 60_000;
    if (Date.now() - cached.fetchedAt < ttl) {
      logger.info('candleCache', `${symbol}/${tf}: cache fresh (${cachedCandles.length} bars), skipping API`);
      return cachedCandles.slice(-maxCandles);
    }
  }

  // ── 3. Fetch incremental candles from API ──────────────────────────────────
  let freshCandles: Candle[] = [];
  try {
    freshCandles = await fetcher(newestCachedTime);
  } catch (e: any) {
    // API failed — return cache as best-effort
    logger.warn('candleCache', `${symbol}/${tf}: API fetch failed, returning cache: ${e.message}`);
    return cachedCandles.slice(-maxCandles);
  }

  if (!freshCandles.length && cachedCandles.length) {
    // API returned nothing new — cache is already up to date
    logger.info('candleCache', `${symbol}/${tf}: no new candles, cache has ${cachedCandles.length} bars`);
    return cachedCandles.slice(-maxCandles);
  }

  // ── 4. Merge, deduplicate, sort ────────────────────────────────────────────
  const merged = validateAndSort([...cachedCandles, ...freshCandles]);

  // ── 5. Persist ────────────────────────────────────────────────────────────
  // Save the full merged set (not capped) so future sessions get max history.
  await writeCache(symbol, tf, merged);

  const result = merged.slice(-maxCandles);
  logger.info('candleCache',
    `${symbol}/${tf}: cache=${cachedCandles.length} + fresh=${freshCandles.length}` +
    ` → merged=${merged.length} bars (returning ${result.length})`);

  return result;
}
