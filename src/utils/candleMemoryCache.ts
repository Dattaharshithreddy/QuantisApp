// ─────────────────────────────────────────────────────────────────────────────
// IN-MEMORY CANDLE CACHE
//
// Fastest possible cache — Map in JS heap, 0ms reads.
// Lives for the entire app session. Cleared per-symbol on symbol change.
//
// Layer order:
//   L1: Memory (this file)    — 0ms
//   L2: AsyncStorage          — ~50ms
//   L3: Firestore             — ~200ms
//   L4: Binance REST          — ~800ms
//
// Why memory cache matters:
//   User loads 15m → 800ms Binance fetch → stored in memory
//   User switches to 1h → prefetch already ran → 0ms from memory
//   User switches back to 15m → 0ms from memory
//   No network call, no AsyncStorage read, no render delay
// ─────────────────────────────────────────────────────────────────────────────
import { Candle } from './indicators';

// Singleton map — lives for entire app session
const store = new Map<string, { candles: Candle[]; fetchedAt: number }>();

// Adjacent timeframes to prefetch when a TF loads
const ADJACENT: Record<string, string[]> = {
  '1m':  ['5m'],
  '5m':  ['1m', '15m'],
  '15m': ['5m', '1h'],
  '30m': ['15m', '1h'],
  '1h':  ['15m', '4h'],
  '4h':  ['1h', '1D'],
  '1D':  ['4h', '1W'],
  '1W':  ['1D'],
};

function key(symbol: string, tf: string): string {
  return `${symbol}_${tf}`;
}

// Read from memory — 0ms
export function memGet(symbol: string, tf: string): Candle[] | null {
  return store.get(key(symbol, tf))?.candles ?? null;
}

// Write to memory
export function memSet(symbol: string, tf: string, candles: Candle[]): void {
  if (!candles.length) return;
  store.set(key(symbol, tf), { candles, fetchedAt: Date.now() });
}

// Evict all TFs for a symbol (call on symbol change to free memory)
export function memEvict(symbol: string): void {
  for (const k of store.keys()) {
    if (k.startsWith(`${symbol}_`)) store.delete(k);
  }
}

// Get adjacent TFs to prefetch for a given TF
export function getAdjacentTfs(tf: string): string[] {
  return ADJACENT[tf] ?? [];
}

// Memory cache size (for diagnostics)
export function memCacheSize(): number {
  return store.size;
}
