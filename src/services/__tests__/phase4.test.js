'use strict';
let passed = 0, failed = 0;
function test(label, fn) {
  try { fn(); console.log(`  ✓  ${label}`); passed++; }
  catch(e) { console.log(`  ✗  ${label}\n     ${e.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const fs = require('fs');

console.log('\n─────────────────────────────────────────');
console.log('Phase 4: ML Storage Service Tests');
console.log('─────────────────────────────────────────\n');

// Test 1: mlStorage.ts exists
test('mlStorage.ts exists', () => {
  assert(fs.existsSync('/tmp/QuantisRepo/src/services/mlStorage.ts'), 'file missing');
});

// Test 2: exports correct functions
const content = fs.readFileSync('/tmp/QuantisRepo/src/services/mlStorage.ts', 'utf8');
test('exports saveModel', () => assert(content.includes('export async function saveModel'), 'missing'));
test('exports loadModel', () => assert(content.includes('export async function loadModel'), 'missing'));
test('exports deleteModel', () => assert(content.includes('export async function deleteModel'), 'missing'));
test('exports modelExists', () => assert(content.includes('export async function modelExists'), 'missing'));

// Test 3: uses Firebase Storage
test('uses Firebase Storage upload', () => assert(content.includes('uploadString'), 'missing uploadString'));
test('uses Firebase Storage download', () => assert(content.includes('getDownloadURL'), 'missing getDownloadURL'));

// Test 4: L1 cache behaviour
test('saveModel saves to AsyncStorage first', () => {
  assert(content.includes('await AsyncStorage.setItem(key, data)'), 'AsyncStorage save missing');
});
test('loadModel checks AsyncStorage first', () => {
  const localFirst = content.indexOf('AsyncStorage.getItem(key)') < content.indexOf('downloadModelFromCloud');
  assert(localFirst, 'AsyncStorage not checked first');
});

// Test 5: mlSignal.ts uses mlStorage
const mlContent = fs.readFileSync('/tmp/QuantisRepo/src/utils/mlSignal.ts', 'utf8');
test('mlSignal.ts imports mlStorage for loadSavedMLP', () =>
  assert(mlContent.includes("import('../services/mlStorage')"), 'mlStorage not imported dynamically'));
test('mlSignal.ts uploads weights after training', () =>
  assert(mlContent.includes('_saveModel(k, v)'), 'saveModel not called after training'));
test('mlSignal.ts uses mlStorage for model delete', () =>
  assert(mlContent.includes('deleteModel'), 'deleteModel not used'));

// Test 6: Firebase Storage path is per-user
test('storage path scoped per-user (/users/{uid}/models/)', () =>
  assert(content.includes('users/${uid}/models/'), 'user-scoped path missing'));

// Test 7: fire-and-forget for cloud ops
test('cloud upload is fire-and-forget (no await)', () => {
  assert(content.includes('uploadModelToCloud(key, data).catch'), 'should not await cloud upload');
});

// Test 8: AccountScreen shows ML backup
const accountContent = fs.readFileSync('/tmp/QuantisRepo/src/screens/AccountScreen.tsx', 'utf8');
test('AccountScreen lists ML model backup', () =>
  assert(accountContent.includes('ML model weights'), 'ML backup not listed'));

console.log(`\n─────────────────────────────────────────`);
console.log(`${passed} passed, ${failed} failed`);
if (!failed) { console.log('✓  ALL PHASE 4 TESTS PASSED\n'); process.exit(0); }
else { process.exit(1); }
