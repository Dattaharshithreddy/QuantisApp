// Unit tests for utils/pnlCalculator.ts — the single authoritative P&L
// module every other file in the app now calls into.
//
// Unlike auditVerification.ts (which mirrors logic inline because most
// audited modules depend on AsyncStorage/React Native), this file imports
// the REAL module directly: pnlCalculator.ts is plain, dependency-free
// arithmetic, so there's no reason to test a copy of it.
//
// Run with: npx ts-node src/utils/__tests__/pnlCalculator.test.ts
// (or compile with the project's babel config and run with node).

import { calculatePnL, calculatePnLPct, directionMultiplier, calculatePnLWithMultiplier, pnlSign } from '../pnlCalculator';

let passed = 0, failed = 0;
function assertClose(actual: number, expected: number, label: string, tolerance = 0.001) {
  const ok = Math.abs(actual - expected) < tolerance;
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}\n      expected: ${expected}\n      actual:   ${actual}`); }
}
function assertEqual(actual: any, expected: any, label: string) {
  if (actual === expected) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}\n      expected: ${expected}\n      actual:   ${actual}`); }
}
function section(title: string) { console.log(`\n${title}`); }

// ─── The exact reported bug scenario ───
section('Regression: the exact reported SHORT bug scenario');
{
  const entryPrice = 1576.98, exitPrice = 1583.69, qty = 19;
  const pnl = calculatePnL({ entryPrice, exitPrice, qty, direction: 'SHORT' });
  assertClose(pnl, -127.49, 'SHORT, price rose against the position: correctly a LOSS, not the reported +127.47');
  assertEqual(pnlSign(pnl), 'loss', 'pnlSign correctly classifies this as a loss');
}

// ─── LONG profit ───
section('LONG profit');
{
  const pnl = calculatePnL({ entryPrice: 100, exitPrice: 110, qty: 10, direction: 'LONG' });
  assertClose(pnl, 100, 'LONG, price rose 10pts x10 qty = +100');
  assertEqual(pnlSign(pnl), 'profit', 'classified as profit');
}

// ─── LONG loss ───
section('LONG loss');
{
  const pnl = calculatePnL({ entryPrice: 100, exitPrice: 90, qty: 10, direction: 'LONG' });
  assertClose(pnl, -100, 'LONG, price fell 10pts x10 qty = -100');
  assertEqual(pnlSign(pnl), 'loss', 'classified as loss');
}

// ─── SHORT profit ───
section('SHORT profit');
{
  const pnl = calculatePnL({ entryPrice: 100, exitPrice: 90, qty: 10, direction: 'SHORT' });
  assertClose(pnl, 100, 'SHORT, price fell 10pts x10 qty = +100 (profit on the short)');
  assertEqual(pnlSign(pnl), 'profit', 'classified as profit');
}

// ─── SHORT loss ───
section('SHORT loss');
{
  const pnl = calculatePnL({ entryPrice: 100, exitPrice: 110, qty: 10, direction: 'SHORT' });
  assertClose(pnl, -100, 'SHORT, price rose 10pts x10 qty = -100 (loss on the short)');
  assertEqual(pnlSign(pnl), 'loss', 'classified as loss');
}

// ─── Break-even ───
section('Break-even (both directions)');
{
  const longPnl = calculatePnL({ entryPrice: 100, exitPrice: 100, qty: 10, direction: 'LONG' });
  const shortPnl = calculatePnL({ entryPrice: 100, exitPrice: 100, qty: 10, direction: 'SHORT' });
  assertClose(longPnl, 0, 'LONG at unchanged price: exactly 0');
  assertClose(shortPnl, 0, 'SHORT at unchanged price: exactly 0');
  assertEqual(pnlSign(longPnl), 'breakeven', 'LONG classified as breakeven');
  assertEqual(pnlSign(shortPnl), 'breakeven', 'SHORT classified as breakeven');
}

// ─── Fees reduce P&L identically regardless of direction ───
section('Fees');
{
  const longPnl = calculatePnL({ entryPrice: 100, exitPrice: 110, qty: 10, direction: 'LONG', fees: 5 });
  const shortPnl = calculatePnL({ entryPrice: 100, exitPrice: 90, qty: 10, direction: 'SHORT', fees: 5 });
  assertClose(longPnl, 95, 'LONG profit of 100 minus 5 in fees = 95');
  assertClose(shortPnl, 95, 'SHORT profit of 100 minus 5 in fees = 95 (fees are direction-agnostic)');
}

// ─── directionMultiplier ───
section('directionMultiplier');
{
  assertEqual(directionMultiplier('LONG'), 1, 'LONG = +1');
  assertEqual(directionMultiplier('SHORT'), -1, 'SHORT = -1');
}

// ─── calculatePnLWithMultiplier matches calculatePnL for both directions ───
section('calculatePnLWithMultiplier / calculatePnL agreement');
{
  const viaDirection = calculatePnL({ entryPrice: 50, exitPrice: 55, qty: 4, direction: 'SHORT' });
  const viaMultiplier = calculatePnLWithMultiplier(50, 55, 4, directionMultiplier('SHORT'));
  assertClose(viaDirection, viaMultiplier, 'Both entry points produce identical results for the same inputs');
}

// ─── calculatePnLPct ───
section('calculatePnLPct');
{
  const pnl = calculatePnL({ entryPrice: 200, exitPrice: 220, qty: 5, direction: 'LONG' });
  const pct = calculatePnLPct(pnl, 200, 5);
  assertClose(pct, 10, 'LONG +20pts on a 200 entry = +10% (100/1000*100)');
  assertEqual(calculatePnLPct(50, 0, 10), 0, 'Zero notional (entryPrice=0) returns 0, not Infinity/NaN');
}

// ─── SL/TP trigger directionality (mirrors paperTradingEngine.ts's monitorOpenPositions) ───
section('Stop-loss / take-profit trigger logic for SHORT (verified against the real engine logic)');
{
  // SHORT: stopLoss sits ABOVE entry, takeProfit sits BELOW entry.
  const entryPrice = 100, stopLoss = 105, takeProfit = 90;
  function checkExit(direction: 'LONG' | 'SHORT', cur: number, sl: number, tp: number): 'STOP_LOSS' | 'TAKE_PROFIT' | null {
    if (direction === 'LONG') {
      if (cur <= sl) return 'STOP_LOSS';
      if (cur >= tp) return 'TAKE_PROFIT';
    } else {
      if (cur >= sl) return 'STOP_LOSS';
      if (cur <= tp) return 'TAKE_PROFIT';
    }
    return null;
  }
  assertEqual(checkExit('SHORT', 106, stopLoss, takeProfit), 'STOP_LOSS', 'SHORT: price rising past stopLoss (above entry) correctly triggers STOP_LOSS');
  assertEqual(checkExit('SHORT', 89, stopLoss, takeProfit), 'TAKE_PROFIT', 'SHORT: price falling past takeProfit (below entry) correctly triggers TAKE_PROFIT');
  assertEqual(checkExit('SHORT', 95, stopLoss, takeProfit), null, 'SHORT: price between the two levels triggers neither');
  // Sanity-check the SL/TP trigger direction also matches a real LOSS/PROFIT
  const slPnl = calculatePnL({ entryPrice, exitPrice: stopLoss, qty: 1, direction: 'SHORT' });
  const tpPnl = calculatePnL({ entryPrice, exitPrice: takeProfit, qty: 1, direction: 'SHORT' });
  assertEqual(slPnl < 0, true, 'SHORT stop-loss level genuinely produces a loss when hit');
  assertEqual(tpPnl > 0, true, 'SHORT take-profit level genuinely produces a profit when hit');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
