import { Candle } from './indicators';
import { Asset } from '../api/assets';
import { fetchMaxHistory, MaxHistoryResult } from './maxHistoryFetch';
import { fetchBnKlines } from '../api/binance';
import { aoCandles, aoCandlesBefore, aoCandlesFrom, AOSession } from '../api/angelOne';
import { fetchCandlesWithCache, isHistoryExhausted, markHistoryExhausted } from './candleCache';
import { fetchAVKlines } from '../api/alphaVantage';
import { logger } from './logger';
import { fetchCdxCandles } from '../api/coindcx';
import { mergeIntoArchive, loadFromArchive, archiveKey } from './historicalArchive';

// ── Capability classification ─────────────────────────────────────────────────
export type FetchCapability = 'full_pagination' | 'single_call_capped' | 'unsupported';

export function getFetchCapability(asset: Asset): FetchCapability {
  if (asset.src === 'binance') return 'full_pagination';
  if (asset.src === 'ao' || asset.src === 'ao_futures') return 'full_pagination';
  if (asset.src === 'coindcx' || asset.src === 'coindcx_futures') return 'single_call_capped';
  if (asset.src === 'av') return 'single_call_capped';
  return 'unsupported';
}

// ── Angel One paginated history ───────────────────────────────────────────────
async function fetchMaxHistoryAO(
  token: string, exchange: string, tf: string,
  session: AOSession, targetBars: number,
): Promise<Candle[]> {
  const chunks: Candle[][] = [];
  let totalFetched = 0;
  let first = await aoCandles(token, exchange, tf, session);
  if (!first.length) return [];
  chunks.push(first);
  totalFetched += first.length;

  const maxChunks = Math.ceil(targetBars / Math.max(1, first.length)) + 2;
  for (let i = 0; i < maxChunks && totalFetched < targetBars; i++) {
    const oldestSoFar = chunks[0][0].time;
    let older: Candle[];
    try {
      older = await aoCandlesBefore(token, exchange, tf, oldestSoFar, session);
    } catch (e: any) {
      logger.warn('multiSourceFetch', `AO pagination chunk ${i} failed: ${e.message}`);
      break;
    }
    if (!older.length) break;
    chunks.unshift(older);
    totalFetched += older.length;
    if (older.length < Math.max(5, first.length * 0.1)) break;
  }

  const byTime = new Map<number, Candle>();
  chunks.flat().forEach(c => byTime.set(c.time, c));
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time).slice(-targetBars);
}

// ── Exchange name helper ──────────────────────────────────────────────────────
function exchangeFor(asset: Asset): string {
  if (asset.src === 'binance') return 'binance';
  if (asset.src === 'ao' || asset.src === 'ao_futures') return 'angelone';
  if (asset.src === 'coindcx' || asset.src === 'coindcx_futures') return 'coindcx';
  if (asset.src === 'av') return 'av';
  return 'unknown';
}

// ── Main export ───────────────────────────────────────────────────────────────
// Flow for full_pagination sources:
//   1. Load Firebase archive (up to 50K candles, persisted across sessions)
//   2. Determine newest archived timestamp
//   3. Fetch ONLY candles newer than that from exchange API (incremental)
//   4. Merge new + archived, persist updated archive to Firebase
//   5. Return merged candles (capped at targetBars)
//
// For single_call_capped sources (CoinDCX, AV):
//   Use fetchCandlesWithCache (AsyncStorage), unchanged behavior.
//   Archive not used for these — single call returns a fixed window.
export async function fetchMaxHistoryForAsset(
  asset: Asset,
  tf: string,
  targetBars: number,
  aoSession: AOSession | null,
  avKey: string | null,
): Promise<{ candles: Candle[]; capability: FetchCapability; note: string | null }> {
  const capability = getFetchCapability(asset);
  const exchange   = exchangeFor(asset);

  if (capability === 'unsupported') {
    return {
      candles: [],
      capability,
      note: `${asset.symbol}: no historical data source exists for forex in this app (only live spot rates) — cannot be evaluated.`,
    };
  }

  // ── Binance ────────────────────────────────────────────────────────────────
  if (asset.src === 'binance' && asset.bnSym) {
    const bnSym = asset.bnSym;
    const CORRECTION_WINDOW = 10;

    // 1. Load archive (Firebase → AsyncStorage fallback)
    const { candles: archived } = await loadFromArchive(asset.symbol, tf, exchange);
    const newestArchivedTime = archived.length ? archived[archived.length - 1].time : null;

    // 2. Incremental fetch from exchange
    let freshCandles: Candle[] = [];
    try {
      if (newestArchivedTime) {
        const tfMs: Record<string, number> = {
          '1m':60000,'3m':180000,'5m':300000,'15m':900000,
          '30m':1800000,'1h':3600000,'4h':14400000,'1D':86400000,
        };
        const barMs = tfMs[tf] ?? 900000;
        const fromTime = newestArchivedTime - (CORRECTION_WINDOW * barMs);
        freshCandles = await fetchBnKlines(bnSym, tf, 1000, undefined, fromTime);
      } else {
        // No archive yet — paginate full history
        const alreadyExhausted = await isHistoryExhausted(asset.symbol, tf);
        if (!alreadyExhausted) {
          const result: MaxHistoryResult = await fetchMaxHistory(bnSym, tf, targetBars);
          if (result.historyExhausted) await markHistoryExhausted(asset.symbol, tf);
          freshCandles = result.candles;
        }
      }
    } catch (e: any) {
      logger.warn('multiSourceFetch', `${asset.symbol}/${tf}: Binance fetch failed: ${e.message}`);
    }

    // 3. If we only got a small incremental update but archive is thin, backfill
    if (archived.length < targetBars && freshCandles.length < targetBars) {
      const alreadyExhausted = await isHistoryExhausted(asset.symbol, tf);
      if (!alreadyExhausted) {
        logger.info('multiSourceFetch',
          `${asset.symbol}/${tf}: archive has ${archived.length} < ${targetBars}, backfilling...`);
        try {
          const result: MaxHistoryResult = await fetchMaxHistory(bnSym, tf, targetBars);
          if (result.historyExhausted) await markHistoryExhausted(asset.symbol, tf);
          // Merge backfill + any fresh candles we already got
          const byTime = new Map<number, Candle>();
          [...result.candles, ...freshCandles].forEach(c => byTime.set(c.time, c));
          freshCandles = Array.from(byTime.values()).sort((a, b) => a.time - b.time);
        } catch (e: any) {
          logger.warn('multiSourceFetch', `${asset.symbol}/${tf}: backfill failed: ${e.message}`);
        }
      }
    }

    // 4. Merge into archive (Firebase persisted)
    const merged = await mergeIntoArchive(asset.symbol, tf, exchange, freshCandles);

    // 5. Also persist in AsyncStorage cache for chart/fast-path access
    if (merged.length) {
      const { fetchCandlesWithCache: _fcc } = require('./candleCache');
      // Write fresh portion only to candleCache (chart uses this for TTL)
      // Do not await — background write
      const { writeCache } = require('./candleCache');
      // Use setCachedCandles to update chart-side cache with latest window
      const { setCachedCandles } = require('./candleCache');
      const chartWindow = merged.slice(-Math.min(10_000, merged.length));
      setCachedCandles(asset.symbol, tf, chartWindow).catch(() => {});
    }

    const result = merged.slice(-targetBars);
    logger.info('multiSourceFetch',
      `${asset.symbol}/${tf}: returning ${result.length} bars (archive=${merged.length})`);
    return { candles: result, capability, note: null };
  }

  // ── Angel One ─────────────────────────────────────────────────────────────
  if ((asset.src === 'ao' || asset.src === 'ao_futures') && asset.aoToken && asset.aoEx) {
    if (!aoSession?.jwtToken) {
      return {
        candles: [],
        capability,
        note: `${asset.symbol}: Angel One not connected — connect it in Settings to evaluate this symbol.`,
      };
    }
    const { aoToken, aoEx } = asset;
    const session = aoSession;
    const CORRECTION_WINDOW = 10;

    // 1. Load archive
    const { candles: archived } = await loadFromArchive(asset.symbol, tf, exchange);
    const newestArchivedTime = archived.length ? archived[archived.length - 1].time : null;

    // 2. Incremental fetch
    let freshCandles: Candle[] = [];
    try {
      if (newestArchivedTime) {
        const tfMs: Record<string, number> = {
          '1m':60000,'3m':180000,'5m':300000,'15m':900000,
          '30m':1800000,'1h':3600000,'4h':14400000,'1D':86400000,
        };
        const barMs = tfMs[tf] ?? 900000;
        const fromTime = newestArchivedTime - (CORRECTION_WINDOW * barMs);
        freshCandles = await aoCandlesFrom(aoToken, aoEx, tf, fromTime, session);
      } else {
        freshCandles = await fetchMaxHistoryAO(aoToken, aoEx, tf, session, targetBars);
      }
    } catch (e: any) {
      logger.warn('multiSourceFetch', `${asset.symbol}/${tf}: AO fetch failed: ${e.message}`);
    }

    // 3. Merge into archive
    const merged = await mergeIntoArchive(asset.symbol, tf, exchange, freshCandles);
    const { setCachedCandles } = require('./candleCache');
    const chartWindow = merged.slice(-Math.min(10_000, merged.length));
    setCachedCandles(asset.symbol, tf, chartWindow).catch(() => {});

    return { candles: merged.slice(-targetBars), capability, note: null };
  }

  // ── CoinDCX (single_call_capped — no archive) ─────────────────────────────
  if ((asset.src === 'coindcx' || asset.src === 'coindcx_futures') && (asset as any).cdxSym) {
    const candles = await fetchCdxCandles((asset as any).cdxSym, tf, Math.min(targetBars, 1000));
    return { candles, capability, note: null };
  }

  // ── Alpha Vantage (single_call_capped) ────────────────────────────────────
  if (asset.src === 'av' && asset.avSym) {
    if (!avKey) {
      return {
        candles: [],
        capability,
        note: `${asset.symbol}: Alpha Vantage key not set — add one in Settings to evaluate this symbol.`,
      };
    }
    const avSym = asset.avSym;
    const key   = avKey;
    const candles = await fetchCandlesWithCache(
      asset.symbol, tf,
      async () => fetchAVKlines(avSym, tf, key),
      { maxCandles: targetBars, forceRefresh: true },
    );
    const note = candles.length
      ? `${asset.symbol}: Alpha Vantage's free tier returns a single, capped window — this is the maximum history available, not a partial fetch. Cache will accumulate more over time.`
      : null;
    return { candles, capability, note };
  }

  return { candles: [], capability: 'unsupported', note: `${asset.symbol}: no usable data source configuration found.` };
}
