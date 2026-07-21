// ─────────────────────────────────────────────────────────────────────────────
// TRADING COACH — Tests  (v1.0.0)
//
// Tests the pure insight-generation logic inline (no AsyncStorage dependency).
// Every insight function is deterministic given a fixed trade set.
//
// Run with: node src/utils/__tests__/tradingCoach.test.js
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

let passed = 0, failed = 0;
const tests = [];
function test(label, fn) { tests.push({ label, fn }); }

function assertEqual(a, e, label) {
  if (a !== e) throw new Error(`${label}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
}
function assertGte(a, min, label) {
  if (a < min) throw new Error(`${label}: expected ≥${min}, got ${a}`);
}
function assertBetween(a, lo, hi, label) {
  if (a < lo || a > hi) throw new Error(`${label}: expected ${lo}–${hi}, got ${a}`);
}
function assertContains(str, sub, label) {
  if (!String(str).includes(sub)) throw new Error(`${label}: "${sub}" not in "${str}"`);
}

// ── Inline pure logic (mirrors tradingCoach.ts exactly) ──────────────────────

const MIN_SAMPLE         = 5;
const MIN_TRADES_OVERALL = 10;

function winRate(trades) {
  if (!trades.length) return 0;
  return (trades.filter(t => t.pnl > 0).length / trades.length) * 100;
}
function avgPnl(trades) {
  if (!trades.length) return 0;
  return trades.reduce((s, t) => s + t.pnl, 0) / trades.length;
}
function profitFactor(trades) {
  const wins = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const loss = Math.abs(trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
  return loss > 0 ? wins / loss : wins > 0 ? Infinity : 0;
}
function groupBy(arr, key) {
  const map = new Map();
  for (const item of arr) {
    const k = key(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}

function overrideInsights(trades) {
  const overrides = trades.filter(t => t.signalSnapshot?.overrideUsed === true);
  const normal    = trades.filter(t => t.signalSnapshot?.overrideUsed === false);
  if (overrides.length < MIN_SAMPLE || normal.length < MIN_SAMPLE) return [];
  const overrideWR = winRate(overrides), normalWR = winRate(normal);
  const delta = overrideWR - normalWR;
  const sentiment = delta < -10 ? 'negative' : delta > 10 ? 'positive' : 'neutral';
  return [{
    id: 'override-wr', category: 'OVERRIDE',
    headline: delta < -10 ? `Overriding the AI costs you ${Math.abs(delta).toFixed(0)}% win rate`
      : delta > 10 ? `Your overrides outperform AI signals by ${delta.toFixed(0)}%`
      : `Your override win rate is close to normal trades`,
    sentiment,
    sampleSize: overrides.length + normal.length,
    impact: Math.min(100, Math.abs(delta) * 2),
    evidence: `Overrides: ${overrideWR.toFixed(1)}% (${overrides.length}) · Normal: ${normalWR.toFixed(1)}% (${normal.length})`,
    detail: '',
  }];
}

function confidenceInsights(trades) {
  const withConf = trades.filter(t => t.signalSnapshot?.confidence != null);
  if (withConf.length < MIN_SAMPLE * 2) return [];
  const bands = [
    { label: 'Low (<50)', min: 0, max: 50 },
    { label: 'Top (80+)', min: 80, max: 101 },
  ];
  const buckets = bands.map(b => ({
    ...b, trades: withConf.filter(t => t.signalSnapshot.confidence >= b.min && t.signalSnapshot.confidence < b.max),
  })).filter(b => b.trades.length >= MIN_SAMPLE);
  if (buckets.length < 2) return [];
  const top = buckets[buckets.length-1], bottom = buckets[0];
  const delta = winRate(top.trades) - winRate(bottom.trades);
  if (Math.abs(delta) <= 5) return [];
  return [{
    id: 'confidence-calibration', category: 'CONFIDENCE',
    headline: delta > 0 ? `High-confidence signals win more` : `High confidence is NOT predicting better outcomes`,
    sentiment: delta > 5 ? 'positive' : 'warning',
    sampleSize: top.trades.length + bottom.trades.length,
    impact: Math.min(100, Math.abs(delta) * 1.5),
    evidence: `Top: ${winRate(top.trades).toFixed(1)}% · Bottom: ${winRate(bottom.trades).toFixed(1)}%`,
    detail: '',
  }];
}

function computeGrade(trades) {
  if (trades.length < MIN_TRADES_OVERALL) return 'INSUFFICIENT';
  const pf = profitFactor(trades), wr = winRate(trades);
  const score = pf * 40 + (wr / 100) * 60;
  if (score >= 90) return 'A+';
  if (score >= 75) return 'A';
  if (score >= 60) return 'B';
  if (score >= 45) return 'C';
  if (score >= 35) return 'D';
  return 'F';
}

// ── Trade factories ───────────────────────────────────────────────────────────

function makeTrade(overrides = {}) {
  return {
    pnl: 50, direction: 'LONG', marketRegime: 'BULL_TREND',
    holdingMs: 3_600_000, exitReason: 'TAKE_PROFIT',
    signalSnapshot: {
      overrideUsed: false, confidence: 75, originalState: 'READY',
      signalType: 'TREND', strategyId: 'SWING', modelVersion: 3,
    },
    ...overrides,
  };
}

function makeTrades(n, overrides = {}) {
  return Array.from({ length: n }, () => makeTrade(overrides));
}

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════════

// ── Section 1: Insufficient data handling ────────────────────────────────────
console.log('\n── 1. Insufficient Data ──');

test('Fewer than 10 trades → INSUFFICIENT grade', () => {
  const grade = computeGrade(makeTrades(9));
  assertEqual(grade, 'INSUFFICIENT', 'Grade with 9 trades');
});

test('Exactly 10 trades → gets a real grade', () => {
  const grade = computeGrade([
    ...makeTrades(6, { pnl: 100 }),
    ...makeTrades(4, { pnl: -30 }),
  ]);
  assertEqual(grade !== 'INSUFFICIENT', true, 'Grade computed with 10 trades');
});

test('Zero trades → INSUFFICIENT', () => {
  assertEqual(computeGrade([]), 'INSUFFICIENT', 'Empty trade list');
});

// ── Section 2: Grade computation ─────────────────────────────────────────────
console.log('\n── 2. Grade Computation ──');

test('High win rate + high profit factor → A+ or A', () => {
  const trades = [
    ...makeTrades(8, { pnl: 200 }),
    ...makeTrades(2, { pnl: -50 }),
  ];
  const grade = computeGrade(trades);
  assertEqual(['A+', 'A'].includes(grade), true, `Strong performance grade: ${grade}`);
});

test('Below-breakeven PF → F grade', () => {
  const trades = [
    ...makeTrades(3, { pnl: 10 }),
    ...makeTrades(7, { pnl: -100 }),
  ];
  const grade = computeGrade(trades);
  assertEqual(grade, 'F', 'Loss-dominant trading');
});

test('Breakeven PF (1.0), 50% WR → B grade (score=70)', () => {
  const trades = [
    ...makeTrades(5, { pnl: 50 }),
    ...makeTrades(5, { pnl: -50 }),
  ];
  const grade = computeGrade(trades);
  // score = PF(1.0)*40 + WR(0.5)*60 = 40+30 = 70 → B
  assertEqual(grade, 'B', `Breakeven grade`);
});

// ── Section 3: Override insights ─────────────────────────────────────────────
console.log('\n── 3. Override Insights ──');

test('Override trades performing much worse → negative insight', () => {
  const trades = [
    // Normal trades: 80% WR
    ...makeTrades(4, { pnl: 100, signalSnapshot: { overrideUsed: false, confidence: 75 } }),
    ...makeTrades(1, { pnl: -50, signalSnapshot: { overrideUsed: false, confidence: 75 } }),
    // Override trades: 20% WR
    ...makeTrades(1, { pnl: 30,  signalSnapshot: { overrideUsed: true,  confidence: 40 } }),
    ...makeTrades(4, { pnl: -80, signalSnapshot: { overrideUsed: true,  confidence: 40 } }),
  ];
  const insights = overrideInsights(trades);
  assertEqual(insights.length, 1, 'One override insight generated');
  assertEqual(insights[0].sentiment, 'negative', 'Negative sentiment for bad overrides');
  assertContains(insights[0].headline, 'costs you', 'Headline mentions cost');
});

test('Override trades performing much better → positive insight', () => {
  const trades = [
    // Normal trades: 40% WR
    ...makeTrades(2, { pnl: 50,  signalSnapshot: { overrideUsed: false, confidence: 75 } }),
    ...makeTrades(3, { pnl: -30, signalSnapshot: { overrideUsed: false, confidence: 75 } }),
    // Override trades: 80% WR
    ...makeTrades(4, { pnl: 100, signalSnapshot: { overrideUsed: true,  confidence: 40 } }),
    ...makeTrades(1, { pnl: -20, signalSnapshot: { overrideUsed: true,  confidence: 40 } }),
  ];
  const insights = overrideInsights(trades);
  assertEqual(insights.length, 1, 'One override insight generated');
  assertEqual(insights[0].sentiment, 'positive', 'Positive when overrides outperform');
});

test('Insufficient samples → no override insight', () => {
  const trades = [
    ...makeTrades(3, { pnl: 100, signalSnapshot: { overrideUsed: false, confidence: 75 } }),
    ...makeTrades(2, { pnl: -30, signalSnapshot: { overrideUsed: true,  confidence: 40 } }),
  ];
  // Only 2 overrides — below MIN_SAMPLE
  const insights = overrideInsights(trades);
  assertEqual(insights.length, 0, 'No insight below MIN_SAMPLE');
});

// ── Section 4: Confidence calibration ────────────────────────────────────────
console.log('\n── 4. Confidence Calibration ──');

test('High confidence beats low confidence → positive insight', () => {
  const trades = [
    // Low confidence (<50): 30% WR
    ...makeTrades(2, { pnl: 50,  signalSnapshot: { overrideUsed: false, confidence: 30 } }),
    ...makeTrades(5, { pnl: -60, signalSnapshot: { overrideUsed: false, confidence: 35 } }),
    // High confidence (80+): 90% WR
    ...makeTrades(9, { pnl: 100, signalSnapshot: { overrideUsed: false, confidence: 85 } }),
    ...makeTrades(1, { pnl: -20, signalSnapshot: { overrideUsed: false, confidence: 90 } }),
  ];
  const insights = confidenceInsights(trades);
  assertEqual(insights.length, 1, 'Confidence insight generated');
  assertEqual(insights[0].sentiment, 'positive', 'Positive calibration');
});

test('High confidence worse than low → warning insight', () => {
  const trades = [
    // Low confidence: 85% WR
    ...makeTrades(5, { pnl: 80,  signalSnapshot: { overrideUsed: false, confidence: 30 } }),
    ...makeTrades(1, { pnl: -20, signalSnapshot: { overrideUsed: false, confidence: 40 } }),
    // High confidence: 30% WR
    ...makeTrades(2, { pnl: 50,  signalSnapshot: { overrideUsed: false, confidence: 85 } }),
    ...makeTrades(5, { pnl: -70, signalSnapshot: { overrideUsed: false, confidence: 90 } }),
  ];
  const insights = confidenceInsights(trades);
  assertEqual(insights.length >= 1, true, 'Insight generated for bad calibration');
  if (insights.length) {
    assertEqual(insights[0].sentiment, 'warning', 'Warning for poor calibration');
  }
});

// ── Section 5: Sample size and evidence ──────────────────────────────────────
console.log('\n── 5. Evidence & Sample Size ──');

test('Override insight sampleSize equals override + normal count', () => {
  const overrideCount = 6, normalCount = 8;
  const trades = [
    ...makeTrades(overrideCount, { signalSnapshot: { overrideUsed: true,  confidence: 50 } }),
    ...makeTrades(normalCount,   { signalSnapshot: { overrideUsed: false, confidence: 75 } }),
  ];
  const insights = overrideInsights(trades);
  if (insights.length) {
    assertEqual(insights[0].sampleSize, overrideCount + normalCount, 'Correct sample size');
  }
});

test('Override insight always includes trade count in evidence', () => {
  const trades = [
    ...makeTrades(5, { pnl: 100, signalSnapshot: { overrideUsed: false, confidence: 80 } }),
    ...makeTrades(5, { pnl: -80, signalSnapshot: { overrideUsed: true,  confidence: 45 } }),
  ];
  const insights = overrideInsights(trades);
  if (insights.length) {
    assertContains(insights[0].evidence, '5', 'Evidence contains trade count');
    assertEqual(typeof insights[0].evidence, 'string', 'Evidence is a string');
  }
});

// ── Section 6: Win rate and profit factor maths ───────────────────────────────
console.log('\n── 6. Core Maths ──');

test('winRate: 3 wins out of 5 = 60%', () => {
  const trades = [
    ...makeTrades(3, { pnl: 50 }),
    ...makeTrades(2, { pnl: -30 }),
  ];
  assertBetween(winRate(trades), 59.9, 60.1, 'Win rate 60%');
});

test('profitFactor: 300 gross win / 60 gross loss = 5.0', () => {
  const trades = [
    ...makeTrades(3, { pnl: 100 }),  // 300 gross win
    ...makeTrades(2, { pnl: -30 }),  // 60 gross loss
  ];
  assertBetween(profitFactor(trades), 4.99, 5.01, 'Profit factor 5.0');
});

test('profitFactor: all losses = 0', () => {
  const trades = makeTrades(5, { pnl: -50 });
  assertEqual(profitFactor(trades), 0, 'All losses = PF 0');
});

test('profitFactor: all wins = Infinity', () => {
  const trades = makeTrades(5, { pnl: 100 });
  assertEqual(profitFactor(trades), Infinity, 'All wins = PF Infinity');
});

test('avgPnl: correct average', () => {
  const trades = [
    makeTrade({ pnl: 100 }),
    makeTrade({ pnl: -50 }),
    makeTrade({ pnl: 200 }),
  ];
  assertBetween(avgPnl(trades), 83.3, 83.4, 'Avg P&L 83.33');
});

// ── Section 7: Impact ranking ────────────────────────────────────────────────
console.log('\n── 7. Impact & Ranking ──');

test('Higher win rate gap → higher impact score', () => {
  // Small gap
  const tradesSmall = [
    ...makeTrades(5, { pnl: 100, signalSnapshot: { overrideUsed: false, confidence: 75 } }),
    ...makeTrades(4, { pnl: 80,  signalSnapshot: { overrideUsed: true,  confidence: 60 } }),
    ...makeTrades(1, { pnl: -20, signalSnapshot: { overrideUsed: true,  confidence: 60 } }),
  ];
  // Large gap
  const tradesLarge = [
    ...makeTrades(5, { pnl: 100, signalSnapshot: { overrideUsed: false, confidence: 75 } }),
    ...makeTrades(1, { pnl: 30,  signalSnapshot: { overrideUsed: true,  confidence: 40 } }),
    ...makeTrades(4, { pnl: -80, signalSnapshot: { overrideUsed: true,  confidence: 40 } }),
  ];
  const smallInsights = overrideInsights(tradesSmall);
  const largeInsights = overrideInsights(tradesLarge);
  if (smallInsights.length && largeInsights.length) {
    assertEqual(
      largeInsights[0].impact >= smallInsights[0].impact, true,
      'Larger gap → higher impact'
    );
  }
});

test('Impact capped at 100', () => {
  // Extreme gap: 100% WR normal, 0% WR overrides
  const trades = [
    ...makeTrades(5, { pnl: 100, signalSnapshot: { overrideUsed: false, confidence: 80 } }),
    ...makeTrades(5, { pnl: -50, signalSnapshot: { overrideUsed: true,  confidence: 30 } }),
  ];
  const insights = overrideInsights(trades);
  if (insights.length) {
    assertEqual(insights[0].impact <= 100, true, 'Impact ≤ 100');
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
(async () => {
  for (const { label, fn } of tests) {
    try {
      const r = fn(); if (r?.then) await r;
      passed++; console.log(`  ✓ ${label}`);
    } catch (e) {
      failed++; console.log(`  ✗ ${label}\n      ${e.message}`);
    }
  }
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  Trading Coach Tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) { console.log('  ✗ SOME TESTS FAILED'); process.exit(1); }
  else            { console.log('  ✓ ALL TESTS PASSED'); }
})();
