// Integration tests for strategyExecutor.ts's SHORT support, added because
// backtest.ts was confirmed (by tracing, not assumption) to only ever
// generate/execute LONG trades. Tests the REAL, modified module directly.
//
// Run with: npx ts-node src/utils/__tests__/backtestShort.test.ts

import { simulateSignalStrategy, simulateAIStrategyWithDiagnostics, ExecConfig, DiagnosticExecConfig } from '../strategyExecutor';
import { Candle } from '../indicators';

let passed = 0, failed = 0;
function check(label: string, cond: boolean, detail?: any) {
  if (cond) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label} ${detail !== undefined ? JSON.stringify(detail) : ''}`); }
}

function mkCandle(time: number, open: number, high: number, low: number, close: number): Candle {
  return { time, open, high, low, close, volume: 1000 } as Candle;
}

const config: ExecConfig = {
  startingCapital: 100000, feePct: 0.1, slippagePct: 0.05, riskPerTradePct: 2,
  atrStopMultiplier: 1.5, atrTargetMultiplier: 2.5, maxHoldingBars: 40,
};

// ─── Scenario 1: LONG entry, hits TAKE_PROFIT ───
{
  console.log('\n=== simulateSignalStrategy: LONG hits TAKE_PROFIT ===');
  // ATR=2 -> stop = entry-3, target = entry+5. Entry bar close=100.
  const candles = [
    mkCandle(0, 100, 100, 100, 100),   // signal fires here (idx 0)
    mkCandle(1, 100, 101, 99, 100.5),
    mkCandle(2, 100.5, 106, 100, 105.5), // high=106 >= target(102.5+... let's recompute)
  ];
  // entryPrice = 100 * 1.0005 = 100.05; stop = 100 - 1.5*2 = 97; target = 100 + 2.5*2 = 105
  const walkIndices = [0, 1, 2];
  let signalCount = 0;
  const { trades } = simulateSignalStrategy(candles, walkIndices, (idx) => {
    if (idx === 0) { signalCount++; return { enter: true, direction: 'LONG', reason: 'test long' }; }
    return { enter: false, reason: 'n/a' };
  }, () => 2, config);

  check('Exactly one trade opened', trades.length === 1, trades.length);
  if (trades.length === 1) {
    check('Trade direction is LONG', trades[0].direction === 'LONG', trades[0].direction);
    check('Exit reason is TAKE_PROFIT (bar 2 high=106 crosses target=105)', trades[0].exitReason === 'TAKE_PROFIT', trades[0].exitReason);
    check('PnL is positive (LONG, price rose)', trades[0].pnl > 0, trades[0].pnl);
  }
}

// ─── Scenario 2: LONG entry, hits STOP_LOSS ───
{
  console.log('\n=== simulateSignalStrategy: LONG hits STOP_LOSS ===');
  const candles = [
    mkCandle(0, 100, 100, 100, 100),
    mkCandle(1, 100, 100, 96, 97),    // low=96 <= stop(97)
  ];
  const { trades } = simulateSignalStrategy(candles, [0, 1], (idx) => {
    if (idx === 0) return { enter: true, direction: 'LONG', reason: 'test' };
    return { enter: false, reason: 'n/a' };
  }, () => 2, config);

  check('Exactly one trade opened', trades.length === 1, trades.length);
  if (trades.length === 1) {
    check('Exit reason is STOP_LOSS', trades[0].exitReason === 'STOP_LOSS', trades[0].exitReason);
    check('PnL is negative (LONG, price fell)', trades[0].pnl < 0, trades[0].pnl);
  }
}

// ─── Scenario 3: SHORT entry, hits TAKE_PROFIT (price falls) ───
{
  console.log('\n=== simulateSignalStrategy: SHORT hits TAKE_PROFIT ===');
  // SHORT: stop = entry+3 = 103, target = entry-5 = 95
  const candles = [
    mkCandle(0, 100, 100, 100, 100),
    mkCandle(1, 100, 101, 94, 95),   // low=94 <= target(95) — price fell, good for short
  ];
  const { trades } = simulateSignalStrategy(candles, [0, 1], (idx) => {
    if (idx === 0) return { enter: true, direction: 'SHORT', reason: 'test short' };
    return { enter: false, reason: 'n/a' };
  }, () => 2, config);

  check('Exactly one trade opened', trades.length === 1, trades.length);
  if (trades.length === 1) {
    check('Trade direction is SHORT', trades[0].direction === 'SHORT', trades[0].direction);
    check('Exit reason is TAKE_PROFIT', trades[0].exitReason === 'TAKE_PROFIT', trades[0].exitReason);
    check('PnL is positive (SHORT, price fell - profit)', trades[0].pnl > 0, trades[0].pnl);
  }
}

// ─── Scenario 4: SHORT entry, hits STOP_LOSS (price rises) - the exact bug shape ───
{
  console.log('\n=== simulateSignalStrategy: SHORT hits STOP_LOSS (price rose against the short) ===');
  const candles = [
    mkCandle(0, 100, 100, 100, 100),
    mkCandle(1, 100, 104, 100, 103.5), // high=104 >= stop(103)
  ];
  const { trades } = simulateSignalStrategy(candles, [0, 1], (idx) => {
    if (idx === 0) return { enter: true, direction: 'SHORT', reason: 'test short loss' };
    return { enter: false, reason: 'n/a' };
  }, () => 2, config);

  check('Exactly one trade opened', trades.length === 1, trades.length);
  if (trades.length === 1) {
    check('Exit reason is STOP_LOSS', trades[0].exitReason === 'STOP_LOSS', trades[0].exitReason);
    check('PnL is negative (SHORT, price rose - loss, NOT incorrectly positive)', trades[0].pnl < 0, trades[0].pnl);
  }
}

// ─── Scenario 5: backward compatibility - omitting direction defaults to LONG exactly as before ───
{
  console.log('\n=== Backward compatibility: omitted direction defaults to LONG ===');
  const candles = [
    mkCandle(0, 100, 100, 100, 100),
    mkCandle(1, 100, 106, 100, 105.5),
  ];
  const { trades } = simulateSignalStrategy(candles, [0, 1], (idx) => {
    if (idx === 0) return { enter: true, reason: 'no direction field at all - exactly like the 5 existing long-only callers' };
    return { enter: false, reason: 'n/a' };
  }, () => 2, config);
  check('Trade opened despite no direction field', trades.length === 1, trades.length);
  if (trades.length === 1) check('Defaulted to LONG', trades[0].direction === 'LONG', trades[0].direction);
}

// ─── Scenario 6: simulateAIStrategyWithDiagnostics actually executes SHORT instead of skipping with BEARISH_NO_SHORT ───
{
  console.log('\n=== simulateAIStrategyWithDiagnostics: SELL signal now actually opens a SHORT (not skipped) ===');
  const diagConfig: DiagnosticExecConfig = { ...config };
  const candles = [
    mkCandle(0, 100, 100, 100, 100),
    mkCandle(1, 100, 101, 94, 95),
  ];
  const { trades, barDecisions } = simulateAIStrategyWithDiagnostics(
    candles, [0, 1],
    (idx) => idx === 0
      ? { ensembleProb: 0.2, mlpProb: 0.15, lrProb: 0.25, agree: true, confidence: 80 } // bearish, models agree
      : { ensembleProb: 0.5, mlpProb: 0.5, lrProb: 0.5, agree: true, confidence: 0 },
    () => 2, null, diagConfig, 0.55
  );

  const entryDecision = barDecisions[0];
  check('Bar decision correctly labels this as a SELL action', entryDecision.action === 'SELL', entryDecision.action);
  check('Bar decision shows executed=true (not skipped)', entryDecision.executed === true, entryDecision);
  check('skipReason is undefined (not BEARISH_NO_SHORT or anything else)', entryDecision.skipReason === undefined, entryDecision.skipReason);
  check('A real SHORT trade was actually opened', trades.length === 1, trades.length);
  if (trades.length === 1) {
    check('Trade direction is SHORT', trades[0].direction === 'SHORT', trades[0].direction);
    check('PnL is positive (price fell, profitable short)', trades[0].pnl > 0, trades[0].pnl);
  }
}

// ─── Scenario 7: existing long-only callers (baselines, sensitivity, etc) are completely unaffected ───
{
  console.log('\n=== Regression: existing 5 long-only callers unaffected (no direction field used at all) ===');
  const candles = [mkCandle(0, 100, 100, 100, 100), mkCandle(1, 100, 106, 100, 105.5)];
  const { trades: tradesOld } = simulateSignalStrategy(candles, [0, 1], (idx) => ({ enter: idx === 0, reason: 'old-style signal, no direction field' }), () => 2, config);
  check('Old-style callers (TypeScript structurally compatible, no direction field) still work identically', tradesOld.length === 1 && tradesOld[0].direction === 'LONG', tradesOld);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
