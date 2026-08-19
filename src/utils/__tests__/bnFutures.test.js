// ─────────────────────────────────────────────────────────────────────────────
// BINANCE FUTURES — Tests  (v1.0.0)
// Tests leverage, margin, liquidation, P&L, RoE, funding, qty sizing.
// Run with: node src/utils/__tests__/bnFutures.test.js
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

let passed = 0, failed = 0;
const tests = [];
function test(label, fn) { tests.push({ label, fn }); }
function assertEqual(a, e, label) {
  if (Math.abs(a - e) > 0.0001 && a !== e)
    throw new Error(`${label}: expected ${e}, got ${a}`);
}
function assertBetween(a, lo, hi, label) {
  if (a < lo || a > hi) throw new Error(`${label}: expected ${lo}–${hi}, got ${a}`);
}
function assertGt(a, min, label) { if (a <= min) throw new Error(`${label}: expected > ${min}, got ${a}`); }
function assertLt(a, max, label) { if (a >= max) throw new Error(`${label}: expected < ${max}, got ${a}`); }
function assertFalse(a, label)   { if (a) throw new Error(`${label}: expected false, got true`); }
function assertTrue(a, label)    { if (!a) throw new Error(`${label}: expected true, got false`); }

// ── Inline pure logic (mirrors bnFuturesTypes.ts) ────────────────────────────

const BN_CONTRACT_SPECS = {
  BTCUSDT:   { symbol:'BTCUSDT',  contractSize:1, minQty:0.001, qtyStep:0.001, maxLeverage:125, takerFeeRate:0.0004, makerFeeRate:0.0002 },
  ETHUSDT:   { symbol:'ETHUSDT',  contractSize:1, minQty:0.001, qtyStep:0.001, maxLeverage:100, takerFeeRate:0.0004, makerFeeRate:0.0002 },
  SOLUSDT:   { symbol:'SOLUSDT',  contractSize:1, minQty:0.1,   qtyStep:0.1,   maxLeverage:50,  takerFeeRate:0.0004, makerFeeRate:0.0002 },
  DOGEUSDT:  { symbol:'DOGEUSDT', contractSize:1, minQty:1,     qtyStep:1,     maxLeverage:75,  takerFeeRate:0.0004, makerFeeRate:0.0002 },
};

const LEVERAGE_TIERS = [1,2,3,5,10,20,25,50,75,100,125];

function clampLeverage(leverage, symbol) {
  const max = BN_CONTRACT_SPECS[symbol].maxLeverage;
  const valid = LEVERAGE_TIERS.filter(t => t <= max);
  return valid.reduce((p,c) => Math.abs(c-leverage) < Math.abs(p-leverage) ? c : p);
}

function computeIsolatedMargin(qty, entryPrice, leverage, feeRate) {
  return (qty * entryPrice / leverage) + (qty * entryPrice * feeRate);
}

function computeLiquidationPrice(direction, entryPrice, leverage, mmRate = 0.005) {
  return direction === 'LONG'
    ? entryPrice * (1 - 1/leverage + mmRate)
    : entryPrice * (1 + 1/leverage - mmRate);
}

function computeBnPnL(direction, entry, current, qty) {
  return (current - entry) * qty * (direction === 'LONG' ? 1 : -1);
}

function computeRoE(pnl, margin) {
  return margin <= 0 ? 0 : (pnl / margin) * 100;
}

function computeFundingPayment(direction, qty, markPrice, fundingRate) {
  return direction === 'LONG'
    ? -(qty * markPrice * fundingRate)
    :  (qty * markPrice * fundingRate);
}

function isLiquidated(pos, price) {
  return pos.direction === 'LONG'
    ? price <= pos.liquidationPrice
    : price >= pos.liquidationPrice;
}

function maxQtyFromBudget(budget, entryPrice, leverage, spec) {
  const notional = budget * leverage;
  const steps = Math.floor(notional / entryPrice / spec.qtyStep);
  return Math.max(0, steps * spec.qtyStep);
}

function riskBasedQty(entryPrice, stopLoss, accountSize, riskPct, spec) {
  const riskAmount  = accountSize * (riskPct / 100);
  const riskPerUnit = Math.abs(entryPrice - stopLoss);
  if (riskPerUnit <= 0) return 0;
  const steps = Math.floor(riskAmount / riskPerUnit / spec.qtyStep);
  return Math.max(0, steps * spec.qtyStep);
}

// ── In-memory portfolio ───────────────────────────────────────────────────────

function createPortfolio(initial = 10_000) {
  return { usdtBalance: initial, initialCapital: initial, openPositions: [],
    totalRealizedPnL: 0, totalFundingPaid: 0 };
}

function openPosition(p, params) {
  const spec     = BN_CONTRACT_SPECS[params.symbol];
  const leverage = clampLeverage(params.leverage, params.symbol);
  const steps    = Math.round(params.qty / spec.qtyStep);
  const qty      = parseFloat((steps * spec.qtyStep).toFixed(8));
  if (qty < spec.minQty) return { opened: false, reason: `Min qty ${spec.minQty}` };
  const margin = computeIsolatedMargin(qty, params.entryPrice, leverage, spec.takerFeeRate);
  if (margin > p.usdtBalance) return { opened: false, reason: 'Insufficient balance' };
  const dup = p.openPositions.find(x => x.symbol === params.symbol);
  if (dup) return { opened: false, reason: 'Duplicate position' };
  const liqPrice = computeLiquidationPrice(params.direction, params.entryPrice, leverage);
  const pos = {
    id: `bnf_${Date.now()}`, symbol: params.symbol, direction: params.direction,
    qty, leverage, entryPrice: params.entryPrice, entryTime: Date.now(),
    stopLoss: params.stopLoss, takeProfit: params.takeProfit,
    isolatedMargin: margin, liquidationPrice: liqPrice,
    notionalValue: qty * params.entryPrice, unrealisedPnL: 0,
    fundingAccrued: 0, lastFundingAt: Date.now() - 9 * 3600_000,
  };
  p.openPositions.push(pos);
  p.usdtBalance -= margin;
  return { opened: true, position: pos };
}

function closePosition(p, posId, exitPrice, reason = 'MANUAL') {
  const idx = p.openPositions.findIndex(x => x.id === posId);
  if (idx === -1) return { closed: false };
  const pos  = p.openPositions[idx];
  const spec = BN_CONTRACT_SPECS[pos.symbol];
  const pnl  = computeBnPnL(pos.direction, pos.entryPrice, exitPrice, pos.qty);
  const fee  = pos.qty * exitPrice * spec.takerFeeRate;
  const marginReturned = reason === 'LIQUIDATION' ? 0 : pos.isolatedMargin;
  p.openPositions.splice(idx, 1);
  p.usdtBalance += marginReturned + pnl - fee;
  p.totalRealizedPnL += pnl - fee;
  return { closed: true, pnl: pnl - fee };
}

function applyFunding(p, prices, rates) {
  const INTERVAL = 8 * 3600_000;
  const now = Date.now();
  for (const pos of p.openPositions) {
    if (now - pos.lastFundingAt < INTERVAL) continue;
    const mark = prices[pos.symbol] ?? pos.entryPrice;
    const rate = rates[pos.symbol] ?? 0;
    const payment = computeFundingPayment(pos.direction, pos.qty, mark, rate);
    pos.fundingAccrued += payment;
    pos.lastFundingAt = now;
    p.usdtBalance += payment;
    p.totalFundingPaid += payment;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════════

// ── 1. Leverage clamping ──────────────────────────────────────────────────────
console.log('\n── 1. Leverage Clamping ──');

test('BTCUSDT max leverage is 125×', () => assertEqual(BN_CONTRACT_SPECS.BTCUSDT.maxLeverage, 125, 'BTC max lev'));
test('SOLUSDT max leverage is 50×', () => assertEqual(BN_CONTRACT_SPECS.SOLUSDT.maxLeverage, 50, 'SOL max lev'));
test('Leverage 10 on BTC → stays 10', () => assertEqual(clampLeverage(10, 'BTCUSDT'), 10, 'Clamp 10'));
test('Leverage 75 on SOL → clamped to 50', () => assertEqual(clampLeverage(75, 'SOLUSDT'), 50, 'Clamp 75→50'));
test('Leverage 200 on ETH → clamped to 100', () => assertEqual(clampLeverage(200, 'ETHUSDT'), 100, 'Clamp 200→100'));
test('Leverage 7 → snaps to nearest tier (5)', () => assertEqual(clampLeverage(7, 'BTCUSDT'), 5, 'Snap 7→5'));
test('Leverage 8 → snaps to nearest tier (10)', () => assertEqual(clampLeverage(8, 'BTCUSDT'), 10, 'Snap 8→10'));

// ── 2. Isolated margin ────────────────────────────────────────────────────────
console.log('\n── 2. Isolated Margin ──');

test('BTC 0.01 @ $60000, 10× → margin = $60 + fee', () => {
  const m = computeIsolatedMargin(0.01, 60_000, 10, 0.0004);
  // notional = $600, margin = $60, fee = $0.24
  assertBetween(m, 60.23, 60.25, 'Margin $60.24');
});

test('ETH 0.1 @ $3000, 20× → margin = $15 + fee', () => {
  const m = computeIsolatedMargin(0.1, 3_000, 20, 0.0004);
  // notional = $300, margin = $15, fee = $0.12
  assertBetween(m, 15.11, 15.13, 'Margin $15.12');
});

test('Margin increases with qty', () => {
  const m1 = computeIsolatedMargin(0.01, 60_000, 10, 0.0004);
  const m2 = computeIsolatedMargin(0.02, 60_000, 10, 0.0004);
  assertBetween(m2, m1 * 1.99, m1 * 2.01, 'Margin doubles with double qty');
});

test('Higher leverage = lower margin for same position', () => {
  const m10  = computeIsolatedMargin(0.01, 60_000, 10, 0.0004);
  const m100 = computeIsolatedMargin(0.01, 60_000, 100, 0.0004);
  assertLt(m100, m10, 'Higher leverage = less margin');
});

// ── 3. Liquidation price ──────────────────────────────────────────────────────
console.log('\n── 3. Liquidation Price ──');

test('LONG 10× liq price < entry price', () => {
  const liq = computeLiquidationPrice('LONG', 60_000, 10);
  assertLt(liq, 60_000, 'LONG liq below entry');
});

test('SHORT 10× liq price > entry price', () => {
  const liq = computeLiquidationPrice('SHORT', 60_000, 10);
  assertGt(liq, 60_000, 'SHORT liq above entry');
});

test('LONG 10× liq at ~90.5% of entry (1 - 1/10 + 0.5%)', () => {
  const liq = computeLiquidationPrice('LONG', 60_000, 10);
  const pct = liq / 60_000;
  assertBetween(pct, 0.90, 0.91, 'LONG 10× liq at ~90.5%');
});

test('Higher leverage → liq price closer to entry (LONG)', () => {
  const liq10  = computeLiquidationPrice('LONG', 60_000, 10);
  const liq100 = computeLiquidationPrice('LONG', 60_000, 100);
  assertGt(liq100, liq10, 'Higher leverage = liq price closer to entry for LONG');
});

test('isLiquidated: LONG position at or below liq price', () => {
  const pos = { direction: 'LONG', liquidationPrice: 54_000 };
  assertTrue(isLiquidated(pos, 54_000), 'Liquidated at liq price');
  assertTrue(isLiquidated(pos, 53_000), 'Liquidated below liq price');
  assertFalse(isLiquidated(pos, 55_000), 'Not liquidated above liq price');
});

test('isLiquidated: SHORT position at or above liq price', () => {
  const pos = { direction: 'SHORT', liquidationPrice: 66_000 };
  assertTrue(isLiquidated(pos, 66_000), 'Liquidated at liq price');
  assertTrue(isLiquidated(pos, 67_000), 'Liquidated above liq price');
  assertFalse(isLiquidated(pos, 65_000), 'Not liquidated below liq price');
});

// ── 4. P&L and RoE ───────────────────────────────────────────────────────────
console.log('\n── 4. P&L and Return on Equity ──');

test('LONG profits when price rises', () => {
  const pnl = computeBnPnL('LONG', 60_000, 62_000, 0.1);
  assertEqual(pnl, 200, 'LONG P&L = $200');
});

test('LONG loses when price falls', () => {
  const pnl = computeBnPnL('LONG', 60_000, 58_000, 0.1);
  assertEqual(pnl, -200, 'LONG loss = -$200');
});

test('SHORT profits when price falls', () => {
  const pnl = computeBnPnL('SHORT', 60_000, 58_000, 0.1);
  assertEqual(pnl, 200, 'SHORT P&L = $200');
});

test('SHORT loses when price rises', () => {
  const pnl = computeBnPnL('SHORT', 60_000, 62_000, 0.1);
  assertEqual(pnl, -200, 'SHORT loss = -$200');
});

test('10× leverage: 1% move = ~10% RoE', () => {
  // 0.01 BTC @ $60,000 = $600 notional, margin ≈ $60
  const margin = computeIsolatedMargin(0.01, 60_000, 10, 0.0004);
  const pnl    = computeBnPnL('LONG', 60_000, 60_600, 0.01); // +1%
  const roe    = computeRoE(pnl, margin);
  assertBetween(roe, 9.5, 10.5, 'RoE ~10% on 1% move with 10× leverage');
});

test('100× leverage: 1% move = ~100% RoE', () => {
  const margin = computeIsolatedMargin(0.01, 60_000, 100, 0.0004);
  const pnl    = computeBnPnL('LONG', 60_000, 60_600, 0.01);
  const roe    = computeRoE(pnl, margin);
  assertBetween(roe, 95, 105, 'RoE ~100% on 1% move with 100× leverage');
});

// ── 5. Funding payments ───────────────────────────────────────────────────────
console.log('\n── 5. Funding Payments ──');

test('Positive funding rate: LONG pays, SHORT receives', () => {
  const rate     = 0.0001;  // 0.01% per 8h (positive = longs pay)
  const longPay  = computeFundingPayment('LONG',  1, 60_000, rate);
  const shortPay = computeFundingPayment('SHORT', 1, 60_000, rate);
  assertLt(longPay, 0, 'LONG pays (negative)');
  assertGt(shortPay, 0, 'SHORT receives (positive)');
  assertEqual(Math.abs(longPay), Math.abs(shortPay), 'Equal and opposite');
});

test('Negative funding rate: SHORT pays, LONG receives', () => {
  const rate     = -0.0001;  // negative = shorts pay
  const longPay  = computeFundingPayment('LONG',  1, 60_000, rate);
  const shortPay = computeFundingPayment('SHORT', 1, 60_000, rate);
  assertGt(longPay, 0, 'LONG receives (positive)');
  assertLt(shortPay, 0, 'SHORT pays (negative)');
});

test('Funding scales with notional value', () => {
  const p1 = Math.abs(computeFundingPayment('LONG', 1, 60_000, 0.0001));
  const p2 = Math.abs(computeFundingPayment('LONG', 2, 60_000, 0.0001));
  assertBetween(p2, p1 * 1.99, p1 * 2.01, 'Funding doubles with double qty');
});

test('Portfolio funding: balance decreases for LONG with positive rate', () => {
  const p = createPortfolio(10_000);
  const r = openPosition(p, { symbol: 'BTCUSDT', direction: 'LONG', qty: 0.01,
    entryPrice: 60_000, leverage: 10, stopLoss: 54_000, takeProfit: 66_000 });
  // Set lastFundingAt to 9 hours ago so funding triggers
  r.position.lastFundingAt = Date.now() - 9 * 3600_000;
  const balBefore = p.usdtBalance;
  applyFunding(p, { BTCUSDT: 60_000 }, { BTCUSDT: 0.0001 });
  assertLt(p.usdtBalance, balBefore, 'Balance decreases for LONG with positive funding');
});

// ── 6. Portfolio lifecycle ────────────────────────────────────────────────────
console.log('\n── 6. Portfolio Lifecycle ──');

test('Opening a position debits isolated margin', () => {
  const p = createPortfolio(10_000);
  const balBefore = p.usdtBalance;
  openPosition(p, { symbol: 'ETHUSDT', direction: 'LONG', qty: 0.1,
    entryPrice: 3_000, leverage: 20, stopLoss: 2700, takeProfit: 3600 });
  assertLt(p.usdtBalance, balBefore, 'Balance reduced after open');
});

test('Profitable close returns margin + profit', () => {
  const p = createPortfolio(10_000);
  const { position } = openPosition(p, { symbol: 'BTCUSDT', direction: 'LONG',
    qty: 0.01, entryPrice: 60_000, leverage: 10, stopLoss: 54_000, takeProfit: 66_000 });
  const balAfterOpen = p.usdtBalance;
  closePosition(p, position.id, 62_000, 'MANUAL');
  assertGt(p.usdtBalance, balAfterOpen, 'Balance increases after profitable close');
  assertGt(p.totalRealizedPnL, 0, 'Positive realised P&L');
});

test('Liquidation: margin forfeited', () => {
  const p = createPortfolio(10_000);
  const { position } = openPosition(p, { symbol: 'BTCUSDT', direction: 'LONG',
    qty: 0.01, entryPrice: 60_000, leverage: 10, stopLoss: 54_000, takeProfit: 66_000 });
  const balAfterOpen = p.usdtBalance;
  // Close at liquidation price with LIQUIDATION reason
  const liq = position.liquidationPrice;
  closePosition(p, position.id, liq, 'LIQUIDATION');
  // On liquidation: margin is NOT returned, only whatever P&L remains
  assertLt(p.usdtBalance, balAfterOpen + position.isolatedMargin,
    'Margin not returned on liquidation');
});

test('Cannot open duplicate symbol', () => {
  const p = createPortfolio(10_000);
  openPosition(p, { symbol: 'ETHUSDT', direction: 'LONG', qty: 0.01,
    entryPrice: 3_000, leverage: 5, stopLoss: 2700, takeProfit: 3600 });
  const r2 = openPosition(p, { symbol: 'ETHUSDT', direction: 'SHORT', qty: 0.01,
    entryPrice: 3_000, leverage: 5, stopLoss: 3300, takeProfit: 2400 });
  assertFalse(r2.opened, 'Second ETH position blocked');
});

test('Multiple different symbols can be open simultaneously', () => {
  const p = createPortfolio(50_000);
  const r1 = openPosition(p, { symbol: 'BTCUSDT', direction: 'LONG',  qty: 0.01, entryPrice: 60_000, leverage: 5,  stopLoss: 54000, takeProfit: 66000 });
  const r2 = openPosition(p, { symbol: 'ETHUSDT', direction: 'SHORT', qty: 0.1,  entryPrice: 3_000,  leverage: 10, stopLoss: 3300, takeProfit: 2700 });
  const r3 = openPosition(p, { symbol: 'SOLUSDT', direction: 'LONG',  qty: 1,    entryPrice: 150,    leverage: 20, stopLoss: 135,  takeProfit: 180 });
  assertTrue(r1.opened, 'BTC opened');
  assertTrue(r2.opened, 'ETH opened');
  assertTrue(r3.opened, 'SOL opened');
  assertEqual(p.openPositions.length, 3, '3 positions open');
});

test('Insufficient balance blocks open', () => {
  const p = createPortfolio(10);  // only $10
  const r = openPosition(p, { symbol: 'BTCUSDT', direction: 'LONG', qty: 0.01,
    entryPrice: 60_000, leverage: 10, stopLoss: 54_000, takeProfit: 66_000 });
  assertFalse(r.opened, 'Blocked by insufficient balance');
});

// ── 7. Qty sizing ─────────────────────────────────────────────────────────────
console.log('\n── 7. Qty Sizing ──');

test('maxQtyFromBudget: $1000 budget, BTC $60000, 10× → 0.166 BTC', () => {
  const qty = maxQtyFromBudget(1_000, 60_000, 10, BN_CONTRACT_SPECS.BTCUSDT);
  // notional = 10000, rawQty = 10000/60000 = 0.1666, steps = 166, qty = 0.166
  assertBetween(qty, 0.165, 0.167, 'Max qty ~0.166');
});

test('riskBasedQty: risk 1% of $10000 on BTC, SL $200 away', () => {
  const qty = riskBasedQty(60_000, 59_800, 10_000, 1, BN_CONTRACT_SPECS.BTCUSDT);
  // riskAmount = $100. riskPerUnit = $200. raw = 0.5. steps = 500. qty = 0.5
  assertBetween(qty, 0.499, 0.501, 'Risk-based qty 0.5');
});

test('riskBasedQty: zero SL distance returns 0', () => {
  const qty = riskBasedQty(60_000, 60_000, 10_000, 1, BN_CONTRACT_SPECS.BTCUSDT);
  assertEqual(qty, 0, 'Zero SL = zero qty');
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
  console.log(`\n${'─'.repeat(62)}`);
  console.log(`  Binance Futures Tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) { console.log('  ✗ SOME TESTS FAILED'); process.exit(1); }
  else            { console.log('  ✓ ALL TESTS PASSED'); }
})();
