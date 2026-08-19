// ─────────────────────────────────────────────────────────────────────────────
// COINDCX FUTURES EXECUTOR  (v1.0.0)
//
// CoinDCX USDT-Margined Perpetual Futures
// Base URL:  https://api.coindcx.com
// Signing:   HMAC-SHA256 of JSON body (same as spot)
//
// Key endpoints:
//   POST /exchange/v1/derivatives/futures/orders/create  — open/close position
//   POST /exchange/v1/derivatives/futures/orders/cancel  — cancel order
//   POST /exchange/v1/derivatives/futures/positions      — get open positions
//   POST /exchange/v1/derivatives/futures/wallet         — get futures wallet
//
// Order body fields:
//   pair           — e.g. 'B-BTC_USDT'
//   side           — 'buy' | 'sell'
//   order_type     — 'market_order' | 'limit_order' | 'stop_market' | 'stop_limit'
//   total_quantity — quantity in base asset (e.g. 0.1 BTC)
//   price          — required for limit orders
//   leverage       — 1–100 depending on pair
//   margin_currency — 'USDT' (default) or 'INR'
//   position_margin_type — 'isolated' | 'cross'
//   timestamp      — epoch ms
// ─────────────────────────────────────────────────────────────────────────────

import { logger } from '../logger';
import type { ExecutionProvider, ExecutionOrderRequest, ExecutionFill, ExecutionContext } from './ExecutionProvider';
import { binanceSign } from '../../api/binanceSigning';

const CDX_BASE = 'https://api.coindcx.com';

// AbortSignal.timeout polyfill for Hermes
function timeoutSignal(ms: number): AbortSignal {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms);
  return ctrl.signal;
}

// Sign request body with HMAC-SHA256 (same as spot)
function cdxSign(body: object, secret: string): string {
  return binanceSign(JSON.stringify(body), secret);
}

async function cdxFuturesRequest<T>(
  method: 'POST',
  path: string,
  body: object,
  apiKey: string,
  apiSecret: string,
): Promise<T> {
  const signature = cdxSign(body, apiSecret);
  const r = await fetch(`${CDX_BASE}${path}`, {
    method,
    headers: {
      'Content-Type':     'application/json',
      'X-AUTH-APIKEY':    apiKey,
      'X-AUTH-SIGNATURE': signature,
    },
    body:   JSON.stringify(body),
    signal: timeoutSignal(15_000),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => r.status.toString());
    throw new Error(`CoinDCX Futures ${path} → HTTP ${r.status}: ${text}`);
  }
  return r.json() as Promise<T>;
}

// ── CoinDCX Futures order side mapping ───────────────────────────────────────
// Opening a LONG  position = 'buy'
// Opening a SHORT position = 'sell'
// Closing a LONG  position = 'sell' with reduce_only=true
// Closing a SHORT position = 'buy'  with reduce_only=true
function cdxFuturesSide(direction: 'LONG' | 'SHORT'): 'buy' | 'sell' {
  return direction === 'LONG' ? 'buy' : 'sell';
}

function cdxFuturesOrderType(t: 'MARKET' | 'LIMIT'): string {
  return t === 'MARKET' ? 'market_order' : 'limit_order';
}

// ── Position type returned by CoinDCX ────────────────────────────────────────
type CdxFuturesPosition = {
  id:              string;
  pair:            string;
  side:            'buy' | 'sell';
  quantity:        number;
  entry_price:     number;
  mark_price:      number;
  unrealised_pnl:  number;
  leverage:        number;
  margin:          number;
  liquidation_price: number;
  status:          string;
};

// ── Executor ─────────────────────────────────────────────────────────────────
export const CoinDCXFuturesExecutor: ExecutionProvider = {
  capabilities: {
    execution: { live: true, paper: true },
    orders:    { market: true, limit: true, stopLoss: true, bracket: false },
    position:  { overnight: true, lotBased: false, partialClose: true, maxLotsPerOrder: 0 },
    risk:      { marginRequired: true, leverage: true, preFlight: false },
    display:   { currency: '$', exchangeLabel: 'CoinDCX Futures', priceDecimals: 2, qtyLabel: 'contracts' },
  },

  async execute(req: ExecutionOrderRequest, ctx: ExecutionContext): Promise<ExecutionFill> {
    const { cdxApiKey, cdxApiSecret } = ctx;
    if (!cdxApiKey || !cdxApiSecret) {
      throw new Error('CoinDCX API keys not configured. Go to More → Broker Connection.');
    }

    // req.symbol = variant.symbol e.g. 'BTCUSDT'
    // CoinDCX futures pair format: 'B-BTC_USDT'
    const pair = symbolToCdxPair(req.symbol);
    const leverage = Math.min(Math.max(1, req.leverage ?? 10), 100);

    const body: Record<string, any> = {
      timestamp:            Date.now(),
      pair,
      side:                 cdxFuturesSide(req.direction),
      order_type:           cdxFuturesOrderType(req.orderType),
      total_quantity:       req.qty,
      leverage,
      margin_currency:      'USDT',
      position_margin_type: 'isolated',
    };

    if (req.orderType === 'LIMIT' && req.limitPrice) {
      body.price = req.limitPrice;
    }
    if (req.stopLoss) {
      body.stop_price = req.stopLoss;
    }

    logger.info('CoinDCXFuturesExecutor',
      `${req.direction} ${req.qty} ${pair} ${leverage}x on CoinDCX Futures`);

    type CdxOrderResp = { orders: Array<{
      id: string; status: string; avg_price?: number;
      price?: number; total_quantity: number;
    }>};

    const resp = await cdxFuturesRequest<CdxOrderResp>(
      'POST', '/exchange/v1/derivatives/futures/orders/create',
      body, cdxApiKey, cdxApiSecret,
    );

    if (!resp.orders?.length) {
      throw new Error('CoinDCX Futures order returned no order objects');
    }
    const order = resp.orders[0];
    const filledPrice = Number(order.avg_price ?? order.price ?? req.limitPrice ?? 0);
    const fees = filledPrice * req.qty * 0.0005; // 0.05% taker fee

    return {
      orderId:     order.id,
      broker:      'COINDCX' as any,
      symbol:      req.symbol,
      direction:   req.direction,
      filledQty:   Number(order.total_quantity),
      filledPrice,
      filledAt:    Date.now(),
      fees,
    };
  },

  async cancel(orderId: string, symbol: string, ctx: ExecutionContext): Promise<void> {
    const { cdxApiKey, cdxApiSecret } = ctx;
    if (!cdxApiKey || !cdxApiSecret) throw new Error('CoinDCX API keys not configured.');
    const body = { id: orderId, timestamp: Date.now() };
    await cdxFuturesRequest(
      'POST', '/exchange/v1/derivatives/futures/orders/cancel',
      body, cdxApiKey, cdxApiSecret,
    );
  },

  async cancelAll(symbol: string, ctx: ExecutionContext) {
    const { cdxApiKey, cdxApiSecret } = ctx;
    if (!cdxApiKey || !cdxApiSecret) return { cancelled: 0, errors: ['CoinDCX API keys not configured.'] };
    try {
      const pair = symbolToCdxPair(symbol);
      const body = { pair, timestamp: Date.now() };
      await cdxFuturesRequest(
        'POST', '/exchange/v1/derivatives/futures/orders/cancel_all',
        body, cdxApiKey, cdxApiSecret,
      );
      return { cancelled: 1, errors: [] };
    } catch (e: any) {
      return { cancelled: 0, errors: [e.message] };
    }
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

// Convert 'BTCUSDT' → 'B-BTC_USDT' (CoinDCX futures pair format)
function symbolToCdxPair(symbol: string): string {
  // Already in pair format
  if (symbol.startsWith('B-')) return symbol;
  // 'BTCUSDT' → 'B-BTC_USDT'
  const base = symbol.replace('USDT', '');
  return `B-${base}_USDT`;
}

// ── Public helpers ────────────────────────────────────────────────────────────

export async function fetchCdxFuturesPositions(
  apiKey: string,
  apiSecret: string,
): Promise<CdxFuturesPosition[]> {
  const body = { timestamp: Date.now(), page: '1', size: '50' };
  try {
    const resp = await cdxFuturesRequest<{ data: CdxFuturesPosition[] }>(
      'POST', '/exchange/v1/derivatives/futures/positions',
      body, apiKey, apiSecret,
    );
    return resp.data ?? [];
  } catch {
    return [];
  }
}

export async function fetchCdxFuturesWallet(
  apiKey: string,
  apiSecret: string,
): Promise<{ balance: number; available: number }> {
  const body = { timestamp: Date.now() };
  try {
    const resp = await cdxFuturesRequest<{ balance: number; available_balance: number }>(
      'POST', '/exchange/v1/derivatives/futures/wallet',
      body, apiKey, apiSecret,
    );
    return { balance: resp.balance ?? 0, available: resp.available_balance ?? 0 };
  } catch {
    return { balance: 0, available: 0 };
  }
}

export async function setCdxFuturesLeverage(
  pair: string,
  leverage: number,
  apiKey: string,
  apiSecret: string,
): Promise<void> {
  const body = { pair, leverage, timestamp: Date.now() };
  await cdxFuturesRequest(
    'POST', '/exchange/v1/derivatives/futures/leverage',
    body, apiKey, apiSecret,
  );
}

export async function testCdxFuturesCredentials(
  apiKey: string,
  apiSecret: string,
): Promise<string | null> {
  try {
    await fetchCdxFuturesWallet(apiKey, apiSecret);
    return null;
  } catch (e: any) {
    return e.message ?? 'CoinDCX Futures connection test failed';
  }
}
