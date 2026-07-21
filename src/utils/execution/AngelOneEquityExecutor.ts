// ─────────────────────────────────────────────────────────────────────────────
// ANGEL ONE EQUITY EXECUTOR  (v1.1.0)
//
// Handles NSE/BSE equity orders via Angel One SmartAPI.
// Product type: INTRADAY (MIS) — square off same day.
// Exchange: NSE or BSE.
// Quantity: unit shares (not lots).
// ─────────────────────────────────────────────────────────────────────────────

import { aoPlaceOrder, aoCancelOrder, aoWaitForFill, AOPlaceOrderParams } from '../../api/angelOneTrading';
import { logger } from '../logger';
import type { ExecutionProvider, ExecutionOrderRequest, ExecutionFill, ExecutionContext } from './ExecutionProvider';

function estimateAOFees(notionalValue: number): number {
  // Angel One intraday brokerage: flat ₹20 per order or 0.05% whichever is lower
  return Math.min(20, notionalValue * 0.0005);
}

export const AngelOneEquityExecutor: ExecutionProvider = {
  capabilities: {
    execution: { live: true,  paper: true },
    orders:    { market: true, limit: true, stopLoss: true, bracket: false },
    position:  { overnight: false, lotBased: false, partialClose: false, maxLotsPerOrder: 0 },
    risk:      { marginRequired: false, leverage: false, preFlight: false },
    display:   { currency: '₹', exchangeLabel: 'NSE / BSE', priceDecimals: 2, qtyLabel: 'shares' },
  },
  async execute(req: ExecutionOrderRequest, ctx: ExecutionContext): Promise<ExecutionFill> {
    if (!ctx.aoSession?.jwtToken) {
      throw new Error('Angel One session not connected. Please reconnect in Settings.');
    }

    const transactiontype = req.direction === 'LONG' ? 'BUY' : 'SELL';
    const ordertype       = req.orderType === 'MARKET' ? 'MARKET' : 'LIMIT';

    const params: AOPlaceOrderParams = {
      variety:         'NORMAL',
      tradingsymbol:   req.symbol,
      symboltoken:     req.symbolToken ?? '',
      transactiontype,
      exchange:        (req.exchange ?? 'NSE') as any,
      ordertype:       ordertype as any,
      producttype:     'INTRADAY',
      duration:        'DAY',
      price:           ordertype === 'LIMIT' ? (req.limitPrice ?? 0) : 0,
      squareoff:       0,
      stoploss:        0,
      quantity:        req.qty,
      uniqueorderid:   req.clientOrderId,
    };

    logger.info('AngelOneEquityExecutor', `Placing ${transactiontype} ${req.qty}×${req.symbol} NSE/BSE`);
    const placed = await aoPlaceOrder(params, ctx.aoSession);
    const filled = await aoWaitForFill(placed.orderId, ctx.aoSession);

    return {
      orderId:     filled.orderId,
      broker:      'ANGEL_ONE',
      symbol:      req.symbol,
      direction:   req.direction,
      filledQty:   filled.filledQty,
      filledPrice: filled.avgFillPrice,
      filledAt:    Date.now(),
      fees:        estimateAOFees(filled.avgFillPrice * filled.filledQty),
    };
  },

  async cancel(orderId: string, _symbol: string, ctx: ExecutionContext): Promise<void> {
    if (!ctx.aoSession?.jwtToken) throw new Error('Angel One session not connected.');
    await aoCancelOrder(orderId, 'NORMAL', ctx.aoSession);
  },

  async cancelAll(_symbol: string, _ctx: ExecutionContext) {
    // Angel One doesn't support cancel-all via API — individual cancellations only
    return { cancelled: 0, errors: ['Angel One requires individual order cancellation.'] };
  },
};
