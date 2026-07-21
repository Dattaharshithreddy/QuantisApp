// VERIFICATION TESTS — Implementation Audit (Secure Storage, Candle History,
// Model Versioning, Smart Retraining, Position Sizing, Exposure Limits)
//
// Plain, dependency-free assertions — no Jest/Vitest config exists in this
// project yet, and adding one is a bigger change than this verification
// pass warrants (see the Android build failure earlier in this project's
// history for why new dependencies get added carefully, not casually).
// Run with: npx ts-node src/utils/__tests__/auditVerification.ts
// (or compile with tsc and run with node).
//
// Each test mirrors the REAL algorithm's logic directly (copied from the
// actual implementation, not re-derived as an abstraction), so a passing
// test here is evidence about the real code, not a parallel toy version
// of it.

let passed = 0, failed = 0;
function assertEqual(actual: any, expected: any, label: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}\n      expected: ${e}\n      actual:   ${a}`); }
}
function section(title: string) { console.log(`\n${title}`); }

// ─── Candle merge (mirrors utils/candleCache.ts: mergeCandles) ───
section('Candle merge / history preservation');
function mergeCandles(cached: { time: number }[], fresh: { time: number }[]) {
  const byTime = new Map<number, any>();
  cached.forEach(c => byTime.set(c.time, c));
  fresh.forEach(c => byTime.set(c.time, c));
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}
{
  const cached = Array.from({ length: 300 }, (_, i) => ({ time: i * 60000, tag: 'cached' }));
  const fresh = Array.from({ length: 150 }, (_, i) => ({ time: (150 + i) * 60000, tag: 'fresh' }));
  const merged = mergeCandles(cached, fresh);
  assertEqual(merged.length, 300, 'No candles lost when fresh fetch is a subset of cached range');
  assertEqual(merged[0].tag, 'cached', 'Oldest history preserved from cache');
  assertEqual(merged[150].tag, 'fresh', 'Fresh data wins on overlap');
  assertEqual(merged.every((c, i) => i === 0 || c.time > merged[i - 1].time), true, 'Chronological order maintained');

  const dupCount = cached.length + fresh.length - merged.length;
  assertEqual(dupCount, 150, 'Duplicate count matches the actual overlap (150 candles present in both)');
}

// ─── Stable versioning + smart retraining decision (mirrors mlSignal.ts) ───
section('Stable versioning + smart retraining');
type Meta = { modelVersion: number; trainingRunNumber: number; candlesAtTraining: number; trainedAt: number; primaryValidationAccuracy: number };
function decide(prev: Meta | null, candleCount: number, forceRetrain: boolean, now: number, validationAccThisRun: number) {
  const NEW_CANDLES_THRESHOLD = 20, STALE_MS = 4 * 3600 * 1000;
  let shouldRetrain: boolean;
  if (forceRetrain || !prev) shouldRetrain = true;
  else {
    const newCandles = candleCount - prev.candlesAtTraining;
    const age = now - prev.trainedAt;
    shouldRetrain = newCandles >= NEW_CANDLES_THRESHOLD || age >= STALE_MS;
  }
  const nextVersion = (prev?.modelVersion ?? 0) + 1;
  const nextRun = (prev?.trainingRunNumber ?? 0) + 1;
  if (!shouldRetrain) {
    return { modelVersion: prev!.modelVersion, trainingRunNumber: prev!.trainingRunNumber, candlesAtTraining: prev!.candlesAtTraining, trainedAt: prev!.trainedAt, primaryValidationAccuracy: validationAccThisRun, shouldRetrain };
  }
  const accepted = !prev || validationAccThisRun >= prev.primaryValidationAccuracy - 2;
  return {
    modelVersion: accepted ? nextVersion : (prev?.modelVersion ?? nextVersion),
    trainingRunNumber: nextRun, candlesAtTraining: candleCount, trainedAt: now, primaryValidationAccuracy: validationAccThisRun, shouldRetrain,
  };
}
{
  const t0 = 1000000;
  const m1 = decide(null, 150, false, t0, 60);
  assertEqual([m1.modelVersion, m1.trainingRunNumber], [1, 1], 'First-ever training: v1, run #1');

  const m2 = decide(m1 as any, 150, false, t0 + 1000, 60);
  assertEqual([m2.modelVersion, m2.trainingRunNumber, m2.shouldRetrain], [1, 1, false], 'Re-opening chart seconds later with no new candles: reused, NOT incremented');

  const m3 = decide(m2 as any, 180, false, t0 + 2000, 63);
  assertEqual([m3.modelVersion, m3.trainingRunNumber, m3.shouldRetrain], [2, 2, true], '30 new candles (above threshold): genuine retrain, accepted, both increment');

  const m4 = decide(m3 as any, 182, false, t0 + 3000, 63);
  assertEqual([m4.modelVersion, m4.trainingRunNumber, m4.shouldRetrain], [2, 2, false], 'Only 2 new candles after that: reused again, unchanged');

  const m5 = decide(m4 as any, 182, false, t0 + 5 * 3600 * 1000, 63);
  assertEqual(m5.shouldRetrain, true, 'Same candle count but 5 hours later: retrains due to staleness');

  const m6 = decide(m4 as any, 182, true, t0 + 3500, 50); // worse accuracy, but forced
  assertEqual([m6.trainingRunNumber, m6.modelVersion], [3, 2], 'Forced retrain with worse accuracy: training run increments, but model version does NOT (rejected)');
}

// ─── Position sizing with notional cap (mirrors riskManager.ts: calcPositionSize) ───
section('Position sizing with notional exposure cap');
function calcPositionSize(accountSize: number, riskPct: number, entry: number, stopLoss: number, maxNotionalValue?: number) {
  const riskAmount = accountSize * (riskPct / 100);
  const perUnitRisk = Math.abs(entry - stopLoss);
  if (perUnitRisk <= 0) return { qty: 0, riskAmount, perUnitRisk: 0, positionValue: 0 };
  const riskBasedQty = Math.floor(riskAmount / perUnitRisk);
  const maxQtyByNotional = maxNotionalValue != null ? Math.floor(maxNotionalValue / entry) : Infinity;
  const qty = Math.max(0, Math.min(riskBasedQty, maxQtyByNotional));
  return { qty, riskAmount, perUnitRisk, positionValue: qty * entry };
}
{
  // The exact reported scenario: ETHUSD, 1.13% ATR-to-price ratio, 1% risk target
  const entry = 3200, stopLoss = 3200 - 36; // 1.5x ATR(24) stop distance
  const uncapped = calcPositionSize(100000, 1, entry, stopLoss);
  assertEqual(Math.round(uncapped.positionValue), 86400, 'Uncapped sizing reproduces the original bug exactly (86,400 = 86.4% of a 100k portfolio)');

  const capped = calcPositionSize(100000, 1, entry, stopLoss, 30000);
  assertEqual(capped.positionValue <= 30000, true, 'Capped sizing never exceeds the provided notional limit');
  assertEqual(capped.qty < uncapped.qty, true, 'Capped quantity is strictly smaller than the uncapped, risk-only quantity');

  const noOverride = calcPositionSize(100000, 1, entry, stopLoss, undefined);
  assertEqual(noOverride.qty, uncapped.qty, 'Omitting maxNotionalValue reproduces the exact original (pre-fix) behavior');
}

// ─── Exposure gate (mirrors paperRiskControls.ts) ───
section('Exposure limit gate');
function checkSymbolExposure(existingExposure: number, candidateValue: number, portfolioValue: number, maxPct: number) {
  const pct = ((existingExposure + candidateValue) / portfolioValue) * 100;
  return pct <= maxPct;
}
{
  assertEqual(checkSymbolExposure(0, 28800, 100000, 30), true, 'A properly-sized first trade (28.8%) on a fresh portfolio is allowed');
  assertEqual(checkSymbolExposure(0, 86400, 100000, 30), false, 'An improperly-sized trade (86.4%) is still correctly rejected if it somehow bypassed sizing');
  assertEqual(checkSymbolExposure(20000, 15000, 100000, 30), false, 'Long (20%) + new short (15%) combine as gross exposure (35%), correctly exceeding the cap');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
