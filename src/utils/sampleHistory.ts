import AsyncStorage from '@react-native-async-storage/async-storage';
import { logger } from './logger';

// Sample History — "never silently change sample count." Every time
// loadCandles (ChartScreen.tsx) computes a new final candle count, it's
// appended here with the SAME explanation string already built there
// (Task 6's "Loaded X fresh candles. Merged with Y cached..." message) —
// this module only persists and retrieves that real explanation, it
// doesn't compute a new one.

export type SampleChangeCategory =
  | 'cache_fresh' | 'cache_expired_merged' | 'fresh_download' | 'history_extended'
  | 'gap_repaired' | 'live_tick' | 'manual_refresh' | 'symbol_or_timeframe_switch';

export type SampleHistoryEntry = {
  timestamp: number;
  count: number;
  reason: string;
  category: SampleChangeCategory;
};

const KEY = (symbol: string, timeframe: string) => `sampleHistory_${symbol}_${timeframe}`;
const MAX_ENTRIES = 20;

export async function recordSampleCount(symbol: string, timeframe: string, count: number, reason: string, category: SampleChangeCategory): Promise<void> {
  try {
    const key = KEY(symbol, timeframe);
    const raw = await AsyncStorage.getItem(key);
    const existing: SampleHistoryEntry[] = raw ? JSON.parse(raw) : [];
    // Don't log a no-op duplicate if the count and reason are identical to
    // the most recent entry (e.g. a cache-hit re-render that didn't
    // actually change anything) — only genuine changes are worth a row.
    if (existing.length && existing[0].count === count && existing[0].reason === reason) return;
    const updated = [{ timestamp: Date.now(), count, reason, category }, ...existing].slice(0, MAX_ENTRIES);
    await AsyncStorage.setItem(key, JSON.stringify(updated));
  } catch (e: any) {
    logger.error('sampleHistory', `Failed to record for ${symbol}/${timeframe}: ${e.message}`);
  }
}

export async function getSampleHistory(symbol: string, timeframe: string): Promise<SampleHistoryEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY(symbol, timeframe));
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}
