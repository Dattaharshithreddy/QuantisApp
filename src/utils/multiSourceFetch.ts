import { Candle } from './indicators';
import { Asset } from '../api/assets';
import { fetchMaxHistory } from './maxHistoryFetch';
import { aoCandles, aoCandlesBefore, aoCandlesFrom, AOSession } from '../api/angelOne';
import { fetchCandlesWithCache } from './candleCache';
import { fetchAVKlines } from '../api/alphaVantage';
import { logger } from './logger';

// TASK 7/8 (Verification & Production Evaluation, asset-class support) —
// before extending the symbol selector to all asset classes, this had to
// be checked first: does this app actually have a way to fetch enough
// HISTORY to evaluate each asset class, or would expanding the selector
// just let people select symbols that silently fail?
//
// Checked directly against the real API files:
//   - binance (crypto): fetchMaxHistory already paginates properly.
//   - ao (NSE stocks/indices): aoCandlesBefore exists — real pagination
//     is possible, just not previously assembled into a "fetch maximum
//     history" loop the way Binance's already was. Built below.
//   - av (US stocks): fetchAVKlines is a SINGLE call with no "before X"
//     pagination function anywhere in this codebase — genuinely capped
//     at whatever one call returns. Not a bug to fix; a real platform
//     limit, reported honestly rather than silently retried forever.
//   - forex: there is NO historical candle endpoint anywhere in this
//     app — api/forex.ts only has fetchForexRates(), which returns live
//     spot rates, not OHLC history. Forex assets genuinely cannot be
//     backtested/evaluated here. Surfaced explicitly below, not
//     fabricated by treating a live rate as a fake candle.

export type FetchCapability = 'full_pagination' | 'single_call_capped' | 'unsupported';

export function getFetchCapability(asset: Asset): FetchCapability {
  if (asset.src === 'binance') return 'full_pagination';
  if (asset.src === 'ao') return 'full_pagination';
  if (asset.src === 'av') return 'single_call_capped';
  return 'unsupported'; // forex, and anything else with no historical source
}

// Paginate backward through AngelOne history using aoCandlesBefore.
// Exported so callers can use it as a fetcher lambda inside fetchCandlesWithCache.
async function fetchMaxHistoryAO(token: string, exchange: string, tf: string, session: AOSession, targetBars: number): Promise<Candle[]> {
  const chunks: Candle[][] = [];
  let totalFetched = 0;
  let first = await aoCandles(token, exchange, tf, session);
  if (!first.length) return [];
  chunks.push(first);
  totalFetched += first.length;

  const maxChunks = Math.ceil(targetBars / Math.max(1, first.length)) + 1;
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

export async function fetchMaxHistoryForAsset(
  asset: Asset, tf: string, targetBars: number, aoSession: AOSession | null, avKey: string | null
): Promise<{ candles: Candle[]; capability: FetchCapability; note: string | null }> {
  const capability = getFetchCapability(asset);

  if (capability === 'unsupported') {
    return { candles: [], capability, note: `${asset.symbol}: no historical data source exists for forex in this app (only live spot rates) — cannot be evaluated.` };
  }

  if (asset.src === 'binance' && asset.bnSym) {
    // Binance: fetchCandlesWithCache with incremental fetcher.
    // newestCachedTime is passed to fetchBnKlines endTime so we only
    // fetch candles NEWER than what cache already has.
    const bnSym = asset.bnSym;
    // CORRECTION_WINDOW: always re-fetch the last N candles to catch broker corrections.
    // Some brokers revise OHLC/volume on the latest closed candle after market close.
    // Re-fetching 10 bars of overlap ensures corrections are picked up on next sync.
    const CORRECTION_WINDOW = 10;
    const candles = await fetchCandlesWithCache(
      asset.symbol, tf,
      async (newestCachedTime) => {
        if (newestCachedTime) {
          // True incremental fetch: request ONLY candles newer than cache.
          // Subtract correction window so last 10 bars are always refreshed.
          const tfMs: Record<string, number> = {
            '1m':60000,'3m':180000,'5m':300000,'15m':900000,
            '30m':1800000,'1h':3600000,'4h':14400000,'1D':86400000,
          };
          const barMs = tfMs[tf] ?? 900000;
          const fromTime = newestCachedTime - (CORRECTION_WINDOW * barMs);
          // Binance API: limit=1000 with startTime gives exactly what we need
          return fetchBnKlines(bnSym, tf, 1000, undefined, fromTime);
        }
        // No cache — fetch full history
        return fetchMaxHistory(bnSym, tf, targetBars);
      },
      { maxCandles: targetBars, forceRefresh: true },
    );
    return { candles, capability, note: null };
  }

  if (asset.src === 'ao' && asset.aoToken && asset.aoEx) {
    if (!aoSession?.jwtToken) return { candles: [], capability, note: `${asset.symbol}: Angel One not connected — connect it in Settings to evaluate this symbol.` };
    const { aoToken, aoEx } = asset;
    const session = aoSession;
    const CORRECTION_WINDOW = 10;
    const candles = await fetchCandlesWithCache(
      asset.symbol, tf,
      async (newestCachedTime) => {
        if (newestCachedTime) {
          // True incremental fetch: request only candles after newestCachedTime.
          // Correction window: re-fetch last 10 bars so broker revisions are caught.
          const tfMs: Record<string, number> = {
            '1m':60000,'3m':180000,'5m':300000,'15m':900000,
            '30m':1800000,'1h':3600000,'4h':14400000,'1D':86400000,
          };
          const barMs = tfMs[tf] ?? 900000;
          const fromTime = newestCachedTime - (CORRECTION_WINDOW * barMs);
          return aoCandlesFrom(aoToken, aoEx, tf, fromTime, session);
        }
        // No cache — fetch full paginated history to seed cache
        return fetchMaxHistoryAO(aoToken, aoEx, tf, session, targetBars);
      },
      { maxCandles: targetBars, forceRefresh: true },
    );
    return { candles, capability, note: null };
  }

  if (asset.src === 'av' && asset.avSym) {
    if (!avKey) return { candles: [], capability, note: `${asset.symbol}: Alpha Vantage key not set — add one in Settings to evaluate this symbol.` };
    const avSym = asset.avSym;
    const key = avKey;
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
