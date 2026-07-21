// ─────────────────────────────────────────────────────────────────────────────
// ANGEL ONE TRADING API  (v1.0.0)
//
// Wraps Angel One SmartAPI order placement, modification, cancellation, and
// status polling. All calls require an active AOSession (jwtToken).
//
// CRITICAL INVARIANTS:
//   • This file only places/cancels/modifies orders. It never handles money.
//   • Every order is logged to logger.ts before being sent.
//   • All errors are thrown — callers decide how to handle/display them.
//   • Never called directly by UI — always goes through liveOrderExecution.ts.
// ─────────────────────────────────────────────────────────────────────────────

import type { AOSession } from './angelOne';
import { withRetry } from '../utils/retry';
import { logger } from '../utils/logger';

const AO_BASE = 'https://apiconnect.angelbroking.com';

function headers(session: AOSession) {
  return {
    'Content-Type':     'application/json',
    Accept:             'application/json',
    'X-UserType':       'USER',
    'X-SourceID':       'WEB',
    'X-ClientLocalIP':  '192.168.1.1',
    'X-ClientPublicIP': '1.1.1.1',
    'X-MACAddress':     'fe80::1',
    'X-PrivateKey':     session.apiKey,
    Authorization:      `Bearer ${session.jwtToken}`,
  };
}

// ── Order types ───────────────────────────────────────────────────────────────

export type AOOrderVariety  = 'NORMAL' | 'STOPLOSS' | 'AMO';
export type AOOrderType     = 'MARKET' | 'LIMIT' | 'STOPLOSS_LIMIT' | 'STOPLOSS_MARKET';
export type AOProductType   = 'DELIVERY' | 'INTRADAY' | 'MARGIN' | 'CARRYFORWARD';
export type AODuration      = 'DAY' | 'IOC';
export type AOExchange      = 'NSE' | 'BSE' | 'NFO' | 'BFO' | 'MCX';
export type AOTransactionType = 'BUY' | 'SELL';

export type AOPlaceOrderParams = {
  variety:         AOOrderVariety;
  tradingsymbol:   string;          // e.g. 'RELIANCE-EQ'
  symboltoken:     string;          // Angel One token e.g. '2885'
  transactiontype: AOTransactionType;
  exchange:        AOExchange;
  ordertype:       AOOrderType;
  producttype:     AOProductType;
  duration:        AODuration;
  price:           number;          // 0 for MARKET orders
  squareoff:       number;          // 0 if no bracket
  stoploss:        number;          // 0 if no stoploss at order level
  quantity:        number;
  triggerprice?:   number;          // for STOPLOSS orders
  // Idempotency: Angel One accepts uniqueorderid on submission.
  // If the same uniqueorderid is submitted twice, the second is rejected
  // with a duplicate-order error rather than placing a second order.
  uniqueorderid?:  string;
};

export type AOOrderResponse = {
  orderId:   string;
  uniqueOrderId: string;
  script:    string;
};

export type AOOrderStatus = {
  orderId:         string;
  status:          'open' | 'complete' | 'rejected' | 'cancelled' | 'pending' | 'trigger pending';
  filledQty:       number;
  unfilledQty:     number;
  avgFillPrice:    number;
  orderType:       string;
  transactionType: string;
  rejectedReason?: string;
};

export type AOPosition = {
  tradingsymbol:   string;
  symboltoken:     string;
  exchange:        string;
  producttype:     string;
  netqty:          number;   // positive = long, negative = short
  buyavgprice:     number;
  sellavgprice:    number;
  ltp:             number;
  pnl:             number;
  realisedpnl:     number;
  unrealisedpnl:   number;
};

// ── Place order ───────────────────────────────────────────────────────────────

export async function aoPlaceOrder(
  params: AOPlaceOrderParams,
  session: AOSession,
): Promise<AOOrderResponse> {
  logger.info('aoTrading', `Placing ${params.transactiontype} ${params.quantity}×${params.tradingsymbol} ${params.ordertype} @ ${params.price}`);

  const r = await withRetry(() => fetch(`${AO_BASE}/rest/secure/angelbroking/order/v1/placeOrder`, {
    method: 'POST',
    headers: headers(session),
    body: JSON.stringify(params),
  }), 2);

  if (!r.ok) throw new Error(`Angel One placeOrder HTTP ${r.status}`);
  const json = await r.json();
  if (!json.status || !json.data?.orderid) {
    throw new Error(json.message || json.errorcode || 'Angel One order placement failed');
  }

  logger.info('aoTrading', `Order placed: ${json.data.orderid}`);
  return {
    orderId:       json.data.orderid,
    uniqueOrderId: json.data.uniqueorderid ?? json.data.orderid,
    script:        params.tradingsymbol,
  };
}

// ── Modify order ──────────────────────────────────────────────────────────────

export async function aoModifyOrder(
  orderId: string,
  changes: { price?: number; quantity?: number; triggerprice?: number; ordertype?: AOOrderType },
  variety: AOOrderVariety,
  session: AOSession,
): Promise<string> {
  logger.info('aoTrading', `Modifying order ${orderId}: ${JSON.stringify(changes)}`);

  const r = await withRetry(() => fetch(`${AO_BASE}/rest/secure/angelbroking/order/v1/modifyOrder`, {
    method: 'POST',
    headers: headers(session),
    body: JSON.stringify({ variety, orderid: orderId, ...changes }),
  }), 2);

  if (!r.ok) throw new Error(`Angel One modifyOrder HTTP ${r.status}`);
  const json = await r.json();
  if (!json.status) throw new Error(json.message || 'Angel One order modification failed');
  return json.data?.orderid ?? orderId;
}

// ── Cancel order ──────────────────────────────────────────────────────────────

export async function aoCancelOrder(
  orderId: string,
  variety: AOOrderVariety,
  session: AOSession,
): Promise<void> {
  logger.info('aoTrading', `Cancelling order ${orderId}`);

  const r = await withRetry(() => fetch(`${AO_BASE}/rest/secure/angelbroking/order/v1/cancelOrder`, {
    method: 'POST',
    headers: headers(session),
    body: JSON.stringify({ variety, orderid: orderId }),
  }), 2);

  if (!r.ok) throw new Error(`Angel One cancelOrder HTTP ${r.status}`);
  const json = await r.json();
  if (!json.status) throw new Error(json.message || 'Angel One order cancellation failed');
  logger.info('aoTrading', `Order ${orderId} cancelled`);
}

// ── Order status ──────────────────────────────────────────────────────────────

export async function aoGetOrderStatus(
  orderId: string,
  session: AOSession,
): Promise<AOOrderStatus | null> {
  const r = await fetch(`${AO_BASE}/rest/secure/angelbroking/order/v1/getOrderBook`, {
    method: 'GET',
    headers: headers(session),
  });

  if (!r.ok) throw new Error(`Angel One getOrderBook HTTP ${r.status}`);
  const json = await r.json();
  if (!json.status || !json.data) return null;

  const order = json.data.find((o: any) => o.orderid === orderId || o.uniqueorderid === orderId);
  if (!order) return null;

  return {
    orderId:         order.orderid,
    status:          order.status?.toLowerCase() ?? 'pending',
    filledQty:       Number(order.filledshares ?? 0),
    unfilledQty:     Number(order.unfilledshares ?? 0),
    avgFillPrice:    Number(order.averageprice ?? 0),
    orderType:       order.ordertype,
    transactionType: order.transactiontype,
    rejectedReason:  order.text,
  };
}

// ── Poll until filled or terminal ─────────────────────────────────────────────

export async function aoWaitForFill(
  orderId: string,
  session: AOSession,
  timeoutMs = 30_000,
  pollIntervalMs = 2_000,
): Promise<AOOrderStatus> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await aoGetOrderStatus(orderId, session);
    if (!status) throw new Error(`Order ${orderId} not found in order book`);
    if (status.status === 'complete') return status;
    if (status.status === 'rejected') throw new Error(`Order rejected: ${status.rejectedReason ?? 'unknown reason'}`);
    if (status.status === 'cancelled') throw new Error(`Order ${orderId} was cancelled`);
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }
  throw new Error(`Order ${orderId} did not fill within ${timeoutMs / 1000}s`);
}

// ── Live positions ────────────────────────────────────────────────────────────

export async function aoGetPositions(session: AOSession): Promise<AOPosition[]> {
  const r = await fetch(`${AO_BASE}/rest/secure/angelbroking/order/v1/getPosition`, {
    method: 'GET',
    headers: headers(session),
  });

  if (!r.ok) throw new Error(`Angel One getPosition HTTP ${r.status}`);
  const json = await r.json();
  if (!json.status || !json.data) return [];

  return json.data.map((p: any): AOPosition => ({
    tradingsymbol:  p.tradingsymbol,
    symboltoken:    p.symboltoken,
    exchange:       p.exchange,
    producttype:    p.producttype,
    netqty:         Number(p.netqty ?? 0),
    buyavgprice:    Number(p.buyavgprice ?? 0),
    sellavgprice:   Number(p.sellavgprice ?? 0),
    ltp:            Number(p.ltp ?? 0),
    pnl:            Number(p.pnl ?? 0),
    realisedpnl:    Number(p.realisedpnl ?? 0),
    unrealisedpnl:  Number(p.unrealisedpnl ?? 0),
  }));
}
