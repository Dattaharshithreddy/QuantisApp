// ─────────────────────────────────────────────────────────────────────────────
// BINANCE FUTURES EXECUTOR  (v1.2.0)
//
// Handles Binance USDM perpetual futures orders via fapi.binance.com.
//
// Key differences from Binance Spot:
//   Base URL:     fapi.binance.com  (NOT api.binance.com)
//   Margin type:  ISOLATED — each position has its own margin wallet
//   Position mode: ONE_WAY (BOTH positionSide) — simpler, default for most users
//   Close:        reduceOnly=true opposite-side order, NOT a normal sell
//   No expiry:    perpetual — position runs until closed or liquidated
//   Funding:      8-hour funding payments auto-applied by Binance
//   Leverage:     explicit (1×–125×), set once per symbol per session
//
// Session setup (runs once per order symbol):
//   setLeverage(symbol, leverage)
//   setMarginType(symbol, 'ISOLATED')
//
// Pre-flight (runs after confirm, before order):
//   runBnFuturesPreFlight() — symbol tradable, balance, price
//
// Fee structure (USDT):
//   Taker: 0.04% of notional (MARKET or aggressive LIMIT)
//   Maker: 0.02% of notional (passive LIMIT)
//   Funding: ±8h, applied to position pnl automatically
// ─────────────────────────────────────────────────────────────────────────────

import {
  bnFuturesSetLeverage, bnFuturesSetMarginType,
  bnFuturesPlaceOrder, bnFuturesWaitForFill,
  bnFuturesCancelOrder, bnFuturesClosePosition,
} from '../../api/binanceFuturesApi';
import { logger } from '../logger';
import { runBnFuturesPreFlight } from './binanceFuturesPreFlight';
import {
  BN_CONTRACT_SPECS, computeIsolatedMargin, computeLiquidationPrice,
  clampLeverage, riskBasedQty, maxQtyFromBudget,
} from '../futures/binance/bnFuturesTypes';
import type {
  ExecutionProvider, ExecutionOrderRequest, ExecutionFill, ExecutionContext,
} from './ExecutionProvider';

// ── Session setup cache ───────────────────────────────────────────────────────
// Track which symbols have been configured this session so we don't repeat
// setLeverage and setMarginType on every order.

const CONFIGURED_SYMBOLS = new Set<string>();

async function ensureSymbolConfigured(
  symbol: string, leverage: number, apiKey: string, secret: string,
): Promise<void> {
  const key = `${symbol}:${leverage}`;
  if (CONFIGURED_SYMBOLS.has(key)) return;

  await bnFuturesSetMarginType(symbol, apiKey, secret);   // ISOLATED — swallows -4046 if already set
  await bnFuturesSetLeverage(symbol, leverage, apiKey, secret);
  CONFIGURED_SYMBOLS.add(key);
}

// ── Fee estimation ────────────────────────────────────────────────────────────

function estimateBnFuturesFees(notionalUsdt: number, orderType: 'MARKET' | 'LIMIT'): number {
  const feeRate = orderType === 'MARKET' ? 0.0004 : 0.0002;   // taker / maker
  return notionalUsdt * feeRate;
}

// ── Executor ──────────────────────────────────────────────────────────────────

export const BinanceFuturesExecutor: ExecutionProvider = {
  capabilities: {
    execution: { live: true,  paper: true },
    orders:    { market: true, limit: true, stopLoss: false, bracket: false },
    position:  { overnight: true, lotBased: false, partialClose: true, maxLotsPerOrder: 0 },
    risk:      { marginRequired: true, leverage: true, preFlight: true },
    display:   { currency: '$', exchangeLabel: 'Binance USDM Perps', priceDecimals: 4, qtyLabel: 'contracts' }},

  async execute(req: ExecutionOrderRequest, ctx: ExecutionContext): Promise<ExecutionFill> {
    if (!ctx.binanceApiKey || !ctx.binanceSecret) {
      throw new Error(
        'Binance API keys not configured.\n\n' +
        'Go to More → Broker Connection to add your Binance Futures API key and secret.'
      );
    }

    const leverage   = req.leverage ?? 10;    // default 10× if not specified
    const spec       = BN_CONTRACT_SPECS[req.symbol as keyof typeof BN_CONTRACT_SPECS];
    const notional   = req.qty * (req.limitPrice ?? 0);
    const margin     = spec
      ? computeIsolatedMargin(req.qty, req.limitPrice ?? 0, leverage, spec.takerFeeRate)
      : notional / leverage;

    // ── Pre-flight ──────────────────────────────────────────────────────────
    const preFlight = await runBnFuturesPreFlight({
      symbol:       req.symbol,
      direction:    req.direction,
      qty:          req.qty,
      leverage,
      limitPrice:   req.limitPrice,
      orderType:    req.orderType,
      marginNeeded: margin,
      apiKey:       ctx.binanceApiKey,
      secret:       ctx.binanceSecret});

    if (!preFlight.ok) {
      throw new Error(preFlight.reason);
    }

    // ── Session setup (idempotent) ──────────────────────────────────────────
    await ensureSymbolConfigured(req.symbol, leverage, ctx.binanceApiKey, ctx.binanceSecret);

    // ── Place order ─────────────────────────────────────────────────────────
    const side: 'BUY' | 'SELL' = req.direction === 'LONG' ? 'BUY' : 'SELL';

    logger.info('BinanceFuturesExecutor',
      `Placing ${side} ${req.qty} ${req.symbol} ${req.orderType} × ${leverage}L ` +
      `margin≈$${margin.toFixed(2)}`
    );

    const placed = await bnFuturesPlaceOrder({
      symbol:          req.symbol,
      side,
      type:            req.orderType,
      quantity:        req.qty,
      price:           req.orderType === 'LIMIT' ? req.limitPrice : undefined,
      timeInForce:     req.orderType === 'LIMIT' ? 'GTC' : undefined,
      newClientOrderId: req.clientOrderId,
      positionSide:    'BOTH',   // ONE_WAY mode
    }, ctx.binanceApiKey, ctx.binanceSecret);

    const filled = placed.status === 'FILLED'
      ? placed
      : await bnFuturesWaitForFill(req.symbol, placed.orderId, ctx.binanceApiKey, ctx.binanceSecret);

    const filledPrice = filled.avgPrice > 0 ? filled.avgPrice : (preFlight.markPrice);
    const fees        = estimateBnFuturesFees(filled.executedQty * filledPrice, req.orderType);

    const liqPrice = spec
      ? computeLiquidationPrice(req.direction, filledPrice, leverage)
      : 0;

    logger.info('BinanceFuturesExecutor',
      `Filled: ${filled.executedQty} @ $${filledPrice} | orderId=${filled.orderId} ` +
      `liqPrice=$${liqPrice.toFixed(2)} fees≈$${fees.toFixed(4)}`
    );

    return {
      orderId:       String(filled.orderId),
      broker:        'BINANCE',
      symbol:        req.symbol,
      direction:     req.direction,
      filledQty:     filled.executedQty,
      filledPrice,
      filledAt:      Date.now(),
      fees,
      // Futures-specific
      marginBlocked: margin,
      lots:          undefined,   // Binance perps don't use lots — qty is in contracts
      lotSize:       undefined};
  },

  async cancel(orderId: string, symbol: string, ctx: ExecutionContext): Promise<void> {
    if (!ctx.binanceApiKey || !ctx.binanceSecret) {
      throw new Error('Binance API keys not configured.');
    }
    await bnFuturesCancelOrder(symbol, Number(orderId), ctx.binanceApiKey, ctx.binanceSecret);
  },

  async cancelAll(symbol: string, ctx: ExecutionContext) {
    if (!ctx.binanceApiKey || !ctx.binanceSecret) {
      return { cancelled: 0, errors: ['Binance API keys not configured.'] };
    }
    try {
      // Close all open positions for this symbol (reduceOnly MARKET)
      const { bnFuturesGetPositions } = await import('../../api/binanceFuturesApi');
      const positions = await bnFuturesGetPositions(ctx.binanceApiKey, ctx.binanceSecret, symbol);
      let cancelled = 0;
      const errors: string[] = [];
      for (const pos of positions) {
        try {
          const dir: 'LONG' | 'SHORT' = pos.positionAmt > 0 ? 'LONG' : 'SHORT';
          await bnFuturesClosePosition(symbol, Math.abs(pos.positionAmt), dir,
            ctx.binanceApiKey!, ctx.binanceSecret!);
          cancelled++;
        } catch (e: any) { errors.push(e.message); }
      }
      return { cancelled, errors };
    } catch (e: any) {
      return { cancelled: 0, errors: [e.message] };
    }
  },
};
