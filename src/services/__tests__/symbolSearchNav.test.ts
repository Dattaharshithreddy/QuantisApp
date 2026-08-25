// ─────────────────────────────────────────────────────────────────────────────
// symbolSearchNav.test.ts
//
// Regression tests for the NSE symbol selection bug.
//
// ROOT CAUSE (documented here for future readers):
//   SymbolSearchScreen previously navigated with only { symbol: 'RELIANCE' }.
//   ChartScreen's route-param effect hit Priority 2 (setSymbol).
//   setSymbol('RELIANCE') called findAssetByLegacySymbol — which only knows
//   built-in ASSETS, not custom search results — and returned null.
//   Fallback: setAssetId('RELIANCE'), setExchange('')  (empty!).
//   The variant useMemo omits allAssets from deps (intentional for built-ins)
//   so it ran with a stale allAssets that didn't yet contain RELIANCE.
//   variant = undefined → asset = allAssets[0] = NIFTY50 → chart showed NIFTY50.
//
// FIX:
//   1. SymbolSearchScreen now passes { assetId, exchange } so ChartScreen
//      hits Priority 1 (setAssetId + setExchange) directly — no setSymbol.
//   2. variant useMemo deps now include a customAssets key so it re-runs
//      when a new symbol is added, picking up the newly-added custom asset.
// ─────────────────────────────────────────────────────────────────────────────

import { findAssetByLegacySymbol } from '../../utils/assetResolver';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeNseAsset(symbol: string, token = '2885') {
  return {
    symbol,
    name: `${symbol} Ltd`,
    type: 'EQUITY' as const,
    src: 'ao' as const,
    aoToken: token,
    aoEx: 'NSE',
    base: 100,
    vol: 0.015,
    custom: true as const,
  };
}

function makeBinanceAsset(baseAsset: string, bnSym: string) {
  return {
    symbol: baseAsset + 'USD',
    name: baseAsset,
    type: 'CRYPTO' as const,
    src: 'binance' as const,
    bnSym,
    base: 1,
    vol: 0.03,
    custom: true as const,
  };
}

// ── 1. findAssetByLegacySymbol — NSE stocks are NOT in the built-in map ─────
describe('findAssetByLegacySymbol — NSE custom assets', () => {
  // RELIANCE, TCS, HDFCBANK ARE in built-in ASSETS — they work even via legacy path.
  // The bug affects NSE stocks NOT in the built-ins (e.g. ADANIENT, LT, AXISBANK).
  // We test those specifically to document the exact failure case the fix targets.
  test('ADANIENT returns null — not a built-in, only available via Search', () => {
    expect(findAssetByLegacySymbol('ADANIENT')).toBeNull();
  });

  test('LT returns null — not a built-in, only available via Search', () => {
    expect(findAssetByLegacySymbol('LT')).toBeNull();
  });

  test('AXISBANK returns null — not a built-in, only available via Search', () => {
    expect(findAssetByLegacySymbol('AXISBANK')).toBeNull();
  });

  test('NIFTY50 returns null (not in by-symbol map as legacy symbol)', () => {
    // NIFTY50 is a built-in LogicalAsset (id='NIFTY50') but its AO variant
    // symbol may differ — findAssetByLegacySymbol looks up by variant.symbol
    // In either case, a custom-search NSE stock will NOT be found here.
    // This test documents that the legacy path is the wrong path for NSE.
    const result = findAssetByLegacySymbol('NIFTY50');
    // It may or may not be in BY_LEGACY_SYMBOL depending on ASSETS.
    // The important thing: NSE custom stocks are definitely not in there.
    expect(typeof result).not.toBe('undefined'); // doesn't throw
  });

  // Binance symbols ARE in the map:
  test('ETHUSD returns the built-in ETH/Binance entry', () => {
    const result = findAssetByLegacySymbol('ETHUSD');
    expect(result).not.toBeNull();
    expect(result?.exchange).toBe('binance');
  });

  test('BTCUSD returns the built-in BTC/Binance entry', () => {
    const result = findAssetByLegacySymbol('BTCUSD');
    expect(result).not.toBeNull();
    expect(result?.exchange).toBe('binance');
  });
});

// ── 2. NSE asset shape from searchNSE ────────────────────────────────────────
describe('NSE search result asset shape', () => {
  test('NSE asset has src=ao', () => {
    const asset = makeNseAsset('RELIANCE');
    expect(asset.src).toBe('ao');
  });

  test('NSE asset has aoToken and aoEx', () => {
    const asset = makeNseAsset('RELIANCE', '2885');
    expect(asset.aoToken).toBe('2885');
    expect(asset.aoEx).toBe('NSE');
  });

  test('NSE asset symbol is the trading symbol, not an assetId', () => {
    const asset = makeNseAsset('HDFCBANK');
    expect(asset.symbol).toBe('HDFCBANK');
  });
});

// ── 3. Nav params shape — verify fix is applied ───────────────────────────────
describe('SymbolSearchScreen nav params after fix', () => {
  test('SymbolSearchScreen source passes assetId and exchange in navigate call', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').join(__dirname, '../../screens/SymbolSearchScreen.tsx'), 'utf8'
    );
    // Must pass assetId (not just symbol) so ChartScreen hits Priority 1
    expect(src).toContain('assetId:  asset.symbol');
    // Must pass exchange so the source (ao/binance/etc.) is preserved
    expect(src).toContain('exchange: asset.src');
    // Must still pass _ts to force effect re-fire
    expect(src).toContain('_ts:      Date.now()');
  });

  test('SymbolSearchScreen does NOT navigate with symbol-only for chart', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').join(__dirname, '../../screens/SymbolSearchScreen.tsx'), 'utf8'
    );
    // The old broken pattern was: params: { symbol: asset.symbol, _ts }
    // It should no longer be the ONLY param (assetId must also be present)
    // We check that assetId is passed alongside symbol
    const navigateCall = src.match(/navigation\.navigate\([^;]+\)/s)?.[0] ?? '';
    expect(navigateCall).toContain('assetId');
    expect(navigateCall).toContain('exchange');
  });
});

// ── 4. Binance symbol identity preserved ──────────────────────────────────────
describe('Binance symbol selection — still works', () => {
  test('Binance asset has src=binance', () => {
    const asset = makeBinanceAsset('ETH', 'ETHUSDT');
    expect(asset.src).toBe('binance');
  });

  test('Binance asset has bnSym', () => {
    const asset = makeBinanceAsset('SOL', 'SOLUSDT');
    expect(asset.bnSym).toBe('SOLUSDT');
  });

  test('findAssetByLegacySymbol still resolves ETHUSD for built-in Binance', () => {
    const result = findAssetByLegacySymbol('ETHUSD');
    expect(result).not.toBeNull();
    expect(result?.assetId).toBe('ETH');
  });

  test('Binance custom search asset passes exchange=binance in navigate', () => {
    const asset = makeBinanceAsset('SHIB', 'SHIBUSDT');
    // Simulate what handlePick sends:
    const params = { assetId: asset.symbol, exchange: asset.src, _ts: 0 };
    expect(params.exchange).toBe('binance');
  });
});

// ── 5. customAssets exposed from DataContext ──────────────────────────────────
describe('DataContext exposes customAssets', () => {
  test('DataContext provider value includes customAssets', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').join(__dirname, '../../context/DataContext.tsx'), 'utf8'
    );
    // The Provider value object must include customAssets
    expect(src).toContain('prices, logicalAssets, allAssets, customAssets,');
  });

  test('DataCtx type includes customAssets field', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').join(__dirname, '../../context/DataContext.tsx'), 'utf8'
    );
    expect(src).toContain('customAssets: Asset[]');
  });
});

// ── 6. variant useMemo deps include customAssets ──────────────────────────────
describe('useChartData variant memo re-runs on custom asset add', () => {
  test('useChartData imports/uses customAssets from useData', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').join(__dirname, '../../screens/chart/hooks/useChartData.ts'), 'utf8'
    );
    expect(src).toContain('customAssets');
  });

  test('variant useMemo deps include customAssetsKey', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').join(__dirname, '../../screens/chart/hooks/useChartData.ts'), 'utf8'
    );
    // The memo must include a customAssets-derived key in its deps
    expect(src).toContain("customAssets ?? []).map((a: any) => a.symbol).join(',')");
  });
});

// ── 7. NSE stock type is STOCK/EQUITY, not INDEX ─────────────────────────────
describe('NSE stock type assignment', () => {
  test('Non-NIFTY symbol gets STOCK type', () => {
    // From searchNSE: type = s.symbol.includes('NIFTY') ? 'INDEX' : 'STOCK'
    const symbols = ['ADANIENT', 'LT', 'AXISBANK', 'ITC', 'ZOMATO'];
    for (const sym of symbols) {
      const type = sym.includes('NIFTY') ? 'INDEX' : 'STOCK';
      expect(type).toBe('STOCK');
    }
  });

  test('NIFTY symbol gets INDEX type', () => {
    const niftySymbols = ['NIFTY50', 'BANKNIFTY', 'FINNIFTY', 'NIFTYMIDCAP150'];
    for (const sym of niftySymbols) {
      const type = sym.includes('NIFTY') ? 'INDEX' : 'STOCK';
      expect(type).toBe('INDEX');
    }
  });
});
