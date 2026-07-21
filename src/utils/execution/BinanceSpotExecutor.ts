// ─────────────────────────────────────────────────────────────────────────────
// BINANCE SPOT EXECUTOR  (v1.1.0)
//
// Handles Binance spot USDT pair orders.
// Exchange: api.binance.com (spot, NOT fapi — futures is a separate executor).
// Product: spot, no leverage, no expiry.
// ─────────────────────────────────────────────────────────────────────────────

import { bnPlaceOrder, bnCancelOrder, bnWaitForFill, bnCancelAllOrders, BinancePlaceOrderParams } from '../../api/binanceTrading';
import { logger } from '../logger';
import type { ExecutionProvider, ExecutionOrderRequest, ExecutionFill, ExecutionContext } from './ExecutionProvider';

function estimateBinanceFees(notionalValue: number): number {
  return notionalValue * 0.001;   // 0.1% maker/taker standard
}

export const BinanceSpotExecutor: ExecutionProvider = {
  capabilities: {
    execution: { live: true,  paper: true },
    orders:    { market: true, limit: true, stopLoss: false, bracket: false },
    position:  { overnight: true, lotBased: false, partialClose: true, maxLotsPerOrder: 0 },
    risk:      { marginRequired: false, leverage: false, preFlight: false },
    display:   { currency: '$', exchangeLabel: 'Binance Spot', priceDecimals: 4, qtyLabel: 'units' },
  },
  async execute(req: ExecutionOrderRequest, ctx: ExecutionContext): Promise<ExecutionFill> {
    if (!ctx.binanceApiKey || !ctx.binanceSecret) {
      throw new Error('Binance API keys not configured. Go to More → Broker Connection.');
    }

    const side = req.direction === 'LONG' ? 'BUY' : 'SELL';

    const params: BinancePlaceOrderParams = {
      symbol:   req.symbol,
      side,
      type:     req.orderType === 'MARKET' ? 'MARKET' : 'LIMIT',
      quantity: req.qty,
      ...(req.orderType === 'LIMIT' && req.limitPrice
        ? { price: req.limitPrice, timeInForce: 'GTC' }
        : {}),
      newClientOrderId: req.clientOrderId,
    };

    logger.info('BinanceSpotExecutor', `Placing ${side} ${req.qty}×${req.symbol} Binance Spot`);
    const placed = await bnPlaceOrder(params, ctx.binanceApiKey, ctx.binanceSecret);

    if (placed.status === 'FILLED' && placed.fills?.length) {
      const totalQty  = placed.fills.reduce((s: number, f: any) => s + Number(f.qty), 0);
      const totalCost = placed.fills.reduce((s: number, f: any) => s + Number(f.qty) * Number(f.price), 0);
      const avgPrice  = totalQty > 0 ? totalCost / totalQty : (req.limitPrice ?? 0);
      const fees      = placed.fills.reduce((s: number, f: any) => s + Number(f.commission), 0);
      return {
        orderId:     String(placed.orderId),
        broker:      'BINANCE',
        symbol:      req.symbol,
        direction:   req.direction,
        filledQty:   placed.executedQty,
        filledPrice: avgPrice,
        filledAt:    Date.now(),
        fees,
      };
    }

    const filled = await bnWaitForFill(req.symbol, placed.orderId, ctx.binanceApiKey, ctx.binanceSecret);
    return {
      orderId:     String(filled.orderId),
      broker:      'BINANCE',
      symbol:      req.symbol,
      direction:   req.direction,
      filledQty:   filled.executedQty,
      filledPrice: filled.avgFillPrice,
      filledAt:    Date.now(),
      fees:        estimateBinanceFees(filled.avgFillPrice * filled.executedQty),
    };
  },

  async cancel(orderId: string, symbol: string, ctx: ExecutionContext): Promise<void> {
    if (!ctx.binanceApiKey || !ctx.binanceSecret) throw new Error('Binance API keys not configured.');
    await bnCancelOrder(symbol, Number(orderId), ctx.binanceApiKey, ctx.binanceSecret);
  },

  async cancelAll(symbol: string, ctx: ExecutionContext) {
    if (!ctx.binanceApiKey || !ctx.binanceSecret) {
      return { cancelled: 0, errors: ['Binance API keys not configured.'] };
    }
    try {
      await bnCancelAllOrders(symbol, ctx.binanceApiKey, ctx.binanceSecret);
      return { cancelled: 1, errors: [] };
    } catch (e: any) {
      return { cancelled: 0, errors: [e.message] };
    }
  },
};
