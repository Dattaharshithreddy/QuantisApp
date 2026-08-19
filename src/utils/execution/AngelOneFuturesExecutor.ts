// ─────────────────────────────────────────────────────────────────────────────
// ANGEL ONE FUTURES EXECUTOR  (v1.1.0)
//
// Handles NFO futures orders via Angel One SmartAPI.
//
// Key differences from equity:
//   producttype:  CARRYFORWARD (not INTRADAY) — futures carry overnight
//   exchange:     NFO (not NSE/BSE)
//   quantity:     lots × lotSize — minimum unit is one lot
//   symboltoken:  NFO instrument token (different token space from equity)
//   symbol:       full NSE symbol e.g. "NIFTY26JULFUT"
//
// Prerequisites:
//   • Angel One F&O segment must be active on the account
//   • Sufficient SPAN + exposure margin in account
//   • NFO instrument token must be fetched from scrip master
//     (handled by futuresContracts.getContractsWithTokens)
//
// Close/square-off:
//   Closing a LONG sends a SELL order with same symbol+qty.
//   Closing a SHORT sends a BUY order with same symbol+qty.
//   Both use producttype CARRYFORWARD so they match the open position.
//
// Brokerage:
//   Angel One F&O: ₹20 flat per order or 0.05% whichever is lower.
//   STT: 0.01% of turnover on sell side (index futures exempt on buy).
//   Exchange charges: ~0.0019% NFO.
//   Total estimate: ~₹40-50 round trip on a NIFTY futures order.
// ─────────────────────────────────────────────────────────────────────────────

import { aoPlaceOrder, aoCancelOrder, aoWaitForFill, AOPlaceOrderParams } from '../../api/angelOneTrading';
import { logger } from '../logger';
import type { ExecutionProvider, ExecutionOrderRequest, ExecutionFill, ExecutionContext } from './ExecutionProvider';
import { estimateMargin } from '../futures/futuresTypes';
import { runFuturesPreFlight } from './futuresPreFlight';

// ── Fee estimation for futures ────────────────────────────────────────────────

function estimateNFOFees(symbol: string, filledPrice: number, qty: number): number {
  const notional     = filledPrice * qty;
  const brokerage    = Math.min(20, notional * 0.0005);    // ₹20 flat or 0.05%
  const exchangeFee  = notional * 0.000019;                // ~0.0019% NFO exchange
  const stt          = notional * 0.0001;                  // STT 0.01% on sell side (estimated both)
  const sebi         = notional * 0.000001;                // SEBI charges
  const gst          = (brokerage + exchangeFee) * 0.18;   // 18% GST on brokerage + exchange
  return brokerage + exchangeFee + stt + sebi + gst;
}

// ── Validation specific to futures ────────────────────────────────────────────

function validateFuturesRequest(req: ExecutionOrderRequest): void {
  if (!req.symbolToken || req.symbolToken === '') {
    throw new Error(
      `NFO instrument token missing for ${req.symbol}. ` +
      `The app needs an active network connection to fetch current futures tokens from Angel One. ` +
      `Please check your connection and try again.`
    );
  }
  if (!req.lots || req.lots < 1) {
    throw new Error(`Order must be at least 1 lot. Got: ${req.lots ?? 0}`);
  }
  if (!req.lotSize || req.lotSize < 1) {
    throw new Error(`Lot size not provided for ${req.symbol}.`);
  }
  if (req.qty !== (req.lots * req.lotSize)) {
    // qty must equal lots × lotSize — catch any mismatch before sending to broker
    throw new Error(
      `Quantity mismatch: qty=${req.qty} but lots=${req.lots} × lotSize=${req.lotSize} = ${req.lots * req.lotSize}. ` +
      `This is a bug — please report it.`
    );
  }
}

// ── Executor ──────────────────────────────────────────────────────────────────

export const AngelOneFuturesExecutor: ExecutionProvider = {
  capabilities: {
    execution: { live: true,  paper: true },
    orders:    { market: true, limit: true, stopLoss: true, bracket: false },
    position:  { overnight: true, lotBased: true, partialClose: false, maxLotsPerOrder: 5 },
    risk:      { marginRequired: true, leverage: true, preFlight: true },
    display:   { currency: '₹', exchangeLabel: 'NFO Futures', priceDecimals: 2, qtyLabel: 'lots' }},
  async execute(req: ExecutionOrderRequest, ctx: ExecutionContext): Promise<ExecutionFill> {
    if (!ctx.aoSession?.jwtToken) {
      throw new Error('Angel One session not connected. Please reconnect in Settings.');
    }

    validateFuturesRequest(req);

    // ── Pre-flight — runs AFTER user confirmation, BEFORE broker call ──────
    // Catches changes that happened between the confirmation screen rendering
    // and the user tapping "Confirm": margin consumed, market closed, circuit hit.
    const marginNeeded = req.lots != null && req.lotSize != null
      ? req.lots * req.lotSize * (req.limitPrice ?? 0) * 0.12   // ~12% of notional
      : 0;

    const preFlight = await runFuturesPreFlight({
      symbol:       req.symbol,
      symbolToken:  req.symbolToken!,
      direction:    req.direction,
      limitPrice:   req.limitPrice,
      orderType:    req.orderType,
      expiry:       req.expiry ?? Date.now() + 86_400_000,   // fallback: 1 day (should always be set)
      marginNeeded,
      aoSession:    ctx.aoSession!});

    if (!preFlight.ok) {
      // Pre-flight throws with a user-readable reason — executor surfaces it via
      // liveOrderExecution which caller catches and shows in an Alert.
      throw new Error(preFlight.reason);
    }

    logger.info('AngelOneFuturesExecutor', `Pre-flight passed. LTP=₹${preFlight.ltp}, margin available=₹${preFlight.availableMargin.toFixed(0)}`);

    const transactiontype = req.direction === 'LONG' ? 'BUY' : 'SELL';
    const ordertype       = req.orderType === 'MARKET' ? 'MARKET' : 'LIMIT';
    const lots            = req.lots!;
    const lotSize         = req.lotSize!;

    const params: AOPlaceOrderParams = {
      variety:         'NORMAL',
      tradingsymbol:   req.symbol,          // e.g. "NIFTY26JULFUT"
      symboltoken:     req.symbolToken!,    // NFO token from scrip master
      transactiontype,
      exchange:        'NFO',
      ordertype:       ordertype as any,
      producttype:     'CARRYFORWARD',      // futures must carry overnight
      duration:        'DAY',
      price:           ordertype === 'LIMIT' ? (req.limitPrice ?? 0) : 0,
      squareoff:       0,
      stoploss:        0,
      quantity:        req.qty,             // lots × lotSize
      uniqueorderid:   req.clientOrderId,   // idempotency key
    };

    logger.info('AngelOneFuturesExecutor',
      `Placing ${transactiontype} ${lots} lots (${req.qty} units) × ${req.symbol} NFO | token=${req.symbolToken}`
    );

    const placed = await aoPlaceOrder(params, ctx.aoSession);
    const filled = await aoWaitForFill(placed.orderId, ctx.aoSession);

    const fees = estimateNFOFees(req.symbol, filled.avgFillPrice, filled.filledQty);

    // Estimate margin blocked — approximate, actual blocked amount comes from AO margin API
    const underlying = req.underlying as any;
    const marginBlocked = underlying
      ? estimateMargin(underlying, filled.avgFillPrice, lots)
      : filled.avgFillPrice * filled.filledQty * 0.12;   // fallback: 12% of notional

    logger.info('AngelOneFuturesExecutor',
      `Filled: ${filled.filledQty} units @ ₹${filled.avgFillPrice} | fees ≈ ₹${fees.toFixed(2)} | margin ≈ ₹${marginBlocked.toFixed(0)}`
    );

    return {
      orderId:      filled.orderId,
      broker:       'ANGEL_ONE_FUTURES',
      symbol:       req.symbol,
      direction:    req.direction,
      filledQty:    filled.filledQty,
      filledPrice:  filled.avgFillPrice,
      filledAt:     Date.now(),
      fees,
      lots,
      lotSize,
      marginBlocked,
      underlying:   req.underlying,
      expiry:       req.expiry,
      expiryLabel:  req.expiryLabel};
  },

  async cancel(orderId: string, _symbol: string, ctx: ExecutionContext): Promise<void> {
    if (!ctx.aoSession?.jwtToken) throw new Error('Angel One session not connected.');
    logger.info('AngelOneFuturesExecutor', `Cancelling NFO order ${orderId}`);
    await aoCancelOrder(orderId, 'NORMAL', ctx.aoSession);
  },

  async cancelAll(_symbol: string, _ctx: ExecutionContext) {
    return { cancelled: 0, errors: ['Angel One requires individual order cancellation. Use the positions screen to close each position.'] };
  },
};
