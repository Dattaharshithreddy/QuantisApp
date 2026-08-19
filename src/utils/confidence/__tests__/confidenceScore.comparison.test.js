// ─────────────────────────────────────────────────────────────────────────────
// CONFIDENCE ENGINE — Before vs After comparison
// 80 synthetic scenarios covering all market conditions.
// "Before" = struct_up used for both buyConf and sellConf (old bug)
// "After"  = struct_up for buyConf, struct_dn for sellConf (fix)
// ─────────────────────────────────────────────────────────────────────────────

function clamp(v) { return Math.max(0, Math.min(100, v)); }
function toward(value, sign) {
  if (sign === 0) return 0;
  return Math.max(0, value * sign);
}

// ── BEFORE: old formula ───────────────────────────────────────────────────────
function struct_up_OLD(q, bos, swing) {
  return clamp((q * 0.3 + bos * 0.4 + swing * 0.3) * 100);
}
// struct_dn OLD was identical to struct_up
const struct_dn_OLD = struct_up_OLD;

// ── AFTER: fixed formula V2 (directional scaler) ─────────────────────────────
function struct_up_NEW(q, bos, swing, trendStr) {
  const upScale = (1 + trendStr) / 2;
  return clamp((q * 0.3 + bos * upScale * 0.4 + swing * upScale * 0.3) * 100);
}
function struct_dn_NEW(q, bos, swing, trendStr) {
  const dnScale = (1 - trendStr) / 2;
  return clamp((q * 0.3 + bos * dnScale * 0.4 + swing * dnScale * 0.3) * 100);
}

// ── Full confidence composite (simplified, matching confidenceScore.ts) ───────
// Uses representative mid-values for the other 7 dimensions.
// The only thing changing between before/after is struct_up vs struct_dn in sellConf.
function computeConf(params) {
  const { mlBuy, mlSell, trend_up, trend_dn, struct_up, struct_dn,
          smc_up, smc_dn, pat_up, pat_dn, fvg_up, fvg_dn,
          vol_up, vol_dn, mtf_up, mtf_dn, regime_up, regime_dn } = params;

  const PAT_CORR = 0.75;
  const buyConf = clamp(
    mlBuy    * 0.25 + trend_up  * 0.15 + struct_up * 0.15 + smc_up   * 0.15 +
    (pat_up * PAT_CORR) * 0.05 +
    fvg_up   * 0.08 + vol_up    * 0.08 + mtf_up    * 0.04 + regime_up * 0.05
  );
  const sellConf = clamp(
    mlSell   * 0.25 + trend_dn  * 0.15 + struct_dn * 0.15 + smc_dn   * 0.15 +
    (pat_dn * PAT_CORR) * 0.05 +
    fvg_dn   * 0.08 + vol_dn    * 0.08 + mtf_dn    * 0.04 + regime_dn * 0.05
  );
  return { buyConf, sellConf };
}

// ── Build a scenario from raw market inputs ───────────────────────────────────
function scenario(label, category, expected, inp) {
  const { mlBuy, mlSell, trendStr, bosConf, swingStr, structQual,
          smcBull, smcBear, patBull, patBear, fvgBull, fvgBear,
          volBull, volBear, mtfBull, mtfBear, regimeBull, regimeBear } = inp;

  // Shared non-structure dimensions
  const shared = {
    mlBuy, mlSell,
    trend_up:   clamp(trendStr > 0 ? trendStr * 100 : 0),
    trend_dn:   clamp(trendStr < 0 ? -trendStr * 100 : 0),
    smc_up:     smcBull, smc_dn: smcBear,
    pat_up:     patBull, pat_dn: patBear,
    fvg_up:     fvgBull, fvg_dn: fvgBear,
    vol_up:     volBull, vol_dn: volBear,
    mtf_up:     mtfBull, mtf_dn: mtfBear,
    regime_up:  regimeBull, regime_dn: regimeBear,
  };

  // BEFORE
  const su_old = struct_up_OLD(structQual, bosConf, swingStr);
  const sd_old = struct_dn_OLD(structQual, bosConf, swingStr);
  const before = computeConf({ ...shared, struct_up: su_old, struct_dn: sd_old });

  // AFTER
  const su_new = struct_up_NEW(structQual, bosConf, swingStr, trendStr);
  const sd_new = struct_dn_NEW(structQual, bosConf, swingStr, trendStr);
  const after  = computeConf({ ...shared, struct_up: su_new, struct_dn: sd_new });

  // Validation: determine if after is an improvement
  const pass = validateExpected(expected, before, after);

  return { label, category, expected, before, after,
           su_old, sd_old, su_new, sd_new, pass };
}

// ── Validation rules ──────────────────────────────────────────────────────────
// "Expected" describes what SHOULD be true after the fix.
// We verify each scenario against its constraint.
function validateExpected(expected, before, after) {
  switch (expected) {
    case 'BUY_DOMINANT':
      // buyConf should exceed sellConf after fix; spread should widen or stay same
      return after.buyConf > after.sellConf &&
             (after.buyConf - after.sellConf) >= (before.buyConf - before.sellConf);
    case 'SELL_DOMINANT':
      return after.sellConf > after.buyConf &&
             (after.sellConf - after.buyConf) >= (before.sellConf - before.buyConf);
    case 'SPREAD_WIDER':
      return Math.abs(after.buyConf - after.sellConf) > Math.abs(before.buyConf - before.sellConf);
    case 'SELL_REDUCED':
      // sellConf should be lower after fix in bull markets
      return after.sellConf <= before.sellConf;
    case 'BUY_REDUCED':
      // buyConf should be lower after fix in bear markets
      return after.buyConf <= before.buyConf;
    case 'SYMMETRIC':
      // In neutral market, buyConf ≈ sellConf (within 5 pts)
      return Math.abs(after.buyConf - after.sellConf) <= 5;
    case 'BUY_UNCHANGED':
      // Strong bull: buyConf should be similar or better (struct_up gating shouldn't destroy it)
      return after.buyConf >= before.buyConf - 5; // allow small tolerance
    case 'NO_INVERSION':
      // Regardless of market: the fix must never invert a correct signal
      return true; // checked separately in the invariant section
    default:
      return true;
  }
}

// ── 80 Test Scenarios ─────────────────────────────────────────────────────────
const scenarios = [];

// Helper defaults
const D = {
  smcBull:50, smcBear:50, patBull:50, patBear:50,
  fvgBull:50, fvgBear:50, volBull:50, volBear:50,
  mtfBull:50, mtfBear:50, regimeBull:50, regimeBear:50,
};

// ── STRONG BULL (12 scenarios) ────────────────────────────────────────────────
for (let i = 0; i < 12; i++) {
  const trendStr = 0.6 + (i % 4) * 0.1;   // 0.6 .. 0.9
  const bosConf  = 0.7 + (i % 3) * 0.1;   // 0.7 .. 0.9
  const mlBuy = 70 + i * 2;
  scenarios.push(scenario(
    `Strong Bull #${i+1} (trend=${trendStr.toFixed(1)}, bos=${bosConf.toFixed(1)})`,
    'STRONG BULL', 'SELL_REDUCED',
    { ...D, trendStr, bosConf, swingStr: 0.8, structQual: 0.75,
      mlBuy, mlSell: 100 - mlBuy,
      smcBull: 70, smcBear: 30, mtfBull: 75, mtfBear: 25, regimeBull: 80, regimeBear: 20 }
  ));
}

// ── STRONG BEAR (12 scenarios) ────────────────────────────────────────────────
for (let i = 0; i < 12; i++) {
  const trendStr = -(0.6 + (i % 4) * 0.1);
  const bosConf  = 0.7 + (i % 3) * 0.1;
  const mlSell = 70 + i * 2;
  scenarios.push(scenario(
    `Strong Bear #${i+1} (trend=${trendStr.toFixed(1)}, bos=${bosConf.toFixed(1)})`,
    'STRONG BEAR', 'BUY_REDUCED',
    { ...D, trendStr, bosConf, swingStr: 0.8, structQual: 0.75,
      mlBuy: 100 - mlSell, mlSell,
      smcBull: 30, smcBear: 70, mtfBull: 25, mtfBear: 75, regimeBull: 20, regimeBear: 80 }
  ));
}

// ── SIDEWAYS / RANGING (10 scenarios) ─────────────────────────────────────────
for (let i = 0; i < 10; i++) {
  const trendStr = (i % 2 === 0 ? 0.05 : -0.05);   // near-zero
  const bosConf = 0.3 + i * 0.05;
  scenarios.push(scenario(
    `Sideways #${i+1} (trend=${trendStr.toFixed(2)}, bos=${bosConf.toFixed(2)})`,
    'SIDEWAYS', 'SYMMETRIC',
    { ...D, trendStr, bosConf, swingStr: 0.4, structQual: 0.5,
      mlBuy: 52, mlSell: 48,
      smcBull: 48, smcBear: 52, mtfBull: 50, mtfBear: 50, regimeBull: 45, regimeBear: 45 }
  ));
}

// ── BULL REVERSAL — price was bearish, now turning bull (10 scenarios) ─────────
for (let i = 0; i < 10; i++) {
  const prevBear = -(0.3 + i * 0.05);   // recent trend still slightly bear
  const mlBuy = 58 + i;                  // model sees bull signal forming
  scenarios.push(scenario(
    `Bull Reversal #${i+1} (trendStr=${prevBear.toFixed(2)}, mlBuy=${mlBuy})`,
    'BULL REVERSAL', 'SELL_REDUCED',
    { ...D, trendStr: prevBear, bosConf: 0.6, swingStr: 0.55, structQual: 0.6,
      mlBuy, mlSell: 100 - mlBuy,
      smcBull: 60, smcBear: 40, mtfBull: 58, mtfBear: 42, regimeBull: 55, regimeBear: 45 }
  ));
}

// ── BEAR REVERSAL (10 scenarios) ──────────────────────────────────────────────
for (let i = 0; i < 10; i++) {
  const prevBull = 0.3 + i * 0.05;
  const mlSell = 58 + i;
  scenarios.push(scenario(
    `Bear Reversal #${i+1} (trendStr=${prevBull.toFixed(2)}, mlSell=${mlSell})`,
    'BEAR REVERSAL', 'BUY_REDUCED',
    { ...D, trendStr: prevBull, bosConf: 0.6, swingStr: 0.55, structQual: 0.6,
      mlBuy: 100 - mlSell, mlSell,
      smcBull: 40, smcBear: 60, mtfBull: 42, mtfBear: 58, regimeBull: 45, regimeBear: 55 }
  ));
}

// ── HIGH VOLATILITY / BREAKOUT (8 scenarios) ──────────────────────────────────
for (let i = 0; i < 8; i++) {
  const trendStr = i < 4 ? 0.5 + i * 0.1 : -(0.5 + (i-4) * 0.1);
  const mlBuy  = trendStr > 0 ? 65 + i * 2 : 35 - i * 2;
  const mlSell = 100 - mlBuy;
  scenarios.push(scenario(
    `Breakout #${i+1} (trend=${trendStr.toFixed(1)})`,
    'BREAKOUT', trendStr > 0 ? 'SPREAD_WIDER' : 'SPREAD_WIDER',
    { ...D, trendStr, bosConf: 0.85, swingStr: 0.9, structQual: 0.8,
      mlBuy, mlSell,
      smcBull: trendStr > 0 ? 75 : 25, smcBear: trendStr > 0 ? 25 : 75,
      mtfBull: trendStr > 0 ? 80 : 20, mtfBear: trendStr > 0 ? 20 : 80,
      regimeBull: trendStr > 0 ? 70 : 30, regimeBear: trendStr > 0 ? 30 : 70 }
  ));
}

// ── WEAK / UNCERTAIN SIGNAL (8 scenarios) ─────────────────────────────────────
for (let i = 0; i < 8; i++) {
  const trendStr = (i % 3 === 0 ? 0.2 : i % 3 === 1 ? -0.2 : 0.05);
  const mlBuy = 50 + (i % 5) * 2;
  scenarios.push(scenario(
    `Weak Signal #${i+1} (trend=${trendStr.toFixed(2)}, mlBuy=${mlBuy})`,
    'WEAK SIGNAL', 'NO_INVERSION',
    { ...D, trendStr, bosConf: 0.4, swingStr: 0.45, structQual: 0.5,
      mlBuy, mlSell: 100 - mlBuy,
      smcBull: 50, smcBear: 50, mtfBull: 50, mtfBear: 50, regimeBull: 50, regimeBear: 50 }
  ));
}

// ── CONFLICTED SIGNALS (10 scenarios) ─────────────────────────────────────────
// Model says BUY but structure is bearish (or vice versa)
for (let i = 0; i < 10; i++) {
  const trendStr = i < 5 ? -(0.4 + i * 0.1) : (0.4 + (i-5) * 0.1);
  const mlBuy    = i < 5 ? 65 + i * 2 : 35 - i * 2;  // model disagrees with structure
  scenarios.push(scenario(
    `Conflicted #${i+1} (structure=${trendStr.toFixed(1)}, mlBuy=${mlBuy})`,
    'CONFLICTED', i < 5 ? 'SELL_REDUCED' : 'BUY_REDUCED',
    { ...D, trendStr, bosConf: 0.7, swingStr: 0.7, structQual: 0.7,
      mlBuy, mlSell: 100 - mlBuy,
      smcBull: i < 5 ? 35 : 65, smcBear: i < 5 ? 65 : 35,
      mtfBull: i < 5 ? 30 : 70, mtfBear: i < 5 ? 70 : 30,
      regimeBull: i < 5 ? 30 : 70, regimeBear: i < 5 ? 70 : 30 }
  ));
}

// ─────────────────────────────────────────────────────────────────────────────
// RESULTS
// ─────────────────────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
const byCategory = {};

// Track all deltas for statistical summary
const buyConfDeltas = [], sellConfDeltas = [], spreadDeltas = [];

for (const s of scenarios) {
  const buDelta  = s.after.buyConf  - s.before.buyConf;
  const sdDelta  = s.after.sellConf - s.before.sellConf;
  const spBefore = Math.abs(s.before.buyConf - s.before.sellConf);
  const spAfter  = Math.abs(s.after.buyConf  - s.after.sellConf);
  buyConfDeltas.push(buDelta);
  sellConfDeltas.push(sdDelta);
  spreadDeltas.push(spAfter - spBefore);

  if (!byCategory[s.category]) byCategory[s.category] = { pass:0, fail:0, rows:[] };
  if (s.pass) { passed++; byCategory[s.category].pass++; }
  else         { failed++; byCategory[s.category].fail++; }
  byCategory[s.category].rows.push(s);
}

// Print category tables
for (const [cat, data] of Object.entries(byCategory)) {
  console.log(`\n${'═'.repeat(90)}`);
  console.log(`  ${cat}  (${data.pass}/${data.pass+data.fail} pass)`);
  console.log('═'.repeat(90));
  console.log(
    'Scenario'.padEnd(44),
    'Buy(B)'.padStart(7), 'Buy(A)'.padStart(7),
    'Sell(B)'.padStart(8), 'Sell(A)'.padStart(8),
    'Spread△'.padStart(8), 'Result'.padStart(7)
  );
  console.log('─'.repeat(90));
  for (const s of data.rows) {
    const spBefore = Math.abs(s.before.buyConf - s.before.sellConf);
    const spAfter  = Math.abs(s.after.buyConf  - s.after.sellConf);
    const spDelta  = spAfter - spBefore;
    console.log(
      s.label.slice(0,43).padEnd(44),
      s.before.buyConf.toFixed(1).padStart(7),
      s.after.buyConf.toFixed(1).padStart(7),
      s.before.sellConf.toFixed(1).padStart(8),
      s.after.sellConf.toFixed(1).padStart(8),
      (spDelta >= 0 ? '+' : '') + spDelta.toFixed(1).padStart(7),
      (s.pass ? '✅' : '❌').padStart(6)
    );
  }
}

// Statistical summary
const mean = arr => arr.reduce((a,b)=>a+b,0)/arr.length;
const std  = arr => { const m=mean(arr); return Math.sqrt(arr.reduce((a,b)=>a+(b-m)**2,0)/arr.length); };

console.log('\n' + '═'.repeat(90));
console.log('  STATISTICAL SUMMARY');
console.log('═'.repeat(90));
console.log(`  Total scenarios:          ${scenarios.length}`);
console.log(`  Passed:                   ${passed} (${(passed/scenarios.length*100).toFixed(0)}%)`);
console.log(`  Failed:                   ${failed}`);

const bearScenarios = scenarios.filter(s => s.category === 'STRONG BEAR' || (s.category === 'CONFLICTED' && s.expected === 'BUY_REDUCED'));
const bullScenarios = scenarios.filter(s => s.category === 'STRONG BULL' || (s.category === 'CONFLICTED' && s.expected === 'SELL_REDUCED'));

const sellAfter  = bullScenarios.map(s => s.after.sellConf);
const sellBefore = bullScenarios.map(s => s.before.sellConf);
const buyAfter   = bearScenarios.map(s => s.after.buyConf);
const buyBefore  = bearScenarios.map(s => s.before.buyConf);

console.log(`\n  In BULL scenarios (${bullScenarios.length} cases):`);
console.log(`    sellConf before: avg ${mean(sellBefore).toFixed(1)} ± ${std(sellBefore).toFixed(1)}`);
console.log(`    sellConf after:  avg ${mean(sellAfter).toFixed(1)} ± ${std(sellAfter).toFixed(1)}`);
console.log(`    Mean reduction:  ${(mean(sellBefore) - mean(sellAfter)).toFixed(1)} points`);

console.log(`\n  In BEAR scenarios (${bearScenarios.length} cases):`);
console.log(`    buyConf before:  avg ${mean(buyBefore).toFixed(1)} ± ${std(buyBefore).toFixed(1)}`);
console.log(`    buyConf after:   avg ${mean(buyAfter).toFixed(1)} ± ${std(buyAfter).toFixed(1)}`);
console.log(`    Mean reduction:  ${(mean(buyBefore) - mean(buyAfter)).toFixed(1)} points`);

const allSpreads = scenarios.map(s => ({
  before: Math.abs(s.before.buyConf - s.before.sellConf),
  after:  Math.abs(s.after.buyConf  - s.after.sellConf),
}));
console.log(`\n  Buy/Sell spread (all ${scenarios.length} scenarios):`);
console.log(`    Before: avg ${mean(allSpreads.map(s=>s.before)).toFixed(1)} pts`);
console.log(`    After:  avg ${mean(allSpreads.map(s=>s.after)).toFixed(1)} pts`);
console.log(`    Mean widening: +${(mean(allSpreads.map(s=>s.after)) - mean(allSpreads.map(s=>s.before))).toFixed(1)} pts`);

// Invariant check: no signal inversion
let inversions = 0;
for (const s of scenarios) {
  const waBefore = s.before.buyConf > s.before.sellConf ? 'BUY' : s.before.sellConf > s.before.buyConf ? 'SELL' : 'NEUTRAL';
  const waAfter  = s.after.buyConf  > s.after.sellConf  ? 'BUY' : s.after.sellConf  > s.after.buyConf  ? 'SELL' : 'NEUTRAL';
  if (waBefore !== 'NEUTRAL' && waAfter !== 'NEUTRAL' && waBefore !== waAfter) {
    inversions++;
    console.log(`  ⚠️  INVERSION: ${s.label} — ${waBefore} → ${waAfter}`);
  }
}
console.log(`\n  Signal inversions (must be 0): ${inversions === 0 ? '✅ 0' : '❌ ' + inversions}`);
console.log('\n' + '═'.repeat(90));
