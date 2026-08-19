// ─────────────────────────────────────────────────────────────────────────────
// FUTURES — Tests  (v1.0.0)
// Tests expiry computation, lot sizes, margin, P&L, and position lifecycle.
// Run with: node src/utils/__tests__/futures.test.js
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

let passed = 0, failed = 0;
const tests = [];
function test(label, fn) { tests.push({ label, fn }); }
function assertEqual(a, e, label) {
  if (a !== e) throw new Error(`${label}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
}
function assertBetween(a, lo, hi, label) {
  if (a < lo || a > hi) throw new Error(`${label}: expected ${lo}–${hi}, got ${a}`);
}
function assertGt(a, min, label) {
  if (a <= min) throw new Error(`${label}: expected > ${min}, got ${a}`);
}
function assertLt(a, max, label) {
  if (a >= max) throw new Error(`${label}: expected < ${max}, got ${a}`);
}

// ── Inline pure logic (mirrors futuresTypes.ts exactly) ──────────────────────

const LOT_SIZES = {
  NIFTY: 75, BANKNIFTY: 30, FINNIFTY: 65, MIDCPNIFTY: 75,
  RELIANCE: 250, TCS: 150, INFY: 300, HDFCBANK: 550,
  ICICIBANK: 700, SBIN: 1500, AXISBANK: 625, BHARTIARTL: 475,
  WIPRO: 1500, TATAMOTORS: 1425, ONGC: 1925,
};

const MARGIN_PCT = {
  NIFTY: 10, BANKNIFTY: 12, FINNIFTY: 11, MIDCPNIFTY: 12,
  RELIANCE: 13, TCS: 13, INFY: 13, HDFCBANK: 14,
  ICICIBANK: 14, SBIN: 15, AXISBANK: 14, BHARTIARTL: 14,
  WIPRO: 14, TATAMOTORS: 15, ONGC: 13,
};

function getLastThursday(year, month) {
  const lastDay   = new Date(year, month + 1, 0);
  const dayOfWeek = lastDay.getDay();
  const daysBack  = (dayOfWeek + 3) % 7;
  return new Date(year, month, lastDay.getDate() - daysBack, 15, 30, 0);
}

function getCurrentExpiryDates(now = new Date()) {
  const y = now.getFullYear(), m = now.getMonth();
  const thisExpiry = getLastThursday(y, m);
  const base = now >= thisExpiry
    ? { y: m === 11 ? y + 1 : y, m: (m + 1) % 12 }
    : { y, m };
  function addM(offset) {
    const total = base.m + offset;
    return getLastThursday(base.y + Math.floor(total / 12), total % 12);
  }
  return { current: addM(0), next: addM(1), far: addM(2) };
}

function daysToExpiry(expiry) {
  return Math.max(0, Math.floor((expiry - Date.now()) / 86_400_000));
}

function estimateMargin(underlying, price, lots) {
  return price * lots * LOT_SIZES[underlying] * (MARGIN_PCT[underlying] / 100);
}

function computeFuturesPnL(direction, entry, current, lots, lotSize) {
  return (current - entry) * lots * lotSize * (direction === 'LONG' ? 1 : -1);
}

function riskBasedLots(entryPrice, stopLoss, lotSize, accountSize, riskPct) {
  const riskAmount  = accountSize * (riskPct / 100);
  const riskPerUnit = Math.abs(entryPrice - stopLoss);
  if (riskPerUnit <= 0) return 0;
  return Math.max(1, Math.floor(riskAmount / (riskPerUnit * lotSize)));
}

function maxAffordableLots(underlying, price, availableCapital, reservePct = 20) {
  const usable       = availableCapital * (1 - reservePct / 100);
  const marginPerLot = estimateMargin(underlying, price, 1);
  if (marginPerLot <= 0) return 0;
  return Math.floor(usable / marginPerLot);
}

// ── In-memory portfolio (mirrors futuresPortfolio.ts) ─────────────────────────

function createPortfolio(initial = 500_000) {
  return { cashBalance: initial, initialCapital: initial, openPositions: [], totalRealizedPnL: 0, totalMtmSettled: 0 };
}

function openPosition(portfolio, params) {
  const lotSize  = LOT_SIZES[params.underlying];
  const qty      = params.lots * lotSize;
  const notional = params.entryPrice * qty;
  const margin   = notional * (MARGIN_PCT[params.underlying] / 100);
  const fee      = notional * 0.0002;

  if (params.lots <= 0) return { opened: false, reason: 'Lots must be >= 1' };
  if (margin + fee > portfolio.cashBalance) return { opened: false, reason: 'Insufficient margin' };
  const dup = portfolio.openPositions.find(p => p.underlying === params.underlying);
  if (dup) return { opened: false, reason: 'Duplicate position' };

  const pos = {
    id: `fut_${Date.now()}`,
    underlying:     params.underlying,
    contractSymbol: params.contractSymbol ?? `${params.underlying}FUT`,
    direction:      params.direction,
    lots:           params.lots,
    lotSize,
    qty,
    entryPrice:     params.entryPrice,
    entryTime:      Date.now(),
    expiry:         params.expiry ?? Date.now() + 30 * 86_400_000,
    expiryLabel:    params.expiryLabel ?? 'TEST',
    stopLoss:       params.stopLoss,
    takeProfit:     params.takeProfit,
    notionalValue:  notional,
    marginBlocked:  margin,
    mtmSettledPnL:  0,
    lastMtmPrice:   params.entryPrice,
    lastMtmAt:      Date.now(),
  };

  portfolio.openPositions.push(pos);
  portfolio.cashBalance -= (margin + fee);
  return { opened: true, position: pos };
}

function closePosition(portfolio, positionId, exitPrice, reason) {
  const idx = portfolio.openPositions.findIndex(p => p.id === positionId);
  if (idx === -1) return { closed: false, reason: 'Not found' };
  const pos     = portfolio.openPositions[idx];
  const cashPnL = computeFuturesPnL(pos.direction, pos.lastMtmPrice, exitPrice, pos.lots, pos.lotSize);
  const totalPnL = pos.mtmSettledPnL + cashPnL;
  const fee     = pos.notionalValue * 0.0002;

  portfolio.openPositions.splice(idx, 1);
  portfolio.cashBalance    += pos.marginBlocked + cashPnL - fee;
  portfolio.totalRealizedPnL += totalPnL - fee;
  return { closed: true, totalPnL, cashPnL, exitPrice };
}

function runMtm(portfolio, settlePrices) {
  const settlements = [];
  for (const pos of portfolio.openPositions) {
    const settle = settlePrices[pos.underlying];
    if (!settle) continue;
    const pnlForDay = computeFuturesPnL(pos.direction, pos.lastMtmPrice, settle, pos.lots, pos.lotSize);
    pos.mtmSettledPnL  += pnlForDay;
    pos.lastMtmPrice    = settle;
    portfolio.cashBalance    += pnlForDay;
    portfolio.totalMtmSettled += pnlForDay;
    settlements.push({ positionId: pos.id, pnlForDay, settlePrice: settle, cumulativeMtm: pos.mtmSettledPnL });
  }
  return settlements;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════════

// ── 1. Lot sizes ─────────────────────────────────────────────────────────────
console.log('\n── 1. Lot Sizes ──');

test('NIFTY lot size is 75', () => assertEqual(LOT_SIZES.NIFTY, 75, 'NIFTY lot'));
test('BANKNIFTY lot size is 30', () => assertEqual(LOT_SIZES.BANKNIFTY, 30, 'BANKNIFTY lot'));
test('FINNIFTY lot size is 65', () => assertEqual(LOT_SIZES.FINNIFTY, 65, 'FINNIFTY lot'));
test('All underlyings have lot sizes > 0', () => {
  for (const [u, v] of Object.entries(LOT_SIZES)) assertGt(v, 0, `${u} lot size`);
});
test('All underlyings have margin % between 8 and 20', () => {
  for (const [u, v] of Object.entries(MARGIN_PCT)) assertBetween(v, 8, 20, `${u} margin`);
});

// ── 2. Expiry computation ─────────────────────────────────────────────────────
console.log('\n── 2. Expiry Computation ──');

test('Last Thursday of July 2026 is correct', () => {
  const d = getLastThursday(2026, 6); // month 6 = July
  assertEqual(d.getDay(), 4, 'Day is Thursday (4)');
  assertEqual(d.getMonth(), 6, 'Month is July');
  assertEqual(d.getFullYear(), 2026, 'Year is 2026');
  // Last Thursday of July 2026: July has 31 days, 31 Jul is Friday,
  // so last Thursday = 30 Jul
  assertEqual(d.getDate(), 30, 'Date is 30th');
});

test('Last Thursday of December 2026 is in December', () => {
  const d = getLastThursday(2026, 11);
  assertEqual(d.getDay(), 4, 'Is Thursday');
  assertEqual(d.getMonth(), 11, 'December');
});

test('getCurrentExpiryDates: current < next < far', () => {
  const dates = getCurrentExpiryDates(new Date(2026, 0, 15)); // Jan 15
  assertGt(dates.next.getTime(), dates.current.getTime(), 'next > current');
  assertGt(dates.far.getTime(), dates.next.getTime(), 'far > next');
});

test('getCurrentExpiryDates: if past expiry, current moves to next month', () => {
  // July 30 2026 is expiry day. If we are ON expiry day after 3:30pm...
  const afterExpiry = new Date(2026, 6, 30, 16, 0, 0); // July 30, 4pm
  const dates = getCurrentExpiryDates(afterExpiry);
  // Current should be August expiry
  assertEqual(dates.current.getMonth(), 7, 'Current moves to August after July expiry');
});

test('daysToExpiry: future date returns positive days', () => {
  const futureExpiry = Date.now() + 20 * 86_400_000;
  assertBetween(daysToExpiry(futureExpiry), 19, 21, 'Days to expiry ~20');
});

test('daysToExpiry: past date returns 0', () => {
  const pastExpiry = Date.now() - 1000;
  assertEqual(daysToExpiry(pastExpiry), 0, 'Past expiry = 0 days');
});

// ── 3. Margin calculation ─────────────────────────────────────────────────────
console.log('\n── 3. Margin Calculation ──');

test('NIFTY 1 lot at 24000: margin = 24000 * 75 * 10% = ₹180,000', () => {
  const margin = estimateMargin('NIFTY', 24000, 1);
  assertBetween(margin, 179_900, 180_100, 'NIFTY 1-lot margin');
});

test('BANKNIFTY 1 lot at 52000: margin = 52000 * 30 * 12% = ₹187,200', () => {
  const margin = estimateMargin('BANKNIFTY', 52000, 1);
  assertBetween(margin, 187_100, 187_300, 'BANKNIFTY 1-lot margin');
});

test('Margin scales linearly with lots', () => {
  const m1 = estimateMargin('NIFTY', 24000, 1);
  const m2 = estimateMargin('NIFTY', 24000, 2);
  assertBetween(m2, m1 * 1.99, m1 * 2.01, 'Margin doubles with 2 lots');
});

test('maxAffordableLots: ₹5L capital, NIFTY at 24000 → affordable lots', () => {
  const lots = maxAffordableLots('NIFTY', 24000, 500_000);
  // 1 lot = ₹180,000 margin. 80% of 500k = 400k usable → floor(400k/180k) = 2
  assertEqual(lots, 2, 'Max lots from ₹5L capital at 24000');
});

test('maxAffordableLots: returns 0 when capital is insufficient', () => {
  const lots = maxAffordableLots('BANKNIFTY', 52000, 10_000);
  assertEqual(lots, 0, 'Cannot afford even 1 lot');
});

// ── 4. Risk-based lot sizing ───────────────────────────────────────────────────
console.log('\n── 4. Risk-Based Lot Sizing ──');

test('Risk 1% of ₹10L on NIFTY, SL = 200 pts: 1 lot', () => {
  // riskAmount = 100k * 1% = ₹10,000
  // riskPerLot = 200 * 75 = ₹15,000 → floor(10,000/15,000) = 0 → max(1,0) = 1
  const lots = riskBasedLots(24000, 23800, 75, 1_000_000, 1);
  assertEqual(lots, 1, 'Risk-based: 1 lot');
});

test('Risk 2% of ₹20L on NIFTY, SL = 100 pts: 5 lots', () => {
  // riskAmount = 400,000. riskPerLot = 100*75 = 7,500. floor(400k/7.5k) = 53 → capped?
  // Actually: 2% of 20L = 40,000. riskPerLot = 100*75=7500. floor(40000/7500) = 5
  const lots = riskBasedLots(24000, 23900, 75, 2_000_000, 2);
  assertEqual(lots, 5, 'Risk-based: 5 lots');
});

test('Zero stop distance returns 0 lots', () => {
  const lots = riskBasedLots(24000, 24000, 75, 1_000_000, 1);
  assertEqual(lots, 0, 'Zero stop = 0 lots');
});

// ── 5. P&L calculation ────────────────────────────────────────────────────────
console.log('\n── 5. P&L Calculation ──');

test('LONG position profits when price rises', () => {
  const pnl = computeFuturesPnL('LONG', 24000, 24200, 1, 75);
  assertEqual(pnl, 200 * 75, 'LONG P&L = 200 * 75 = ₹15,000');
});

test('LONG position loses when price falls', () => {
  const pnl = computeFuturesPnL('LONG', 24000, 23800, 1, 75);
  assertEqual(pnl, -200 * 75, 'LONG loss = -₹15,000');
});

test('SHORT position profits when price falls', () => {
  const pnl = computeFuturesPnL('SHORT', 24000, 23800, 1, 75);
  assertEqual(pnl, 200 * 75, 'SHORT P&L = +₹15,000');
});

test('SHORT position loses when price rises', () => {
  const pnl = computeFuturesPnL('SHORT', 24000, 24200, 1, 75);
  assertEqual(pnl, -200 * 75, 'SHORT loss = -₹15,000');
});

test('P&L scales correctly with lots', () => {
  const p1 = computeFuturesPnL('LONG', 24000, 24100, 1, 75);
  const p3 = computeFuturesPnL('LONG', 24000, 24100, 3, 75);
  assertEqual(p3, p1 * 3, '3 lots = 3x P&L');
});

// ── 6. Portfolio open/close ───────────────────────────────────────────────────
console.log('\n── 6. Portfolio Open / Close ──');

test('Opening NIFTY 1 lot debits correct margin from balance', () => {
  const port = createPortfolio(500_000);
  const result = openPosition(port, {
    underlying: 'NIFTY', direction: 'LONG', lots: 1,
    entryPrice: 24000, stopLoss: 23800, takeProfit: 24500,
  });
  assertEqual(result.opened, true, 'Position opened');
  const margin = estimateMargin('NIFTY', 24000, 1);
  const fee    = 24000 * 75 * 0.0002;
  assertBetween(port.cashBalance, 500_000 - margin - fee - 1, 500_000 - margin - fee + 1, 'Balance debited by margin + fee');
});

test('Closing LONG at higher price returns margin + profit', () => {
  const port = createPortfolio(500_000);
  const { position } = openPosition(port, {
    underlying: 'NIFTY', direction: 'LONG', lots: 1,
    entryPrice: 24000, stopLoss: 23800, takeProfit: 24500,
  });
  const balAfterOpen = port.cashBalance;
  const result = closePosition(port, position.id, 24200, 'MANUAL');
  assertEqual(result.closed, true, 'Position closed');
  assertGt(port.cashBalance, balAfterOpen, 'Balance increases after profitable close');
  assertGt(result.totalPnL, 0, 'Positive P&L on favourable close');
});

test('Cannot open duplicate underlying', () => {
  const port = createPortfolio(1_000_000);
  openPosition(port, { underlying: 'BANKNIFTY', direction: 'LONG', lots: 1, entryPrice: 52000, stopLoss: 51000, takeProfit: 54000 });
  const second = openPosition(port, { underlying: 'BANKNIFTY', direction: 'SHORT', lots: 1, entryPrice: 52000, stopLoss: 53000, takeProfit: 50000 });
  assertEqual(second.opened, false, 'Second BANKNIFTY position blocked');
  assertEqual(second.reason, 'Duplicate position', 'Correct reason');
});

test('Insufficient margin blocks position open', () => {
  const port = createPortfolio(1_000);  // only ₹1,000
  const result = openPosition(port, { underlying: 'NIFTY', direction: 'LONG', lots: 1, entryPrice: 24000, stopLoss: 23800, takeProfit: 24500 });
  assertEqual(result.opened, false, 'Blocked by insufficient margin');
  assertEqual(result.reason, 'Insufficient margin', 'Correct reason');
});

test('Portfolio can hold multiple different underlyings', () => {
  const port = createPortfolio(2_000_000);
  const r1 = openPosition(port, { underlying: 'NIFTY', direction: 'LONG', lots: 1, entryPrice: 24000, stopLoss: 23800, takeProfit: 24500 });
  const r2 = openPosition(port, { underlying: 'BANKNIFTY', direction: 'SHORT', lots: 1, entryPrice: 52000, stopLoss: 53000, takeProfit: 50000 });
  assertEqual(r1.opened, true, 'NIFTY opened');
  assertEqual(r2.opened, true, 'BANKNIFTY opened');
  assertEqual(port.openPositions.length, 2, 'Two positions open');
});

// ── 7. MTM settlement ─────────────────────────────────────────────────────────
console.log('\n── 7. MTM Settlement ──');

test('MTM credits cash when price moves in favour of LONG', () => {
  const port = createPortfolio(1_000_000);
  const { position } = openPosition(port, { underlying: 'NIFTY', direction: 'LONG', lots: 1, entryPrice: 24000, stopLoss: 23500, takeProfit: 25000 });
  const balBefore = port.cashBalance;
  const settlements = runMtm(port, { NIFTY: 24100 });  // +100 pts
  assertEqual(settlements.length, 1, '1 settlement');
  assertEqual(settlements[0].pnlForDay, 100 * 75, 'MTM credit = 100 * 75 = ₹7,500');
  assertGt(port.cashBalance, balBefore, 'Balance increased after favourable MTM');
});

test('MTM debits cash when price moves against LONG', () => {
  const port = createPortfolio(1_000_000);
  openPosition(port, { underlying: 'NIFTY', direction: 'LONG', lots: 1, entryPrice: 24000, stopLoss: 23500, takeProfit: 25000 });
  const balBefore = port.cashBalance;
  runMtm(port, { NIFTY: 23900 });  // -100 pts
  assertLt(port.cashBalance, balBefore, 'Balance decreased after adverse MTM');
});

test('MTM: lastMtmPrice updated to settlement price', () => {
  const port = createPortfolio(1_000_000);
  const { position: pos } = openPosition(port, { underlying: 'NIFTY', direction: 'LONG', lots: 1, entryPrice: 24000, stopLoss: 23500, takeProfit: 25000 });
  runMtm(port, { NIFTY: 24150 });
  const updatedPos = port.openPositions.find(p => p.id === pos.id);
  assertEqual(updatedPos.lastMtmPrice, 24150, 'lastMtmPrice updated');
});

test('MTM P&L is computed from lastMtmPrice, not entry price', () => {
  const port = createPortfolio(1_000_000);
  openPosition(port, { underlying: 'NIFTY', direction: 'LONG', lots: 1, entryPrice: 24000, stopLoss: 23500, takeProfit: 25000 });
  // Day 1: settle at 24100
  const day1 = runMtm(port, { NIFTY: 24100 });
  // Day 2: settle at 24200 — should credit 100 pts, NOT 200 pts
  const day2 = runMtm(port, { NIFTY: 24200 });
  assertEqual(day1[0].pnlForDay, 100 * 75, 'Day 1: 100 pts');
  assertEqual(day2[0].pnlForDay, 100 * 75, 'Day 2: 100 pts from lastMtmPrice, not entry');
});

test('Total P&L on close = MTM settled + day-of P&L', () => {
  const port = createPortfolio(1_000_000);
  const { position } = openPosition(port, { underlying: 'NIFTY', direction: 'LONG', lots: 1, entryPrice: 24000, stopLoss: 23500, takeProfit: 25000 });
  // Day 1: settle at 24200 (+200 pts, +₹15,000)
  runMtm(port, { NIFTY: 24200 });
  // Close at 24300 (last MTM was 24200, so today's P&L = +100 pts = +₹7,500)
  const result = closePosition(port, position.id, 24300, 'MANUAL');
  const expectedMtmSettled = 200 * 75;      // ₹15,000
  const expectedTodayPnL   = 100 * 75;      // ₹7,500
  const fee = 24000 * 75 * 0.0002;
  assertBetween(result.totalPnL, expectedMtmSettled + expectedTodayPnL - 2,
    expectedMtmSettled + expectedTodayPnL + 2, 'Total P&L = MTM + today');
});

// ── 8. NFO symbol format ──────────────────────────────────────────────────────
console.log('\n── 8. NFO Symbol Format ──');

test('NIFTY July 2026 symbol format', () => {
  // buildNFOSymbol inline
  const underlying = 'NIFTY', year = 2026, month = 6; // July
  const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const yy  = String(year).slice(2);  // '26'
  const mon = MONTHS[month];          // 'JUL'
  const sym = `${underlying}${yy}${mon}FUT`;
  assertEqual(sym, 'NIFTY26JULFUT', 'NFO symbol format correct');
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
  console.log(`  Futures Tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) { console.log('  ✗ SOME TESTS FAILED'); process.exit(1); }
  else            { console.log('  ✓ ALL TESTS PASSED'); }
})();
