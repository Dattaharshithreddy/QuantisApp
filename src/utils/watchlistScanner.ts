import AsyncStorage from '@react-native-async-storage/async-storage';
import { Asset } from '../api/assets';
import { Candle } from '../utils/indicators';
import { fetchBnKlines } from '../api/binance';
import { aoCandles } from '../api/angelOne';
import { fetchAVKlines } from '../api/alphaVantage';
import { getCachedCandles, setCachedCandles } from './candleCache';
import { withRetry } from './retry';
import { trainAndPredict, loadModelMetadata } from './mlSignal';
import { getOptimalConfig } from './modelOptimization';
import { attemptOpenPosition, checkAIExitSignal, monitorOpenPositions } from './paperTradingEngine';
import { getPortfolio } from './paperPortfolio';
import { notifyDailySummary } from './paperNotifications';
import { getPaperTrades } from './paperTradeJournal';
import { logger } from './logger';

// Reuses, rather than reimplements:
//  - getCachedCandles/setCachedCandles for "reuse cache, fetch only missing"
//  - withRetry (retry.ts) for transient-failure recovery — NEWLY wired in
//    this phase; previously the scanner had no retry at all, so a single
//    flaky request would just fail that symbol for the whole cycle
//  - trainAndPredict for the AI pipeline, warm-started, min-retrain-interval
//    gated (unchanged logic from Phase 4)
//  - attemptOpenPosition / checkAIExitSignal / monitorOpenPositions for all
//    trade execution and SL/TP/AI-exit monitoring

export type ScannerConfig = {
  pollingIntervalMs: number;
  minRetrainIntervalMs: number;
  maxConcurrency: number; // how many symbols can be in-flight (network+AI) at once
};
const DEFAULT_CONFIG: ScannerConfig = { pollingIntervalMs: 5 * 60 * 1000, minRetrainIntervalMs: 10 * 60 * 1000, maxConcurrency: 3 };

export type ScannerStats = {
  symbolsScanned: number;
  cacheHits: number;
  cacheMisses: number;
  failedRequests: number;
  lastError: string | null;
  avgScanDurationMs: number;
  totalScanDurationMs: number;
  scanCyclesRun: number;
};

export type ScannerStatus = {
  lastScanTime: number | null;
  nextScanTime: number | null;
  currentlyScanning: string[];
  lastResults: Record<string, { action: string; confidence: number; regime: string; riskScore: number }>;
  stats: ScannerStats;
};

const STATUS_KEY = 'scannerStatus';
const CONFIG_KEY = 'scannerConfig';
const LOCK_KEY = 'scannerLock';
const DEFAULT_STATS: ScannerStats = { symbolsScanned: 0, cacheHits: 0, cacheMisses: 0, failedRequests: 0, lastError: null, avgScanDurationMs: 0, totalScanDurationMs: 0, scanCyclesRun: 0 };

export async function getScannerConfig(): Promise<ScannerConfig> {
  const raw = await AsyncStorage.getItem(CONFIG_KEY);
  return raw ? { ...DEFAULT_CONFIG, ...JSON.parse(raw) } : DEFAULT_CONFIG;
}
export async function saveScannerConfig(config: ScannerConfig): Promise<void> {
  await AsyncStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

export async function getScannerStatus(): Promise<ScannerStatus> {
  const raw = await AsyncStorage.getItem(STATUS_KEY);
  if (!raw) return { lastScanTime: null, nextScanTime: null, currentlyScanning: [], lastResults: {}, stats: DEFAULT_STATS };
  const parsed = JSON.parse(raw);
  return { ...parsed, stats: { ...DEFAULT_STATS, ...parsed.stats } };
}
async function saveScannerStatus(status: ScannerStatus): Promise<void> {
  await AsyncStorage.setItem(STATUS_KEY, JSON.stringify(status));
}

// Prevents duplicate/overlapping scans, with a staleness timeout in case a
// previous cycle crashed mid-scan and never released the lock.
async function acquireScanLock(): Promise<boolean> {
  const raw = await AsyncStorage.getItem(LOCK_KEY);
  if (raw && Date.now() - parseInt(raw, 10) < 3 * 60 * 1000) return false;
  await AsyncStorage.setItem(LOCK_KEY, String(Date.now()));
  return true;
}
async function releaseScanLock(): Promise<void> {
  await AsyncStorage.removeItem(LOCK_KEY);
}

// Exported so Phase 1's multi-timeframe evaluator can reuse this exact
// cache-aware, retry-protected fetch path instead of duplicating it.
export async function fetchCandlesForAsset(asset: Asset, tf: string, aoSession: any, avKey: string, stats: ScannerStats): Promise<Candle[]> {
  const cached = await getCachedCandles(asset.symbol, tf);
  if (cached?.isFresh) { stats.cacheHits++; return cached.candles; }
  stats.cacheMisses++;

  try {
    // withRetry recovers from transient network blips / momentary rate
    // limits — 2 retries with exponential backoff, same utility already
    // used by the core fetchers themselves (this wraps the whole
    // fetch-and-fallback decision, not just one HTTP call).
    const fresh = await withRetry(async () => {
      if (asset.src === 'binance' && asset.bnSym) return fetchBnKlines(asset.bnSym, tf);
      if (asset.src === 'ao' && aoSession?.jwtToken && asset.aoToken && asset.aoEx) return aoCandles(asset.aoToken, asset.aoEx, tf, aoSession);
      if (asset.src === 'av' && asset.avSym && avKey) return fetchAVKlines(asset.avSym, tf, avKey);
      return [];
    }, { tag: `scanner-${asset.symbol}`, retries: 2 });

    if (fresh.length) await setCachedCandles(asset.symbol, tf, fresh);
    return fresh.length ? fresh : (cached?.candles || []);
  } catch (e: any) {
    stats.failedRequests++;
    stats.lastError = `${asset.symbol}: ${e.message}`;
    logger.warn('watchlistScanner', `${asset.symbol}: fetch failed after retries, falling back to cache if any: ${e.message}`);
    return cached?.candles || [];
  }
}

// Processes symbols with bounded concurrency — up to maxConcurrency in
// flight at once, rather than fully sequential (slow) or fully unbounded
// (could hammer free-tier rate limits across many symbols at once).
async function processWithConcurrencyLimit<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  async function runNext(): Promise<void> {
    const idx = cursor++;
    if (idx >= items.length) return;
    await worker(items[idx]);
    return runNext();
  }
  const lanes = Array.from({ length: Math.min(limit, items.length) }, () => runNext());
  await Promise.all(lanes);
}

export async function runScanCycle(
  assets: Asset[], tf: string, livePrices: Record<string, number>, aoSession: any, avKey: string
): Promise<ScannerStatus> {
  const gotLock = await acquireScanLock();
  if (!gotLock) {
    logger.warn('watchlistScanner', 'Scan already in progress — skipping this cycle to avoid duplicate scans.');
    return getScannerStatus();
  }

  const cycleStart = Date.now();
  const config = await getScannerConfig();
  const prevStatus = await getScannerStatus();
  const status: ScannerStatus = {
    lastScanTime: cycleStart, nextScanTime: cycleStart + config.pollingIntervalMs,
    currentlyScanning: assets.map(a => a.symbol), lastResults: { ...prevStatus.lastResults },
    stats: { ...prevStatus.stats },
  };
  await saveScannerStatus(status);

  try {
    await monitorOpenPositions(livePrices); // SL/TP/trailing checks every cycle, regardless of which screen is open
    const portfolio = await getPortfolio();

    await processWithConcurrencyLimit(assets, config.maxConcurrency, async (asset) => {
      try {
        const candles = await fetchCandlesForAsset(asset, tf, aoSession, avKey, status.stats);
        status.stats.symbolsScanned++;
        if (candles.length < 60) return;

        const meta = await loadModelMetadata(asset.symbol, tf);
        const recentlyTrained = meta && Date.now() - meta.trainedAt < config.minRetrainIntervalMs;
        if (recentlyTrained) {
          status.lastResults[asset.symbol] = { action: 'CACHED', confidence: meta!.confidence ?? 0, regime: 'n/a', riskScore: 0 };
          return;
        }

        // Model Improvement Phase: use the per-(symbol,timeframe) optimal
        // horizon/threshold if one has been computed (modelOptimization.ts,
        // built from real backtested evidence) — falls back to the
        // existing global defaults automatically when none exists yet,
        // so this is purely additive, never a regression for unoptimized
        // assets.
        const optimalConfig = await getOptimalConfig(asset.symbol, tf);
        const prediction = await trainAndPredict(asset.symbol, tf, candles, optimalConfig?.bestHorizon, optimalConfig?.bestThreshold, false, asset.type);
        if (!prediction) return;

        status.lastResults[asset.symbol] = { action: prediction.action, confidence: prediction.confidence, regime: 'see position', riskScore: prediction.riskScore };

        if (portfolio.mode !== 'AUTO') return;

        const currentPrice = livePrices[asset.symbol] ?? prediction.suggestedEntry;
        const existingPosition = portfolio.openPositions.find(p => p.symbol === asset.symbol);

        if (existingPosition) await checkAIExitSignal(existingPosition, prediction, currentPrice);
        else await attemptOpenPosition(asset.symbol, tf, prediction, currentPrice, candles, asset.type);
      } catch (e: any) {
        status.stats.failedRequests++;
        status.stats.lastError = `${asset.symbol}: ${e.message}`;
        logger.error('watchlistScanner', `${asset.symbol}: scan failed: ${e.message}`);
      }
    });
  } finally {
    status.currentlyScanning = [];
    status.stats.scanCyclesRun++;
    status.stats.totalScanDurationMs += Date.now() - cycleStart;
    status.stats.avgScanDurationMs = status.stats.totalScanDurationMs / status.stats.scanCyclesRun;
    await saveScannerStatus(status);
    await releaseScanLock();
  }

  return status;
}

let dailySummaryInFlight = false;
export async function maybeSendDailySummary(): Promise<void> {
  if (dailySummaryInFlight) return; // a check/send for today is already in progress from an overlapping scan cycle
  dailySummaryInFlight = true;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const lastSent = await AsyncStorage.getItem('lastDailySummaryDate');
    if (lastSent === today) return;

    const trades = await getPaperTrades();
    const todaysTrades = trades.filter(t => new Date(t.exitTime).toISOString().slice(0, 10) === today);
    if (todaysTrades.length === 0) return;

    const netPnl = todaysTrades.reduce((s, t) => s + t.pnl, 0);
    await notifyDailySummary(todaysTrades.length, netPnl);
    await AsyncStorage.setItem('lastDailySummaryDate', today);
  } finally {
    dailySummaryInFlight = false; // ALWAYS cleared, even on early return or exception
  }
}
