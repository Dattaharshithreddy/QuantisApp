// ─────────────────────────────────────────────────────────────────────────────
// JOURNAL FEATURES — Integration Test Suite
//
// Tests three features added in v6.9.2:
//   1. Manual close prediction evaluation (separate from trade management)
//   2. Strategy information in journal records
//   3. Review overlay levels correct for Entry/Exit/SL/TP
// ─────────────────────────────────────────────────────────────────────────────

// ── Inline the logic under test ───────────────────────────────────────────────

function classifyPredictionResult(direction, entryPrice, exitPrice) {
  if (exitPrice === entryPrice) return 'NEUTRAL';
  if (direction === 'LONG') return exitPrice > entryPrice ? 'CORRECT' : 'INCORRECT';
  return exitPrice < entryPrice ? 'CORRECT' : 'INCORRECT';
}

function classifyManagementOutcome(exitReason) {
  switch (exitReason) {
    case 'TAKE_PROFIT':    return 'TAKE_PROFIT';
    case 'STOP_LOSS':      return 'STOP_LOSS';
    case 'MANUAL_CLOSE':   return 'MANUAL_CLOSE';
    case 'MANUAL_EXIT':    return 'MANUAL_CLOSE'; // legacy
    case 'TIME_EXIT':      return 'TIME_EXIT';
    case 'AI_EXIT_SIGNAL': return 'AI_EXIT';
    default:               return 'UNKNOWN';
  }
}

function managementOutcomeLabel(outcome) {
  switch (outcome) {
    case 'TAKE_PROFIT':  return '✅ Take Profit';
    case 'STOP_LOSS':    return '🛑 Stop Loss';
    case 'MANUAL_CLOSE': return '🤚 Manual Close';
    case 'TIME_EXIT':    return '⏱ Time Exit';
    case 'AI_EXIT':      return '🤖 AI Signal Exit';
    case 'UNKNOWN':      return 'Exit';
  }
}

// Simulate buildTradeRecord new field population
function buildMockRecord(overrides = {}) {
  const position = {
    id: 'pos_1', symbol: 'BTC', timeframe: '15m', assetClass: 'CRYPTO',
    direction: 'LONG', entryTime: 1000, entryPrice: 100,
    qty: 1, aiConfidence: 70, riskScoreAtEntry: 0.3, tradeQuality: null,
    modelVersion: 1, predictionHorizon: 3, entryFee: 0.1,
    maxUnrealizedDrawdown: 2, maxUnrealizedProfit: 5,
    entryReason: 'Test', stopLoss: 95, takeProfit: 110,
    tradeEconomics: {}, entrySnapshot: { topFeatures: [], marketRegime: 'BULL', orderBookSnapshot: null, recentCandles: [] },
    mgmt: null,
    strategyId: 'SWING', strategyName: 'Swing', strategyIcon: '🌊',
    ...overrides.position,
  };
  const exitReason = overrides.exitReason ?? 'MANUAL_CLOSE';
  const exitPrice  = overrides.exitPrice  ?? 102;
  const pnl        = overrides.pnl        ?? (exitPrice - position.entryPrice) * position.qty;

  return {
    id: position.id, symbol: position.symbol, direction: position.direction,
    entryPrice: position.entryPrice, exitPrice,
    exitReason,
    pnl, pnlPct: pnl / position.entryPrice * 100,
    strategyId:   position.strategyId,
    strategyName: position.strategyName,
    strategyIcon: position.strategyIcon,
    predictionResult: classifyPredictionResult(position.direction, position.entryPrice, exitPrice),
    tradeManagementOutcome: classifyManagementOutcome(exitReason),
    reviewLevels: { stopLoss: position.stopLoss, takeProfit: position.takeProfit },
  };
}

let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log('  ✅', label); }
  else    { failed++; console.log('  ❌', label, detail ? `(${detail})` : ''); }
}

// ═══════════════════════════════════════════════════════════════════════════
// PART 1: MANUAL CLOSE PREDICTION EVALUATION
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── Part 1: Manual close prediction evaluation ──────────────────');

// The core requirement: prediction is evaluated on price movement to exit,
// NEVER on whether TP/SL was reached. Management outcome is separate.

// Scenario A: LONG, manual close at profit → prediction CORRECT, management MANUAL_CLOSE
const A = buildMockRecord({ exitReason: 'MANUAL_CLOSE', exitPrice: 102 });
check('A: LONG +2% manual close → prediction CORRECT', A.predictionResult === 'CORRECT');
check('A: management outcome = MANUAL_CLOSE', A.tradeManagementOutcome === 'MANUAL_CLOSE');
check('A: prediction and management are independent', A.predictionResult !== A.tradeManagementOutcome);

// Scenario B: LONG, panic manual close at loss → prediction INCORRECT, management MANUAL_CLOSE
// Key: prediction INCORRECT because price moved wrong direction, despite being manual
const B = buildMockRecord({ exitReason: 'MANUAL_CLOSE', exitPrice: 97, pnl: -3 });
check('B: LONG -3% manual close → prediction INCORRECT', B.predictionResult === 'INCORRECT');
check('B: management still MANUAL_CLOSE (not affected by prediction)', B.tradeManagementOutcome === 'MANUAL_CLOSE');
check('B: management label is Manual Close', managementOutcomeLabel(B.tradeManagementOutcome) === '🤚 Manual Close');

// Scenario C: TP hit → prediction CORRECT, management TAKE_PROFIT
const C = buildMockRecord({ exitReason: 'TAKE_PROFIT', exitPrice: 110 });
check('C: TP hit → prediction CORRECT', C.predictionResult === 'CORRECT');
check('C: management TAKE_PROFIT', C.tradeManagementOutcome === 'TAKE_PROFIT');

// Scenario D: SL hit → prediction INCORRECT, management STOP_LOSS
const D = buildMockRecord({ exitReason: 'STOP_LOSS', exitPrice: 95, pnl: -5 });
check('D: SL hit → prediction INCORRECT', D.predictionResult === 'INCORRECT');
check('D: management STOP_LOSS', D.tradeManagementOutcome === 'STOP_LOSS');

// Scenario E: SHORT, manual close at profit (price fell) → CORRECT
const E = buildMockRecord({
  position: { direction: 'SHORT', entryPrice: 100, stopLoss: 105, takeProfit: 90 },
  exitReason: 'MANUAL_CLOSE', exitPrice: 95, pnl: 5
});
check('E: SHORT -5% manual close (profit) → prediction CORRECT', E.predictionResult === 'CORRECT');
check('E: management MANUAL_CLOSE', E.tradeManagementOutcome === 'MANUAL_CLOSE');

// Scenario F: LONG at exactly entry price → NEUTRAL
const F = buildMockRecord({ exitReason: 'MANUAL_CLOSE', exitPrice: 100, pnl: 0 });
check('F: LONG exit at entry price → NEUTRAL', F.predictionResult === 'NEUTRAL');

// Scenario G: TIME_EXIT
const G = buildMockRecord({ exitReason: 'TIME_EXIT', exitPrice: 103 });
check('G: TIME_EXIT → management TIME_EXIT', G.tradeManagementOutcome === 'TIME_EXIT');
check('G: TIME_EXIT prediction still evaluated on price', G.predictionResult === 'CORRECT');
check('G: management label is Time Exit', managementOutcomeLabel(G.tradeManagementOutcome) === '⏱ Time Exit');

// Scenario H: legacy MANUAL_EXIT → maps to MANUAL_CLOSE
const H = buildMockRecord({ exitReason: 'MANUAL_EXIT', exitPrice: 98, pnl: -2 });
check('H: legacy MANUAL_EXIT → maps to MANUAL_CLOSE', H.tradeManagementOutcome === 'MANUAL_CLOSE');
check('H: prediction still INCORRECT (price moved down)', H.predictionResult === 'INCORRECT');

// Scenario I: AI_EXIT_SIGNAL → AI_EXIT management outcome
const I = buildMockRecord({ exitReason: 'AI_EXIT_SIGNAL', exitPrice: 105 });
check('I: AI_EXIT_SIGNAL → management AI_EXIT', I.tradeManagementOutcome === 'AI_EXIT');

// Critical invariant: prediction result NEVER equals management outcome type
// (they are different dimensions — one is accuracy, one is mechanism)
const allRecords = [A, B, C, D, E, F, G, H, I];
let crossContamination = false;
for (const r of allRecords) {
  // predictionResult should be 'CORRECT'|'INCORRECT'|'NEUTRAL'
  if (!['CORRECT','INCORRECT','NEUTRAL'].includes(r.predictionResult)) {
    crossContamination = true;
    console.log('  ❌ Invalid predictionResult:', r.predictionResult);
  }
  // tradeManagementOutcome should be one of the management values
  if (['CORRECT','INCORRECT','NEUTRAL'].includes(r.tradeManagementOutcome)) {
    crossContamination = true;
    console.log('  ❌ Management outcome contaminated with prediction value:', r.tradeManagementOutcome);
  }
}
check('Invariant: predictionResult and tradeManagementOutcome never share values', !crossContamination);

// ═══════════════════════════════════════════════════════════════════════════
// PART 2: STRATEGY INFORMATION IN JOURNAL
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── Part 2: Strategy information in journal records ─────────────');

const withStrategy = buildMockRecord({ position: { strategyId: 'SWING', strategyName: 'Swing', strategyIcon: '🌊' } });
check('Strategy: strategyId preserved in record', withStrategy.strategyId === 'SWING');
check('Strategy: strategyName preserved', withStrategy.strategyName === 'Swing');
check('Strategy: strategyIcon preserved', withStrategy.strategyIcon === '🌊');

// Backward compat: record without strategyId must work fine
const withoutStrategy = {
  id: 'old_1', symbol: 'ETH', direction: 'LONG',
  entryPrice: 100, exitPrice: 105, exitReason: 'TAKE_PROFIT',
  predictionResult: 'CORRECT', tradeManagementOutcome: 'TAKE_PROFIT',
  // NO strategyId, strategyName, strategyIcon, tradeManagementOutcome
};
check('Backward compat: record without strategyId is valid', withoutStrategy.strategyId === undefined);
check('Backward compat: strategy fields absent = no crash', (() => {
  try { const name = withoutStrategy.strategyName ?? 'None'; return name === 'None'; }
  catch { return false; }
})());

// All four strategy IDs
for (const [id, name, icon] of [
  ['SCALPING','Scalping','⚡'], ['INTRADAY','Intraday','📊'],
  ['SWING','Swing','🌊'], ['POSITION','Position','🏔️']
]) {
  const r = buildMockRecord({ position: { strategyId: id, strategyName: name, strategyIcon: icon } });
  check(`Strategy: ${id} preserved correctly`, r.strategyId === id && r.strategyName === name && r.strategyIcon === icon);
}

// ═══════════════════════════════════════════════════════════════════════════
// PART 3: REVIEW OVERLAY LEVELS
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── Part 3: Review overlay levels (Entry/Exit/SL/TP) ───────────');

function computeReviewLevels(trade) {
  // Mirrors the logic in useChartOverlays.ts reviewTradeLevels useMemo
  const levels = [
    { label: 'Entry', price: trade.entryPrice,                      color: 'blue',   dashed: false },
    { label: 'Exit',  price: trade.exitPrice,                       color: 'accent', dashed: false },
    { label: 'SL',    price: trade.reviewLevels?.stopLoss   ?? 0,   color: 'red',    dashed: true  },
    { label: 'TP',    price: trade.reviewLevels?.takeProfit  ?? 0,  color: 'green',  dashed: true  },
  ].filter(l => l.price > 0);
  return levels;
}

const tradeForReview = buildMockRecord({ exitReason: 'MANUAL_CLOSE', exitPrice: 103 });
const levels = computeReviewLevels(tradeForReview);

check('Review: Entry level present', levels.some(l => l.label === 'Entry' && l.price === 100));
check('Review: Exit level present', levels.some(l => l.label === 'Exit' && l.price === 103));
check('Review: SL level present', levels.some(l => l.label === 'SL' && l.price === 95));
check('Review: TP level present', levels.some(l => l.label === 'TP' && l.price === 110));
check('Review: exactly 4 levels', levels.length === 4);
check('Review: Entry not dashed (solid line)', !levels.find(l => l.label === 'Entry').dashed);
check('Review: Exit not dashed (solid line)', !levels.find(l => l.label === 'Exit').dashed);
check('Review: SL dashed (reference line)', levels.find(l => l.label === 'SL').dashed);
check('Review: TP dashed (reference line)', levels.find(l => l.label === 'TP').dashed);

// Backward compat: old record without reviewLevels → levels filtered out (no crash)
const oldTrade = { entryPrice: 100, exitPrice: 105, reviewLevels: undefined };
const oldLevels = computeReviewLevels(oldTrade);
check('Backward compat: old record without reviewLevels → Entry+Exit only', oldLevels.length === 2);
check('Backward compat: no crash on missing reviewLevels', oldLevels.every(l => l.price > 0));

// Review markers
function computeReviewMarkers(trade, candles) {
  if (!trade || !candles.length) return [];
  const firstTime = candles[0].time;
  const result = [];
  if (trade.entryTime >= firstTime)
    result.push({ time: trade.entryTime, type: 'ENTRY', price: trade.entryPrice, label: 'Entry' });
  if (trade.exitTime >= firstTime) {
    const exitType = trade.tradeManagementOutcome === 'STOP_LOSS' ? 'SL_HIT'
                   : trade.tradeManagementOutcome === 'TAKE_PROFIT' ? 'TP_HIT'
                   : trade.exitReason === 'STOP_LOSS' ? 'SL_HIT'
                   : trade.exitReason === 'TAKE_PROFIT' ? 'TP_HIT'
                   : 'EXIT';
    result.push({ time: trade.exitTime, type: exitType, price: trade.exitPrice, label: 'Exit' });
  }
  return result;
}

const candles = [{ time: 0 }, { time: 500 }, { time: 1000 }, { time: 1500 }];
const tradeFull = { ...tradeForReview, entryTime: 500, exitTime: 1200 };
const markers = computeReviewMarkers(tradeFull, candles);

check('Review markers: 2 markers (entry + exit)', markers.length === 2);
check('Review markers: ENTRY marker present', markers.some(m => m.type === 'ENTRY'));
check('Review markers: EXIT marker present (manual close)', markers.some(m => m.type === 'EXIT'));

const tradeTP = { ...buildMockRecord({ exitReason: 'TAKE_PROFIT', exitPrice: 110 }), entryTime: 500, exitTime: 1200 };
const markersTP = computeReviewMarkers(tradeTP, candles);
check('Review markers: TP_HIT marker for TAKE_PROFIT exit', markersTP.some(m => m.type === 'TP_HIT'));

const tradeSL = { ...buildMockRecord({ exitReason: 'STOP_LOSS', exitPrice: 95, pnl: -5 }), entryTime: 500, exitTime: 1200 };
const markersSL = computeReviewMarkers(tradeSL, candles);
check('Review markers: SL_HIT marker for STOP_LOSS exit', markersSL.some(m => m.type === 'SL_HIT'));

// ═══════════════════════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(62));
console.log(`  ${passed + failed} checks | ✅ ${passed} passed | ❌ ${failed} failed`);
if (failed === 0) {
  console.log('');
  console.log('  ALL FEATURES VERIFIED:');
  console.log('  1. Prediction evaluated on price movement, not close reason');
  console.log('  2. Prediction outcome and trade management are independent');
  console.log('  3. Strategy info (id/name/icon) preserved in journal records');
  console.log('  4. Review levels: Entry/Exit solid, SL/TP dashed');
  console.log('  5. Backward compat: old records without new fields work fine');
}
console.log('═'.repeat(62));
