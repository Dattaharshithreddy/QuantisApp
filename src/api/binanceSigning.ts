// ─────────────────────────────────────────────────────────────────────────────
// BINANCE SIGNING UTILITY  (v1.0.0)
//
// Pure-TypeScript HMAC-SHA256 for signing Binance REST API requests.
// React Native does not have native crypto.subtle on all platforms, so this
// uses the same compact bit-manipulation implementation as binanceTrading.ts
// (previously inlined there, now shared between spot and futures).
//
// Used by: binanceTrading.ts (spot), binanceFuturesApi.ts (USDM perps)
// ─────────────────────────────────────────────────────────────────────────────

function leftRotate32(n: number, bits: number): number {
  return ((n << bits) | (n >>> (32 - bits))) >>> 0;
}

function sha256(msg: Uint8Array): Uint8Array {
  const K = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
  ];
  let h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const l = msg.length;
  const bitLen = l * 8;
  const padLen = l % 64 < 56 ? 56 - (l % 64) : 120 - (l % 64);
  const buf = new Uint8Array(l + padLen + 8);
  buf.set(msg);
  buf[l] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(buf.length - 4, bitLen >>> 0, false);
  dv.setUint32(buf.length - 8, Math.floor(bitLen / 0x100000000), false);
  for (let i = 0; i < buf.length; i += 64) {
    const W = new Array(64).fill(0);
    for (let j = 0; j < 16; j++) W[j] = dv.getUint32(i + j * 4, false);
    for (let j = 16; j < 64; j++) {
      const s0 = (leftRotate32(W[j-15],25))^(leftRotate32(W[j-15],14))^(W[j-15]>>>3);
      const s1 = (leftRotate32(W[j-2],15))^(leftRotate32(W[j-2],13))^(W[j-2]>>>10);
      W[j] = (W[j-16] + s0 + W[j-7] + s1) >>> 0;
    }
    let [a,b,c,d,e,f,g,hh] = h;
    for (let j = 0; j < 64; j++) {
      const S1   = (leftRotate32(e,26))^(leftRotate32(e,21))^(leftRotate32(e,7));
      const ch   = (e & f) ^ (~e & g);
      const temp1= (hh + S1 + ch + K[j] + W[j]) >>> 0;
      const S0   = (leftRotate32(a,30))^(leftRotate32(a,19))^(leftRotate32(a,10));
      const maj  = (a & b) ^ (a & c) ^ (b & c);
      const temp2= (S0 + maj) >>> 0;
      hh=g; g=f; f=e; e=(d+temp1)>>>0; d=c; c=b; b=a; a=(temp1+temp2)>>>0;
    }
    h = h.map((v,i)=>(v + [a,b,c,d,e,f,g,hh][i])>>>0);
  }
  const out = new Uint8Array(32);
  const dvOut = new DataView(out.buffer);
  h.forEach((v,i) => dvOut.setUint32(i*4, v, false));
  return out;
}

const enc = (s: string) => new TextEncoder().encode(s);
const toHex = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2,'0')).join('');

function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  const bLen = 64;
  let k = key.length > bLen ? sha256(key) : key;
  const kPad = new Uint8Array(bLen);
  kPad.set(k);
  const iKey = kPad.map(b => b ^ 0x36);
  const oKey = kPad.map(b => b ^ 0x5c);
  const inner = new Uint8Array(bLen + data.length);
  inner.set(iKey); inner.set(data, bLen);
  const outer = new Uint8Array(bLen + 32);
  outer.set(oKey); outer.set(sha256(inner), bLen);
  return sha256(outer);
}

/**
 * Signs a Binance query string with HMAC-SHA256.
 * Used identically for both spot (api.binance.com) and futures (fapi.binance.com).
 */
export function binanceSign(queryString: string, secret: string): string {
  return toHex(hmacSha256(enc(secret), enc(queryString)));
}
