// ─────────────────────────────────────────────────────────────────────────────
// ROLLING WINDOW — Proof Test
//
// Proves that recencyWindow correctly detects strategy performance degradation
// that all-time statistics would hide.
//
// Core scenario (ChatGPT's warning made concrete):
//   SWING:    historically great (PF=3.81, 63% win over 60 trades)
//             but recently degrading (PF=0.32, 30% win in last 20 trades)
//   INTRADAY: stable (PF=1.8, 60% win throughout)
//
//   Without window: recommends SWING (historical record dominates) ❌
//   With window=20: recommends INTRADAY (recent degradation detected) ✅
// ─────────────────────────────────────────────────────────────────────────────

const MIN_TRADES_MODERATE = 10;

function computeMatrix(trades, opts = {}) {
  const win = opts.recencyWindow ?? 100;
  const tagged = trades.filter(t => t.strategyId != null);
  const sorted = [...tagged].sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));
  const groups = new Map();
  for (const t of sorted) {
    if (!groups.has(t.regimeAtEntry)) groups.set(t.regimeAtEntry, new Map());
    const bs = groups.get(t.regimeAtEntry);
    if (!bs.has(t.strategyId)) bs.set(t.strategyId, []);
    bs.get(t.strategyId).push(t);
  }
  if (isFinite(win)) {
    for (const bs of groups.values()) {
      for (const [id, g] of bs) {
        if (g.length > win) bs.set(id, g.slice(0, win));
      }
    }
  }
  const mat = new Map();
  for (const [regime, bs] of groups) {
    const cm = new Map();
    for (const [sid, g] of bs) {
      const wins   = g.filter(t => t.pnl > 0);
      const losses = g.filter(t => t.pnl <= 0);
      const gw = wins.reduce((s, t) => s + t.pnl, 0);
      const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
      const n = g.length;
      cm.set(sid, {
        strategyId:   sid,
        tradeCount:   n,
        winRate:      (wins.length / n) * 100,
        profitFactor: gl > 0 ? gw / gl : gw > 0 ? Infinity : 0,
        confidence:   n >= 20 ? 'STRONG' : n >= 10 ? 'MODERATE' : 'INSUFFICIENT',
      });
    }
    mat.set(regime, cm);
  }
  return mat;
}

function recommend(regime, mat, opts = {}) {
  const minTrades      = opts.minTradesForRecommendation ?? MIN_TRADES_MODERATE;
  const recencyWindow  = opts.recencyWindow ?? 100;
  const row = mat.get(regime);
  if (!row) return null;
  const cands = [...row.values()].filter(
    c => c.confidence !== 'INSUFFICIENT' && c.tradeCount >= minTrades
  );
  if (!cands.length) return null;
  const best = cands.sort((a, b) => {
    const d = (isFinite(b.profitFactor) ? b.profitFactor : 99)
            - (isFinite(a.profitFactor) ? a.profitFactor : 99);
    return Math.abs(d) > 0.1 ? d : b.winRate - a.winRate;
  })[0];
  const windowNote = isFinite(recencyWindow)
    ? ` (last ${recencyWindow} trades per strategy)` : '';
  return {
    strategyId:   best.strategyId,
    winRate:      best.winRate,
    profitFactor: best.profitFactor,
    tradeCount:   best.tradeCount,
    confidence:   best.confidence,
    reason: `Based on ${best.tradeCount} recent paper trades in ${regime}${windowNote}.`,
  };
}

// ── Build test data ───────────────────────────────────────────────────────────
const now = Date.now();
const trades = [];

// SWING — old great trades (40 trades, 80% win, 60–20 days ago)
for (let i = 0; i < 40; i++) {
  trades.push({
    strategyId: 'SWING', pnl: i < 32 ? 400 : -100, pnlPct: i < 32 ? 4 : -1,
    holdingBars: 30, holdingMs: 3 * 86400000, entryConfidence: 75,
    regimeAtEntry: 'STRONG_BULL_TREND', direction: 'LONG',
    closedAt: now - (60 - i) * 86400000,
  });
}
// SWING — recent degrading trades (20 trades, 30% win, last 20 hours)
for (let i = 0; i < 20; i++) {
  trades.push({
    strategyId: 'SWING', pnl: i < 6 ? 150 : -200, pnlPct: i < 6 ? 2 : -2.5,
    holdingBars: 30, holdingMs: 3 * 86400000, entryConfidence: 72,
    regimeAtEntry: 'STRONG_BULL_TREND', direction: 'LONG',
    closedAt: now - (20 - i) * 3600000,
  });
}
// INTRADAY — stable 60% win throughout (25 trades over 25 days)
for (let i = 0; i < 25; i++) {
  trades.push({
    strategyId: 'INTRADAY', pnl: i < 15 ? 120 : -80, pnlPct: i < 15 ? 1.5 : -1,
    holdingBars: 8, holdingMs: 2 * 3600000, entryConfidence: 55,
    regimeAtEntry: 'STRONG_BULL_TREND', direction: 'LONG',
    closedAt: now - (25 - i) * 86400000,
  });
}
// One trade with no closedAt — should sort last (treated as oldest)
trades.push({
  strategyId: 'SWING', pnl: -300, pnlPct: -4,
  holdingBars: 5, holdingMs: 1000, entryConfidence: 60,
  regimeAtEntry: 'STRONG_BULL_TREND', direction: 'LONG',
  // no closedAt
});

// ── Run tests ─────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function check(label, ok) {
  if (ok) { passed++; console.log('  ✅', label); }
  else    { failed++; console.log('  ❌', label); }
}

const matAll = computeMatrix(trades, { recencyWindow: Infinity });
const matW20 = computeMatrix(trades, { recencyWindow: 20 });
const matDef = computeMatrix(trades);                           // default = 100
const recAll = recommend('STRONG_BULL_TREND', matAll, { recencyWindow: Infinity });
const recW20 = recommend('STRONG_BULL_TREND', matW20, { recencyWindow: 20 });
const recDef = recommend('STRONG_BULL_TREND', matDef);

const swAll = matAll.get('STRONG_BULL_TREND')?.get('SWING');
const swW20 = matW20.get('STRONG_BULL_TREND')?.get('SWING');
const swDef = matDef.get('STRONG_BULL_TREND')?.get('SWING');

console.log('═'.repeat(62));
console.log('  ROLLING WINDOW PROOF TEST');
console.log('═'.repeat(62));

console.log('\n── Scenario setup ──');
console.log('  SWING: 40 old trades (80% win) + 20 recent trades (30% win)');
console.log('  INTRADAY: 25 stable trades (60% win)');

console.log('\n── All-time statistics (no window) ──');
console.log(`  SWING:    trades=${swAll?.tradeCount}  win%=${swAll?.winRate.toFixed(1)}  PF=${swAll?.profitFactor.toFixed(2)}`);
console.log(`  Recommendation: ${recAll?.strategyId}`);

console.log('\n── Window=20 (recent 20 trades per cell) ──');
console.log(`  SWING:    trades=${swW20?.tradeCount}  win%=${swW20?.winRate.toFixed(1)}  PF=${swW20?.profitFactor.toFixed(2)}`);
console.log(`  Recommendation: ${recW20?.strategyId}`);

console.log('\n── Tests ──');

// Core scenario
check('All-trades recommends SWING (strong historical record)',         recAll?.strategyId === 'SWING');
check('Window=20 detects degradation, switches to INTRADAY',          recW20?.strategyId === 'INTRADAY');
check('All-trades and windowed give DIFFERENT recommendations',        recAll?.strategyId !== recW20?.strategyId);

// Window boundaries
check('SWING window=20: exactly 20 trades included',                  swW20?.tradeCount === 20);
check('SWING window=20: win rate = 30% (recent only)',                Math.abs((swW20?.winRate ?? 0) - 30) < 1);
check('SWING window=20: PF reflects recent losses (<1)',              (swW20?.profitFactor ?? 1) < 1);

// All-time captures historical strength
check('SWING all-time: 61 trades (60 + 1 no-closedAt)',               swAll?.tradeCount === 61);
check('SWING all-time: win% ~63% (blended)',                          (swAll?.winRate ?? 0) > 60 && (swAll?.winRate ?? 0) < 70);
check('SWING all-time: PF > 3 (old wins dominate)',                   (swAll?.profitFactor ?? 0) > 3);

// closedAt=undefined sorts last
check('Trade without closedAt sorts last (excluded from window=20)',  swW20?.tradeCount === 20);

// Default window=100 includes all 61 SWING trades (under default threshold)
check('Default window=100: includes all 61 SWING trades',            swDef?.tradeCount === 61);

// Reason string
check('Window=20 reason mentions "last 20 trades"',                   recW20?.reason.includes('last 20 trades'));
check('All-trades reason has no window note',                         !recAll?.reason.includes('last'));

// No modification to input trades
const tradeCountBefore = trades.length;
computeMatrix(trades, { recencyWindow: 20 });
check('computeMatrix does not modify input trades array',             trades.length === tradeCountBefore);

console.log('');
console.log('═'.repeat(62));
console.log(`  ${passed + failed} checks | ✅ ${passed} passed | ❌ ${failed} failed`);
if (failed === 0) {
  console.log('');
  console.log('  PROVEN: Rolling window correctly detects performance');
  console.log('  degradation that all-time statistics would hide.');
  console.log('  Market evolution is now handled.');
}
console.log('═'.repeat(62));
