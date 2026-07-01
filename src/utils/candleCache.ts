import AsyncStorage from '@react-native-async-storage/async-storage';
import { Candle } from './indicators';
import { logger } from './logger';

// Local candle cache, keyed by symbol+timeframe, with a per-timeframe TTL.
// Lets the chart render instantly from cache while a fresh fetch runs in the
// background, and reduces redundant API calls (helps a lot against Alpha
// Vantage's tiny daily rate limit specifically).
const TTL_MS: Record<string, number> = {
  '1m': 60 * 1000, '5m': 3 * 60 * 1000, '15m': 5 * 60 * 1000,
  '1h': 15 * 60 * 1000, '4h': 30 * 60 * 1000, '1D': 60 * 60 * 1000, '1W': 4 * 60 * 60 * 1000,
};

const key = (symbol: string, tf: string) => `candleCache_${symbol}_${tf}`;

export async function getCachedCandles(symbol: string, tf: string): Promise<{ candles: Candle[]; isFresh: boolean } | null> {
  try {
    const raw = await AsyncStorage.getItem(key(symbol, tf));
    if (!raw) return null;
    const { candles, fetchedAt } = JSON.parse(raw);
    const ttl = TTL_MS[tf] ?? 5 * 60 * 1000;
    return { candles, isFresh: Date.now() - fetchedAt < ttl };
  } catch (e: any) {
    logger.warn('candleCache', `Read failed for ${symbol}/${tf}: ${e.message}`);
    return null;
  }
}

export async function setCachedCandles(symbol: string, tf: string, candles: Candle[]): Promise<void> {
  try {
    await AsyncStorage.setItem(key(symbol, tf), JSON.stringify({ candles, fetchedAt: Date.now() }));
  } catch (e: any) {
    logger.warn('candleCache', `Write failed for ${symbol}/${tf}: ${e.message}`);
  }
}

// Merges freshly-fetched candles with cached ones, deduping by timestamp —
// used so panning-loaded history and cache don't produce duplicate bars.
export function mergeCandles(cached: Candle[], fresh: Candle[]): Candle[] {
  const byTime = new Map<number, Candle>();
  cached.forEach(c => byTime.set(c.time, c));
  fresh.forEach(c => byTime.set(c.time, c)); // fresh data wins on overlap
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}
