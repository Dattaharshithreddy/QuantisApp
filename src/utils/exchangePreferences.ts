// ─────────────────────────────────────────────────────────────────────────────
// EXCHANGE PREFERENCES  (v1.0.0)
//
// Persists the user's preferred exchange per asset, keyed by a stable slug.
// Key: toSlug(asset.name) — lowercase, spaces removed, e.g. 'bitcoin', 'ethereum'.
//
// We use name-derived slugs rather than symbol strings because symbol differs
// per exchange ('BTCUSD' on Binance, 'BTCUSDT' on CoinDCX). Name is stable
// for built-in assets and never changes in practice. The slug normalisation
// (lowercase + no spaces) makes it immune to minor name capitalisation changes.
//
// Usage:
//   await setExchangePreference('Bitcoin', 'coindcx');
//   const src = await getExchangePreference('Bitcoin');
//   // => 'coindcx'
//
// ChartScreen (Phase 2 ExchangeSelector) writes this when the user switches exchange.
// ChartScreen also reads this on mount to restore the previously selected exchange.
// ─────────────────────────────────────────────────────────────────────────────

import AsyncStorage from '@react-native-async-storage/async-storage';
import { KVStore } from '../services/storage';
import { logger } from './logger';

const STORAGE_KEY = 'exchangePreferences_v1';

type ExchangePrefs = Record<string, string>; // name → asset.src

// ── Stable key derivation ────────────────────────────────────────────────────
// Converts a display name to a stable, lowercase, no-space slug.
// 'Bitcoin' → 'bitcoin', 'BNB' → 'bnb', 'Solana' → 'solana'
function toSlug(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '');
}

// ── In-memory cache so repeated reads don't hit AsyncStorage ─────────────────
let _cache: ExchangePrefs | null = null;

async function load(): Promise<ExchangePrefs> {
  if (_cache !== null) return _cache;
  try {
    const raw = await KVStore.get(STORAGE_KEY);
    _cache = raw ? JSON.parse(raw) : {};
  } catch (e: any) {
    logger.warn('exchangePrefs', `Load error: ${e.message}`);
    _cache = {};
  }
  return _cache!;
}

async function save(prefs: ExchangePrefs): Promise<void> {
  _cache = prefs;
  try {
    await KVStore.set(STORAGE_KEY, JSON.stringify(prefs));
  } catch (e: any) {
    logger.warn('exchangePrefs', `Save error: ${e.message}`);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Set the user's preferred exchange for a given asset name.
 * @param name   asset.name, e.g. 'Bitcoin'
 * @param src    asset.src, e.g. 'coindcx' | 'binance'
 */
export async function setExchangePreference(name: string, src: string): Promise<void> {
  const prefs = await load();
  await save({ ...prefs, [toSlug(name)]: src });
}

/**
 * Get the user's preferred exchange src for an asset name.
 * Returns null if no preference has been set.
 */
export async function getExchangePreference(name: string): Promise<string | null> {
  const prefs = await load();
  return prefs[toSlug(name)] ?? null;
}

/**
 * Load all preferences at once — used by MarketsScreen on mount.
 */
export async function getAllExchangePreferences(): Promise<ExchangePrefs> {
  return load();
}

/**
 * Clear cached preferences (call on logout / reset).
 */
export function clearExchangePreferencesCache(): void {
  _cache = null;
}
