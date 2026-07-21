// ─────────────────────────────────────────────────────────────────────────────
// BINANCE FUTURES API  (v1.2.0)
//
// Wraps Binance USDM Perpetual Futures REST API (fapi.binance.com).
// USDM = USD-Margined = USDT collateral, settled in USDT.
//
// CRITICAL DIFFERENCES from Binance Spot (api.binance.com):
//   • Base URL: https://fapi.binance.com  (NOT api.binance.com)
//   • Leverage must be set before placing: POST /fapi/v1/leverage
//   • Margin type: ISOLATED (each position has its own margin wallet)
//   • Position mode: ONE_WAY (default — we do not support HEDGE mode)
//   • Close position: same order endpoint with reduceOnly=true
//   • Account balance: /fapi/v2/account → availableBalance per asset
//   • Price precision: varies per symbol — use exchangeInfo before ordering
//
// WITHDRAWAL PERMISSIONS:
//   The Binance Futures API key must have "Futures trading" permission.
//   WITHDRAWAL PERMISSION MUST NEVER BE ENABLED.
//   Restrict the key to your IP address in Binance API management.
//
// ORDER FLOW:
//   1. bnFuturesSetLeverage()  — set leverage for symbol (once per session)
//   2. bnFuturesSetMarginType() — ensure ISOLATED (once per session)
//   3. bnFuturesPlaceOrder()   — place the actual order
//   4. bnFuturesWaitForFill()  — poll until FILLED status
//   5. bnFuturesClosePosition() — when user closes, sends reduceOnly order
// ─────────────────────────────────────────────────────────────────────────────

import { binanceSign } from './binanceSigning';
import { logger }     from '../utils/logger';
import { withRetry }  from '../utils/retry';

const FAPI_BASE = 'https://fapi.binance.com';
const FILL_POLL_INTERVAL_MS = 500;
const FILL_POLL_TIMEOUT_MS  = 30_000;  // 30s — futures fills are usually fast

function headers(apiKey: string) {
  return { 'X-MBX-APIKEY': apiKey, 'Content-Type': 'application/x-www-form-urlencoded' };
}

async function fapiRequest<T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  params: Record<string, string | number | boolean>,
  apiKey: string,
  secret: string,
): Promise<T> {
  const ts = Date.now();
  const allParams = { ...params, timestamp: ts };
  const qs = Object.entries(allParams).map(([k, v]) => `${k}=${v}`).join('&');
  const signature = binanceSign(qs, secret);

  const url = method === 'GET' || method === 'DELETE'
    ? `${FAPI_BASE}${path}?${qs}&signature=${signature}`
    : `${FAPI_BASE}${path}`;
  const body = method === 'POST'
    ? `${qs}&signature=${signature}`
    : undefined;

  const r = await fetch(url, { method, headers: headers(apiKey), body });
  const json = await r.json();

  if (!r.ok) {
    const code = json.code ?? r.status;
    const msg  = json.msg  ?? r.statusText;
    throw new Error(`Binance Futures API ${code}: ${msg}`);
  }
  return json as T;
}

// ── Account & balance ─────────────────────────────────────────────────────────

export type BnFuturesBalance = {
  asset:            string;   // 'USDT'
  walletBalance:    number;
  unrealizedProfit: number;
  marginBalance:    number;
  availableBalance: number;   // what can be used for new positions
  crossUnPnl:       number;
};

/**
 * Fetches USDT futures account balances.
 * Returns null on failure — callers handle gracefully.
 */
export async function bnFuturesGetBalance(
  apiKey: string, secret: string,
): Promise<BnFuturesBalance | null> {
  try {
    const data = await fapiRequest<any[]>('GET', '/fapi/v2/balance', {}, apiKey, secret);
    const usdt = data.find((b: any) => b.asset === 'USDT');
    if (!usdt) return null;
    return {
      asset:            'USDT',
      walletBalance:    parseFloat(usdt.balance),
      unrealizedProfit: parseFloat(usdt.crossUnPnl),
      marginBalance:    parseFloat(usdt.balance) + parseFloat(usdt.crossUnPnl),
      availableBalance: parseFloat(usdt.availableBalance),
      crossUnPnl:       parseFloat(usdt.crossUnPnl),
    };
  } catch { return null; }
}

// ── Position risk (open positions) ────────────────────────────────────────────

export type BnPositionRisk = {
  symbol:             string;
  positionSide:       'BOTH' | 'LONG' | 'SHORT';  // BOTH = ONE_WAY mode
  positionAmt:        number;   // positive=long, negative=short, 0=none
  entryPrice:         number;
  markPrice:          number;
  unRealizedProfit:   number;
  liquidationPrice:   number;
  leverage:           number;
  isolatedMargin:     number;
  marginType:         'isolated' | 'cross';
};

export async function bnFuturesGetPositions(
  apiKey: string, secret: string, symbol?: string,
): Promise<BnPositionRisk[]> {
  const params: Record<string, string> = {};
  if (symbol) params.symbol = symbol;
  const data = await fapiRequest<any[]>('GET', '/fapi/v2/positionRisk', params, apiKey, secret);
  return data
    .filter((p: any) => parseFloat(p.positionAmt) !== 0)
    .map((p: any) => ({
      symbol:           p.symbol,
      positionSide:     p.positionSide,
      positionAmt:      parseFloat(p.positionAmt),
      entryPrice:       parseFloat(p.entryPrice),
      markPrice:        parseFloat(p.markPrice),
      unRealizedProfit: parseFloat(p.unRealizedProfit),
      liquidationPrice: parseFloat(p.liquidationPrice),
      leverage:         parseInt(p.leverage, 10),
      isolatedMargin:   parseFloat(p.isolatedMargin),
      marginType:       p.marginType,
    }));
}

// ── Pre-trade setup ───────────────────────────────────────────────────────────

/**
 * Sets leverage for a symbol. Must be called before placing the first order.
 * Safe to call repeatedly — returns ok if already set to the requested value.
 */
export async function bnFuturesSetLeverage(
  symbol: string, leverage: number, apiKey: string, secret: string,
): Promise<void> {
  logger.info('bnFuturesApi', `Setting leverage: ${symbol} × ${leverage}`);
  await fapiRequest('POST', '/fapi/v1/leverage', { symbol, leverage }, apiKey, secret);
}

/**
 * Sets margin type to ISOLATED for a symbol.
 * Binance returns error code -4046 if already ISOLATED — we swallow that.
 */
export async function bnFuturesSetMarginType(
  symbol: string, apiKey: string, secret: string,
): Promise<void> {
  try {
    logger.info('bnFuturesApi', `Setting margin type: ${symbol} → ISOLATED`);
    await fapiRequest('POST', '/fapi/v1/marginType', { symbol, marginType: 'ISOLATED' }, apiKey, secret);
  } catch (e: any) {
    // -4046 = "No need to change margin type" — already isolated, which is fine
    if (!e.message.includes('-4046')) throw e;
  }
}

// ── Order placement ───────────────────────────────────────────────────────────

export type BnFuturesOrderParams = {
  symbol:           string;
  side:             'BUY' | 'SELL';
  type:             'MARKET' | 'LIMIT';
  quantity:         number;
  price?:           number;        // required for LIMIT
  timeInForce?:     'GTC' | 'IOC' | 'FOK' | 'GTX';  // required for LIMIT
  reduceOnly?:      boolean;       // true when closing a position
  newClientOrderId?: string;       // idempotency key
  positionSide?:    'BOTH';        // ONE_WAY mode always uses BOTH
};

export type BnFuturesOrderResponse = {
  orderId:       number;
  symbol:        string;
  status:        'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'REJECTED' | 'EXPIRED';
  avgPrice:      number;
  executedQty:   number;
  cumQuote:      number;   // total USDT value executed
  side:          'BUY' | 'SELL';
  type:          string;
  reduceOnly:    boolean;
};

export async function bnFuturesPlaceOrder(
  params: BnFuturesOrderParams, apiKey: string, secret: string,
): Promise<BnFuturesOrderResponse> {
  const reqParams: Record<string, string | number | boolean> = {
    symbol:       params.symbol,
    side:         params.side,
    type:         params.type,
    quantity:     params.quantity,
    positionSide: params.positionSide ?? 'BOTH',
  };
  if (params.type === 'LIMIT') {
    reqParams.price       = params.price!;
    reqParams.timeInForce = params.timeInForce ?? 'GTC';
  }
  if (params.reduceOnly)        reqParams.reduceOnly       = true;
  if (params.newClientOrderId)  reqParams.newClientOrderId = params.newClientOrderId;

  logger.info('bnFuturesApi',
    `Placing ${params.side} ${params.quantity} ${params.symbol} ` +
    `${params.type}${params.price ? ' @ $' + params.price : ''} ` +
    `${params.reduceOnly ? '[reduceOnly]' : ''}`
  );

  const r = await withRetry(() =>
    fapiRequest<any>('POST', '/fapi/v1/order', reqParams, apiKey, secret)
  );

  return {
    orderId:     r.orderId,
    symbol:      r.symbol,
    status:      r.status,
    avgPrice:    parseFloat(r.avgPrice ?? '0'),
    executedQty: parseFloat(r.executedQty ?? '0'),
    cumQuote:    parseFloat(r.cumQuote ?? '0'),
    side:        r.side,
    type:        r.type,
    reduceOnly:  r.reduceOnly ?? false,
  };
}

/**
 * Polls for order fill. Futures orders usually fill in <1s for MARKET.
 */
export async function bnFuturesWaitForFill(
  symbol: string, orderId: number, apiKey: string, secret: string,
): Promise<BnFuturesOrderResponse> {
  const deadline = Date.now() + FILL_POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const r = await fapiRequest<any>('GET', '/fapi/v1/order',
      { symbol, orderId }, apiKey, secret);

    if (r.status === 'FILLED') {
      return {
        orderId:     r.orderId,
        symbol:      r.symbol,
        status:      r.status,
        avgPrice:    parseFloat(r.avgPrice),
        executedQty: parseFloat(r.executedQty),
        cumQuote:    parseFloat(r.cumQuote),
        side:        r.side,
        type:        r.type,
        reduceOnly:  r.reduceOnly ?? false,
      };
    }
    if (r.status === 'CANCELED' || r.status === 'REJECTED' || r.status === 'EXPIRED') {
      throw new Error(`Futures order ${orderId} ended with status ${r.status}.`);
    }
    await new Promise(resolve => setTimeout(resolve, FILL_POLL_INTERVAL_MS));
  }
  throw new Error(`Futures order ${orderId} not filled within ${FILL_POLL_TIMEOUT_MS / 1000}s.`);
}

/**
 * Cancels an open futures order.
 */
export async function bnFuturesCancelOrder(
  symbol: string, orderId: number, apiKey: string, secret: string,
): Promise<void> {
  logger.info('bnFuturesApi', `Cancelling futures order ${orderId} for ${symbol}`);
  await fapiRequest('DELETE', '/fapi/v1/order', { symbol, orderId }, apiKey, secret);
}

/**
 * Closes a futures position by placing a reduceOnly order in the opposite direction.
 * qty should match the open position quantity exactly.
 */
export async function bnFuturesClosePosition(
  symbol: string, qty: number, direction: 'LONG' | 'SHORT',
  apiKey: string, secret: string,
): Promise<BnFuturesOrderResponse> {
  const closeSide: 'BUY' | 'SELL' = direction === 'LONG' ? 'SELL' : 'BUY';
  logger.info('bnFuturesApi', `Closing ${direction} ${qty} ${symbol} with ${closeSide} reduceOnly`);
  return bnFuturesPlaceOrder({
    symbol, side: closeSide, type: 'MARKET', quantity: qty, reduceOnly: true,
  }, apiKey, secret);
}

// ── Market data ───────────────────────────────────────────────────────────────

export type BnFuturesTicker = {
  symbol:        string;
  price:         number;
  priceChange:   number;
  priceChangePct: number;
  volume:        number;
  quoteVolume:   number;
};

export async function bnFuturesGetTicker(
  symbol: string,
): Promise<BnFuturesTicker> {
  const r = await fetch(`${FAPI_BASE}/fapi/v1/ticker/24hr?symbol=${symbol}`);
  if (!r.ok) throw new Error(`Binance Futures ticker HTTP ${r.status}`);
  const d = await r.json();
  return {
    symbol:         d.symbol,
    price:          parseFloat(d.lastPrice),
    priceChange:    parseFloat(d.priceChange),
    priceChangePct: parseFloat(d.priceChangePercent),
    volume:         parseFloat(d.volume),
    quoteVolume:    parseFloat(d.quoteVolume),
  };
}

/**
 * Gets exchange info for a symbol — used for price/quantity precision.
 * Returns null on failure.
 */
export async function bnFuturesGetSymbolInfo(symbol: string): Promise<{
  pricePrecision: number;
  quantityPrecision: number;
  status: 'TRADING' | string;
} | null> {
  try {
    const r = await fetch(`${FAPI_BASE}/fapi/v1/exchangeInfo`);
    if (!r.ok) return null;
    const d   = await r.json();
    const sym = (d.symbols as any[]).find((s: any) => s.symbol === symbol);
    if (!sym) return null;
    return {
      pricePrecision:    sym.pricePrecision,
      quantityPrecision: sym.quantityPrecision,
      status:            sym.status,
    };
  } catch { return null; }
}
