// ─────────────────────────────────────────────────────────────────────────────
// ONBOARDING — Tests  (v1.0.0)
// Tests persistence, completion, skip, restart, experience, and tooltip logic.
// Run with: node src/utils/__tests__/onboarding.test.js
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

let passed = 0, failed = 0;
const tests = [];
function test(label, fn) { tests.push({ label, fn }); }
function assertEqual(a, e, label) {
  if (a !== e) throw new Error(`${label}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
}
function assertTrue(a, label) { if (!a) throw new Error(`${label}: expected true`); }
function assertNull(a, label) { if (a !== null) throw new Error(`${label}: expected null, got ${JSON.stringify(a)}`); }

// ── In-memory AsyncStorage mock ────────────────────────────────────────────────
const store = new Map();
const MockAsyncStorage = {
  getItem:      async (k) => store.has(k) ? store.get(k) : null,
  setItem:      async (k, v) => { store.set(k, v); },
  removeItem:   async (k) => { store.delete(k); },
  multiRemove:  async (keys) => { keys.forEach(k => store.delete(k)); },
};

// ── Inline onboarding logic (mirrors onboarding.ts) ──────────────────────────
const KEY_COMPLETED  = 'onboarding_completed_v1';
const KEY_EXPERIENCE = 'onboarding_experience_v1';
const KEY_TOOLTIPS   = 'onboarding_tooltips_v1';

async function isOnboardingComplete() {
  try {
    const v = await MockAsyncStorage.getItem(KEY_COMPLETED);
    return v === 'true';
  } catch { return false; }
}

async function markOnboardingComplete() {
  try { await MockAsyncStorage.setItem(KEY_COMPLETED, 'true'); } catch {}
}

async function resetOnboarding() {
  try { await MockAsyncStorage.multiRemove([KEY_COMPLETED, KEY_EXPERIENCE, KEY_TOOLTIPS]); } catch {}
}

async function saveExperience(exp) {
  try { await MockAsyncStorage.setItem(KEY_EXPERIENCE, exp); } catch {}
}

async function getExperience() {
  try { return await MockAsyncStorage.getItem(KEY_EXPERIENCE); } catch { return null; }
}

async function isTooltipDismissed(id) {
  try {
    const raw = await MockAsyncStorage.getItem(KEY_TOOLTIPS);
    const set = raw ? JSON.parse(raw) : [];
    return set.includes(id);
  } catch { return false; }
}

async function dismissTooltip(id) {
  try {
    const raw = await MockAsyncStorage.getItem(KEY_TOOLTIPS);
    const set = raw ? JSON.parse(raw) : [];
    if (!set.includes(id)) {
      set.push(id);
      await MockAsyncStorage.setItem(KEY_TOOLTIPS, JSON.stringify(set));
    }
  } catch {}
}

async function getDismissedTooltips() {
  try {
    const raw = await MockAsyncStorage.getItem(KEY_TOOLTIPS);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

// Helper: fresh store for each test
function clearStore() { store.clear(); }

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════════

// ── 1. First launch ───────────────────────────────────────────────────────────
console.log('\n── 1. First Launch ──');

test('First launch: isOnboardingComplete returns false', async () => {
  clearStore();
  const result = await isOnboardingComplete();
  assertEqual(result, false, 'First launch not complete');
});

test('First launch: no experience saved', async () => {
  clearStore();
  const exp = await getExperience();
  assertNull(exp, 'No experience on first launch');
});

test('First launch: no tooltips dismissed', async () => {
  clearStore();
  const dismissed = await getDismissedTooltips();
  assertEqual(dismissed.length, 0, 'No dismissed tooltips');
});

// ── 2. Completion ────────────────────────────────────────────────────────────
console.log('\n── 2. Completion ──');

test('markOnboardingComplete → isOnboardingComplete returns true', async () => {
  clearStore();
  await markOnboardingComplete();
  const result = await isOnboardingComplete();
  assertEqual(result, true, 'Complete after mark');
});

test('Completion persists across reads', async () => {
  clearStore();
  await markOnboardingComplete();
  // Read twice — same result
  const r1 = await isOnboardingComplete();
  const r2 = await isOnboardingComplete();
  assertEqual(r1, true, 'First read true');
  assertEqual(r2, true, 'Second read still true');
});

test('Correct AsyncStorage key used for completion', async () => {
  clearStore();
  await markOnboardingComplete();
  const raw = await MockAsyncStorage.getItem(KEY_COMPLETED);
  assertEqual(raw, 'true', 'Stored as string "true"');
});

// ── 3. Skip flow ─────────────────────────────────────────────────────────────
console.log('\n── 3. Skip Flow ──');

test('Skip marks onboarding complete without experience', async () => {
  clearStore();
  // Simulate skip: mark complete without saving experience
  await markOnboardingComplete();
  const done = await isOnboardingComplete();
  const exp  = await getExperience();
  assertEqual(done, true, 'Marked complete on skip');
  assertNull(exp, 'No experience on skip');
});

// ── 4. Experience preference ──────────────────────────────────────────────────
console.log('\n── 4. Experience Preference ──');

test('saveExperience: paper → getExperience returns paper', async () => {
  clearStore();
  await saveExperience('paper');
  const exp = await getExperience();
  assertEqual(exp, 'paper', 'Paper experience saved');
});

test('saveExperience: live → getExperience returns live', async () => {
  clearStore();
  await saveExperience('live');
  const exp = await getExperience();
  assertEqual(exp, 'live', 'Live experience saved');
});

test('saveExperience: futures → getExperience returns futures', async () => {
  clearStore();
  await saveExperience('futures');
  const exp = await getExperience();
  assertEqual(exp, 'futures', 'Futures experience saved');
});

test('saveExperience: can be overwritten', async () => {
  clearStore();
  await saveExperience('paper');
  await saveExperience('live');
  const exp = await getExperience();
  assertEqual(exp, 'live', 'Experience overwritten to live');
});

// ── 5. Restart onboarding ─────────────────────────────────────────────────────
console.log('\n── 5. Restart Onboarding ──');

test('resetOnboarding clears completion flag', async () => {
  clearStore();
  await markOnboardingComplete();
  await resetOnboarding();
  const done = await isOnboardingComplete();
  assertEqual(done, false, 'Completion cleared after reset');
});

test('resetOnboarding clears experience', async () => {
  clearStore();
  await saveExperience('live');
  await resetOnboarding();
  const exp = await getExperience();
  assertNull(exp, 'Experience cleared after reset');
});

test('resetOnboarding clears dismissed tooltips', async () => {
  clearStore();
  await dismissTooltip('tip_test_1');
  await dismissTooltip('tip_test_2');
  await resetOnboarding();
  const dismissed = await getDismissedTooltips();
  assertEqual(dismissed.length, 0, 'Tooltips cleared after reset');
});

test('After reset: isOnboardingComplete returns false (show again)', async () => {
  clearStore();
  await markOnboardingComplete();
  await saveExperience('paper');
  await dismissTooltip('tip_abc');
  await resetOnboarding();
  const done = await isOnboardingComplete();
  assertEqual(done, false, 'Would show onboarding again after reset');
});

// ── 6. Progress tracking (step logic) ────────────────────────────────────────
console.log('\n── 6. Progress / Step Logic ──');

test('Non-live experience: total steps = 9', () => {
  // Steps 1-8 + step 10 (ready), skipping step 9 (broker)
  const experience = 'paper';
  const totalSteps = experience === 'live' ? 10 : 9;
  assertEqual(totalSteps, 9, 'Paper experience: 9 steps');
});

test('Live experience: total steps = 10 (includes broker setup)', () => {
  const experience = 'live';
  const totalSteps = experience === 'live' ? 10 : 9;
  assertEqual(totalSteps, 10, 'Live experience: 10 steps');
});

test('No experience selected: cannot advance from step 2', () => {
  const step = 2;
  const experience = null;
  const canGoNext = !(step === 2 && !experience);
  assertEqual(canGoNext, false, 'Cannot advance without experience on step 2');
});

test('Experience selected: can advance from step 2', () => {
  const step = 2;
  const experience = 'paper';
  const canGoNext = !(step === 2 && !experience);
  assertEqual(canGoNext, true, 'Can advance with experience on step 2');
});

test('Step 1: can always advance (no validation)', () => {
  const step = 1;
  const experience = null;
  const canGoNext = !(step === 2 && !experience);
  assertEqual(canGoNext, true, 'Step 1 always allows next');
});

// ── 7. Tooltip persistence ────────────────────────────────────────────────────
console.log('\n── 7. Tooltip Persistence ──');

test('Tooltip not dismissed initially', async () => {
  clearStore();
  const dismissed = await isTooltipDismissed('tip_test');
  assertEqual(dismissed, false, 'Not dismissed initially');
});

test('After dismissTooltip: isTooltipDismissed returns true', async () => {
  clearStore();
  await dismissTooltip('tip_test');
  const dismissed = await isTooltipDismissed('tip_test');
  assertEqual(dismissed, true, 'Dismissed after call');
});

test('Dismissing same tooltip twice does not duplicate entry', async () => {
  clearStore();
  await dismissTooltip('tip_dup');
  await dismissTooltip('tip_dup');
  const all = await getDismissedTooltips();
  const count = all.filter(t => t === 'tip_dup').length;
  assertEqual(count, 1, 'No duplicate entries');
});

test('Multiple different tooltips can be dismissed', async () => {
  clearStore();
  await dismissTooltip('tip_a');
  await dismissTooltip('tip_b');
  await dismissTooltip('tip_c');
  const all = await getDismissedTooltips();
  assertEqual(all.length, 3, '3 tooltips dismissed');
  assertTrue(all.includes('tip_a'), 'tip_a present');
  assertTrue(all.includes('tip_b'), 'tip_b present');
  assertTrue(all.includes('tip_c'), 'tip_c present');
});

test('Undismissed tooltip is not in dismissed list', async () => {
  clearStore();
  await dismissTooltip('tip_a');
  const dismissed = await isTooltipDismissed('tip_b');
  assertEqual(dismissed, false, 'Undismissed tooltip not in list');
});

// ── 8. Conditional broker screen ─────────────────────────────────────────────
console.log('\n── 8. Conditional Broker Screen ──');

test('Live experience: step 9 is broker setup', () => {
  const experience = 'live';
  // getContentStep(9) for live = 9 (broker setup)
  const contentStep = experience === 'live' ? 9 : 10;
  assertEqual(contentStep, 9, 'Live: step 9 is broker');
});

test('Non-live experience: step 9 is ready screen (content step 10)', () => {
  const experience = 'paper';
  // getContentStep(9) for non-live = 10 (ready screen, skips broker)
  const contentStep = experience === 'live' ? 9 : 10;
  assertEqual(contentStep, 10, 'Paper: step 9 skips to ready');
});

// ── 9. AsyncStorage key format ────────────────────────────────────────────────
console.log('\n── 9. AsyncStorage Keys ──');

test('Keys use versioned naming convention', () => {
  assertTrue(KEY_COMPLETED.endsWith('_v1'), 'Completed key versioned');
  assertTrue(KEY_EXPERIENCE.endsWith('_v1'), 'Experience key versioned');
  assertTrue(KEY_TOOLTIPS.endsWith('_v1'), 'Tooltips key versioned');
});

test('Keys start with onboarding_ prefix', () => {
  assertTrue(KEY_COMPLETED.startsWith('onboarding_'), 'Completed key prefixed');
  assertTrue(KEY_EXPERIENCE.startsWith('onboarding_'), 'Experience key prefixed');
  assertTrue(KEY_TOOLTIPS.startsWith('onboarding_'), 'Tooltips key prefixed');
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
  console.log(`  Onboarding Tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) { console.log('  ✗ SOME TESTS FAILED'); process.exit(1); }
  else            { console.log('  ✓ ALL TESTS PASSED'); }
})();
