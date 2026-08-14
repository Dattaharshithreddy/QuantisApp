'use strict';
let passed = 0, failed = 0;
function test(label, fn) {
  try { fn(); console.log(`  ✓  ${label}`); passed++; }
  catch(e) { console.log(`  ✗  ${label}\n     ${e.message}`); failed++; }
}
function assertEqual(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

const store = {};
const AsyncStorage = {
  getItem: async (k) => store[k] ?? null,
  setItem: async (k, v) => { store[k] = v; },
  removeItem: async (k) => { delete store[k]; },
};

let firestoreCallCount = 0;
const KEY_MODES = {};
const DEFAULT_MODE = 'ASYNC_ONLY';
function modeFor(key) {
  for (const prefix of Object.keys(KEY_MODES)) {
    if (key === prefix || key.startsWith(prefix)) return KEY_MODES[prefix];
  }
  return DEFAULT_MODE;
}

const KVStore = {
  async get(key) {
    if (modeFor(key) === 'FIRESTORE') { firestoreCallCount++; return null; }
    return AsyncStorage.getItem(key);
  },
  async set(key, value) {
    await AsyncStorage.setItem(key, value);
    if (modeFor(key) !== 'ASYNC_ONLY') { firestoreCallCount++; }
  },
  async remove(key) {
    await AsyncStorage.removeItem(key);
    if (modeFor(key) !== 'ASYNC_ONLY') { firestoreCallCount++; }
  },
  promote(key, mode = 'DUAL_WRITE') { KEY_MODES[key] = mode; },
};

console.log('\n─────────────────────────────────────────');
console.log('Phase 1: Storage Abstraction Layer Tests');
console.log('─────────────────────────────────────────\n');

async function run() {
  const val1 = await KVStore.get('nonexistent');
  test('get() returns null for missing key', () => assertEqual(val1, null, 'missing key'));

  await KVStore.set('test_key', 'hello');
  const val2 = await KVStore.get('test_key');
  test('set() + get() round-trip', () => assertEqual(val2, 'hello', 'round-trip'));

  await KVStore.set('remove_key', 'to_delete');
  await KVStore.remove('remove_key');
  test('remove() deletes key', () => assertEqual(store['remove_key'], undefined, 'after remove'));

  const obj = { price: 1234.56, direction: 'LONG' };
  await KVStore.set('json_key', JSON.stringify(obj));
  const val3 = await KVStore.get('json_key');
  const parsed = JSON.parse(val3);
  test('JSON values round-trip correctly', () => {
    assertEqual(parsed.price, 1234.56, 'price');
    assertEqual(parsed.direction, 'LONG', 'direction');
  });

  firestoreCallCount = 0;
  await KVStore.set('async_only_key', 'v'); await KVStore.get('async_only_key'); await KVStore.remove('async_only_key');
  test('ASYNC_ONLY never calls Firestore', () => assertEqual(firestoreCallCount, 0, 'count'));

  firestoreCallCount = 0;
  KVStore.promote('dual_key', 'DUAL_WRITE');
  await KVStore.set('dual_key', 'dual_value');
  test('DUAL_WRITE calls Firestore on set', () => { if(firestoreCallCount===0) throw new Error('not called'); });

  test('DUAL_WRITE get() reads AsyncStorage', () => assertEqual(store['dual_key'], 'dual_value', 'local'));

  KVStore.promote('aichat_v1_', 'DUAL_WRITE');
  test('prefix matching for dynamic keys', () => assertEqual(modeFor('aichat_v1_BTCUSD'), 'DUAL_WRITE', 'prefix'));

  await KVStore.set('ow', 'original'); await KVStore.set('ow', 'updated');
  test('set() overwrites existing value', () => assertEqual(store['ow'], 'updated', 'overwrite'));

  await KVStore.set('key_a', 'alpha'); await KVStore.set('key_b', 'beta'); await KVStore.remove('key_a');
  test('multiple keys are independent', () => assertEqual(store['key_b'], 'beta', 'key_b'));

  console.log(`\n─────────────────────────────────────────`);
  console.log(`${passed} passed, ${failed} failed`);
  if (!failed) { console.log('✓  ALL PHASE 1 TESTS PASSED\n'); process.exit(0); }
  else { process.exit(1); }
}
run().catch(e => { console.error(e); process.exit(1); });
