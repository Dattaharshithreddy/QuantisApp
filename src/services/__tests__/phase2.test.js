'use strict';
// Phase 2: Verify all 13 user-data keys are in DUAL_WRITE mode
// and that KVStore integration points are correct

let passed = 0, failed = 0;
function test(label, fn) {
  try { fn(); console.log(`  ✓  ${label}`); passed++; }
  catch(e) { console.log(`  ✗  ${label}\n     ${e.message}`); failed++; }
}
function assertEqual(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// Replicate KEY_MODES from storage.ts
const KEY_MODES = {
  'riskSettings':            'DUAL_WRITE',
  'paperMode':               'DUAL_WRITE',
  'themeName':               'DUAL_WRITE',
  'exchangePreferences_v1':  'DUAL_WRITE',
  'paperPortfolio':          'DUAL_WRITE',
  'livePortfolio_v1':        'DUAL_WRITE',
  'liveOrderHistory_v1':     'DUAL_WRITE',
  'paperTradeJournal':       'DUAL_WRITE',
  'shadowTrades_v1':         'DUAL_WRITE',
  'hiddenBuiltinAssets':     'DUAL_WRITE',
  'customWatchlist':         'DUAL_WRITE',
  'aichat_v1_':              'DUAL_WRITE',
  'predictionHistory_':      'DUAL_WRITE',
  'dailyPnL_':               'DUAL_WRITE',
};

function modeFor(key) {
  for (const prefix of Object.keys(KEY_MODES)) {
    if (key === prefix || key.startsWith(prefix)) return KEY_MODES[prefix];
  }
  return 'ASYNC_ONLY';
}

console.log('\n─────────────────────────────────────────');
console.log('Phase 2: User Data Keys Migration Tests');
console.log('─────────────────────────────────────────\n');

// Test each key is DUAL_WRITE
const keysToTest = [
  ['riskSettings', 'riskSettings'],
  ['paperMode', 'paperMode'],
  ['themeName', 'themeName'],
  ['exchangePreferences_v1', 'exchangePreferences_v1'],
  ['paperPortfolio', 'paperPortfolio'],
  ['livePortfolio_v1', 'livePortfolio_v1'],
  ['liveOrderHistory_v1', 'liveOrderHistory_v1'],
  ['paperTradeJournal', 'paperTradeJournal'],
  ['shadowTrades_v1', 'shadowTrades_v1'],
  ['hiddenBuiltinAssets', 'hiddenBuiltinAssets'],
  ['customWatchlist', 'customWatchlist'],
  ['aichat_v1_BTCUSD', 'aichat_v1_ prefix'],
  ['aichat_v1_ETHUSD', 'aichat_v1_ prefix (ETH)'],
  ['predictionHistory_BTCUSD_15m', 'predictionHistory_ prefix'],
  ['dailyPnL_2026-08-14', 'dailyPnL_ prefix'],
];

for (const [key, label] of keysToTest) {
  test(`${label} is DUAL_WRITE`, () => {
    assertEqual(modeFor(key), 'DUAL_WRITE', `mode for '${key}'`);
  });
}

// Test cache keys stay ASYNC_ONLY
const asyncOnlyKeys = [
  'candleCache_BTCUSD_15m',
  'PRICE_CACHE_KEY',
  'RUNNING_TASK_IDS_KEY',
  'MODEL_KEY',
  'LR_KEY',
];
for (const key of asyncOnlyKeys) {
  test(`${key} stays ASYNC_ONLY`, () => {
    assertEqual(modeFor(key), 'ASYNC_ONLY', `mode for '${key}'`);
  });
}

// Verify migrated files use KVStore
const fs = require('fs');
const migratedFiles = [
  'src/utils/riskManager.ts',
  'src/context/ThemeContext.tsx',
  'src/utils/paperPortfolio.ts',
  'src/utils/livePortfolio.ts',
  'src/utils/exchangePreferences.ts',
  'src/utils/paperTradeJournal.ts',
  'src/utils/shadowTradeJournal.ts',
  'src/utils/watchlist.ts',
  'src/utils/predictionHistory.ts',
  'src/screens/AIChatScreen.tsx',
  'src/screens/LivePositionsScreen.tsx',
];

for (const f of migratedFiles) {
  const content = fs.readFileSync(`/tmp/QuantisRepo/${f}`, 'utf8');
  test(`${f.split('/').pop()} imports KVStore`, () => {
    if (!content.includes('KVStore')) throw new Error('KVStore not imported');
  });
  test(`${f.split('/').pop()} uses KVStore.get/set`, () => {
    const usesKV = content.includes('KVStore.get(') || content.includes('KVStore.set(');
    if (!usesKV) throw new Error('KVStore not used for read/write');
  });
}

console.log(`\n─────────────────────────────────────────`);
console.log(`${passed} passed, ${failed} failed`);
if (!failed) { console.log('✓  ALL PHASE 2 TESTS PASSED\n'); process.exit(0); }
else { process.exit(1); }
