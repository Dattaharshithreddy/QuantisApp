// ─────────────────────────────────────────────────────────────────────────────
// BINANCE SPOT TRADING API  (v1.0.0)
//
// Wraps Binance Spot REST API for order placement, cancellation, and status.
// Requires API key + secret with Spot trading permission enabled.
// WITHDRAWAL PERMISSION MUST NEVER BE ENABLED on the API key used here.
//
// HMAC-SHA256 signing is required for all trading endpoints.
// React Native does not have native crypto — uses a pure-JS implementation.
// ─────────────────────────────────────────────────────────────────────────────

import { logger } from '../utils/logger';

const BN_BASE = 'https://api.binance.com';

// ── Minimal HMAC-SHA256 in pure TypeScript ────────────────────────────────────
// React Native has no native crypto.subtle in all environments.
// This is a compact, dependency-free HMAC-SHA256 for signing Binance requests.

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
      W[j] = (W[j-16]+s0+W[j-7]+s1) >>> 0;
    }
    let [a,b,c,d,e,f,g,hh] = h;
    for (let j = 0; j < 64; j++) {
      const S1 = (leftRotate32(e,26))^(leftRotate32(e,21))^(leftRotate32(e,7));
      const ch = (e&f)^((~e>>>0)&g);
      const t1 = (hh+S1+ch+K[j]+W[j]) >>> 0;
      const S0 = (leftRotate32(a,30))^(leftRotate32(a,19))^(leftRotate32(a,10));
      const maj = (a&b)^(a&c)^(b&c);
      const t2 = (S0+maj) >>> 0;
      hh=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0;
    }
    h = h.map((v,i) => (v+[a,b,c,d,e,f,g,hh][i])>>>0);
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  h.forEach((v,i) => odv.setUint32(i*4, v, false));
  return out;
}

function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  const BLOCK = 64;
  let k = key.length > BLOCK ? sha256(key) : key;
  const pad = new Uint8Array(BLOCK);
  pad.set(k);
  const ipad = pad.map(b => b ^ 0x36);
  const opad = pad.map(b => b ^ 0x5c);
  const inner = new Uint8Array(ipad.length + data.length);
  inner.set(ipad); inner.set(data, ipad.length);
  const outer = new Uint8Array(opad.length + 32);
  outer.set(opad); outer.set(sha256(inner), opad.length);
  return sha256(outer);
}

function toHex(buf: Uint8Array): string {
  return Array.from(buf).map(b => b.toString(16).padStart(2,'0')).join('');
}

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function sign(queryString: string, secret: string): string {
  return toHex(hmacSha256(enc(secret), enc(queryString)));
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type BinanceSide       = 'BUY' | 'SELL';
export type BinanceOrderType  = 'MARKET' | 'LIMIT' | 'STOP_LOSS_LIMIT';
export type BinanceTimeInForce= 'GTC' | 'IOC' | 'FOK';

export type BinancePlaceOrderParams = {
  symbol:           string;           // e.g. 'BTCUSDT'
  side:             BinanceSide;
  type:             BinanceOrderType;
  quantity:         number;
  price?:           number;           // required for LIMIT, STOP_LOSS_LIMIT
  stopPrice?:       number;           // required for STOP_LOSS_LIMIT
  timeInForce?:     BinanceTimeInForce; // required for LIMIT
  newClientOrderId?: string;          // idempotency key — if set, Binance rejects
                                      // duplicate submissions with the same ID
};

export type BinanceOrderResponse = {
  orderId:          number;
  clientOrderId:    string;
  symbol:           string;
  status:           string;
  executedQty:      number;
  cummulativeQuoteQty: number;
  fills?:           { price: string; qty: string; commission: string }[];
};

export type BinanceOrderStatus = {
  orderId:       number;
  symbol:        string;
  status:        'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'REJECTED' | 'EXPIRED';
  executedQty:   number;
  avgFillPrice:  number;
  side:          BinanceSide;
  type:          string;
};

// ── Signed request helper ─────────────────────────────────────────────────────

async function signedRequest(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  params: Record<string, string | number>,
  apiKey: string,
  secret: string,
): Promise<any> {
  const ts = Date.now();
  const allParams = { ...params, timestamp: ts };
  const qs = Object.entries(allParams).map(([k,v]) => `${k}=${v}`).join('&');
  const signature = sign(qs, secret);
  const url = `${BN_BASE}${path}?${qs}&signature=${signature}`;

  const r = await fetch(url, {
    method,
    headers: {
      'X-MBX-APIKEY': apiKey,
      'Content-Type': 'application/json'}});

  const json = await r.json();
  if (!r.ok) throw new Error(`Binance ${method} ${path} ${r.status}: ${json.msg ?? JSON.stringify(json)}`);
  return json;
}

// ── Place order ───────────────────────────────────────────────────────────────

export async function bnPlaceOrder(
  params: BinancePlaceOrderParams,
  apiKey: string,
  secret: string,
): Promise<BinanceOrderResponse> {
  logger.info('bnTrading', `Placing ${params.side} ${params.quantity}×${params.symbol} ${params.type}`);

  const reqParams: Record<string, string | number> = {
    symbol:   params.symbol,
    side:     params.side,
    type:     params.type,
    quantity: params.quantity};
  if (params.price)             reqParams.price             = params.price.toFixed(8);
  if (params.stopPrice)         reqParams.stopPrice         = params.stopPrice.toFixed(8);
  if (params.timeInForce)       reqParams.timeInForce       = params.timeInForce;
  if (params.newClientOrderId)  reqParams.newClientOrderId  = params.newClientOrderId;

  const json = await signedRequest('POST', '/api/v3/order', reqParams, apiKey, secret);

  logger.info('bnTrading', `Order placed: ${json.orderId} status=${json.status}`);
  return {
    orderId:             json.orderId,
    clientOrderId:       json.clientOrderId,
    symbol:              json.symbol,
    status:              json.status,
    executedQty:         Number(json.executedQty ?? 0),
    cummulativeQuoteQty: Number(json.cummulativeQuoteQty ?? 0),
    fills:               json.fills};
}

// ── Cancel order ──────────────────────────────────────────────────────────────

export async function bnCancelOrder(
  symbol: string,
  orderId: number,
  apiKey: string,
  secret: string,
): Promise<void> {
  logger.info('bnTrading', `Cancelling order ${orderId} on ${symbol}`);
  await signedRequest('DELETE', '/api/v3/order', { symbol, orderId }, apiKey, secret);
  logger.info('bnTrading', `Order ${orderId} cancelled`);
}

// ── Order status ──────────────────────────────────────────────────────────────

export async function bnGetOrderStatus(
  symbol: string,
  orderId: number,
  apiKey: string,
  secret: string,
): Promise<BinanceOrderStatus> {
  const json = await signedRequest('GET', '/api/v3/order', { symbol, orderId }, apiKey, secret);
  return {
    orderId:      json.orderId,
    symbol:       json.symbol,
    status:       json.status,
    executedQty:  Number(json.executedQty ?? 0),
    avgFillPrice: Number(json.price ?? 0),
    side:         json.side,
    type:         json.type};
}

// ── Poll until filled ─────────────────────────────────────────────────────────

export async function bnWaitForFill(
  symbol: string,
  orderId: number,
  apiKey: string,
  secret: string,
  timeoutMs = 30_000,
  pollIntervalMs = 1_500,
): Promise<BinanceOrderStatus> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await bnGetOrderStatus(symbol, orderId, apiKey, secret);
    if (status.status === 'FILLED') return status;
    if (status.status === 'CANCELED' || status.status === 'REJECTED' || status.status === 'EXPIRED') {
      throw new Error(`Order ${orderId} ended with status: ${status.status}`);
    }
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }
  throw new Error(`Order ${orderId} did not fill within ${timeoutMs / 1000}s`);
}

// ── Account positions ─────────────────────────────────────────────────────────

export async function bnGetBalances(apiKey: string, secret: string): Promise<{ asset: string; free: number; locked: number }[]> {
  const json = await signedRequest('GET', '/api/v3/account', {}, apiKey, secret);
  return (json.balances ?? [])
    .filter((b: any) => Number(b.free) > 0 || Number(b.locked) > 0)
    .map((b: any) => ({ asset: b.asset, free: Number(b.free), locked: Number(b.locked) }));
}

// ── Cancel all open orders (kill switch) ──────────────────────────────────────

export async function bnCancelAllOrders(symbol: string, apiKey: string, secret: string): Promise<void> {
  logger.info('bnTrading', `Cancelling all open orders for ${symbol}`);
  await signedRequest('DELETE', '/api/v3/openOrders', { symbol }, apiKey, secret);
}
