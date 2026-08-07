// ─────────────────────────────────────────────────────────────────────────────
// COINDCX SPOT EXECUTOR  (v1.0.0)
//
// Handles CoinDCX spot USDT pair orders.
// Exchange: api.coindcx.com (spot, NOT futures — no leverage product on CoinDCX spot).
//
// CoinDCX signing (different from Binance):
//   - Binance: signs the QUERY STRING with HMAC-SHA256
//   - CoinDCX: signs the JSON REQUEST BODY with HMAC-SHA256
//   Both use the same pure-JS HMAC implementation from binanceSigning.ts.
//
// Fee structure: 0.1% maker/taker (standard CoinDCX spot tier)
//
// API reference: https://docs.coindcx.com/
//   Order create:  POST /exchange/v1/orders/create
//   Order cancel:  DELETE /exchange/v1/orders/cancel
//   Cancel all:    DELETE /exchange/v1/orders/cancel_all
//   Balances:      GET /exchange/v1/users/balances
//   Open orders:   GET /exchange/v1/orders/active_orders
// ─────────────────────────────────────────────────────────────────────────────

import { logger } from '../logger';
import type { ExecutionProvider, ExecutionOrderRequest, ExecutionFill, ExecutionContext } from './ExecutionProvider';

// ── CoinDCX HMAC signing ──────────────────────────────────────────────────────
// Reuses the same pure-JS sha256/hmacSha256 logic from binanceSigning.ts.
// CoinDCX signs the raw JSON body string, not a query string.
// The signature is placed in the 'X-AUTH-SIGNATURE' header.
import { binanceSign } from '../../api/binanceSigning';

// AbortSignal.timeout() polyfill for Hermes on older Android
function timeoutSignal(ms: number): AbortSignal {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms);
  return ctrl.signal;
}

/**
 * Sign a CoinDCX request body.
 * CoinDCX HMAC-SHA256: sign = hmac_sha256(apiSecret, JSON.stringify(body))
 * Reuses binanceSign since the HMAC algorithm is identical.
 */
function cdxSign(body: object, apiSecret: string): string {
  return binanceSign(JSON.stringify(body), apiSecret);
}

// ── CoinDCX REST helpers ──────────────────────────────────────────────────────

const CDX_BASE = 'https://api.coindcx.com';

async function cdxRequest<T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body: object,
  apiKey: string,
  apiSecret: string,
): Promise<T> {
  const signature = cdxSign(body, apiSecret);
  const r = await fetch(`${CDX_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-AUTH-APIKEY':    apiKey,
      'X-AUTH-SIGNATURE': signature,
    },
    body: JSON.stringify(body),
    signal: timeoutSignal(15_000),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => r.status.toString());
    throw new Error(`CoinDCX ${method} ${path} → HTTP ${r.status}: ${text}`);
  }
  return r.json() as Promise<T>;
}

// ── Order type mapping ────────────────────────────────────────────────────────
// CoinDCX order_type: 'market_order' | 'limit_order'
// CoinDCX side:       'buy' | 'sell'

function cdxOrderType(t: 'MARKET' | 'LIMIT'): 'market_order' | 'limit_order' {
  return t === 'MARKET' ? 'market_order' : 'limit_order';
}

function cdxSide(direction: 'LONG' | 'SHORT'): 'buy' | 'sell' {
  return direction === 'LONG' ? 'buy' : 'sell';
}

// ── Fee estimator ─────────────────────────────────────────────────────────────
function estimateCdxFees(notionalValue: number): number {
  return notionalValue * 0.001; // 0.1% standard maker/taker
}

// ── Response types ────────────────────────────────────────────────────────────

type CdxOrderResponse = {
  orders: Array<{
    id:              string;
    client_order_id?: string;
    market:          string;
    side:            string;
    order_type:      string;
    status:          string;          // 'open' | 'filled' | 'cancelled' | 'partially_filled'
    fee_amount:      string | number;
    fee:             string | number;
    avg_price?:      string | number;
    price_per_unit?: string | number;
    total_quantity:  string | number;
    remaining_quantity?: string | number;
  }>;
};

type CdxBalanceEntry = {
  currency:          string;    // e.g. 'BTC', 'USDT'
  balance:           string;
  locked_balance:    string;
};

// ── Executor ──────────────────────────────────────────────────────────────────

export const CoinDCXExecutor: ExecutionProvider = {
  capabilities: {
    execution: { live: true, paper: true },
    orders:    { market: true, limit: true, stopLoss: false, bracket: false },
    position:  { overnight: true, lotBased: false, partialClose: true, maxLotsPerOrder: 0 },
    risk:      { marginRequired: false, leverage: false, preFlight: false },
    display:   { currency: '$', exchangeLabel: 'CoinDCX Spot', priceDecimals: 4, qtyLabel: 'units' },
  },

  async execute(req: ExecutionOrderRequest, ctx: ExecutionContext): Promise<ExecutionFill> {
    const { cdxApiKey, cdxApiSecret } = ctx;
    if (!cdxApiKey || !cdxApiSecret) {
      throw new Error('CoinDCX API keys not configured. Go to More → Broker Connection.');
    }

    // CoinDCX uses the market symbol (e.g. 'BTCUSDT') not the pair string ('B-BTC_USDT')
    // req.symbol is variant.symbol = 'BTCUSDT' — matches CoinDCX market directly
    const body: Record<string, any> = {
      market:         req.symbol,
      side:           cdxSide(req.direction),
      order_type:     cdxOrderType(req.orderType),
      total_quantity: req.qty,
      timestamp:      Date.now(),
    };
    if (req.orderType === 'LIMIT' && req.limitPrice) {
      body.price_per_unit = req.limitPrice;
    }
    if (req.clientOrderId) {
      body.client_order_id = req.clientOrderId;
    }

    logger.info('CoinDCXExecutor', `Placing ${body.side} ${req.qty}×${req.symbol} CoinDCX Spot`);

    const resp = await cdxRequest<CdxOrderResponse>(
      'POST', '/exchange/v1/orders/create', body, cdxApiKey, cdxApiSecret
    );

    if (!resp.orders?.length) {
      throw new Error('CoinDCX order create returned no order objects');
    }
    const order = resp.orders[0];

    // Wait for fill if market order — CoinDCX fills market orders near-instantly
    // Limit orders return 'open' status; for now we return with estimate
    const isFilled = order.status === 'filled';
    const avgPrice = isFilled
      ? Number(order.avg_price ?? order.price_per_unit ?? req.limitPrice ?? 0)
      : Number(order.price_per_unit ?? req.limitPrice ?? 0);
    const filledQty = isFilled
      ? Number(order.total_quantity) - Number(order.remaining_quantity ?? 0)
      : Number(order.total_quantity);
    const fees = Number(order.fee_amount ?? order.fee ?? 0) ||
                 estimateCdxFees(avgPrice * filledQty);

    return {
      orderId:     order.id,
      broker:      'COINDCX' as any,
      symbol:      req.symbol,
      direction:   req.direction,
      filledQty:   filledQty || req.qty,
      filledPrice: avgPrice || (req.limitPrice ?? 0),
      filledAt:    Date.now(),
      fees,
    };
  },

  async cancel(orderId: string, symbol: string, ctx: ExecutionContext): Promise<void> {
    const { cdxApiKey, cdxApiSecret } = ctx;
    if (!cdxApiKey || !cdxApiSecret) {
      throw new Error('CoinDCX API keys not configured.');
    }
    const body = { id: orderId, timestamp: Date.now() };
    logger.info('CoinDCXExecutor', `Cancelling order ${orderId} for ${symbol}`);
    await cdxRequest('DELETE', '/exchange/v1/orders/cancel', body, cdxApiKey, cdxApiSecret);
  },

  async cancelAll(symbol: string, ctx: ExecutionContext): Promise<{ cancelled: number; errors: string[] }> {
    const { cdxApiKey, cdxApiSecret } = ctx;
    if (!cdxApiKey || !cdxApiSecret) {
      return { cancelled: 0, errors: ['CoinDCX API keys not configured.'] };
    }
    try {
      const body = { market: symbol, timestamp: Date.now() };
      logger.info('CoinDCXExecutor', `Cancel all open orders for ${symbol}`);
      await cdxRequest('DELETE', '/exchange/v1/orders/cancel_all', body, cdxApiKey, cdxApiSecret);
      return { cancelled: 1, errors: [] };
    } catch (e: any) {
      logger.warn('CoinDCXExecutor', `cancelAll error: ${e.message}`);
      return { cancelled: 0, errors: [e.message] };
    }
  },
};

// ── Balance helper (not part of ExecutionProvider, used by OrderConfirmationScreen) ──

/**
 * Fetch CoinDCX spot balances.
 * Returns a map from currency → { available, locked }.
 * Used by OrderConfirmationScreen to show available balance before placing order.
 */
export async function fetchCdxBalances(
  apiKey: string,
  apiSecret: string,
): Promise<Record<string, { available: number; locked: number }>> {
  const body = { timestamp: Date.now() };
  const entries = await cdxRequest<CdxBalanceEntry[]>(
    'GET', '/exchange/v1/users/balances', body, apiKey, apiSecret
  );
  const result: Record<string, { available: number; locked: number }> = {};
  for (const e of entries) {
    const avail = Number(e.balance) - Number(e.locked_balance);
    result[e.currency.toUpperCase()] = {
      available: Math.max(0, avail),
      locked:    Number(e.locked_balance),
    };
  }
  return result;
}

/**
 * Test CoinDCX credentials by fetching balances.
 * Returns null on success, error message string on failure.
 */
export async function testCdxCredentials(
  apiKey: string,
  apiSecret: string,
): Promise<string | null> {
  try {
    await fetchCdxBalances(apiKey, apiSecret);
    return null;
  } catch (e: any) {
    return e.message ?? 'CoinDCX connection test failed';
  }
}
