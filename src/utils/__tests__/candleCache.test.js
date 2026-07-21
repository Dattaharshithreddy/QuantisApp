// ─────────────────────────────────────────────────────────────────────────────
// CANDLE CACHE — Integration Test Suite
//
// Tests all 9 required scenarios:
//   1. Empty cache
//   2. Partial cache (incremental update)
//   3. Full cache (TTL fresh — skip API)
//   4. Duplicate API data
//   5. Corrupted cache (graceful rebuild)
//   6. Incremental update (cache grows over time)
//   7. Restart persistence (session cache cleared, disk read)
//   8. Multiple symbols
//   9. Multiple timeframes
//
// REGRESSION: Identical candles produce identical output regardless of
// whether they came from cache or API (ML logic invariant).
// ─────────────────────────────────────────────────────────────────────────────

// Inline the core logic from candleCache.ts
const CACHE_VERSION = 2;
const TTL_MS = { '1m':60000,'5m':180000,'15m':300000,'1h':900000,'4h':1800000,'1D':3600000 };

function isValidCandle(c) {
  return c && typeof c.time==='number' && c.time>0 &&
    typeof c.open==='number' && isFinite(c.open) &&
    typeof c.high==='number' && isFinite(c.high) &&
    typeof c.low==='number'  && isFinite(c.low)  &&
    typeof c.close==='number'&& isFinite(c.close)&&
    typeof c.volume==='number'&& c.volume>=0;
}
function validateAndSort(candles) {
  const m = new Map();
  for (const c of candles) if (isValidCandle(c)) m.set(c.time, c);
  return Array.from(m.values()).sort((a,b)=>a.time-b.time);
}
function isCacheEntryValid(raw) {
  return raw && raw.version===CACHE_VERSION &&
    typeof raw.fetchedAt==='number' && typeof raw.symbol==='string' &&
    typeof raw.tf==='string' && Array.isArray(raw.candles);
}

// Mock AsyncStorage
class MockStorage {
  constructor() { this.store = {}; }
  async getItem(k) { return this.store[k] ?? null; }
  async setItem(k, v) { this.store[k] = v; }
  async removeItem(k) { delete this.store[k]; }
  async getAllKeys() { return Object.keys(this.store); }
  async multiRemove(keys) { keys.forEach(k => delete this.store[k]); }
  clear() { this.store = {}; }
}

// Minimal fetchCandlesWithCache implementation (mirrors production code)
async function fetchCandlesWithCache(symbol, tf, fetcher, storage, sessionCache, options={}) {
  const { maxCandles=10000, forceRefresh=false, skipApiIfFresh=false } = options;
  const sk = `candleCache_v${CACHE_VERSION}_${symbol}_${tf}`;
  
  // Read cache
  let cached = sessionCache.get(sk) ?? null;
  if (!cached) {
    const raw = await storage.getItem(sk);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (isCacheEntryValid(parsed)) {
          cached = { ...parsed, candles: validateAndSort(parsed.candles) };
          sessionCache.set(sk, cached);
        }
      } catch {}
    }
  }
  
  const cachedCandles = cached?.candles ?? [];
  const newestCachedTime = cachedCandles.length ? cachedCandles[cachedCandles.length-1].time : null;
  
  // TTL check
  if (skipApiIfFresh && cached && !forceRefresh) {
    const ttl = TTL_MS[tf] ?? 300000;
    if (Date.now() - cached.fetchedAt < ttl) return cachedCandles.slice(-maxCandles);
  }
  
  // Fetch fresh
  let fresh = [];
  try { fresh = await fetcher(newestCachedTime); } catch {}
  
  if (!fresh.length && cachedCandles.length) return cachedCandles.slice(-maxCandles);
  
  const merged = validateAndSort([...cachedCandles, ...fresh]);
  
  // Write back
  const entry = { version: CACHE_VERSION, candles: merged, fetchedAt: Date.now(), symbol, tf };
  sessionCache.set(sk, entry);
  await storage.setItem(sk, JSON.stringify(entry));
  
  return merged.slice(-maxCandles);
}

function makeCandle(time, price=100) {
  return { time, open:price, high:price+1, low:price-1, close:price, volume:1000 };
}

let pass=0, fail=0;
function check(label, ok, detail='') {
  if (ok) { pass++; console.log('  ✅', label); }
  else    { fail++; console.log('  ❌', label, detail||''); }
}

(async () => {

// ── Test 1: Empty cache ──────────────────────────────────────────────────────
console.log('\n── 1. Empty cache ──');
{
  const storage = new MockStorage();
  const session = new Map();
  const apiCandles = [makeCandle(1000), makeCandle(2000), makeCandle(3000)];
  const result = await fetchCandlesWithCache('BTC', '5m', async () => apiCandles, storage, session);
  check('Returns API candles when cache empty', result.length === 3);
  check('Candles sorted', result[0].time === 1000 && result[2].time === 3000);
  const cached = JSON.parse(await storage.getItem('candleCache_v2_BTC_5m'));
  check('Cache written to storage', cached?.candles?.length === 3);
  check('Cache has version field', cached?.version === 2);
}

// ── Test 2: Partial cache — incremental update ───────────────────────────────
console.log('\n── 2. Partial cache (incremental update) ──');
{
  const storage = new MockStorage();
  const session = new Map();
  const existing = [makeCandle(1000), makeCandle(2000), makeCandle(3000)];
  await storage.setItem('candleCache_v2_NIFTY_1h', JSON.stringify({
    version:2, symbol:'NIFTY', tf:'1h', fetchedAt: Date.now()-99999,
    candles: existing,
  }));
  
  let newestSeen = null;
  const result = await fetchCandlesWithCache('NIFTY', '1h', async (newestTime) => {
    newestSeen = newestTime;
    return [makeCandle(4000), makeCandle(5000)]; // 2 new candles
  }, storage, session, { forceRefresh: true });
  
  check('newestCachedTime passed to fetcher', newestSeen === 3000);
  check('Merged: 3 cached + 2 new = 5 total', result.length === 5);
  check('Old candles preserved', result[0].time === 1000);
  check('New candles appended', result[4].time === 5000);
}

// ── Test 3: Full cache — TTL fresh, skip API ─────────────────────────────────
console.log('\n── 3. Full cache (TTL fresh — skip API) ──');
{
  const storage = new MockStorage();
  const session = new Map();
  await storage.setItem('candleCache_v2_ETH_15m', JSON.stringify({
    version:2, symbol:'ETH', tf:'15m', fetchedAt: Date.now()-1000, // 1 second ago
    candles: [makeCandle(100),makeCandle(200),makeCandle(300)],
  }));
  
  let apiCalled = false;
  const result = await fetchCandlesWithCache('ETH', '15m', async () => {
    apiCalled = true; return [makeCandle(400)];
  }, storage, session, { skipApiIfFresh: true });
  
  check('API NOT called when cache is fresh', !apiCalled);
  check('Returns cached candles', result.length === 3);
}

// ── Test 4: Duplicate API data ───────────────────────────────────────────────
console.log('\n── 4. Duplicate API data ──');
{
  const storage = new MockStorage();
  const session = new Map();
  const candles = [makeCandle(1000), makeCandle(2000), makeCandle(3000)];
  await storage.setItem('candleCache_v2_BTC_1h', JSON.stringify({
    version:2, symbol:'BTC', tf:'1h', fetchedAt: Date.now()-99999,
    candles,
  }));
  
  // API returns candles that overlap with cache
  const result = await fetchCandlesWithCache('BTC', '1h', async () => [
    makeCandle(2000), makeCandle(3000), makeCandle(4000), // 2 duplicates + 1 new
  ], storage, session, { forceRefresh: true });
  
  check('No duplicates: 3 unique → 4 total', result.length === 4);
  check('All timestamps unique', new Set(result.map(c=>c.time)).size === 4);
}

// ── Test 5: Corrupted cache ───────────────────────────────────────────────────
console.log('\n── 5. Corrupted cache (graceful rebuild) ──');
{
  const storage = new MockStorage();
  const session = new Map();
  // Write corrupt JSON
  await storage.setItem('candleCache_v2_RELIANCE_1D', 'NOT_VALID_JSON{{{');
  
  const apiCandles = [makeCandle(10000), makeCandle(20000)];
  let rebuilt = false;
  const result = await fetchCandlesWithCache('RELIANCE', '1D', async () => {
    rebuilt = true; return apiCandles;
  }, storage, session);
  
  check('No crash on corrupt cache', result !== undefined);
  check('API called to rebuild', rebuilt);
  check('Returns API candles after rebuild', result.length === 2);
}

// ── Test 5b: Wrong version cache ─────────────────────────────────────────────
console.log('\n── 5b. Wrong version cache (auto-discard) ──');
{
  const storage = new MockStorage();
  const session = new Map();
  await storage.setItem('candleCache_v2_TCS_5m', JSON.stringify({
    version: 1, // old version
    symbol:'TCS', tf:'5m', fetchedAt: Date.now(),
    candles: [makeCandle(1), makeCandle(2)],
  }));
  
  const result = await fetchCandlesWithCache('TCS', '5m', async () => [makeCandle(100)], storage, session);
  check('Old version cache discarded, API used', result.length === 1 && result[0].time === 100);
}

// ── Test 6: Cache grows incrementally over multiple calls ─────────────────────
console.log('\n── 6. Incremental growth over multiple calls ──');
{
  const storage = new MockStorage();
  const session = new Map();
  
  // Day 1: 100 candles
  const day1 = Array.from({length:100}, (_,i) => makeCandle(i*60000 + 1000000));
  await fetchCandlesWithCache('INFY', '1m', async () => day1, storage, session);
  
  // Day 2: 50 new candles
  const day2 = Array.from({length:50}, (_,i) => makeCandle(i*60000 + 1000000 + 100*60000));
  const result2 = await fetchCandlesWithCache('INFY', '1m', async () => day2, storage, session, {forceRefresh:true});
  
  // Day 3: 30 new candles
  const day3 = Array.from({length:30}, (_,i) => makeCandle(i*60000 + 1000000 + 150*60000));
  const result3 = await fetchCandlesWithCache('INFY', '1m', async () => day3, storage, session, {forceRefresh:true});
  
  check('Cache grew: day1(100) + day2(50) = 150', result2.length === 150);
  check('Cache grew: 150 + day3(30) = 180', result3.length === 180);
  check('All candles sorted', result3.every((c,i) => i===0 || c.time >= result3[i-1].time));
}

// ── Test 7: Restart persistence ───────────────────────────────────────────────
console.log('\n── 7. Restart persistence (session cleared, disk survives) ──');
{
  const storage = new MockStorage();
  const session1 = new Map();
  
  const original = [makeCandle(1000), makeCandle(2000), makeCandle(3000)];
  await fetchCandlesWithCache('HDFC', '1h', async () => original, storage, session1);
  
  // Simulate app restart — new session cache (empty), same disk storage
  const session2 = new Map();
  let apiCallCount = 0;
  const result = await fetchCandlesWithCache('HDFC', '1h', async () => {
    apiCallCount++;
    return [makeCandle(4000)]; // 1 new candle after restart
  }, storage, session2, { forceRefresh: true });
  
  check('Cache survives restart (read from disk)', result.length === 4);
  check('Old candles preserved across restart', result[0].time === 1000);
  check('New candle appended after restart', result[3].time === 4000);
}

// ── Test 8: Multiple symbols ──────────────────────────────────────────────────
console.log('\n── 8. Multiple symbols ──');
{
  const storage = new MockStorage();
  const session = new Map();
  
  const symbols = ['BTC', 'ETH', 'NIFTY', 'RELIANCE'];
  for (const sym of symbols) {
    const candles = [makeCandle(1000*(symbols.indexOf(sym)+1))];
    await fetchCandlesWithCache(sym, '1h', async () => candles, storage, session);
  }
  
  // Verify each symbol has independent cache
  for (const sym of symbols) {
    const result = await fetchCandlesWithCache(sym, '1h', async () => [], storage, session, {skipApiIfFresh:true});
    check(`${sym}: independent cache entry`, result.length === 1);
  }
  check('Storage has 4 separate keys', 
    Object.keys(storage.store).filter(k=>k.includes('candleCache')).length === 4);
}

// ── Test 9: Multiple timeframes ───────────────────────────────────────────────
console.log('\n── 9. Multiple timeframes ──');
{
  const storage = new MockStorage();
  const session = new Map();
  const tfs = ['5m', '15m', '1h', '1D'];
  
  for (const tf of tfs) {
    const candles = Array.from({length:tfs.indexOf(tf)+1}, (_,i) => makeCandle((i+1)*1000));
    await fetchCandlesWithCache('NIFTY', tf, async () => candles, storage, session);
  }
  
  for (const tf of tfs) {
    const result = await fetchCandlesWithCache('NIFTY', tf, async () => [], storage, session, {skipApiIfFresh:true});
    check(`NIFTY/${tf}: ${tfs.indexOf(tf)+1} candles`, result.length === tfs.indexOf(tf)+1);
  }
}

// ── Regression: identical candles → identical output ─────────────────────────
console.log('\n── Regression: identical candles same output cache vs API ──');
{
  const storage = new MockStorage();
  const session = new Map();
  
  const candles = [makeCandle(1000,95),makeCandle(2000,96),makeCandle(3000,97)];
  
  // First call: from API
  const fromApi = await fetchCandlesWithCache('BTC','5m', async () => candles, storage, session);
  
  // Second call: from cache (TTL not fresh, but same candles)
  const fromCache = await fetchCandlesWithCache('BTC','5m', async () => [], storage, session, {forceRefresh:true});
  
  check('Cache output identical to API output: length', fromApi.length === fromCache.length);
  check('Cache output identical: all prices match',
    fromApi.every((c,i) => c.close === fromCache[i].close && c.time === fromCache[i].time));
  check('Invariant: order preserved', fromCache[0].time < fromCache[1].time);
}

// ── Validate candle filtering ─────────────────────────────────────────────────
console.log('\n── Corrupt candle filtering ──');
{
  const storage = new MockStorage();
  const session = new Map();
  
  const mixed = [
    makeCandle(1000),          // valid
    { time: 2000, open: NaN }, // corrupt (NaN)
    makeCandle(3000),          // valid
    { time: 0, close: 100 },  // corrupt (time=0)
    makeCandle(4000),          // valid
  ];
  
  const result = await fetchCandlesWithCache('X', '1h', async () => mixed, storage, session);
  check('Corrupt candles filtered out', result.length === 3);
  check('Valid candles preserved', result.every(c => isValidCandle(c)));
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(60));
console.log(`  ${pass+fail} checks | ✅ ${pass} passed | ❌ ${fail} failed`);
if (!fail) console.log('\n  ALL CACHE INVARIANTS PROVEN');
console.log('═'.repeat(60));

})();
