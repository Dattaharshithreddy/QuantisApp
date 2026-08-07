// ─────────────────────────────────────────────────────────────────────────────
// ASSET RESOLVER  (v1.0.0)
//
// Single source of truth for resolving (assetId, exchange) → ExchangeVariant.
//
// This module is the bridge between:
//   • The UI layer  (assetId='BTC', exchange='coindcx')
//   • The data layer (variant.symbol='BTCUSDT', variant.src='coindcx')
//   • The ML layer   (symbol='BTCUSDT' — never changes)
//
// Rules:
//   1. All functions are pure — no side effects, no async, no state.
//   2. resolveVariant always returns SOMETHING — falls back to defaultExchange.
//   3. resolveSymbol returns undefined only for unknown assets (not null — callers
//      can use `?? 'UNKNOWN'` rather than needing null checks in hot paths).
//   4. findAssetByLegacySymbol provides backward compat for existing navigation
//      params and trade records that carry `symbol:'BTCUSD'` not `assetId:'BTC'`.
// ─────────────────────────────────────────────────────────────────────────────

import { ASSETS, LogicalAsset, ExchangeVariant } from '../api/assets';

// ── Lookup maps (built once at module load, O(1) access) ─────────────────────

// assetId → LogicalAsset
const BY_ID = new Map<string, LogicalAsset>(
  ASSETS.map(a => [a.id, a])
);

// variant.symbol → { assetId, exchange } — for backward compat
const BY_LEGACY_SYMBOL = new Map<string, { assetId: string; exchange: string }>();
for (const asset of ASSETS) {
  for (const [src, variant] of Object.entries(asset.exchanges)) {
    // Only register the first entry for a given symbol to avoid ambiguity
    if (!BY_LEGACY_SYMBOL.has(variant.symbol)) {
      BY_LEGACY_SYMBOL.set(variant.symbol, { assetId: asset.id, exchange: src });
    }
  }
}

// ── Core resolver ─────────────────────────────────────────────────────────────

/**
 * Resolve (assetId, exchange) → ExchangeVariant.
 *
 * Falls back to asset.defaultExchange if the requested exchange is not
 * available for this asset. Returns undefined only if assetId is unknown.
 *
 * @example
 * resolveVariant('BTC', 'coindcx')  // → { src:'coindcx', symbol:'BTCUSDT', ... }
 * resolveVariant('BTC', 'bybit')    // → falls back to Binance (defaultExchange)
 * resolveVariant('UNKNOWN', 'binance') // → undefined
 */
export function resolveVariant(
  assetId: string,
  exchange: string,
): ExchangeVariant | undefined {
  const asset = BY_ID.get(assetId);
  if (!asset) return undefined;
  return asset.exchanges[exchange] ?? asset.exchanges[asset.defaultExchange];
}

/**
 * Get the LogicalAsset for an assetId.
 */
export function resolveAsset(assetId: string): LogicalAsset | undefined {
  return BY_ID.get(assetId);
}

/**
 * Get the INTERNAL symbol string for (assetId, exchange).
 * This is the string used by ML storage, candle cache, and price feeds.
 *
 * @example
 * resolveSymbol('BTC', 'binance')  // → 'BTCUSD'
 * resolveSymbol('BTC', 'coindcx') // → 'BTCUSDT'
 * resolveSymbol('UNKNOWN', 'x')   // → undefined
 */
export function resolveSymbol(
  assetId: string,
  exchange: string,
): string | undefined {
  return resolveVariant(assetId, exchange)?.symbol;
}

/**
 * List all available exchange keys for a given asset.
 * Returns an empty array for unknown assets.
 *
 * @example
 * getAvailableExchanges('BTC')     // → ['binance', 'coindcx', 'binance_futures']
 * getAvailableExchanges('NIFTY50') // → ['ao']
 * getAvailableExchanges('UNKNOWN') // → []
 */
export function getAvailableExchanges(assetId: string): string[] {
  const asset = BY_ID.get(assetId);
  if (!asset) return [];
  return Object.keys(asset.exchanges);
}

// ── Backward compatibility ────────────────────────────────────────────────────

/**
 * Resolve an old-style symbol string to { assetId, exchange }.
 * Used to handle legacy navigation params: { symbol: 'BTCUSD' }.
 *
 * @example
 * findAssetByLegacySymbol('BTCUSD')   // → { assetId:'BTC', exchange:'binance' }
 * findAssetByLegacySymbol('BTCUSDT')  // → { assetId:'BTC', exchange:'coindcx' }
 * findAssetByLegacySymbol('UNKNOWN')  // → null
 */
export function findAssetByLegacySymbol(
  symbol: string,
): { assetId: string; exchange: string } | null {
  return BY_LEGACY_SYMBOL.get(symbol) ?? null;
}

/**
 * Convert a legacy Asset-shaped object (the old flat Asset type) to
 * { assetId, exchange }. Used during migration of custom assets stored
 * in AsyncStorage under the old flat format.
 *
 * Looks up by legacy symbol first, falls back to assetId === symbol.
 */
export function resolveFromLegacyAsset(
  legacySymbol: string,
  legacySrc: string,
): { assetId: string; exchange: string } {
  // Try exact symbol match first
  const bySymbol = BY_LEGACY_SYMBOL.get(legacySymbol);
  if (bySymbol) return bySymbol;
  // Fall back: treat the symbol as an assetId directly
  return { assetId: legacySymbol, exchange: legacySrc };
}

// ── Bulk helpers ──────────────────────────────────────────────────────────────

/**
 * Expand ASSETS into a flat array of (asset, variant) pairs.
 * Used by DataContext to seed prices and subscribe to feeds.
 */
export function allVariants(): Array<{ asset: LogicalAsset; variant: ExchangeVariant }> {
  const result: Array<{ asset: LogicalAsset; variant: ExchangeVariant }> = [];
  for (const asset of ASSETS) {
    for (const variant of Object.values(asset.exchanges)) {
      result.push({ asset, variant });
    }
  }
  return result;
}

/**
 * Get all variants for a specific exchange src across all assets.
 * Used by DataContext to build per-exchange price subscriptions.
 *
 * @example
 * variantsForExchange('binance')  // → all Binance spot variants
 * variantsForExchange('coindcx') // → all CoinDCX variants
 */
export function variantsForExchange(
  src: string,
): Array<{ asset: LogicalAsset; variant: ExchangeVariant }> {
  return allVariants().filter(({ variant }) => variant.src === src);
}
