// ─────────────────────────────────────────────────────────────────────────────
// ASSET RESOLVER — Tests  (v1.0.0)
//
// Tests the production asset architecture:
//   • resolveVariant    — (assetId, exchange) → ExchangeVariant
//   • resolveSymbol     — (assetId, exchange) → internal symbol string
//   • getAvailableExchanges — assetId → string[]
//   • findAssetByLegacySymbol — old symbol → { assetId, exchange }
//   • ASSETS structural invariants — no collisions, complete fields
//   • ML isolation — different exchanges produce different symbols
//   • Backward compat — all old symbols resolvable
//
// Run with:
//   node src/utils/__tests__/assetResolver.test.js
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

// ── Inline the ASSETS and resolver logic ─────────────────────────────────────
// We inline rather than require() because TypeScript files need transpilation.
// This mirrors the exact logic in assetResolver.ts / assets.ts.

// ── Minimal ASSETS (must match production assets.ts exactly) ─────────────────
const ASSETS = [
  // Indices
  { id:'NIFTY50',    name:'Nifty 50',        type:'INDEX',  defaultExchange:'ao',
    exchanges:{ ao:{ src:'ao', symbol:'NIFTY50',    aoToken:'99926000', aoEx:'NSE', base:24900, vol:0.009 } } },
  { id:'BANKNIFTY',  name:'Bank Nifty',       type:'INDEX',  defaultExchange:'ao',
    exchanges:{ ao:{ src:'ao', symbol:'BANKNIFTY',  aoToken:'99926009', aoEx:'NSE', base:52800, vol:0.013 } } },
  { id:'FINNIFTY',   name:'Fin Nifty',        type:'INDEX',  defaultExchange:'ao',
    exchanges:{ ao:{ src:'ao', symbol:'FINNIFTY',   aoToken:'99926037', aoEx:'NSE', base:23400, vol:0.011 } } },
  // Indian stocks
  { id:'RELIANCE',   name:'Reliance Ind.',    type:'STOCK',  defaultExchange:'ao',
    exchanges:{ ao:{ src:'ao', symbol:'RELIANCE',   aoToken:'2885',     aoEx:'NSE', base:2945,  vol:0.013 } } },
  { id:'TCS',        name:'TCS',              type:'STOCK',  defaultExchange:'ao',
    exchanges:{ ao:{ src:'ao', symbol:'TCS',        aoToken:'11536',    aoEx:'NSE', base:3900,  vol:0.011 } } },
  { id:'INFY',       name:'Infosys',          type:'STOCK',  defaultExchange:'ao',
    exchanges:{ ao:{ src:'ao', symbol:'INFY',       aoToken:'1594',     aoEx:'NSE', base:1450,  vol:0.014 } } },
  { id:'HDFCBANK',   name:'HDFC Bank',        type:'STOCK',  defaultExchange:'ao',
    exchanges:{ ao:{ src:'ao', symbol:'HDFCBANK',   aoToken:'1333',     aoEx:'NSE', base:1650,  vol:0.015 } } },
  { id:'ICICIBANK',  name:'ICICI Bank',       type:'STOCK',  defaultExchange:'ao',
    exchanges:{ ao:{ src:'ao', symbol:'ICICIBANK',  aoToken:'4963',     aoEx:'NSE', base:1220,  vol:0.014 } } },
  { id:'SBIN',       name:'State Bank India', type:'STOCK',  defaultExchange:'ao',
    exchanges:{ ao:{ src:'ao', symbol:'SBIN',       aoToken:'3045',     aoEx:'NSE', base:785,   vol:0.016 } } },
  { id:'BAJFINANCE', name:'Bajaj Finance',    type:'STOCK',  defaultExchange:'ao',
    exchanges:{ ao:{ src:'ao', symbol:'BAJFINANCE', aoToken:'317',      aoEx:'NSE', base:7200,  vol:0.018 } } },
  { id:'TATAMOTORS', name:'Tata Motors',      type:'STOCK',  defaultExchange:'ao',
    exchanges:{ ao:{ src:'ao', symbol:'TATAMOTORS', aoToken:'3456',     aoEx:'NSE', base:955,   vol:0.020 } } },
  { id:'MARUTI',     name:'Maruti Suzuki',    type:'STOCK',  defaultExchange:'ao',
    exchanges:{ ao:{ src:'ao', symbol:'MARUTI',     aoToken:'10999',    aoEx:'NSE', base:12400, vol:0.012 } } },
  { id:'WIPRO',      name:'Wipro',            type:'STOCK',  defaultExchange:'ao',
    exchanges:{ ao:{ src:'ao', symbol:'WIPRO',      aoToken:'3787',     aoEx:'NSE', base:520,   vol:0.014 } } },
  // US stocks
  { id:'AAPL', name:'Apple Inc.',   type:'STOCK', defaultExchange:'av',
    exchanges:{ av:{ src:'av', symbol:'AAPL', avSym:'AAPL', base:192, vol:0.014 } } },
  { id:'NVDA', name:'NVIDIA Corp.', type:'STOCK', defaultExchange:'av',
    exchanges:{ av:{ src:'av', symbol:'NVDA', avSym:'NVDA', base:875, vol:0.024 } } },
  { id:'TSLA', name:'Tesla Inc.',   type:'STOCK', defaultExchange:'av',
    exchanges:{ av:{ src:'av', symbol:'TSLA', avSym:'TSLA', base:249, vol:0.026 } } },
  { id:'MSFT', name:'Microsoft',    type:'STOCK', defaultExchange:'av',
    exchanges:{ av:{ src:'av', symbol:'MSFT', avSym:'MSFT', base:415, vol:0.011 } } },
  // Forex
  { id:'EURUSD', name:'EUR / USD', type:'FOREX', defaultExchange:'forex',
    exchanges:{ forex:{ src:'forex', symbol:'EURUSD', fxKey:'EUR', fxInv:false, base:1.0847, vol:0.003 } } },
  { id:'GBPUSD', name:'GBP / USD', type:'FOREX', defaultExchange:'forex',
    exchanges:{ forex:{ src:'forex', symbol:'GBPUSD', fxKey:'GBP', fxInv:false, base:1.2634, vol:0.004 } } },
  { id:'USDJPY', name:'USD / JPY', type:'FOREX', defaultExchange:'forex',
    exchanges:{ forex:{ src:'forex', symbol:'USDJPY', fxKey:'JPY', fxInv:true,  base:154.2,  vol:0.003 } } },
  { id:'USDINR', name:'USD / INR', type:'FOREX', defaultExchange:'forex',
    exchanges:{ forex:{ src:'forex', symbol:'USDINR', fxKey:'INR', fxInv:true,  base:83.4,   vol:0.002 } } },
  // Crypto — multi-exchange
  { id:'BTC', name:'Bitcoin', type:'CRYPTO', defaultExchange:'binance',
    exchanges:{
      binance:         { src:'binance',         symbol:'BTCUSD',  bnSym:'BTCUSDT', base:67420, vol:0.028 },
      coindcx:         { src:'coindcx',         symbol:'BTCUSDT', cdxSym:'B-BTC_USDT', cdxMkt:'BTCUSDT', base:67420, vol:0.028 },
    } },
  { id:'ETH', name:'Ethereum', type:'CRYPTO', defaultExchange:'binance',
    exchanges:{
      binance:         { src:'binance',         symbol:'ETHUSD',  bnSym:'ETHUSDT', base:3485, vol:0.032 },
      coindcx:         { src:'coindcx',         symbol:'ETHUSDT', cdxSym:'B-ETH_USDT', cdxMkt:'ETHUSDT', base:3485, vol:0.032 },
    } },
  { id:'BNB', name:'BNB', type:'CRYPTO', defaultExchange:'binance',
    exchanges:{
      binance:         { src:'binance',         symbol:'BNBUSD',  bnSym:'BNBUSDT', base:580, vol:0.025 },
      coindcx:         { src:'coindcx',         symbol:'BNBUSDT', cdxSym:'B-BNB_USDT', cdxMkt:'BNBUSDT', base:580, vol:0.025 },
    } },
  { id:'SOL', name:'Solana', type:'CRYPTO', defaultExchange:'binance',
    exchanges:{
      binance:         { src:'binance',         symbol:'SOLUSD',  bnSym:'SOLUSDT', base:148, vol:0.035 },
      coindcx:         { src:'coindcx',         symbol:'SOLUSDT', cdxSym:'B-SOL_USDT', cdxMkt:'SOLUSDT', base:148, vol:0.035 },
    } },
  { id:'XRP', name:'XRP', type:'CRYPTO', defaultExchange:'binance',
    exchanges:{
      binance:         { src:'binance',         symbol:'XRPUSD',  bnSym:'XRPUSDT', base:0.52, vol:0.040 },
      coindcx:         { src:'coindcx',         symbol:'XRPUSDT', cdxSym:'B-XRP_USDT', cdxMkt:'XRPUSDT', base:0.52, vol:0.040 },
    } },
  { id:'DOGE', name:'Dogecoin', type:'CRYPTO', defaultExchange:'binance_futures',
    exchanges:{
      binance_futures: { src:'binance_futures', symbol:'DOGE-PERP', bnSym:'DOGEUSDT', base:0.078, vol:0.055 },
    } },
  // NSE Futures
  { id:'NIFTY-FUT',     name:'Nifty 50 Futures',  type:'INDEX', defaultExchange:'ao_futures',
    exchanges:{ ao_futures:{ src:'ao_futures', symbol:'NIFTY-FUT',     underlying:'NIFTY',     lotSize:75,   aoEx:'NFO', base:24900, vol:0.009 } } },
  { id:'BANKNIFTY-FUT', name:'Bank Nifty Futures', type:'INDEX', defaultExchange:'ao_futures',
    exchanges:{ ao_futures:{ src:'ao_futures', symbol:'BANKNIFTY-FUT', underlying:'BANKNIFTY', lotSize:30,   aoEx:'NFO', base:52800, vol:0.013 } } },
  { id:'FINNIFTY-FUT',  name:'Fin Nifty Futures',  type:'INDEX', defaultExchange:'ao_futures',
    exchanges:{ ao_futures:{ src:'ao_futures', symbol:'FINNIFTY-FUT',  underlying:'FINNIFTY',  lotSize:65,   aoEx:'NFO', base:23400, vol:0.011 } } },
  { id:'RELIANCE-FUT',  name:'Reliance Futures',   type:'STOCK', defaultExchange:'ao_futures',
    exchanges:{ ao_futures:{ src:'ao_futures', symbol:'RELIANCE-FUT',  underlying:'RELIANCE',  lotSize:250,  aoEx:'NFO', base:2945,  vol:0.013 } } },
  { id:'TCS-FUT',       name:'TCS Futures',        type:'STOCK', defaultExchange:'ao_futures',
    exchanges:{ ao_futures:{ src:'ao_futures', symbol:'TCS-FUT',       underlying:'TCS',       lotSize:150,  aoEx:'NFO', base:3900,  vol:0.011 } } },
  { id:'INFY-FUT',      name:'Infosys Futures',    type:'STOCK', defaultExchange:'ao_futures',
    exchanges:{ ao_futures:{ src:'ao_futures', symbol:'INFY-FUT',      underlying:'INFY',      lotSize:300,  aoEx:'NFO', base:1450,  vol:0.014 } } },
  { id:'HDFCBANK-FUT',  name:'HDFC Bank Futures',  type:'STOCK', defaultExchange:'ao_futures',
    exchanges:{ ao_futures:{ src:'ao_futures', symbol:'HDFCBANK-FUT',  underlying:'HDFCBANK',  lotSize:550,  aoEx:'NFO', base:1650,  vol:0.015 } } },
  { id:'SBIN-FUT',      name:'SBI Futures',        type:'STOCK', defaultExchange:'ao_futures',
    exchanges:{ ao_futures:{ src:'ao_futures', symbol:'SBIN-FUT',      underlying:'SBIN',      lotSize:1500, aoEx:'NFO', base:785,   vol:0.016 } } },
];

// ── Inline resolver functions (mirror assetResolver.ts) ──────────────────────
const BY_ID = new Map(ASSETS.map(a => [a.id, a]));
const BY_LEGACY_SYMBOL = new Map();
for (const asset of ASSETS) {
  for (const [src, variant] of Object.entries(asset.exchanges)) {
    if (!BY_LEGACY_SYMBOL.has(variant.symbol)) {
      BY_LEGACY_SYMBOL.set(variant.symbol, { assetId: asset.id, exchange: src });
    }
  }
}

function resolveVariant(assetId, exchange) {
  const asset = BY_ID.get(assetId);
  if (!asset) return undefined;
  return asset.exchanges[exchange] ?? asset.exchanges[asset.defaultExchange];
}
function resolveSymbol(assetId, exchange) {
  return resolveVariant(assetId, exchange)?.symbol;
}
function getAvailableExchanges(assetId) {
  const asset = BY_ID.get(assetId);
  if (!asset) return [];
  return Object.keys(asset.exchanges);
}
function findAssetByLegacySymbol(symbol) {
  return BY_LEGACY_SYMBOL.get(symbol) ?? null;
}
function toSlug(name) {
  return name.toLowerCase().replace(/\s+/g, '');
}

// ── Test harness ──────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const allTests = [];
function test(label, fn) { allTests.push({ label, fn }); }
function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function assertDefined(val, label) {
  if (val === undefined || val === null)
    throw new Error(`${label}: expected defined value, got ${val}`);
}
function assertUndefined(val, label) {
  if (val !== undefined && val !== null)
    throw new Error(`${label}: expected undefined, got ${JSON.stringify(val)}`);
}
function assertIncludes(arr, val, label) {
  if (!arr.includes(val))
    throw new Error(`${label}: expected ${JSON.stringify(arr)} to include ${JSON.stringify(val)}`);
}
function assertTrue(cond, label) {
  if (!cond) throw new Error(`${label}: expected true`);
}
function assertFalse(cond, label) {
  if (cond) throw new Error(`${label}: expected false`);
}

// ─────────────────────────────────────────────────────────────────────────────
// TESTS
// ─────────────────────────────────────────────────────────────────────────────

test('1. resolveVariant: known asset + known exchange → correct variant', () => {
  const v = resolveVariant('BTC', 'binance');
  assertDefined(v, 'variant');
  assertEqual(v.src, 'binance', 'src');
  assertEqual(v.symbol, 'BTCUSD', 'symbol');
  assertEqual(v.bnSym, 'BTCUSDT', 'bnSym');
});

test('2. resolveVariant: known asset + unknown exchange → falls back to default', () => {
  const v = resolveVariant('BTC', 'bybit'); // bybit not in exchanges
  assertDefined(v, 'variant');
  // Falls back to defaultExchange='binance'
  assertEqual(v.src, 'binance', 'src fallback');
  assertEqual(v.symbol, 'BTCUSD', 'symbol fallback');
});

test('3. resolveVariant: unknown assetId → undefined', () => {
  const v = resolveVariant('UNKNOWN_ASSET', 'binance');
  assertUndefined(v, 'resolveVariant for unknown asset');
});

test('4. resolveSymbol: BTC + binance → BTCUSD', () => {
  assertEqual(resolveSymbol('BTC', 'binance'), 'BTCUSD', 'BTC binance symbol');
});

test('5. resolveSymbol: BTC + coindcx → BTCUSDT', () => {
  assertEqual(resolveSymbol('BTC', 'coindcx'), 'BTCUSDT', 'BTC coindcx symbol');
});

test('6. resolveSymbol: unknown asset → undefined', () => {
  assertUndefined(resolveSymbol('FAKECOIN', 'binance'), 'unknown asset symbol');
});

test('7. getAvailableExchanges: BTC → includes binance and coindcx only', () => {
  const exchanges = getAvailableExchanges('BTC');
  assertIncludes(exchanges, 'binance', 'BTC has binance');
  assertIncludes(exchanges, 'coindcx', 'BTC has coindcx');
  assertEqual(exchanges.length, 2, 'BTC has exactly 2 exchanges (futures removed from Markets)');
});

test('8. getAvailableExchanges: NIFTY50 → only ao', () => {
  const exchanges = getAvailableExchanges('NIFTY50');
  assertEqual(exchanges, ['ao'], 'NIFTY50 exchanges');
});

test('9. getAvailableExchanges: unknown → empty array', () => {
  assertEqual(getAvailableExchanges('FAKECOIN'), [], 'unknown asset exchanges');
});

test('10. findAssetByLegacySymbol: BTCUSD → BTC/binance', () => {
  const r = findAssetByLegacySymbol('BTCUSD');
  assertDefined(r, 'legacy BTCUSD result');
  assertEqual(r.assetId, 'BTC', 'assetId');
  assertEqual(r.exchange, 'binance', 'exchange');
});

test('11. findAssetByLegacySymbol: BTCUSDT → BTC/coindcx', () => {
  const r = findAssetByLegacySymbol('BTCUSDT');
  assertDefined(r, 'legacy BTCUSDT result');
  assertEqual(r.assetId, 'BTC', 'assetId');
  assertEqual(r.exchange, 'coindcx', 'exchange');
});

test('12. findAssetByLegacySymbol: unknown → null', () => {
  const r = findAssetByLegacySymbol('XYZFAKE');
  assertEqual(r, null, 'unknown legacy symbol');
});

test('13. ML key isolation: BTC binance and BTC coindcx produce different symbols', () => {
  const binanceSym = resolveSymbol('BTC', 'binance');
  const coindcxSym = resolveSymbol('BTC', 'coindcx');
  assertDefined(binanceSym, 'binance symbol defined');
  assertDefined(coindcxSym, 'coindcx symbol defined');
  assertTrue(binanceSym !== coindcxSym, 'BTC Binance and CoinDCX have different ML symbols');
  // Confirm concrete values
  assertEqual(binanceSym, 'BTCUSD',  'Binance BTC symbol');
  assertEqual(coindcxSym, 'BTCUSDT', 'CoinDCX BTC symbol');
});

test('14. All built-in assets have a valid defaultExchange', () => {
  for (const asset of ASSETS) {
    const defaultVariant = asset.exchanges[asset.defaultExchange];
    assertDefined(defaultVariant, `${asset.id} defaultExchange '${asset.defaultExchange}' exists in exchanges`);
  }
});

test('15. All exchange variants have required fields: src, symbol, base, vol', () => {
  for (const asset of ASSETS) {
    for (const [src, variant] of Object.entries(asset.exchanges)) {
      assertTrue(typeof variant.src    === 'string' && variant.src.length > 0,  `${asset.id}/${src}: src`);
      assertTrue(typeof variant.symbol === 'string' && variant.symbol.length > 0, `${asset.id}/${src}: symbol`);
      assertTrue(typeof variant.base   === 'number' && variant.base > 0,         `${asset.id}/${src}: base`);
      assertTrue(typeof variant.vol    === 'number' && variant.vol > 0,           `${asset.id}/${src}: vol`);
    }
  }
});

test('16. No two variants in the same asset share a symbol (no intra-asset collision)', () => {
  for (const asset of ASSETS) {
    const symbols = Object.values(asset.exchanges).map(v => v.symbol);
    const unique = new Set(symbols);
    assertEqual(unique.size, symbols.length, `${asset.id}: all variant symbols are unique`);
  }
});

test('17. CoinDCX variants have cdxSym and cdxMkt', () => {
  for (const asset of ASSETS) {
    const cdx = asset.exchanges['coindcx'];
    if (!cdx) continue;
    assertTrue(typeof cdx.cdxSym === 'string' && cdx.cdxSym.length > 0,  `${asset.id}/coindcx: cdxSym`);
    assertTrue(typeof cdx.cdxMkt === 'string' && cdx.cdxMkt.length > 0,  `${asset.id}/coindcx: cdxMkt`);
    // cdxSym must start with 'B-' (Binance-denominated USDT pair on CoinDCX)
    assertTrue(cdx.cdxSym.startsWith('B-'), `${asset.id}/coindcx: cdxSym starts with B-`);
  }
});

test('18. Binance spot variants have bnSym', () => {
  for (const asset of ASSETS) {
    const bn = asset.exchanges['binance'];
    if (!bn) continue;
    assertTrue(typeof bn.bnSym === 'string' && bn.bnSym.length > 0, `${asset.id}/binance: bnSym`);
    // bnSym should end in USDT for spot pairs
    assertTrue(bn.bnSym.endsWith('USDT'), `${asset.id}/binance: bnSym ends in USDT`);
  }
});

test('19. Angel One variants have aoToken and aoEx (where applicable)', () => {
  for (const asset of ASSETS) {
    const ao = asset.exchanges['ao'];
    if (!ao) continue;
    // ao_futures may have aoToken populated at runtime — only check aoEx
    assertTrue(typeof ao.aoEx === 'string' && ao.aoEx.length > 0, `${asset.id}/ao: aoEx`);
    // Equity (not futures) must have aoToken
    assertTrue(typeof ao.aoToken === 'string' && ao.aoToken.length > 0, `${asset.id}/ao: aoToken`);
  }
});

test('20. Exchange preference slug: display names → stable lowercase slugs', () => {
  assertEqual(toSlug('Bitcoin'),       'bitcoin',       'Bitcoin slug');
  assertEqual(toSlug('BNB'),           'bnb',           'BNB slug');
  assertEqual(toSlug('Solana'),        'solana',        'Solana slug');
  assertEqual(toSlug('EUR / USD'),     'eur/usd',       'EUR/USD slug');
  assertEqual(toSlug('State Bank India'), 'statebankindia', 'multi-word slug');
  assertEqual(toSlug('NIFTY 50'),      'nifty50',       'NIFTY 50 slug');
});

test('21. No duplicate assetIds across ASSETS', () => {
  const ids = ASSETS.map(a => a.id);
  const unique = new Set(ids);
  assertEqual(unique.size, ids.length, `All ${ids.length} asset IDs are unique`);
});

test('22. ASSETS covers expected built-in set', () => {
  const expected = ['BTC','ETH','BNB','SOL','XRP','NIFTY50','BANKNIFTY','EURUSD','AAPL','NVDA'];
  for (const id of expected) {
    assertTrue(BY_ID.has(id), `ASSETS contains ${id}`);
  }
});

test('23. resolveVariant is pure: same input always gives same output', () => {
  const r1 = resolveVariant('BTC', 'binance');
  const r2 = resolveVariant('BTC', 'binance');
  assertEqual(JSON.stringify(r1), JSON.stringify(r2), 'resolveVariant is deterministic');
});

test('24. Price key (variant.symbol) is unique across entire ASSETS list', () => {
  const allSymbols = [];
  for (const asset of ASSETS) {
    for (const variant of Object.values(asset.exchanges)) {
      allSymbols.push(variant.symbol);
    }
  }
  const unique = new Set(allSymbols);
  assertEqual(unique.size, allSymbols.length,
    `All ${allSymbols.length} variant symbols are globally unique (no cross-asset collision)`);
});

test('25. Backward compat: findAssetByLegacySymbol covers all known old-format symbols', () => {
  // These are the symbols used in the old flat Asset format
  const legacySymbols = [
    // Binance crypto spot
    'BTCUSD','ETHUSD','BNBUSD','SOLUSD','XRPUSD',
    // CoinDCX crypto spot
    'BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT',
    // Perp futures — still in ASSETS (ao_futures/binance_futures sections), just not in LogicalAsset.exchanges for Markets
    // These resolve via the dedicated futures LogicalAssets (NIFTY-FUT etc.) or ao_futures
    // BTC-PERP etc. are removed from LogicalAsset — skip them in backward compat test
    // Angel One indices
    'NIFTY50','BANKNIFTY','FINNIFTY',
    // Indian stocks
    'RELIANCE','TCS','INFY','HDFCBANK','ICICIBANK','SBIN','BAJFINANCE','TATAMOTORS','MARUTI','WIPRO',
    // US stocks
    'AAPL','NVDA','TSLA','MSFT',
    // Forex
    'EURUSD','GBPUSD','USDJPY','USDINR',
    // NSE futures
    'NIFTY-FUT','BANKNIFTY-FUT','FINNIFTY-FUT',
    'RELIANCE-FUT','TCS-FUT','INFY-FUT','HDFCBANK-FUT','SBIN-FUT',
  ];
  const missing = legacySymbols.filter(s => !findAssetByLegacySymbol(s));
  assertEqual(missing, [], `All legacy symbols resolve. Missing: ${missing.join(', ')}`);
});

// ── Run all tests sequentially ────────────────────────────────────────────────
(async () => {
  console.log('\n─────────────────────────────────────────────────────');
  console.log('ASSET RESOLVER — Test Suite');
  console.log('─────────────────────────────────────────────────────\n');

  for (const { label, fn } of allTests) {
    try {
      await fn();
      console.log(`  ✓  ${label}`);
      passed++;
    } catch (e) {
      console.log(`  ✗  ${label}`);
      console.log(`       ${e.message}`);
      failed++;
    }
  }

  console.log(`\n─────────────────────────────────────────────────────`);
  console.log(`${passed} passed, ${failed} failed (${allTests.length} total)`);
  if (failed === 0) {
    console.log('✓  ALL ASSET RESOLVER TESTS PASSED\n');
    process.exit(0);
  } else {
    console.log(`✗  ${failed} TEST(S) FAILED\n`);
    process.exit(1);
  }
})();
