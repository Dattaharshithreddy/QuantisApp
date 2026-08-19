// ─────────────────────────────────────────────────────────────────────────────
// WATCHLIST AWARENESS — Regression Tests  v1.0.0
//
// Tests cover:
//   1. assetToCalendarCategories — all asset types, all branches, edge cases
//   2. getWatchlistRelevance     — matching, no-match, open-position flag
//   3. getWatchlistRelevantEvents — sorting, open-position priority
//   4. Integration               — realistic combined portfolio + event scenarios
//   5. Graceful edge cases       — empty inputs, unknown types, no positions
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

// ── Inline the pure logic under test (mirrors marketIntelligenceCalendar.ts) ──

/**
 * Maps an Asset to the set of AffectedAsset categories it belongs to.
 */
function assetToCalendarCategories(asset) {
  const sym   = asset.symbol.toUpperCase();
  const bnSym = (asset.bnSym ?? '').toUpperCase();
  const categories = [];

  switch (asset.type) {
    case 'INDEX':
      if (sym.startsWith('BANKNIFTY') || sym.includes('BANKNIFTY')) {
        categories.push('BANKNIFTY');
        categories.push('NIFTY');
      } else if (sym.startsWith('NIFTY') || sym.startsWith('FINNIFTY')) {
        categories.push('NIFTY');
      }
      break;
    case 'STOCK':
      if (asset.src === 'ao' || asset.src === 'ao_futures') {
        categories.push('NIFTY');
      }
      break;
    case 'FOREX':
      if (asset.fxKey === 'INR') categories.push('USDINR');
      break;
    case 'CRYPTO':
      if (bnSym.startsWith('BTC')) {
        categories.push('BTC');
      } else if (bnSym.startsWith('ETH')) {
        categories.push('ETH');
      } else if (bnSym.length > 0) {
        categories.push('ALTCOINS');
      }
      break;
    case 'COMMODITY':
      if (sym.includes('GOLD') || sym.includes('XAU')) categories.push('GOLD');
      if (sym.includes('SILVER') || sym.includes('XAG')) categories.push('SILVER');
      if (sym.includes('CRUDE') || sym.includes('OIL') || sym.includes('WTI') || sym.includes('BRENT')) {
        categories.push('CRUDE');
      }
      break;
  }

  return Array.from(new Set(categories));
}

/**
 * Computes watchlist relevance for a single event.
 */
function getWatchlistRelevance(event, watchlistAssets, openPositionSymbols) {
  const categoryToSymbols = new Map();

  for (const asset of watchlistAssets) {
    const cats = assetToCalendarCategories(asset);
    for (const cat of cats) {
      if (!categoryToSymbols.has(cat)) categoryToSymbols.set(cat, []);
      categoryToSymbols.get(cat).push(asset.symbol);
    }
  }

  const matches = [];
  for (const affectedCat of event.affectedAssets) {
    const symbols = categoryToSymbols.get(affectedCat);
    if (!symbols || symbols.length === 0) continue;
    const hasOpenPosition = symbols.some(s => openPositionSymbols.has(s));
    matches.push({ assetCategory: affectedCat, matchedSymbols: symbols, hasOpenPosition });
  }

  const allMatchedSymbols = Array.from(new Set(matches.flatMap(m => m.matchedSymbols)));
  const hasOpenPosition   = matches.some(m => m.hasOpenPosition);
  const isRelevant        = matches.length > 0;

  let summaryLine = '';
  if (isRelevant) {
    const symbolList = allMatchedSymbols.slice(0, 3).join(', ');
    const more       = allMatchedSymbols.length > 3 ? ` +${allMatchedSymbols.length - 3} more` : '';
    summaryLine = hasOpenPosition
      ? `Open position affected: ${symbolList}${more}`
      : `Affects your watchlist: ${symbolList}${more}`;
  }

  return { isRelevant, matches, allMatchedSymbols, hasOpenPosition, summaryLine };
}

/**
 * Returns events relevant to the watchlist, open-positions first.
 */
function getWatchlistRelevantEvents(events, watchlistAssets, openPositionSymbols) {
  return events
    .map(event => ({ event, relevance: getWatchlistRelevance(event, watchlistAssets, openPositionSymbols) }))
    .filter(({ relevance }) => relevance.isRelevant)
    .sort((a, b) => {
      const aPos = a.relevance.hasOpenPosition ? 0 : 1;
      const bPos = b.relevance.hasOpenPosition ? 0 : 1;
      if (aPos !== bPos) return aPos - bPos;
      return a.event.date.getTime() - b.event.date.getTime();
    });
}

// ── Asset factories mirroring the real ASSETS array structure ─────────────────

const NIFTY50    = { symbol: 'NIFTY50',    type: 'INDEX',     src: 'ao',              base: 24900 };
const BANKNIFTY  = { symbol: 'BANKNIFTY',  type: 'INDEX',     src: 'ao',              base: 52800 };
const FINNIFTY   = { symbol: 'FINNIFTY',   type: 'INDEX',     src: 'ao',              base: 23400 };
const RELIANCE   = { symbol: 'RELIANCE',   type: 'STOCK',     src: 'ao',              base: 2945  };
const TCS        = { symbol: 'TCS',        type: 'STOCK',     src: 'ao',              base: 3900  };
const USDINR     = { symbol: 'USDINR',     type: 'FOREX',     src: 'forex', fxKey: 'INR', fxInv: true, base: 83.4 };
const EURUSD     = { symbol: 'EURUSD',     type: 'FOREX',     src: 'forex', fxKey: 'EUR', fxInv: false, base: 1.08 };
const BTCUSD     = { symbol: 'BTCUSD',     type: 'CRYPTO',    src: 'binance', bnSym: 'BTCUSDT', base: 67420 };
const ETHUSD     = { symbol: 'ETHUSD',     type: 'CRYPTO',    src: 'binance', bnSym: 'ETHUSDT', base: 3485  };
const SOLUSD     = { symbol: 'SOLUSD',     type: 'CRYPTO',    src: 'binance', bnSym: 'SOLUSDT', base: 148   };
const AAPL       = { symbol: 'AAPL',       type: 'STOCK',     src: 'av',              base: 192   }; // US stock
const BTCPERP    = { symbol: 'BTC-PERP',   type: 'CRYPTO',    src: 'binance_futures', bnSym: 'BTCUSDT', base: 67420 };
const NIFTY_FUT  = { symbol: 'NIFTY-FUT',  type: 'INDEX',     src: 'ao_futures',      base: 24900 };
const BNKFUT     = { symbol: 'BANKNIFTY-FUT', type: 'INDEX',  src: 'ao_futures',      base: 52800 };

// Gold/Silver/Crude are COMMODITY type (not in current ASSETS but valid type)
const GOLD_ASSET   = { symbol: 'GOLD',   type: 'COMMODITY', src: 'mcx', base: 72000 };
const SILVER_ASSET = { symbol: 'SILVER', type: 'COMMODITY', src: 'mcx', base: 850   };
const CRUDE_ASSET  = { symbol: 'CRUDE',  type: 'COMMODITY', src: 'mcx', base: 6800  };
const XAU_ASSET    = { symbol: 'XAUUSD', type: 'COMMODITY', src: 'forex', base: 2350 };

// Event factory
function makeEvent(id, affectedAssets, overrides = {}) {
  return {
    id,
    title: `Test Event ${id}`,
    affectedAssets,
    date: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
    impact: 'HIGH',
    region: 'US',
    category: 'FOMC',
    ...overrides,
  };
}

// ── Test runner ────────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
const errors = [];

function test(name, fn) {
  try { fn(); console.log(`  ✅  ${name}`); passed++; }
  catch (e) { console.error(`  ❌  ${name}\n      ${e.message}`); failed++; errors.push({ name, message: e.message }); }
}

function expect(value) {
  return {
    toBe:       expected => { if (value !== expected) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(value)}`); },
    toEqual:    expected => { if (JSON.stringify(value) !== JSON.stringify(expected)) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(value)}`); },
    toBeTruthy: ()       => { if (!value) throw new Error(`Expected truthy, got ${value}`); },
    toBeFalsy:  ()       => { if (value)  throw new Error(`Expected falsy, got ${value}`);  },
    toContain:  item     => { if (!value.includes(item)) throw new Error(`Expected to contain ${JSON.stringify(item)}`); },
    not: {
      toContain: item => { if (value.includes(item)) throw new Error(`Expected NOT to contain ${JSON.stringify(item)}`); },
      toBe: expected  => { if (value === expected) throw new Error(`Expected NOT ${JSON.stringify(expected)}`); },
    },
    toHaveLength: n => { if (value.length !== n) throw new Error(`Expected length ${n}, got ${value.length}`); },
    toBeGreaterThan: n => { if (!(value > n)) throw new Error(`Expected ${value} > ${n}`); },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. assetToCalendarCategories — mapping rules
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── 1. assetToCalendarCategories ────────────────────────────────');

test('NIFTY50 → [NIFTY]', () => {
  expect(assetToCalendarCategories(NIFTY50)).toEqual(['NIFTY']);
});

test('BANKNIFTY → [BANKNIFTY, NIFTY] (both affected)', () => {
  const cats = assetToCalendarCategories(BANKNIFTY);
  expect(cats).toContain('BANKNIFTY');
  expect(cats).toContain('NIFTY');
});

test('FINNIFTY → [NIFTY]', () => {
  expect(assetToCalendarCategories(FINNIFTY)).toEqual(['NIFTY']);
});

test('NIFTY-FUT (ao_futures) → [NIFTY]', () => {
  // NIFTY-FUT has type INDEX, startsWith check on symbol must handle the suffix
  const asset = { symbol: 'NIFTY-FUT', type: 'INDEX', src: 'ao_futures', base: 24900 };
  // NIFTY-FUT starts with 'NIFTY' → should map to NIFTY
  expect(assetToCalendarCategories(asset)).toContain('NIFTY');
});

test('BANKNIFTY-FUT → [BANKNIFTY, NIFTY]', () => {
  const cats = assetToCalendarCategories(BNKFUT);
  expect(cats).toContain('BANKNIFTY');
  expect(cats).toContain('NIFTY');
});

test('NSE stock (ao) → [NIFTY]', () => {
  expect(assetToCalendarCategories(RELIANCE)).toEqual(['NIFTY']);
});

test('Another NSE stock (TCS, ao) → [NIFTY]', () => {
  expect(assetToCalendarCategories(TCS)).toEqual(['NIFTY']);
});

test('US stock (av src) → [] (no mapping — avoid guessing)', () => {
  expect(assetToCalendarCategories(AAPL)).toEqual([]);
});

test('USDINR forex → [USDINR]', () => {
  expect(assetToCalendarCategories(USDINR)).toEqual(['USDINR']);
});

test('EURUSD forex (non-INR) → [] (no mapping for non-INR pairs)', () => {
  expect(assetToCalendarCategories(EURUSD)).toEqual([]);
});

test('BTCUSD → [BTC]', () => {
  expect(assetToCalendarCategories(BTCUSD)).toEqual(['BTC']);
});

test('BTC-PERP (binance_futures) → [BTC]', () => {
  expect(assetToCalendarCategories(BTCPERP)).toEqual(['BTC']);
});

test('ETHUSD → [ETH]', () => {
  expect(assetToCalendarCategories(ETHUSD)).toEqual(['ETH']);
});

test('SOLUSD (non-BTC/ETH crypto) → [ALTCOINS]', () => {
  expect(assetToCalendarCategories(SOLUSD)).toEqual(['ALTCOINS']);
});

test('GOLD commodity → [GOLD]', () => {
  expect(assetToCalendarCategories(GOLD_ASSET)).toContain('GOLD');
});

test('XAUUSD commodity → [GOLD]', () => {
  expect(assetToCalendarCategories(XAU_ASSET)).toContain('GOLD');
});

test('SILVER commodity → [SILVER]', () => {
  expect(assetToCalendarCategories(SILVER_ASSET)).toContain('SILVER');
});

test('CRUDE commodity → [CRUDE]', () => {
  expect(assetToCalendarCategories(CRUDE_ASSET)).toContain('CRUDE');
});

test('Unknown type → [] (no mapping, no crash)', () => {
  const unknown = { symbol: 'MYSTERY', type: 'UNKNOWN', src: 'mystery', base: 0 };
  const cats = assetToCalendarCategories(unknown);
  expect(cats).toEqual([]);
});

test('BANKNIFTY does not appear in result twice (dedup)', () => {
  const cats = assetToCalendarCategories(BANKNIFTY);
  const niftyCount = cats.filter(c => c === 'NIFTY').length;
  expect(niftyCount).toBe(1);
});

test('Crypto asset with no bnSym → [] (no bnSym length check passes)', () => {
  const noSym = { symbol: 'MYSTERY-COIN', type: 'CRYPTO', src: 'binance', bnSym: '', base: 0 };
  expect(assetToCalendarCategories(noSym)).toEqual([]);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. getWatchlistRelevance — matching logic
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── 2. getWatchlistRelevance ────────────────────────────────────');

test('Event affecting NIFTY + NIFTY50 in watchlist → relevant', () => {
  const event  = makeEvent('e1', ['NIFTY', 'GOLD']);
  const result = getWatchlistRelevance(event, [NIFTY50], new Set());
  expect(result.isRelevant).toBe(true);
});

test('Event affecting GOLD but watchlist has only NIFTY50 → not relevant', () => {
  const event  = makeEvent('e1', ['GOLD']);
  const result = getWatchlistRelevance(event, [NIFTY50], new Set());
  expect(result.isRelevant).toBe(false);
});

test('Event affecting BTC + BTCUSD in watchlist → relevant, category=BTC', () => {
  const event  = makeEvent('e1', ['BTC', 'ETH']);
  const result = getWatchlistRelevance(event, [BTCUSD], new Set());
  expect(result.isRelevant).toBe(true);
  expect(result.matches.some(m => m.assetCategory === 'BTC')).toBe(true);
});

test('Event with no matching assets → isRelevant false', () => {
  const event  = makeEvent('e1', ['SILVER', 'CRUDE']);
  const result = getWatchlistRelevance(event, [NIFTY50, BTCUSD], new Set());
  expect(result.isRelevant).toBe(false);
});

test('Empty watchlist → always not relevant', () => {
  const event  = makeEvent('e1', ['NIFTY', 'GOLD', 'BTC']);
  const result = getWatchlistRelevance(event, [], new Set());
  expect(result.isRelevant).toBe(false);
});

test('Open position in matched symbols → hasOpenPosition true', () => {
  const event     = makeEvent('e1', ['BTC']);
  const openSyms  = new Set(['BTCUSD']);
  const result    = getWatchlistRelevance(event, [BTCUSD], openSyms);
  expect(result.hasOpenPosition).toBe(true);
});

test('Open position symbol not in watchlist match → hasOpenPosition false', () => {
  // BTC-PERP is an open position, but event only affects GOLD which maps to gold assets
  const event    = makeEvent('e1', ['GOLD']);
  const openSyms = new Set(['BTC-PERP']);
  const result   = getWatchlistRelevance(event, [GOLD_ASSET], openSyms);
  // GOLD_ASSET matches GOLD category; BTC-PERP is not in matchedSymbols
  expect(result.hasOpenPosition).toBe(false);
});

test('Position open in same category as event → hasOpenPosition true', () => {
  const event    = makeEvent('e1', ['NIFTY']);
  const openSyms = new Set(['RELIANCE']); // RELIANCE maps to NIFTY
  const result   = getWatchlistRelevance(event, [RELIANCE], openSyms);
  expect(result.hasOpenPosition).toBe(true);
});

test('allMatchedSymbols deduplicated across categories', () => {
  // BANKNIFTY maps to both BANKNIFTY and NIFTY — should appear only once in allMatchedSymbols
  const event  = makeEvent('e1', ['NIFTY', 'BANKNIFTY']);
  const result = getWatchlistRelevance(event, [BANKNIFTY], new Set());
  const bankniftyCount = result.allMatchedSymbols.filter(s => s === 'BANKNIFTY').length;
  expect(bankniftyCount).toBe(1);
});

test('summaryLine mentions "Open position affected" when hasOpenPosition', () => {
  const event    = makeEvent('e1', ['BTC']);
  const openSyms = new Set(['BTCUSD']);
  const result   = getWatchlistRelevance(event, [BTCUSD], openSyms);
  expect(result.summaryLine).toContain('Open position affected');
});

test('summaryLine mentions "Affects your watchlist" when no open position', () => {
  const event  = makeEvent('e1', ['BTC']);
  const result = getWatchlistRelevance(event, [BTCUSD], new Set());
  expect(result.summaryLine).toContain('Affects your watchlist');
});

test('summaryLine empty when not relevant', () => {
  const event  = makeEvent('e1', ['SILVER']);
  const result = getWatchlistRelevance(event, [BTCUSD], new Set());
  expect(result.summaryLine).toBe('');
});

test('summaryLine shows at most 3 symbols with +N more', () => {
  const event = makeEvent('e1', ['NIFTY']);
  // 4 NSE stocks all map to NIFTY
  const assets = [RELIANCE, TCS, NIFTY50, { symbol: 'SBIN', type: 'STOCK', src: 'ao', base: 785 }];
  const result = getWatchlistRelevance(event, assets, new Set());
  // allMatchedSymbols has 4 items; summaryLine should mention "+1 more"
  expect(result.summaryLine).toContain('+1 more');
});

test('matches array contains one entry per affected category that matched', () => {
  const event  = makeEvent('e1', ['NIFTY', 'USDINR', 'GOLD']);
  const result = getWatchlistRelevance(event, [NIFTY50, USDINR], new Set());
  // NIFTY matched (NIFTY50), USDINR matched, GOLD not matched
  expect(result.matches.length).toBe(2);
  const cats = result.matches.map(m => m.assetCategory);
  expect(cats).toContain('NIFTY');
  expect(cats).toContain('USDINR');
  expect(cats).not.toContain('GOLD');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. getWatchlistRelevantEvents — sorting and filtering
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── 3. getWatchlistRelevantEvents ───────────────────────────────');

const FAR_DATE   = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
const NEAR_DATE  = new Date(Date.now() + 1 * 24 * 60 * 60 * 1000);

test('Returns only events that are relevant to the watchlist', () => {
  const events = [
    makeEvent('e1', ['NIFTY'],  { date: FAR_DATE  }),
    makeEvent('e2', ['SILVER'], { date: NEAR_DATE }),  // not relevant (no silver in watchlist)
  ];
  const result = getWatchlistRelevantEvents(events, [NIFTY50], new Set());
  expect(result.length).toBe(1);
  expect(result[0].event.id).toBe('e1');
});

test('Empty events → empty result', () => {
  const result = getWatchlistRelevantEvents([], [NIFTY50], new Set());
  expect(result.length).toBe(0);
});

test('No relevant events → empty result', () => {
  const events = [makeEvent('e1', ['GOLD', 'SILVER'])];
  const result = getWatchlistRelevantEvents(events, [BTCUSD], new Set());
  expect(result.length).toBe(0);
});

test('Events with open positions sort before watchlist-only events', () => {
  const events = [
    makeEvent('e1', ['BTC'],   { date: FAR_DATE  }),  // watchlist only (no open pos)
    makeEvent('e2', ['NIFTY'], { date: FAR_DATE  }),  // has open position
  ];
  const openSyms = new Set(['NIFTY50']); // NIFTY50 maps to NIFTY
  const watchlist = [BTCUSD, NIFTY50];
  const result = getWatchlistRelevantEvents(events, watchlist, openSyms);
  expect(result[0].event.id).toBe('e2'); // position event first
  expect(result[0].relevance.hasOpenPosition).toBe(true);
});

test('Within same priority tier, earlier events come first', () => {
  const events = [
    makeEvent('e1', ['BTC'], { date: FAR_DATE  }),
    makeEvent('e2', ['BTC'], { date: NEAR_DATE }),
  ];
  const result = getWatchlistRelevantEvents(events, [BTCUSD], new Set());
  expect(result[0].event.id).toBe('e2'); // nearer date first
});

test('Each result entry includes both event and relevance', () => {
  const events = [makeEvent('e1', ['BTC'])];
  const result = getWatchlistRelevantEvents(events, [BTCUSD], new Set());
  expect(result[0].event).toBeTruthy();
  expect(result[0].relevance).toBeTruthy();
  expect(result[0].relevance.isRelevant).toBe(true);
});

test('Multiple open positions in different categories all detected', () => {
  const events  = [makeEvent('e1', ['NIFTY', 'BTC', 'USDINR'])];
  const watchlist = [NIFTY50, BTCUSD, USDINR];
  const openSyms  = new Set(['NIFTY50', 'BTCUSD']); // USDINR not open
  const result    = getWatchlistRelevantEvents(events, watchlist, openSyms);
  expect(result.length).toBe(1);
  expect(result[0].relevance.hasOpenPosition).toBe(true);
  // Check that the matches that have positions are correct
  const positionMatches = result[0].relevance.matches.filter(m => m.hasOpenPosition);
  expect(positionMatches.length).toBeGreaterThan(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Integration — realistic portfolio + event scenarios
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── 4. Integration Scenarios ────────────────────────────────────');

test('RBI MPC event: BANKNIFTY/NIFTY watchlist → relevant, HDFCBANK open position flagged', () => {
  const rbiEvent  = makeEvent('rbi-mpc', ['NIFTY', 'BANKNIFTY', 'USDINR']);
  const watchlist = [BANKNIFTY, NIFTY50, USDINR, BTCUSD];
  const openSyms  = new Set(['HDFCBANK', 'BANKNIFTY']); // both are NSE assets mapping to NIFTY/BANKNIFTY
  // Add HDFCBANK as a STOCK(ao) asset
  const hdfcAsset = { symbol: 'HDFCBANK', type: 'STOCK', src: 'ao', base: 1650 };
  const result    = getWatchlistRelevance(rbiEvent, [...watchlist, hdfcAsset], openSyms);
  expect(result.isRelevant).toBe(true);
  expect(result.hasOpenPosition).toBe(true);
  expect(result.allMatchedSymbols).toContain('BANKNIFTY');
  expect(result.allMatchedSymbols).toContain('NIFTY50');
  expect(result.allMatchedSymbols).toContain('USDINR');
});

test('US CPI event: crypto-heavy portfolio → BTC and ETH flagged', () => {
  const cpiEvent  = makeEvent('us-cpi', ['NIFTY', 'GOLD', 'CRUDE', 'BTC', 'ETH', 'USDINR']);
  const watchlist = [BTCUSD, ETHUSD, SOLUSD]; // crypto-only watchlist
  const result    = getWatchlistRelevance(cpiEvent, watchlist, new Set());
  expect(result.isRelevant).toBe(true);
  const cats = result.matches.map(m => m.assetCategory);
  expect(cats).toContain('BTC');
  expect(cats).toContain('ETH');
  // ALTCOINS (SOLUSDT) should also match since event doesn't explicitly list ALTCOINS,
  // but SOL maps to ALTCOINS which may or may not be in this event's affectedAssets
  // us-cpi doesn't affect ALTCOINS explicitly — so SOL should NOT match
  expect(result.allMatchedSymbols).not.toContain('SOLUSD');
});

test('OPEC event: crude commodity in watchlist → relevant', () => {
  const opecEvent = makeEvent('opec', ['CRUDE', 'NIFTY', 'USDINR']);
  const result    = getWatchlistRelevance(opecEvent, [CRUDE_ASSET], new Set());
  expect(result.isRelevant).toBe(true);
  expect(result.matches[0].assetCategory).toBe('CRUDE');
});

test('NSE holiday: equity-heavy portfolio → relevant (holiday affects NIFTY)', () => {
  const holiday   = makeEvent('nse-holiday', ['NIFTY', 'BANKNIFTY']);
  const watchlist = [NIFTY50, RELIANCE, TCS, BANKNIFTY];
  const result    = getWatchlistRelevance(holiday, watchlist, new Set());
  expect(result.isRelevant).toBe(true);
  expect(result.allMatchedSymbols.length).toBeGreaterThan(2);
});

test('EIA oil: only crypto in watchlist → not relevant', () => {
  const eiaEvent  = makeEvent('eia', ['CRUDE']);
  const result    = getWatchlistRelevance(eiaEvent, [BTCUSD, ETHUSD], new Set());
  expect(result.isRelevant).toBe(false);
});

test('FOMC: full watchlist → relevant with multiple categories', () => {
  const fomcEvent = makeEvent('fomc', ['NIFTY', 'GOLD', 'CRUDE', 'BTC', 'ETH', 'USDINR']);
  const watchlist = [NIFTY50, BTCUSD, ETHUSD, USDINR, GOLD_ASSET, CRUDE_ASSET];
  const result    = getWatchlistRelevance(fomcEvent, watchlist, new Set());
  expect(result.isRelevant).toBe(true);
  expect(result.matches.length).toBe(6); // all 6 categories matched
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Edge cases
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── 5. Edge Cases ───────────────────────────────────────────────');

test('Event with empty affectedAssets → not relevant (no crash)', () => {
  const event  = makeEvent('empty', []);
  const result = getWatchlistRelevance(event, [NIFTY50, BTCUSD], new Set());
  expect(result.isRelevant).toBe(false);
  expect(result.matches.length).toBe(0);
});

test('Empty openPositionSymbols Set → hasOpenPosition always false', () => {
  const event  = makeEvent('e1', ['BTC']);
  const result = getWatchlistRelevance(event, [BTCUSD], new Set());
  expect(result.hasOpenPosition).toBe(false);
});

test('Open position symbol that is not in the watchlist → no match', () => {
  // BNBUSD not in watchlist, even if open
  const event    = makeEvent('e1', ['ALTCOINS']);
  const openSyms = new Set(['BNBUSD']);
  const result   = getWatchlistRelevance(event, [BTCUSD], openSyms); // BTCUSD → BTC, not ALTCOINS
  expect(result.isRelevant).toBe(false);
});

test('Same symbol in watchlist twice → counted once in allMatchedSymbols', () => {
  // Two identical assets — should deduplicate in the output
  const dupList = [BTCUSD, { ...BTCUSD }];
  const event   = makeEvent('e1', ['BTC']);
  const result  = getWatchlistRelevance(event, dupList, new Set());
  const btcCount = result.allMatchedSymbols.filter(s => s === 'BTCUSD').length;
  expect(btcCount).toBe(1);
});

test('Null/undefined bnSym on crypto → treated as no-mapping (no crash)', () => {
  const noBnSym = { symbol: 'MYSTERY', type: 'CRYPTO', src: 'binance', bnSym: undefined, base: 0 };
  const cats = assetToCalendarCategories(noBnSym);
  expect(cats).toEqual([]);
});

test('getWatchlistRelevantEvents with empty watchlist returns nothing', () => {
  const events = [makeEvent('e1', ['NIFTY', 'BTC', 'ETH', 'GOLD'])];
  const result = getWatchlistRelevantEvents(events, [], new Set());
  expect(result.length).toBe(0);
});

test('Position open flag preserved in getWatchlistRelevantEvents result', () => {
  const events    = [makeEvent('e1', ['BTC'], { date: NEAR_DATE })];
  const openSyms  = new Set(['BTCUSD']);
  const result    = getWatchlistRelevantEvents(events, [BTCUSD], openSyms);
  expect(result[0].relevance.hasOpenPosition).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// Results
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n─────────────────────────────────────────────────────────────────');
console.log(`Watchlist Awareness Tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('\nFailed tests:');
  errors.forEach(e => console.error(`  ❌ ${e.name}\n     ${e.message}`));
  process.exit(1);
} else {
  console.log('All tests passed ✅');
}
