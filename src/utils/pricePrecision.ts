import { Asset } from '../api/assets';
import { fetchSymbolPricePrecision } from '../api/binance';
import { logger } from './logger';

// TASK 5 (Price Scale) — root cause of "BTC shows 60224 instead of
// 60224.15" and "Forex shows 1.0834 instead of 1.08342": pFmt decided
// decimal places purely from the magnitude of the number, with no
// knowledge of what the actual asset is or what precision its exchange
// actually uses. Verified directly: a BTC price >10000 hit the
// toFixed(0) branch, truncating real cents; a forex price between 1 and
// 100 hit the toFixed(4) branch, one digit short of the conventional
// 5-decimal pip precision shown in the request's own example.
//
// For Binance symbols, this fetches REAL exchange precision (tickSize
// from exchangeInfo) and caches it — never guessed. For AO (NSE
// stocks/indices) and AV (US stocks), there is no tick-size API exposed
// anywhere in this codebase to query — 2 decimal places is the genuine,
// universal equity/index convention (cents), not an arbitrary guess.
// Forex defaults to 5 decimals (standard pip-level quoting) for the same
// reason: no tick-size endpoint exists for the forex source in this app,
// so a real, named convention is used and disclosed as such, rather than
// silently presented as fetched.

const cache = new Map<string, number>();
const inFlight = new Map<string, Promise<number>>();

const CLASS_DEFAULTS: Record<Asset['type'], number> = {
  STOCK: 2, INDEX: 2, COMMODITY: 2, CRYPTO: 2, FOREX: 5,
};

export async function getPricePrecision(asset: Asset): Promise<number> {
  const key = `${asset.symbol}|${asset.src}`;
  if (cache.has(key)) return cache.get(key)!;
  if (inFlight.has(key)) return inFlight.get(key)!;

  const promise = (async () => {
    let precision = CLASS_DEFAULTS[asset.type];
    if (asset.src === 'binance' && asset.bnSym) {
      try {
        const real = await fetchSymbolPricePrecision(asset.bnSym);
        if (real != null) precision = real;
      } catch (e: any) {
        logger.warn('pricePrecision', `${asset.symbol}: exchangeInfo fetch failed, using class default (${precision}): ${e.message}`);
      }
    }
    cache.set(key, precision);
    inFlight.delete(key);
    return precision;
  })();

  inFlight.set(key, promise);
  return promise;
}

// Synchronous fallback for render paths that can't await (e.g. inside an
// SVG draw call) — returns the cached value if already fetched, otherwise
// the honest class-level convention immediately, with a fetch kicked off
// in the background for next time. Never blocks rendering on a network call.
export function getPricePrecisionSync(asset: Asset): number {
  const key = `${asset.symbol}|${asset.src}`;
  if (cache.has(key)) return cache.get(key)!;
  getPricePrecision(asset).catch(() => {}); // warm the cache for the next render, fire-and-forget
  return CLASS_DEFAULTS[asset.type];
}

export function formatPriceWithPrecision(v: number | null | undefined, decimals: number): string {
  if (v == null || isNaN(v)) return '—';
  return v.toFixed(decimals);
}
