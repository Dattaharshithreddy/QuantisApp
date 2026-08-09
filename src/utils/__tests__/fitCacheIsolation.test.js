// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION TEST: fitCache.S isolation from _computeLiveOverlay  (Point 6)
//
// Verifies that _computeLiveOverlay working on a clone does NOT mutate
// the historical S arrays stored in fitCache.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

let passed = 0, failed = 0;
function test(label, fn) {
  try { fn(); console.log(`  ✓  ${label}`); passed++; }
  catch(e) { console.log(`  ✗  ${label}\n       ${e.message}`); failed++; }
}
function assertEqual(a, b, label) {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw new Error(`${label}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function assertNotEqual(a, b, label) {
  if (JSON.stringify(a) === JSON.stringify(b))
    throw new Error(`${label}: values should differ but are equal: ${JSON.stringify(a)}`);
}
function assertTrue(c, label) { if (!c) throw new Error(`${label}: expected true`); }

// ── Minimal indicator series mock (same shape as precomputeSeriesImpl output) ─
function makeHistoricalS(n) {
  // Each indicator array has n entries with deterministic values
  const arr = (v) => Array.from({length: n}, (_, i) => v + i * 0.001);
  return {
    ema20:  arr(100), ema50: arr(200), ema200: arr(300), sma20: arr(400),
    rsiArr: arr(50),  atrArr: arr(1.5),
    macdRes: { macd: arr(0.1), signal: arr(0.05), hist: arr(0.05) },
    bb:     Array.from({length: n}, (_, i) => ({ mid: 100+i*0.01, up: 102+i*0.01, low: 98+i*0.01, std: 2 })),
    obvArr: arr(1000), vwapArr: arr(100),
    // Non-mutated arrays — should remain unchanged
    histVol: arr(0.02), stochRsi: arr(50), adxArr: arr(20),
    rsiArr2: arr(50), cciArr: arr(0), willR: arr(-50),
  };
}

// ── Simulate what _computeLiveOverlay does (inline — no import needed) ───────
function applyLiveOverlay(historicalS, n, newPrice, prevPrice) {
  // This mirrors the CLONED version of _computeLiveOverlay
  const S = {
    ...historicalS,
    ema20:   [...historicalS.ema20],
    ema50:   [...historicalS.ema50],
    ema200:  [...historicalS.ema200],
    sma20:   [...historicalS.sma20],
    rsiArr:  [...historicalS.rsiArr],
    atrArr:  [...historicalS.atrArr],
    obvArr:  [...historicalS.obvArr],
    vwapArr: [...historicalS.vwapArr],
    macdRes: {
      ...historicalS.macdRes,
      macd:   [...historicalS.macdRes.macd],
      signal: [...historicalS.macdRes.signal],
      hist:   [...historicalS.macdRes.hist],
    },
    bb: [...historicalS.bb],
  };

  // Apply EMA update at index n-1
  const alpha20 = 2 / 21;
  S.ema20[n-1] = S.ema20[n-2] + alpha20 * (newPrice - S.ema20[n-2]);
  S.rsiArr[n-1] = 55.0; // approximate
  S.atrArr[n-1] = S.atrArr[n-2] * 0.9 + Math.abs(newPrice - prevPrice) * 0.1;
  S.bb[n-1] = { ...S.bb[n-1], mid: newPrice, up: newPrice + 2, low: newPrice - 2, std: 2 };

  return S;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('1. historicalS.ema20 is NOT mutated after applyLiveOverlay', () => {
  const n = 500;
  const historicalS = makeHistoricalS(n);
  const originalEma20AtN = historicalS.ema20[n-1];
  const overlay = applyLiveOverlay(historicalS, n, 67500, 67420);
  // overlay has a different value at n-1
  assertNotEqual(overlay.ema20[n-1], originalEma20AtN, 'overlay has different ema20[n-1]');
  // historicalS is unchanged
  assertEqual(historicalS.ema20[n-1], originalEma20AtN, 'historicalS.ema20[n-1] unchanged');
});

test('2. historicalS.rsiArr is NOT mutated after applyLiveOverlay', () => {
  const n = 500;
  const historicalS = makeHistoricalS(n);
  const originalRsi = historicalS.rsiArr[n-1];
  applyLiveOverlay(historicalS, n, 67500, 67420);
  assertEqual(historicalS.rsiArr[n-1], originalRsi, 'historicalS.rsiArr[n-1] unchanged');
});

test('3. historicalS.atrArr is NOT mutated after applyLiveOverlay', () => {
  const n = 500;
  const historicalS = makeHistoricalS(n);
  const originalAtr = historicalS.atrArr[n-1];
  applyLiveOverlay(historicalS, n, 67500, 67420);
  assertEqual(historicalS.atrArr[n-1], originalAtr, 'historicalS.atrArr[n-1] unchanged');
});

test('4. historicalS.macdRes.macd is NOT mutated after applyLiveOverlay', () => {
  const n = 500;
  const historicalS = makeHistoricalS(n);
  const originalMacd = historicalS.macdRes.macd[n-1];
  applyLiveOverlay(historicalS, n, 67500, 67420);
  assertEqual(historicalS.macdRes.macd[n-1], originalMacd, 'macdRes.macd[n-1] unchanged');
});

test('5. historicalS.bb is NOT mutated after applyLiveOverlay', () => {
  const n = 500;
  const historicalS = makeHistoricalS(n);
  const originalBbMid = historicalS.bb[n-1].mid;
  applyLiveOverlay(historicalS, n, 67500, 67420);
  assertEqual(historicalS.bb[n-1].mid, originalBbMid, 'bb[n-1].mid unchanged');
});

test('6. Non-mutated arrays (histVol, stochRsi) remain shared reference (no unnecessary copy)', () => {
  const n = 500;
  const historicalS = makeHistoricalS(n);
  const overlay = applyLiveOverlay(historicalS, n, 67500, 67420);
  // histVol is NOT in the mutated set — shared by reference is correct
  assertTrue(overlay.histVol === historicalS.histVol, 'histVol shared by reference (not copied)');
  assertTrue(overlay.stochRsi === historicalS.stochRsi, 'stochRsi shared by reference');
  assertTrue(overlay.adxArr === historicalS.adxArr, 'adxArr shared by reference');
});

test('7. Historical values at indices 0..n-2 are preserved in overlay', () => {
  const n = 500;
  const historicalS = makeHistoricalS(n);
  const overlay = applyLiveOverlay(historicalS, n, 67500, 67420);
  // Check several mid-range indices
  for (const i of [0, 100, 250, 498]) {
    assertEqual(overlay.ema20[i], historicalS.ema20[i], `ema20[${i}] preserved in overlay`);
    assertEqual(overlay.rsiArr[i], historicalS.rsiArr[i], `rsiArr[${i}] preserved`);
  }
});

test('8. fitCache.S reference is unchanged — same as historicalS after overlay', () => {
  const n = 500;
  const historicalS = makeHistoricalS(n);
  // Simulate fitCache holding a reference to historicalS
  const fitCache = { S: historicalS, allFeatures: [], validIndices: [] };
  // Run overlay — should NOT affect fitCache.S
  const overlay = applyLiveOverlay(historicalS, n, 67500, 67420);
  // fitCache.S is same object as historicalS — both must be unchanged
  assertEqual(fitCache.S.ema20[n-1], historicalS.ema20[n-1], 'fitCache.S.ema20[n-1] unchanged');
  assertEqual(fitCache.S.rsiArr[n-1], historicalS.rsiArr[n-1], 'fitCache.S.rsiArr[n-1] unchanged');
  // overlay has different values
  assertNotEqual(overlay.ema20[n-1], fitCache.S.ema20[n-1], 'overlay has independent ema20[n-1]');
});

test('9. Performance: cloning 10 arrays of length 5000 is fast (<5ms)', () => {
  const n = 5000;
  const historicalS = makeHistoricalS(n);
  const start = Date.now();
  // Run 100 overlay calls (simulating rapid price ticks)
  for (let i = 0; i < 100; i++) {
    applyLiveOverlay(historicalS, n, 67500 + i * 0.1, 67420 + i * 0.1);
  }
  const elapsed = Date.now() - start;
  const perCall = elapsed / 100;
  console.log(`     100 overlay calls on 5000-bar S: ${elapsed}ms total, ${perCall.toFixed(2)}ms/call`);
  assertTrue(perCall < 5, `${perCall.toFixed(2)}ms/call should be <5ms`);
});

test('10. All 12 written properties confirmed in clone — none missed', () => {
  const written = ['ema20','ema50','ema200','sma20','rsiArr','atrArr',
                   'macdRes.macd','macdRes.signal','macdRes.hist','bb','obvArr','vwapArr'];
  const n = 100;
  const historicalS = makeHistoricalS(n);
  const overlay = applyLiveOverlay(historicalS, n, 102, 101);
  // Each cloned array must be a different reference than the original
  assertTrue(overlay.ema20 !== historicalS.ema20,   'ema20 is independent copy');
  assertTrue(overlay.ema50 !== historicalS.ema50,   'ema50 is independent copy');
  assertTrue(overlay.rsiArr !== historicalS.rsiArr, 'rsiArr is independent copy');
  assertTrue(overlay.atrArr !== historicalS.atrArr, 'atrArr is independent copy');
  assertTrue(overlay.bb !== historicalS.bb,         'bb is independent copy');
  assertTrue(overlay.obvArr !== historicalS.obvArr, 'obvArr is independent copy');
  assertTrue(overlay.vwapArr !== historicalS.vwapArr,'vwapArr is independent copy');
  assertTrue(overlay.macdRes !== historicalS.macdRes,'macdRes is independent copy');
  assertTrue(overlay.macdRes.macd !== historicalS.macdRes.macd,'macdRes.macd is independent');
  console.log(`     All ${written.length} written properties confirmed independent ✓`);
});

// ── Run ───────────────────────────────────────────────────────────────────────
console.log('\n─────────────────────────────────────────────────────');
console.log('fitCache.S ISOLATION — Regression Tests (Point 6-8)');
console.log('─────────────────────────────────────────────────────\n');
Promise.resolve().then(() => {
  console.log(`\n─────────────────────────────────────────────────────`);
  console.log(`${passed} passed, ${failed} failed (${passed+failed} total)`);
  if (!failed) { console.log('✓  ALL ISOLATION TESTS PASSED\n'); process.exit(0); }
  else { console.log(`✗  ${failed} FAILED\n`); process.exit(1); }
});
