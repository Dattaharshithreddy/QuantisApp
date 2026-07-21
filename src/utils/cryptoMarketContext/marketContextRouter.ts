// ─────────────────────────────────────────────────────────────────────────────
// MARKET CONTEXT ROUTER  (v1.0.0)
//
// Auto-detects asset type and returns the appropriate market context.
//
// Routing rules:
//   src === 'binance' or type === 'CRYPTO'  → CryptoMarketContext
//   src === 'ao' or type === 'STOCK'/'INDEX' → MarketContext (Indian)
//   other                                   → null (neutral context)
//
// The returned context is NEVER fed into the 116-feature ML vector.
// It is available for UI display, paper-trade logging, and future use.
// ─────────────────────────────────────────────────────────────────────────────

import { fetchMarketContext } from '../marketContext/marketContextFetch';
import { fetchCryptoMarketContext } from './cryptoMarketContextFetch';
import type { MarketContext } from '../marketContext/marketContextTypes';
import type { CryptoMarketContext } from './cryptoMarketContextTypes';

export type UnifiedMarketContext =
  | { kind: 'CRYPTO'; ctx: CryptoMarketContext }
  | { kind: 'INDIAN'; ctx: MarketContext }
  | { kind: 'NONE' };

export function detectAssetKind(
  src: string,
  assetType?: string,
): 'CRYPTO' | 'INDIAN' | 'NONE' {
  if (src === 'binance' || assetType === 'CRYPTO')           return 'CRYPTO';
  if (src === 'ao'      || assetType === 'STOCK' || assetType === 'INDEX') return 'INDIAN';
  return 'NONE';
}

// Fetch market context for any asset — never throws
export async function fetchUnifiedMarketContext(
  symbol:    string,
  src:       string,
  assetType?: string,
): Promise<UnifiedMarketContext> {
  const kind = detectAssetKind(src, assetType);
  const _start = Date.now();
  try {
    let result: UnifiedMarketContext;
    if (kind === 'CRYPTO') {
      const ctx = await fetchCryptoMarketContext(symbol);
      result = { kind: 'CRYPTO', ctx };
    } else if (kind === 'INDIAN') {
      const ctx = await fetchMarketContext();
      result = { kind: 'INDIAN', ctx };
    } else {
      result = { kind: 'NONE' };
    }
    import('../performanceMetrics').then(m => m.recordMetric('market_context', Date.now() - _start)).catch(() => {});
    return result;
  } catch (e: any) {
    // Non-fatal — prediction continues without context
  }
  return { kind: 'NONE' };
}
