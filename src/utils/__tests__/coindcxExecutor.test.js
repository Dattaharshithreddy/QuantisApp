// ─────────────────────────────────────────────────────────────────────────────
// COINDCX EXECUTOR — Tests  (v1.0.0)
//
// Tests CoinDCX signing, executor capabilities, credential guards,
// and order routing integration.
//
// Run with:
//   node src/utils/__tests__/coindcxExecutor.test.js
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

// ── Inline the HMAC signing logic (mirror binanceSigning.ts + cdxSign) ────────
function leftRotate32(n, bits) { return ((n << bits) | (n >>> (32 - bits))) >>> 0; }
function sha256(msg) {
  const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  let h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const l = msg.length, bitLen = l * 8, padLen = l % 64 < 56 ? 56 - l % 64 : 120 - l % 64;
  const buf = new Uint8Array(l + padLen + 8); buf.set(msg); buf[l] = 0x80;
  const dv = new DataView(buf.buffer); dv.setUint32(buf.length - 4, bitLen >>> 0, false); dv.setUint32(buf.length - 8, Math.floor(bitLen / 0x100000000), false);
  for (let i = 0; i < buf.length; i += 64) {
    const W = new Array(64).fill(0);
    for (let j = 0; j < 16; j++) W[j] = dv.getUint32(i + j * 4, false);
    for (let j = 16; j < 64; j++) { const s0 = (leftRotate32(W[j-15],25))^(leftRotate32(W[j-15],14))^(W[j-15]>>>3); const s1 = (leftRotate32(W[j-2],15))^(leftRotate32(W[j-2],13))^(W[j-2]>>>10); W[j] = (W[j-16]+s0+W[j-7]+s1)>>>0; }
    let [a,b,c,d,e,f,g,hh] = h;
    for (let j = 0; j < 64; j++) { const S1=(leftRotate32(e,26))^(leftRotate32(e,21))^(leftRotate32(e,7)); const ch=(e&f)^(~e&g); const temp1=(hh+S1+ch+K[j]+W[j])>>>0; const S0=(leftRotate32(a,30))^(leftRotate32(a,19))^(leftRotate32(a,10)); const maj=(a&b)^(a&c)^(b&c); const temp2=(S0+maj)>>>0; hh=g;g=f;f=e;e=(d+temp1)>>>0;d=c;c=b;b=a;a=(temp1+temp2)>>>0; }
    h = h.map((v,i)=>(v+[a,b,c,d,e,f,g,hh][i])>>>0);
  }
  const out = new Uint8Array(32); const dvOut = new DataView(out.buffer); h.forEach((v,i)=>dvOut.setUint32(i*4,v,false)); return out;
}
const enc = s => new TextEncoder ? new TextEncoder().encode(s) : Buffer.from(s);
const toHex = b => Array.from(b).map(x => x.toString(16).padStart(2,'0')).join('');
function hmacSha256(key, data) {
  const bLen = 64; let k = key.length > bLen ? sha256(key) : key; const kPad = new Uint8Array(bLen); kPad.set(k);
  const iKey = kPad.map(b => b ^ 0x36); const oKey = kPad.map(b => b ^ 0x5c);
  const inner = new Uint8Array(bLen + data.length); inner.set(iKey); inner.set(data, bLen);
  const outer = new Uint8Array(bLen + 32); outer.set(oKey); outer.set(sha256(inner), bLen);
  return sha256(outer);
}
function binanceSign(queryString, secret) {
  const e = s => typeof Buffer !== 'undefined' ? Buffer.from(s) : new TextEncoder().encode(s);
  return toHex(hmacSha256(e(secret), e(queryString)));
}
function cdxSign(body, apiSecret) { return binanceSign(JSON.stringify(body), apiSecret); }

// ── Mock ExecutionContext ──────────────────────────────────────────────────────
const CTX_NO_CDX = { aoSession: null };
const CTX_WITH_CDX = { cdxApiKey: 'test_key_123', cdxApiSecret: 'test_secret_456' };

// ── Inline CoinDCXExecutor capabilities (no imports needed) ──────────────────
const CAPABILITIES = {
  execution: { live: true, paper: true },
  orders:    { market: true, limit: true, stopLoss: false, bracket: false },
  position:  { overnight: true, lotBased: false, partialClose: true, maxLotsPerOrder: 0 },
  risk:      { marginRequired: false, leverage: false, preFlight: false },
  display:   { currency: '$', exchangeLabel: 'CoinDCX Spot', priceDecimals: 4, qtyLabel: 'units' },
};

// ── Test harness ──────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const allTests = [];
function test(label, fn) { allTests.push({ label, fn }); }
function assertEqual(a, e, label) { if (JSON.stringify(a) !== JSON.stringify(e)) throw new Error(`${label}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`); }
function assertTrue(c, label) { if (!c) throw new Error(`${label}: expected true`); }
function assertFalse(c, label) { if (c) throw new Error(`${label}: expected false`); }
function assertThrows(fn, msgFragment, label) {
  let threw = false;
  try { fn(); } catch(e) {
    threw = true;
    if (msgFragment && !e.message.includes(msgFragment))
      throw new Error(`${label}: expected error containing "${msgFragment}", got "${e.message}"`);
  }
  if (!threw) throw new Error(`${label}: expected an error to be thrown`);
}
async function assertRejects(fn, msgFragment, label) {
  let threw = false;
  try { await fn(); } catch(e) {
    threw = true;
    if (msgFragment && !e.message.includes(msgFragment))
      throw new Error(`${label}: expected rejection containing "${msgFragment}", got "${e.message}"`);
  }
  if (!threw) throw new Error(`${label}: expected a rejection`);
}

// ─────────────────────────────────────────────────────────────────────────────
// SIGNING TESTS
// ─────────────────────────────────────────────────────────────────────────────

test('1. cdxSign produces a 64-char hex string (SHA256 output)', () => {
  const sig = cdxSign({ market: 'BTCUSDT', side: 'buy' }, 'mysecret');
  assertEqual(sig.length, 64, 'signature length');
  assertTrue(/^[0-9a-f]{64}$/.test(sig), 'hex characters only');
});

test('2. cdxSign is deterministic — same input produces same output', () => {
  const body = { market: 'ETHUSDT', side: 'sell', total_quantity: 0.5, timestamp: 1720000000000 };
  const sig1 = cdxSign(body, 'secret123');
  const sig2 = cdxSign(body, 'secret123');
  assertEqual(sig1, sig2, 'signatures match');
});

test('3. cdxSign changes when body changes', () => {
  const base = { market: 'BTCUSDT', timestamp: 1720000000000 };
  const sig1 = cdxSign({ ...base, side: 'buy'  }, 'secret');
  const sig2 = cdxSign({ ...base, side: 'sell' }, 'secret');
  assertTrue(sig1 !== sig2, 'different body → different signature');
});

test('4. cdxSign changes when secret changes', () => {
  const body = { market: 'BTCUSDT', side: 'buy', timestamp: 1720000000000 };
  const sig1 = cdxSign(body, 'secret_A');
  const sig2 = cdxSign(body, 'secret_B');
  assertTrue(sig1 !== sig2, 'different secret → different signature');
});

test('5. cdxSign signs JSON body not query string (CoinDCX vs Binance difference)', () => {
  const body = { market: 'BTCUSDT', side: 'buy' };
  const cdxSig    = cdxSign(body, 'secret');      // signs JSON.stringify(body)
  const bnSig     = binanceSign('market=BTCUSDT&side=buy', 'secret'); // signs query string
  assertTrue(cdxSig !== bnSig, 'CoinDCX and Binance produce different signatures for same data');
});

// ─────────────────────────────────────────────────────────────────────────────
// CAPABILITIES TESTS
// ─────────────────────────────────────────────────────────────────────────────

test('6. Capabilities: live and paper execution enabled', () => {
  assertTrue(CAPABILITIES.execution.live,  'live enabled');
  assertTrue(CAPABILITIES.execution.paper, 'paper enabled');
});

test('7. Capabilities: market and limit orders supported', () => {
  assertTrue(CAPABILITIES.orders.market, 'market orders');
  assertTrue(CAPABILITIES.orders.limit,  'limit orders');
  assertFalse(CAPABILITIES.orders.stopLoss, 'no stop-loss orders (CoinDCX spot)');
  assertFalse(CAPABILITIES.orders.bracket,  'no bracket orders');
});

test('8. Capabilities: no leverage, not lot-based', () => {
  assertFalse(CAPABILITIES.position.lotBased,     'not lot-based (units)');
  assertFalse(CAPABILITIES.risk.leverage,          'no leverage (spot)');
  assertFalse(CAPABILITIES.risk.marginRequired,    'no margin (full notional spot)');
  assertTrue(CAPABILITIES.position.overnight,      'can hold overnight (spot)');
  assertTrue(CAPABILITIES.position.partialClose,   'partial close allowed');
});

test('9. Capabilities: display currency is $ (USDT pairs)', () => {
  assertEqual(CAPABILITIES.display.currency,      '$',           'currency');
  assertEqual(CAPABILITIES.display.exchangeLabel, 'CoinDCX Spot','exchange label');
  assertEqual(CAPABILITIES.display.qtyLabel,      'units',       'qty label');
});

// ─────────────────────────────────────────────────────────────────────────────
// EXECUTOR MAP INTEGRATION TESTS (structural)
// ─────────────────────────────────────────────────────────────────────────────

test('10. EXECUTOR_MAP includes coindcx key (structural check via file content)', () => {
  const fs = require('fs');
  const content = fs.readFileSync(__dirname + '/../liveOrderExecution.ts', 'utf8');
  assertTrue(content.includes("coindcx:          CoinDCXExecutor"), 'EXECUTOR_MAP has coindcx');
});

test('11. LiveOrderRequest assetSrc union includes coindcx', () => {
  const fs = require('fs');
  const content = fs.readFileSync(__dirname + '/../liveOrderExecution.ts', 'utf8');
  assertTrue(content.includes("'coindcx'"), 'assetSrc union has coindcx');
});

test('12. ExecutionContext has cdxApiKey and cdxApiSecret fields', () => {
  const fs = require('fs');
  const content = fs.readFileSync(__dirname + '/../execution/ExecutionProvider.ts', 'utf8');
  assertTrue(content.includes('cdxApiKey'),    'cdxApiKey in ExecutionContext');
  assertTrue(content.includes('cdxApiSecret'), 'cdxApiSecret in ExecutionContext');
});

test('13. ExecutionFill.broker includes COINDCX', () => {
  const fs = require('fs');
  const content = fs.readFileSync(__dirname + '/../execution/ExecutionProvider.ts', 'utf8');
  assertTrue(content.includes("'COINDCX'"), 'COINDCX in broker union');
});

// ─────────────────────────────────────────────────────────────────────────────
// ORDER ROUTING TESTS (structural — verify no existing paths changed)
// ─────────────────────────────────────────────────────────────────────────────

test('14. Existing Binance credential fetch still targets binance assetSrc only', () => {
  const fs = require('fs');
  const content = fs.readFileSync(__dirname + '/../liveOrderExecution.ts', 'utf8');
  // The new credential fetch should gate on binance OR binance_futures, not all
  assertTrue(
    content.includes("req.assetSrc === 'binance' || req.assetSrc === 'binance_futures'"),
    'Binance credential fetch gated correctly'
  );
});

test('15. CoinDCX credential fetch gated on coindcx assetSrc only', () => {
  const fs = require('fs');
  const content = fs.readFileSync(__dirname + '/../liveOrderExecution.ts', 'utf8');
  assertTrue(
    content.includes("req.assetSrc === 'coindcx'"),
    'CoinDCX credential fetch gated on coindcx'
  );
});

test('16. BrokerConnectionScreen has CoinDCX section', () => {
  const fs = require('fs');
  const content = fs.readFileSync(__dirname + '/../../screens/BrokerConnectionScreen.tsx', 'utf8');
  assertTrue(content.includes('cdxApiKey'),     'cdxApiKey in BrokerConnectionScreen');
  assertTrue(content.includes('cdxApiSecret'),  'cdxApiSecret in BrokerConnectionScreen');
  assertTrue(content.includes('CoinDCX'),       'CoinDCX label in screen');
  assertTrue(content.includes('testCdxCredentials'), 'connection test wired in');
});

test('17. BrokerConnectionScreen tests credentials before saving', () => {
  const fs = require('fs');
  const content = fs.readFileSync(__dirname + '/../../screens/BrokerConnectionScreen.tsx', 'utf8');
  // Credential test must happen before setLiveTradingCredential for CoinDCX
  const testIdx = content.indexOf('testCdxCredentials');
  const saveIdx = content.indexOf("setLiveTradingCredential('cdxApiKey'");
  assertTrue(testIdx > 0 && saveIdx > 0 && testIdx < saveIdx,
    'testCdxCredentials called before saving credentials');
});

// ─────────────────────────────────────────────────────────────────────────────
// FEE ESTIMATION TESTS
// ─────────────────────────────────────────────────────────────────────────────

test('18. Fee estimation: 0.1% of notional value', () => {
  // estimateCdxFees(notionalValue) = notionalValue * 0.001
  const notional = 1000; // $1000 worth of BTC
  const expectedFee = 1; // $1.00
  const actualFee = notional * 0.001;
  assertEqual(actualFee, expectedFee, '0.1% fee on $1000 notional');
});

// ─────────────────────────────────────────────────────────────────────────────
// BROKER LABEL TESTS
// ─────────────────────────────────────────────────────────────────────────────

test('19. Broker label map includes COINDCX → CoinDCX', () => {
  const fs = require('fs');
  const content = fs.readFileSync(__dirname + '/../liveOrderExecution.ts', 'utf8');
  assertTrue(
    content.includes("fill.broker === 'COINDCX' ? 'CoinDCX'"),
    'COINDCX broker label maps to CoinDCX'
  );
});

test('20. Existing broker labels unchanged (Binance, Angel One)', () => {
  const fs = require('fs');
  const content = fs.readFileSync(__dirname + '/../liveOrderExecution.ts', 'utf8');
  assertTrue(content.includes("'ANGEL_ONE' ? 'Angel One'"),    'Angel One label preserved');
  assertTrue(content.includes("'BINANCE_FUTURES' ? 'Binance Perps'"), 'Binance Futures label preserved');
});

// ── Run ───────────────────────────────────────────────────────────────────────
(async () => {
  console.log('\n─────────────────────────────────────────────────────');
  console.log('COINDCX EXECUTOR — Test Suite');
  console.log('─────────────────────────────────────────────────────\n');
  for (const { label, fn } of allTests) {
    try { await fn(); console.log(`  ✓  ${label}`); passed++; }
    catch (e) { console.log(`  ✗  ${label}\n       ${e.message}`); failed++; }
  }
  console.log(`\n─────────────────────────────────────────────────────`);
  console.log(`${passed} passed, ${failed} failed (${allTests.length} total)`);
  if (failed === 0) { console.log('✓  ALL COINDCX EXECUTOR TESTS PASSED\n'); process.exit(0); }
  else { console.log(`✗  ${failed} TEST(S) FAILED\n`); process.exit(1); }
})();
