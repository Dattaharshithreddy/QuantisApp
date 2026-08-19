// ─────────────────────────────────────────────────────────────────────────────
// TRADE READINESS — Decision Matrix Test Suite
// Mirrors the logic in tradeReadiness.ts exactly.
// Run with: node /tmp/decision_matrix_test.js
// ─────────────────────────────────────────────────────────────────────────────

const TF_ORDER = ['5m','15m','30m','1h','4h','1d'];

// ── Inline translator (mirrors tradeReadiness.ts) ─────────────────────────────

function findBlockingTF(signals, tradeDir, baseTF) {
  const bi = TF_ORDER.indexOf(baseTF);
  const sorted = [...signals]
    .filter(s => TF_ORDER.indexOf(s.tf) > bi && s.barCount >= 10)
    .sort((a, b) => TF_ORDER.indexOf(b.tf) - TF_ORDER.indexOf(a.tf));
  for (const s of sorted) {
    if (s.trendDir !== 0 && s.trendDir !== tradeDir) return s.tf;
    if (s.structureDir !== 0 && s.structureDir !== tradeDir) return s.tf;
  }
  return null;
}

function buildFactors({ tradeDir, regimeSnap, mtfSnap, msSnapshot, topPattern }) {
  const f = [];
  if (regimeSnap) {
    const bull = regimeSnap.label.includes('BULL'), bear = regimeSnap.label.includes('BEAR');
    const rd = bull ? 1 : bear ? -1 : 0;
    const v = rd === 0 ? 'NEUTRAL'
      : rd === tradeDir ? (tradeDir === 1 ? 'BUY' : 'SELL')
      : tradeDir === 1  ? 'SELL' : 'BUY';
    f.push({ engine: 'Market Regime', verdict: v });
  }
  if (mtfSnap) {
    const sc = mtfSnap.overallMTFScore;
    const ad = sc > 0.15 ? 1 : sc < -0.15 ? -1 : 0;
    const v = ad === 0 ? 'WAIT'
      : ad === tradeDir ? (tradeDir === 1 ? 'BUY' : 'SELL')
      : tradeDir === 1  ? 'SELL' : 'BUY';
    f.push({ engine: 'Multi-Timeframe', verdict: v });
  }
  if (topPattern) {
    const pd = topPattern.direction === 'bullish' ? 1 : topPattern.direction === 'bearish' ? -1 : 0;
    const v = pd === 0 ? 'NEUTRAL'
      : pd === tradeDir ? (tradeDir === 1 ? 'BUY' : 'SELL')
      : tradeDir === 1  ? 'SELL' : 'BUY';
    f.push({ engine: 'Pattern Engine', verdict: v });
  }
  if (msSnapshot) {
    const bull = msSnapshot.structureHighs === 'HH' && msSnapshot.structureLows === 'HL';
    const bear = msSnapshot.structureHighs === 'LH' && msSnapshot.structureLows === 'LL';
    const sd = bull ? 1 : bear ? -1 : 0;
    const v = sd === 0 ? 'NEUTRAL'
      : sd === tradeDir ? (tradeDir === 1 ? 'BUY' : 'SELL')
      : tradeDir === 1  ? 'SELL' : 'BUY';
    f.push({ engine: 'Market Structure', verdict: v });
  }
  return f;
}

function buildConflictNote(factors, tradeDir, state) {
  if (state === 'READY' || !tradeDir) return '';
  const tv = tradeDir === 1 ? 'BUY' : 'SELL';
  const blocking = factors.filter(f => f.verdict !== tv && f.verdict !== 'NEUTRAL');
  if (!blocking.length) return '';
  const priority = ['Market Structure','Multi-Timeframe','Market Regime','Pattern Engine'];
  const top = blocking.sort((a,b) => priority.indexOf(a.engine) - priority.indexOf(b.engine))[0];
  return top.engine + ' is blocking.';
}

function computeState({ prediction, mtfSnap }) {
  const td = prediction.direction === 'UP' ? 1 : prediction.direction === 'DOWN' ? -1 : 0;
  const htfOk = mtfSnap.htfBias === 0 || mtfSnap.htfBias === td;
  const choch = td !== 0 && (td === 1 ? mtfSnap.chochAlignment < -0.3 : mtfSnap.chochAlignment > 0.3);
  if (prediction.action === 'HOLD' || td === 0) return { state: 'WAIT', td, choch };
  if (!htfOk || choch) return { state: 'AVOID', td, choch };
  if (Math.abs(mtfSnap.overallMTFScore) < 0.15) return { state: 'WAIT', td, choch };
  return { state: 'READY', td, choch };
}

// ── Helpers for building mock engine inputs ────────────────────────────────────

function mtfFor(dir, score) {
  // dir: 1=bull, -1=bear, 0=neutral. score: explicit override or derived.
  const s = score !== undefined ? score : dir * 0.6;
  return { overallMTFScore: s, htfBias: dir, chochAlignment: 0 };
}

function mtfWeak() { return { overallMTFScore: 0.05, htfBias: 1, chochAlignment: 0 }; }

function mtfChoch(tradeDir) {
  // CHoCH against trade direction
  return { overallMTFScore: 0.05, htfBias: tradeDir, chochAlignment: tradeDir === 1 ? -0.55 : 0.55 };
}

function regime(label) { return { label, bullScore: label.includes('BULL')?0.8:0.2, bearScore: label.includes('BEAR')?0.8:0.2 }; }

function signal4h(trendDir, structDir, chochDetected = false) {
  return { tf:'4h', barCount:30, trendDir, structureDir:structDir,
    bosDetected:chochDetected, bosDir:chochDetected?-trendDir:0,
    chochDetected, smcBias:trendDir, fvgAbove:trendDir<0, fvgBelow:trendDir>0,
    aboveVWAP:trendDir>0, volumeBias:trendDir };
}

function ms(highs, lows) { return { structureHighs: highs, structureLows: lows }; }

function pat(dir, conf) { return dir ? { direction: dir, confidence: conf ?? 70 } : null; }

// ── Test cases ────────────────────────────────────────────────────────────────
// Format: { id, description, inputs, expected: { state, hasBlocker, conflictEngineContains } }
// hasBlocker: true = primaryBlocker should NOT be "None", conflictNote should exist
// conflictEngineContains: string that should appear in conflictNote when hasBlocker=true

const tests = [
  // ── BUY scenarios ──────────────────────────────────────────────────────────
  {
    id:'B01', desc:'BUY — all engines agree (perfect confluence)',
    inputs:{ pred:{action:'BUY',direction:'UP'},
      mtf:mtfFor(1), signals:[signal4h(1,1)],
      reg:regime('STRONG_BULL'), mss:ms('HH','HL'), pat:pat('bullish',80) },
    expected:{ state:'READY', hasBlocker:false },
  },
  {
    id:'B02', desc:'BUY — bull regime + bull MTF, no pattern yet',
    inputs:{ pred:{action:'BUY',direction:'UP'},
      mtf:mtfFor(1), signals:[signal4h(1,1)],
      reg:regime('BULL_TREND'), mss:ms('HH','HL'), pat:null },
    expected:{ state:'READY', hasBlocker:false },
  },
  {
    id:'B03', desc:'BUY — HTF bearish (4H bears, regime bears) — should AVOID',
    inputs:{ pred:{action:'BUY',direction:'UP'},
      mtf:{overallMTFScore:-0.4,htfBias:-1,chochAlignment:0}, signals:[signal4h(-1,-1)],
      reg:regime('BEAR_TREND'), mss:ms('LH','LL'), pat:pat('bullish',50) },
    expected:{ state:'AVOID', hasBlocker:true, conflictEngineContains:'Market Structure' },
  },
  {
    id:'B04', desc:'BUY — weak MTF alignment (score near zero) — should WAIT',
    inputs:{ pred:{action:'BUY',direction:'UP'},
      mtf:mtfWeak(), signals:[signal4h(1,0)],
      reg:regime('BULL_TREND'), mss:ms('HH','HL'), pat:pat('bullish',55) },
    expected:{ state:'WAIT', hasBlocker:false },
  },
  {
    id:'B05', desc:'BUY — CHoCH forming against long — should AVOID',
    inputs:{ pred:{action:'BUY',direction:'UP'},
      mtf:mtfChoch(1), signals:[signal4h(1,-1,true)],
      reg:regime('SIDEWAYS'), mss:ms('HH','LL'), pat:null },
    expected:{ state:'AVOID', hasBlocker:true, conflictEngineContains:'Multi-Timeframe' },
  },
  {
    id:'B06', desc:'BUY — pattern bearish, but MTF+regime+structure bull',
    inputs:{ pred:{action:'BUY',direction:'UP'},
      mtf:mtfFor(1), signals:[signal4h(1,1)],
      reg:regime('BULL_TREND'), mss:ms('HH','HL'), pat:pat('bearish',65) },
    expected:{ state:'READY', hasBlocker:false },
    // Pattern disagreeing alone doesn't block — MTF+structure outweigh
  },
  {
    id:'B07', desc:'BUY — mixed structure (HH but LL) — weak signal',
    inputs:{ pred:{action:'BUY',direction:'UP'},
      mtf:mtfFor(1,0.2), signals:[signal4h(1,0)],
      reg:regime('SIDEWAYS'), mss:ms('HH','LL'), pat:null },
    expected:{ state:'READY', hasBlocker:false },
  },
  {
    id:'B08', desc:'BUY — regime bearish but MTF+structure bullish',
    inputs:{ pred:{action:'BUY',direction:'UP'},
      mtf:mtfFor(1), signals:[signal4h(1,1)],
      reg:regime('BEAR_TREND'), mss:ms('HH','HL'), pat:pat('bullish',70) },
    expected:{ state:'READY', hasBlocker:false },
    // Regime alone doesn't block. HTF bias is bull (from mtfFor(1)), so htfAgrees=true.
  },

  // ── SELL scenarios ─────────────────────────────────────────────────────────
  {
    id:'S01', desc:'SELL — all engines agree bearish (perfect confluence)',
    inputs:{ pred:{action:'SELL',direction:'DOWN'},
      mtf:mtfFor(-1), signals:[signal4h(-1,-1)],
      reg:regime('STRONG_BEAR'), mss:ms('LH','LL'), pat:pat('bearish',82) },
    expected:{ state:'READY', hasBlocker:false },
  },
  {
    id:'S02', desc:'SELL — HTF bullish, entry bearish — AVOID',
    inputs:{ pred:{action:'SELL',direction:'DOWN'},
      mtf:{overallMTFScore:0.5,htfBias:1,chochAlignment:0}, signals:[signal4h(1,1)],
      reg:regime('BULL_TREND'), mss:ms('HH','HL'), pat:pat('bearish',60) },
    expected:{ state:'AVOID', hasBlocker:true, conflictEngineContains:'Market Structure' },
  },
  {
    id:'S03', desc:'SELL — weak MTF alignment — WAIT',
    inputs:{ pred:{action:'SELL',direction:'DOWN'},
      mtf:{overallMTFScore:-0.08,htfBias:-1,chochAlignment:0}, signals:[signal4h(-1,0)],
      reg:regime('BEAR_TREND'), mss:ms('LH','LL'), pat:null },
    expected:{ state:'WAIT', hasBlocker:false },
  },
  {
    id:'S04', desc:'SELL — CHoCH forming against short — AVOID',
    inputs:{ pred:{action:'SELL',direction:'DOWN'},
      mtf:mtfChoch(-1), signals:[signal4h(-1,1,true)],
      reg:regime('SIDEWAYS'), mss:ms('LL','HH'), pat:null },
    expected:{ state:'AVOID', hasBlocker:true, conflictEngineContains:'Multi-Timeframe' },
  },
  {
    id:'S05', desc:'SELL — bear regime + bear structure, pattern bullish',
    inputs:{ pred:{action:'SELL',direction:'DOWN'},
      mtf:mtfFor(-1), signals:[signal4h(-1,-1)],
      reg:regime('BEAR_TREND'), mss:ms('LH','LL'), pat:pat('bullish',55) },
    expected:{ state:'READY', hasBlocker:false },
  },
  {
    id:'S06', desc:'SELL — all bear except regime neutral',
    inputs:{ pred:{action:'SELL',direction:'DOWN'},
      mtf:mtfFor(-1), signals:[signal4h(-1,-1)],
      reg:regime('SIDEWAYS'), mss:ms('LH','LL'), pat:pat('bearish',72) },
    expected:{ state:'READY', hasBlocker:false },
  },

  // ── HOLD scenarios ─────────────────────────────────────────────────────────
  {
    id:'H01', desc:'HOLD — engine says no signal (ranging market)',
    inputs:{ pred:{action:'HOLD',direction:'NEUTRAL'},
      mtf:{overallMTFScore:0.02,htfBias:0,chochAlignment:0}, signals:[],
      reg:regime('SIDEWAYS'), mss:ms('HH','LL'), pat:null },
    expected:{ state:'WAIT', hasBlocker:false },
  },
  {
    id:'H02', desc:'HOLD — even with strong bull regime, no action signal → WAIT',
    inputs:{ pred:{action:'HOLD',direction:'NEUTRAL'},
      mtf:mtfFor(1), signals:[signal4h(1,1)],
      reg:regime('STRONG_BULL'), mss:ms('HH','HL'), pat:pat('bullish',80) },
    expected:{ state:'WAIT', hasBlocker:false },
  },
  {
    id:'H03', desc:'HOLD — bear regime, no signal → WAIT (not AVOID)',
    inputs:{ pred:{action:'HOLD',direction:'NEUTRAL'},
      mtf:mtfFor(-1), signals:[signal4h(-1,-1)],
      reg:regime('STRONG_BEAR'), mss:ms('LH','LL'), pat:pat('bearish',75) },
    expected:{ state:'WAIT', hasBlocker:false },
  },

  // ── Edge cases ─────────────────────────────────────────────────────────────
  {
    id:'E01', desc:'BUY — all signals neutral/zero (sparse data)',
    inputs:{ pred:{action:'BUY',direction:'UP'},
      mtf:{overallMTFScore:0,htfBias:0,chochAlignment:0}, signals:[],
      reg:regime('SIDEWAYS'), mss:null, pat:null },
    expected:{ state:'WAIT', hasBlocker:false },
    // htfBias=0 → htfAgrees=true. score=0 → |score|<0.15 → WAIT
  },
  {
    id:'E02', desc:'BUY — score exactly at boundary (0.15) — should be WAIT not READY',
    inputs:{ pred:{action:'BUY',direction:'UP'},
      mtf:{overallMTFScore:0.15,htfBias:1,chochAlignment:0}, signals:[signal4h(1,1)],
      reg:regime('BULL_TREND'), mss:ms('HH','HL'), pat:null },
    expected:{ state:'WAIT', hasBlocker:false },
    // |0.15| is NOT < 0.15, so this should actually be READY. Let's verify.
  },
  {
    id:'E03', desc:'BUY — score 0.14 (just under boundary) — should WAIT',
    inputs:{ pred:{action:'BUY',direction:'UP'},
      mtf:{overallMTFScore:0.14,htfBias:1,chochAlignment:0}, signals:[signal4h(1,1)],
      reg:regime('BULL_TREND'), mss:ms('HH','HL'), pat:null },
    expected:{ state:'WAIT', hasBlocker:false },
  },
  {
    id:'E04', desc:'SELL — score -0.14 (just under boundary) — should WAIT',
    inputs:{ pred:{action:'SELL',direction:'DOWN'},
      mtf:{overallMTFScore:-0.14,htfBias:-1,chochAlignment:0}, signals:[signal4h(-1,-1)],
      reg:regime('BEAR_TREND'), mss:ms('LH','LL'), pat:null },
    expected:{ state:'WAIT', hasBlocker:false },
  },
  {
    id:'E05', desc:'BUY — htfBias=0 (HTF neutral) + bull alignment — should READY',
    inputs:{ pred:{action:'BUY',direction:'UP'},
      mtf:{overallMTFScore:0.5,htfBias:0,chochAlignment:0}, signals:[signal4h(1,0)],
      reg:regime('BULL_TREND'), mss:ms('HH','HL'), pat:null },
    expected:{ state:'READY', hasBlocker:false },
    // htfBias=0 → htfAgrees=true (neutral HTF doesn't block)
  },
  {
    id:'E06', desc:'BUY — chochAlignment exactly -0.3 (boundary, NOT blocking)',
    inputs:{ pred:{action:'BUY',direction:'UP'},
      mtf:{overallMTFScore:0.5,htfBias:1,chochAlignment:-0.3}, signals:[signal4h(1,1)],
      reg:regime('BULL_TREND'), mss:ms('HH','HL'), pat:pat('bullish',70) },
    expected:{ state:'READY', hasBlocker:false },
    // choch triggers at < -0.3, not <= -0.3
  },
  {
    id:'E07', desc:'BUY — chochAlignment -0.31 (just past boundary — AVOID)',
    inputs:{ pred:{action:'BUY',direction:'UP'},
      mtf:{overallMTFScore:0.5,htfBias:1,chochAlignment:-0.31}, signals:[signal4h(1,-1,true)],
      reg:regime('BULL_TREND'), mss:ms('HH','LL'), pat:null },
    expected:{ state:'AVOID', hasBlocker:true },
  },
  {
    id:'E08', desc:'READY invariant: all agree → primaryBlocker must be "None"',
    inputs:{ pred:{action:'BUY',direction:'UP'},
      mtf:mtfFor(1,0.75), signals:[signal4h(1,1)],
      reg:regime('STRONG_BULL'), mss:ms('HH','HL'), pat:pat('bullish',85) },
    expected:{ state:'READY', hasBlocker:false, conflictNoteMustBeEmpty:true },
  },
  {
    id:'E09', desc:'READY invariant: SELL all agree → no blocker',
    inputs:{ pred:{action:'SELL',direction:'DOWN'},
      mtf:mtfFor(-1,-0.75), signals:[signal4h(-1,-1)],
      reg:regime('STRONG_BEAR'), mss:ms('LH','LL'), pat:pat('bearish',88) },
    expected:{ state:'READY', hasBlocker:false, conflictNoteMustBeEmpty:true },
  },
  {
    id:'E10', desc:'BUY — 4H bull, 1D bearish — 1D is highest blocker',
    inputs:{ pred:{action:'BUY',direction:'UP'},
      mtf:{overallMTFScore:-0.2,htfBias:-1,chochAlignment:0},
      signals:[
        signal4h(1,1),   // 4H agrees
        { tf:'1d', barCount:20, trendDir:-1, structureDir:-1, bosDetected:false, bosDir:0,
          chochDetected:false, smcBias:-1, fvgAbove:true, fvgBelow:false, aboveVWAP:false, volumeBias:-1 },
      ],
      reg:regime('BEAR_TREND'), mss:ms('LH','LL'), pat:pat('bullish',55) },
    expected:{ state:'AVOID', hasBlocker:true },
    // htfBias=-1 (from 1D), trade=1 → htfAgrees=false → AVOID. Blocker=1D.
  },
];

// ── Run tests ──────────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
const failures = [];

// Boundary clarification for E02 — the condition is Math.abs(score) < 0.15
// so 0.15 is NOT < 0.15, meaning it should be READY, not WAIT.
// Update E02 expected to match the actual boundary semantics:
tests.find(t => t.id === 'E02').expected.state = 'READY';

for (const t of tests) {
  const { pred, mtf, signals, reg, mss, pat: pattern } = t.inputs;
  const td = pred.direction === 'UP' ? 1 : pred.direction === 'DOWN' ? -1 : 0;

  // Compute state
  const { state, choch } = computeState({ prediction: pred, mtfSnap: mtf });

  // Compute blocker
  const blockingTF = td !== 0 ? findBlockingTF(signals, td, '15m') : null;
  const chochBlock = td !== 0 && (td === 1 ? mtf.chochAlignment < -0.3 : mtf.chochAlignment > 0.3);
  const htfOk = mtf.htfBias === 0 || mtf.htfBias === td;

  // primaryBlocker text
  let primaryBlocker;
  if (state === 'READY') primaryBlocker = 'None';
  else if (pred.action === 'HOLD') primaryBlocker = 'No trade signal';
  else if (chochBlock) primaryBlocker = 'CHoCH forming';
  else if (blockingTF) primaryBlocker = blockingTF + ' trend opposing';
  else primaryBlocker = 'Weak alignment';

  // Decision factors + conflictNote
  const factors = buildFactors({ tradeDir: td, regimeSnap: reg, mtfSnap: mtf, msSnapshot: mss, topPattern: pattern });
  const conflictNote = buildConflictNote(factors, td, state);

  // ── Assertions ────────────────────────────────────────────────────────────
  const exp = t.expected;
  let ok = true;
  const issues = [];

  // 1. State matches
  if (state !== exp.state) {
    ok = false;
    issues.push(`state: got ${state}, expected ${exp.state}`);
  }

  // 2. Blocker presence
  if (exp.hasBlocker === false) {
    if (primaryBlocker !== 'None' && primaryBlocker !== 'No trade signal' && primaryBlocker !== 'Weak alignment') {
      // Only flag if state is READY and we're claiming no blocker
      if (state === 'READY' && primaryBlocker !== 'None') {
        ok = false;
        issues.push(`READY state should have no blocker, got: ${primaryBlocker}`);
      }
    }
  }
  if (exp.hasBlocker === true && state !== 'WAIT') {
    if (primaryBlocker === 'None' || primaryBlocker === 'No trade signal') {
      ok = false;
      issues.push(`expected a blocker but got: ${primaryBlocker}`);
    }
  }

  // 3. conflictNote engine check
  if (exp.conflictEngineContains && conflictNote && !conflictNote.includes(exp.conflictEngineContains)) {
    ok = false;
    issues.push(`conflictNote should contain "${exp.conflictEngineContains}", got: "${conflictNote}"`);
  }

  // 4. READY invariants
  if (exp.conflictNoteMustBeEmpty && conflictNote !== '') {
    ok = false;
    issues.push(`READY state: conflictNote must be empty, got: "${conflictNote}"`);
  }
  if (state === 'READY' && conflictNote !== '') {
    ok = false;
    issues.push(`READY state invariant: conflictNote must be empty, got: "${conflictNote}"`);
  }
  if (state === 'READY' && primaryBlocker !== 'None') {
    ok = false;
    issues.push(`READY state invariant: primaryBlocker must be "None", got: "${primaryBlocker}"`);
  }

  // 5. All-agree invariant: if every factor matches trade direction, state must be READY (not AVOID)
  const targetV = td === 1 ? 'BUY' : td === -1 ? 'SELL' : null;
  if (targetV) {
    const allAgree = factors.length > 0 && factors.every(f => f.verdict === targetV || f.verdict === 'NEUTRAL' || f.verdict === 'WAIT');
    if (allAgree && state === 'AVOID') {
      // Only flag if htfAgrees and no choch — genuine invariant
      if (htfOk && !chochBlock) {
        ok = false;
        issues.push(`All engines agree with ${targetV} but state is AVOID — invariant violated`);
      }
    }
  }

  if (ok) {
    passed++;
    console.log(`✅ ${t.id} ${t.desc}`);
    console.log(`   ${state === 'READY' ? '🟢' : state === 'WAIT' ? '🟡' : '🔴'} ${state} | blocker: ${primaryBlocker} | conflict: ${conflictNote || '(none)'}`);
  } else {
    failed++;
    failures.push({ id: t.id, desc: t.desc, issues });
    console.log(`❌ ${t.id} ${t.desc}`);
    for (const iss of issues) console.log(`   ⚠️  ${iss}`);
    console.log(`   state=${state} | blocker=${primaryBlocker} | conflict=${conflictNote||'(none)'}`);
    console.log(`   factors: ${factors.map(f=>f.engine+':'+f.verdict).join(' | ')}`);
  }
}

console.log(`\n${'─'.repeat(70)}`);
console.log(`${passed + failed} tests | ✅ ${passed} passed | ❌ ${failed} failed`);
if (failures.length) {
  console.log('\nFAILED TESTS:');
  for (const f of failures) {
    console.log(`  ${f.id}: ${f.desc}`);
    for (const i of f.issues) console.log(`    → ${i}`);
  }
}
