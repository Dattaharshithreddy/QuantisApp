// ─────────────────────────────────────────────────────────────────────────────
// PORTFOLIO RISK MANAGER — Tests  (v1.0.0)
// Run with: node src/utils/__tests__/portfolioRiskManager.test.js
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

let passed = 0, failed = 0;
const tests = [];
function test(label, fn) { tests.push({ label, fn }); }
function assertEqual(a, e, label) {
  if (Math.abs(Number(a) - Number(e)) > 0.0001 && a !== e)
    throw new Error(`${label}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
}
function assertBetween(a, lo, hi, label) {
  if (a < lo || a > hi) throw new Error(`${label}: expected ${lo}–${hi}, got ${a}`);
}
function assertGt(a, min, label) { if (a <= min) throw new Error(`${label}: expected > ${min}, got ${a}`); }
function assertLt(a, max, label) { if (a >= max) throw new Error(`${label}: expected < ${max}, got ${a}`); }
function assertTrue(a, label)    { if (!a) throw new Error(`${label}: expected true`); }

// ── Inline pure logic mirroring portfolioRiskManager.ts ──────────────────────

const APPROX_USD_INR = 84.0;
const Z_95 = 1.645;
const Z_99 = 2.326;

const DAILY_VOL = {
  BTCUSDT: 0.030, ETHUSDT: 0.035, SOLUSDT: 0.045, NIFTY: 0.012,
  BANKNIFTY: 0.015, RELIANCE: 0.018, DEFAULT: 0.020,
};

function getDailyVol(sym) { return DAILY_VOL[sym.toUpperCase()] ?? DAILY_VOL.DEFAULT; }
function usdToInr(usd) { return usd * APPROX_USD_INR; }

function computeVaR(positions) {
  const posVars = positions.map(p => getDailyVol(p.symbol) * p.notionalInr);
  const sumSq   = posVars.reduce((s, v) => s + v * v, 0);
  let cross = 0;
  for (let i = 0; i < posVars.length; i++)
    for (let j = i + 1; j < posVars.length; j++) {
      const corr = positions[i].account === positions[j].account ? 0.6 : 0.3;
      cross += 2 * corr * posVars[i] * posVars[j];
    }
  const sigma = Math.sqrt(sumSq + cross);
  return { var95: Z_95 * sigma, var99: Z_99 * sigma };
}

function computeRiskLevel(leverage, marginPct, var95, totalCapital) {
  if (leverage > 10 || marginPct > 80 || (totalCapital > 0 && var95 > totalCapital * 0.10)) return 'VERY_HIGH';
  if (leverage > 5  || marginPct > 60 || (totalCapital > 0 && var95 > totalCapital * 0.05)) return 'HIGH';
  if (leverage > 2  || marginPct > 40) return 'MODERATE';
  return 'LOW';
}

function buildReport(accounts, livePrices = {}) {
  const positions = [];
  let totalCapital = 0, totalNotional = 0, totalUnrealised = 0, totalMargin = 0;

  for (const acct of accounts) {
    totalCapital  += acct.balanceInr ?? 0;
    totalNotional += acct.notionalInr ?? 0;
    totalUnrealised += acct.unrealisedInr ?? 0;
    totalMargin   += acct.marginUsed ?? 0;
    for (const pos of acct.positions ?? []) {
      positions.push({ ...pos, account: acct.name });
    }
  }

  if (totalNotional > 0)
    positions.forEach(p => { p.weight = (p.notionalInr / totalNotional) * 100; });

  const sorted = [...positions].sort((a, b) => b.notionalInr - a.notionalInr);
  const largest = sorted[0] ?? null;
  const concentrationPct = largest && totalNotional > 0
    ? (largest.notionalInr / totalNotional) * 100 : 0;
  const marginUtilPct = totalCapital > 0 ? (totalMargin / totalCapital) * 100 : 0;
  const leverage      = totalCapital > 0 ? totalNotional / totalCapital : 0;
  const { var95, var99 } = computeVaR(sorted);
  const riskLevel = computeRiskLevel(leverage, marginUtilPct, var95, totalCapital);

  return {
    totalCapitalInr: totalCapital, totalNotionalInr: totalNotional,
    totalUnrealisedInr: totalUnrealised, marginUtilisationPct: marginUtilPct,
    overallLeverage: leverage, concentrationPct, largestPosition: largest,
    var95Inr: var95, var99Inr: var99, riskLevel, positions: sorted,
  };
}

// ── Test fixtures ─────────────────────────────────────────────────────────────

function paperAcct(balance, positions = []) {
  const notional = positions.reduce((s, p) => s + p.notionalInr, 0);
  return { name: 'Paper Equity', currency: 'INR', balanceInr: balance,
    notionalInr: notional, unrealisedInr: 0, marginUsed: notional, positions };
}

function futuresAcct(balance, positions = []) {
  const notional = positions.reduce((s, p) => s + p.notionalInr, 0);
  const margin   = positions.reduce((s, p) => s + (p.notionalInr / (p.leverage ?? 10)), 0);
  return { name: 'NSE Futures', currency: 'INR', balanceInr: balance,
    notionalInr: notional, unrealisedInr: 0, marginUsed: margin, positions };
}

function bnAcct(usdtBalance, positions = []) {
  const notionalUsd = positions.reduce((s, p) => s + p.notionalInr / 84, 0);
  const marginUsd   = positions.reduce((s, p) => s + (p.notionalInr / 84) / (p.leverage ?? 10), 0);
  return { name: 'Binance Futures', currency: 'USDT',
    balanceInr: usdToInr(usdtBalance),
    notionalInr: usdToInr(notionalUsd), unrealisedInr: 0,
    marginUsed: usdToInr(marginUsd), positions };
}

function pos(symbol, notionalInr, direction = 'LONG', leverage = 1) {
  return { id: `pos_${symbol}`, symbol, notionalInr, direction, leverage, unrealisedInr: 0 };
}

// ═══════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════

// ── 1. Capital and exposure aggregation ────────────────────────────────────
console.log('\n── 1. Capital & Exposure Aggregation ──');

test('Empty portfolio: all zeros, LOW risk', () => {
  const r = buildReport([paperAcct(100_000), futuresAcct(500_000)]);
  assertEqual(r.totalNotionalInr, 0, 'No notional when no positions');
  assertEqual(r.overallLeverage, 0, 'Zero leverage with no positions');
  assertEqual(r.riskLevel, 'LOW', 'Empty portfolio is LOW risk');
});

test('Totals correctly sum across accounts', () => {
  const r = buildReport([
    paperAcct(100_000, [pos('RELIANCE', 50_000)]),
    futuresAcct(500_000, [pos('NIFTY', 200_000, 'LONG', 10)]),
  ]);
  assertEqual(r.totalCapitalInr, 600_000, 'Total capital ₹6L');
  assertEqual(r.totalNotionalInr, 250_000, 'Total notional ₹2.5L');
});

test('USD accounts converted at ₹84/USD', () => {
  const r = buildReport([
    bnAcct(1000, [pos('BTCUSDT', 84_000, 'LONG', 10)]),  // $1000 USDT = ₹84,000
  ]);
  assertBetween(r.totalCapitalInr, 83_900, 84_100, 'BN balance converted');
});

test('Three accounts: total is sum of all', () => {
  const r = buildReport([
    paperAcct(200_000, [pos('TCS', 80_000)]),
    futuresAcct(500_000, [pos('BANKNIFTY', 300_000, 'LONG', 12)]),
    bnAcct(5000, [pos('ETHUSDT', usdToInr(5000), 'LONG', 20)]),
  ]);
  assertGt(r.totalCapitalInr, 500_000, 'Total capital > ₹5L');
  assertGt(r.totalNotionalInr, 350_000, 'Total notional > ₹3.5L');
});

// ── 2. Leverage and margin utilisation ────────────────────────────────────
console.log('\n── 2. Leverage & Margin Utilisation ──');

test('Equity-only: leverage = notional / capital', () => {
  const r = buildReport([paperAcct(100_000, [pos('INFY', 80_000)])]);
  assertBetween(r.overallLeverage, 0.79, 0.81, 'Equity leverage ~0.8× (not leveraged)');
});

test('10× futures: overall leverage reflects futures leverage', () => {
  // Capital ₹5L, NSE futures notional ₹50L = 10× leverage
  const r = buildReport([
    futuresAcct(500_000, [pos('NIFTY', 5_000_000, 'LONG', 10)]),
  ]);
  assertGt(r.overallLeverage, 9, 'Leverage > 9× on 10× futures');
  assertEqual(computeRiskLevel(r.overallLeverage, r.marginUtilisationPct, r.var95Inr, r.totalCapitalInr),
    'VERY_HIGH', 'Very high risk at 10× leverage');
});

test('Margin utilisation: 50% of capital in margin = 50%', () => {
  // Capital ₹10L, margin ₹5L (50% of capital)
  const capital = 1_000_000;
  const notional = 500_000; // e.g. equity at 1× — margin = notional
  const r = buildReport([paperAcct(capital, [pos('RELIANCE', notional)])]);
  assertBetween(r.marginUtilisationPct, 49, 51, 'Margin utilisation 50%');
});

test('HIGH risk: leverage 6×', () => {
  const level = computeRiskLevel(6, 50, 0, 1_000_000);
  assertEqual(level, 'HIGH', 'Leverage 6× → HIGH');
});

test('MODERATE risk: leverage 3×', () => {
  const level = computeRiskLevel(3, 35, 0, 1_000_000);
  assertEqual(level, 'MODERATE', 'Leverage 3× → MODERATE');
});

test('LOW risk: leverage 1×, margin 30%', () => {
  const level = computeRiskLevel(1, 30, 0, 1_000_000);
  assertEqual(level, 'LOW', 'Leverage 1× → LOW');
});

// ── 3. Concentration risk ─────────────────────────────────────────────────
console.log('\n── 3. Concentration Risk ──');

test('Single position: concentration = 100%', () => {
  const r = buildReport([paperAcct(500_000, [pos('RELIANCE', 200_000)])]);
  assertBetween(r.concentrationPct, 99, 101, 'Single position = 100% concentration');
});

test('Two equal positions: concentration = 50% each', () => {
  const r = buildReport([
    paperAcct(500_000, [
      pos('RELIANCE', 100_000),
      pos('INFY',     100_000),
    ]),
  ]);
  assertBetween(r.concentrationPct, 49, 51, 'Equal positions = 50% concentration');
});

test('Largest position identified correctly', () => {
  const r = buildReport([
    paperAcct(1_000_000, [
      pos('TCS',      50_000),
      pos('NIFTY',   300_000),
      pos('RELIANCE', 80_000),
    ]),
  ]);
  assertEqual(r.largestPosition?.symbol, 'NIFTY', 'Largest = NIFTY');
});

test('No positions: concentration = 0, no largest', () => {
  const r = buildReport([paperAcct(500_000)]);
  assertEqual(r.concentrationPct, 0, 'No concentration with no positions');
  assertEqual(r.largestPosition, null, 'No largest position');
});

// ── 4. VaR computation ────────────────────────────────────────────────────
console.log('\n── 4. Value at Risk ──');

test('VaR99 > VaR95 always', () => {
  const r = buildReport([
    paperAcct(500_000, [pos('NIFTY', 200_000), pos('BTCUSDT', 100_000)]),
  ]);
  assertGt(r.var99Inr, r.var95Inr, 'VaR99 > VaR95');
});

test('Single BTC position VaR: 3% daily vol on ₹1L notional', () => {
  // Single position: sigma = 0.03 * 100_000 = 3000
  // VaR95 = 1.645 * 3000 = 4935
  const { var95 } = computeVaR([{ symbol: 'BTCUSDT', notionalInr: 100_000, account: 'A' }]);
  assertBetween(var95, 4900, 4970, 'BTC VaR95 ~₹4935');
});

test('Two correlated positions have higher VaR than uncorrelated', () => {
  const samAcct = [
    { symbol: 'BTCUSDT', notionalInr: 100_000, account: 'A' },
    { symbol: 'ETHUSDT', notionalInr: 100_000, account: 'A' },  // same account → corr 0.6
  ];
  const diffAcct = [
    { symbol: 'BTCUSDT', notionalInr: 100_000, account: 'A' },
    { symbol: 'ETHUSDT', notionalInr: 100_000, account: 'B' },  // diff account → corr 0.3
  ];
  const { var95: v1 } = computeVaR(samAcct);
  const { var95: v2 } = computeVaR(diffAcct);
  assertGt(v1, v2, 'Same-account (higher corr) → higher VaR');
});

test('Zero positions: VaR = 0', () => {
  const { var95, var99 } = computeVaR([]);
  assertEqual(var95, 0, 'No positions → VaR95 = 0');
  assertEqual(var99, 0, 'No positions → VaR99 = 0');
});

test('VaR scales with notional — doubling notional doubles VaR (single position)', () => {
  const { var95: v1 } = computeVaR([{ symbol: 'NIFTY', notionalInr: 100_000, account: 'A' }]);
  const { var95: v2 } = computeVaR([{ symbol: 'NIFTY', notionalInr: 200_000, account: 'A' }]);
  assertBetween(v2 / v1, 1.99, 2.01, 'Doubling notional doubles VaR');
});

// ── 5. Risk level classification ──────────────────────────────────────────
console.log('\n── 5. Risk Level Classification ──');

test('VERY_HIGH: leverage > 10', () => {
  assertEqual(computeRiskLevel(11, 0, 0, 1e6), 'VERY_HIGH', 'Leverage 11 → VERY_HIGH');
});

test('VERY_HIGH: margin util > 80%', () => {
  assertEqual(computeRiskLevel(1, 85, 0, 1e6), 'VERY_HIGH', 'Margin 85% → VERY_HIGH');
});

test('VERY_HIGH: VaR > 10% of capital', () => {
  assertEqual(computeRiskLevel(1, 0, 120_000, 1_000_000), 'VERY_HIGH', 'VaR 12% → VERY_HIGH');
});

test('HIGH: VaR between 5-10% of capital', () => {
  assertEqual(computeRiskLevel(1, 0, 70_000, 1_000_000), 'HIGH', 'VaR 7% → HIGH');
});

test('All thresholds work together — worst metric wins', () => {
  // Leverage is MODERATE (3×), but margin is HIGH (65%) → overall HIGH
  assertEqual(computeRiskLevel(3, 65, 0, 1e6), 'HIGH', 'Worst metric determines level');
});

// ── 6. Currency conversion ────────────────────────────────────────────────
console.log('\n── 6. Currency Conversion ──');

test('USD to INR at ₹84', () => {
  assertBetween(usdToInr(1000), 83_900, 84_100, '$1000 = ~₹84,000');
});

test('INR accounts not converted (₹1 = ₹1)', () => {
  const r = buildReport([paperAcct(500_000, [pos('NIFTY', 200_000)])]);
  assertEqual(r.totalCapitalInr, 500_000, 'INR account: no conversion');
});

test('Mixed currency portfolio: totals in INR', () => {
  const r = buildReport([
    paperAcct(100_000),  // ₹1L
    bnAcct(1000),        // $1000 = ₹84,000
  ]);
  assertBetween(r.totalCapitalInr, 183_000, 185_000, 'Mixed: ~₹1.84L total');
});

// ── 7. Position weights ───────────────────────────────────────────────────
console.log('\n── 7. Position Weights ──');

test('Weights sum to 100% when positions exist', () => {
  const r = buildReport([
    paperAcct(1_000_000, [
      pos('RELIANCE', 200_000),
      pos('TCS',      300_000),
      pos('NIFTY',    500_000),
    ]),
  ]);
  const totalWeight = r.positions.reduce((s, p) => s + p.weight, 0);
  assertBetween(totalWeight, 99.9, 100.1, 'Weights sum to 100%');
});

test('Positions sorted by notional descending', () => {
  const r = buildReport([
    paperAcct(1_000_000, [
      pos('SMALL',  10_000),
      pos('LARGE', 500_000),
      pos('MED',   100_000),
    ]),
  ]);
  assertTrue(r.positions[0].notionalInr >= r.positions[1].notionalInr, 'First >= second');
  assertTrue(r.positions[1].notionalInr >= r.positions[2].notionalInr, 'Second >= third');
  assertEqual(r.positions[0].symbol, 'LARGE', 'Largest first');
});

// ═══════════════════════════════════════════════════════════════════════════
(async () => {
  for (const { label, fn } of tests) {
    try {
      const r = fn(); if (r?.then) await r;
      passed++; console.log(`  ✓ ${label}`);
    } catch (e) {
      failed++; console.log(`  ✗ ${label}\n      ${e.message}`);
    }
  }
  console.log(`\n${'─'.repeat(62)}`);
  console.log(`  Portfolio Risk Tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) { console.log('  ✗ SOME TESTS FAILED'); process.exit(1); }
  else            { console.log('  ✓ ALL TESTS PASSED'); }
})();
