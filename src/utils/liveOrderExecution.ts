// ─────────────────────────────────────────────────────────────────────────────
// LIVE ORDER EXECUTION  (v1.1.0)
//
// Public façade — all callers (OrderConfirmationScreen, LivePositionsScreen,
// KillSwitchScreen) use this file. The actual execution logic lives in the
// executor classes under src/utils/execution/.
//
// To add a new broker/asset type:
//   1. Create an executor implementing ExecutionProvider
//   2. Add its assetSrc key to EXECUTOR_MAP below
//   3. Nothing else changes
//
// Supported assetSrc values:
//   'ao'          → Angel One NSE/BSE equity (INTRADAY)
//   'ao_futures'  → Angel One NFO futures (CARRYFORWARD, lots)
//   'binance'     → Binance spot USDT pairs
//   'coindcx'     → CoinDCX spot USDT pairs
// ─────────────────────────────────────────────────────────────────────────────

import { getLiveTradingCredential }    from './secureCredentials';
import { logger }                      from './logger';
import { createOrderRecord, appendOrder, updateOrderState } from './liveOrderLifecycle';
import { startMetric, endMetric }      from './performanceMetrics';
import { notifyLiveOrderFilled, notifyLiveOrderFailed } from './paperNotifications';
import type { AOSession }              from '../api/angelOne';
import type { ExecutionFill }          from './execution/ExecutionProvider';
import { AngelOneEquityExecutor }      from './execution/AngelOneEquityExecutor';
import { AngelOneFuturesExecutor }     from './execution/AngelOneFuturesExecutor';
import { BinanceSpotExecutor }         from './execution/BinanceSpotExecutor';
import { BinanceFuturesExecutor }      from './execution/BinanceFuturesExecutor';
import { CoinDCXExecutor }             from './execution/CoinDCXExecutor';
import { CoinDCXFuturesExecutor }      from './execution/CoinDCXFuturesExecutor';

// ── Types (re-exported so callers don't need to import ExecutionProvider) ──────

export type { ExecutionFill as LiveOrderFill };
export type LiveOrderType = 'MARKET' | 'LIMIT';

export type LiveOrderRequest = {
  assetSrc:      'ao' | 'ao_futures' | 'binance' | 'binance_futures' | 'coindcx' | 'coindcx_futures';
  symbol:        string;
  direction:     'LONG' | 'SHORT';
  qty:           number;
  orderType:     LiveOrderType;
  limitPrice?:   number;
  stopLoss?:     number;
  takeProfit?:   number;
  // Angel One equity
  symbolToken?:  string;
  exchange?:     string;
  // Angel One futures
  lots?:         number;
  lotSize?:      number;
  underlying?:   string;
  expiry?:       number;
  expiryLabel?:  string;
  // Binance futures
  leverage?:     number;   // 1–125, defaults to 10 if not specified
};

// ── Executor registry ─────────────────────────────────────────────────────────

const EXECUTOR_MAP = {
  ao:               AngelOneEquityExecutor,
  ao_futures:       AngelOneFuturesExecutor,
  binance:          BinanceSpotExecutor,
  binance_futures:  BinanceFuturesExecutor,
  coindcx:          CoinDCXExecutor,
  coindcx_futures:  CoinDCXFuturesExecutor,
} as const;

type SupportedAssetSrc = keyof typeof EXECUTOR_MAP;

// ── In-flight guard — prevents duplicate orders from rapid double-press ────────

const IN_FLIGHT = new Map<string, string>();

// ── Public API ────────────────────────────────────────────────────────────────

export async function placeLiveOrder(
  req: LiveOrderRequest,
  aoSession?: AOSession | null,
): Promise<ExecutionFill> {
  const executor = EXECUTOR_MAP[req.assetSrc as SupportedAssetSrc];
  if (!executor) {
    throw new Error(`Live trading not supported for asset source: ${req.assetSrc}`);
  }

  // Duplicate-press guard
  const flightKey = `${req.symbol}|${req.direction}|${req.assetSrc}`;
  if (IN_FLIGHT.has(flightKey)) {
    logger.warn('liveExecution', `Duplicate blocked — ${flightKey} already in flight`);
    throw new Error(`An order for ${req.symbol} is already being placed. Please wait for it to complete.`);
  }

  logger.info('liveExecution', `Routing ${req.direction} ${req.qty}×${req.symbol} via ${req.assetSrc}`);

  // Lifecycle record — created before broker contact for auditability
  const orderRecord = createOrderRecord({
    broker:         req.assetSrc === 'ao' ? 'ANGEL_ONE' :
                    req.assetSrc === 'ao_futures' ? 'ANGEL_ONE_FUTURES' :
                    req.assetSrc === 'coindcx' ? 'COINDCX' : 'BINANCE',
    symbol:         req.symbol,
    direction:      req.direction,
    assetSrc:       req.assetSrc,
    requestedQty:   req.qty,
    requestedPrice: req.limitPrice ?? 0,
    orderType:      req.orderType,
    stopLoss:       req.stopLoss ?? 0,
    takeProfit:     req.takeProfit ?? 0});
  await appendOrder(orderRecord);
  await updateOrderState(orderRecord.localId, 'SUBMITTED', {}, 'Sending to broker');

  IN_FLIGHT.set(flightKey, orderRecord.localId);
  startMetric('order_submission', orderRecord.localId);
  startMetric('broker_ack', orderRecord.localId);

  try {
    // Build execution context — fetch credentials lazily
    const binanceApiKey = (req.assetSrc === 'binance' || req.assetSrc === 'binance_futures')
      ? (await getLiveTradingCredential('binanceApiKey') ?? undefined) : undefined;
    const binanceSecret = (req.assetSrc === 'binance' || req.assetSrc === 'binance_futures')
      ? (await getLiveTradingCredential('binanceApiSecret') ?? undefined) : undefined;
    const cdxApiKey = (req.assetSrc === 'coindcx' || req.assetSrc === 'coindcx_futures')
      ? (await getLiveTradingCredential('cdxApiKey') ?? undefined) : undefined;
    const cdxApiSecret = (req.assetSrc === 'coindcx' || req.assetSrc === 'coindcx_futures')
      ? (await getLiveTradingCredential('cdxApiSecret') ?? undefined) : undefined;

    const fill = await executor.execute(
      { ...req, clientOrderId: orderRecord.localId },
      { aoSession, binanceApiKey, binanceSecret, cdxApiKey, cdxApiSecret },
    );

    await updateOrderState(orderRecord.localId, 'ACKNOWLEDGED', { brokerOrderId: fill.orderId }, 'Broker acknowledged');
    await endMetric('order_submission', orderRecord.localId);
    await endMetric('broker_ack', orderRecord.localId);
    await updateOrderState(orderRecord.localId, 'FILLED', {
      filledQty:   fill.filledQty,
      filledPrice: fill.filledPrice,
      fees:        fill.fees,
      filledAt:    fill.filledAt}, 'Order fully filled');
    await endMetric('fill_time', orderRecord.localId).catch(() => {});

    // Push notification — fires even when the confirmation screen is dismissed
    // and app is backgrounded during the fill wait.
    const currency = (fill.broker === 'ANGEL_ONE' || fill.broker === 'ANGEL_ONE_FUTURES') ? '₹' : '$';
    const brokerLabel = fill.broker === 'ANGEL_ONE' ? 'Angel One' :
                        fill.broker === 'ANGEL_ONE_FUTURES' ? 'Angel One NFO' :
                        fill.broker === 'BINANCE_FUTURES' ? 'Binance Perps' :
                        fill.broker === 'COINDCX' ? (req.assetSrc === 'coindcx_futures' ? 'CoinDCX Futures' : 'CoinDCX') : 'Binance';
    // Push notification for live fill
    import('../services/notifications').then(({ notifyLiveFill }) => {
      notifyLiveFill(fill.symbol, fill.direction, fill.filledQty, fill.filledPrice, fill.orderId).catch(() => {});
    }).catch(() => {});
    notifyLiveOrderFilled(
      fill.symbol, fill.direction, fill.filledQty, fill.filledPrice,
      currency, brokerLabel, fill.lots, fill.lotSize,
    ).catch(() => {});

    // Save to order history for audit trail
    import('@react-native-async-storage/async-storage').then(({ default: AS }) => {
      AS.getItem('liveOrderHistory_v1').then(raw => {
        const hist = JSON.parse(raw ?? '[]');
        hist.unshift({ ...fill, assetSrc: req.assetSrc, time: Date.now() });
        AS.setItem('liveOrderHistory_v1', JSON.stringify(hist.slice(0, 50)));
      }).catch(() => {});
    }).catch(() => {});

    return fill;
  } catch (e: any) {
    await updateOrderState(orderRecord.localId, 'FAILED', {}, e.message);
    // Push notification for failure — user may have left the confirmation screen
    notifyLiveOrderFailed(req.symbol, e.message).catch(() => {});
    throw e;
  } finally {
    IN_FLIGHT.delete(flightKey);
  }
}

export async function cancelLiveOrder(
  broker: 'ANGEL_ONE' | 'ANGEL_ONE_FUTURES' | 'BINANCE' | 'BINANCE_FUTURES' | 'COINDCX',
  orderId: string,
  symbol: string,
  aoSession?: AOSession | null,
): Promise<void> {
  logger.info('liveExecution', `Cancelling ${broker} order ${orderId} for ${symbol}`);
  const assetSrc: SupportedAssetSrc =
    broker === 'ANGEL_ONE'         ? 'ao' :
    broker === 'ANGEL_ONE_FUTURES'  ? 'ao_futures' :
    broker === 'BINANCE_FUTURES'    ? 'binance_futures' :
    broker === 'COINDCX'            ? 'coindcx' : 'binance'; // Note: coindcx_futures resolved from broker label
  const executor = EXECUTOR_MAP[assetSrc];
  const binanceApiKey = (broker === 'BINANCE' || broker === 'BINANCE_FUTURES')
    ? (await getLiveTradingCredential('binanceApiKey') ?? undefined) : undefined;
  const binanceSecret = (broker === 'BINANCE' || broker === 'BINANCE_FUTURES')
    ? (await getLiveTradingCredential('binanceApiSecret') ?? undefined) : undefined;
  const cdxApiKey    = broker === 'COINDCX'
    ? (await getLiveTradingCredential('cdxApiKey') ?? undefined) : undefined;
  const cdxApiSecret = broker === 'COINDCX'
    ? (await getLiveTradingCredential('cdxApiSecret') ?? undefined) : undefined;
  await executor.cancel(orderId, symbol, { aoSession, binanceApiKey, binanceSecret, cdxApiKey, cdxApiSecret });
}

export async function emergencyCancelAll(
  symbol: string,
  broker: 'ANGEL_ONE' | 'ANGEL_ONE_FUTURES' | 'BINANCE' | 'BINANCE_FUTURES' | 'COINDCX',
  aoSession?: AOSession | null,
): Promise<{ cancelled: number; errors: string[] }> {
  const assetSrc: SupportedAssetSrc =
    broker === 'ANGEL_ONE'         ? 'ao' :
    broker === 'ANGEL_ONE_FUTURES'  ? 'ao_futures' :
    broker === 'BINANCE_FUTURES'    ? 'binance_futures' :
    broker === 'COINDCX'            ? 'coindcx' : 'binance'; // Note: coindcx_futures resolved from broker label
  const executor = EXECUTOR_MAP[assetSrc];
  const binanceApiKey = (broker === 'BINANCE' || broker === 'BINANCE_FUTURES')
    ? (await getLiveTradingCredential('binanceApiKey') ?? undefined) : undefined;
  const binanceSecret = (broker === 'BINANCE' || broker === 'BINANCE_FUTURES')
    ? (await getLiveTradingCredential('binanceApiSecret') ?? undefined) : undefined;
  const cdxApiKey    = broker === 'COINDCX'
    ? (await getLiveTradingCredential('cdxApiKey') ?? undefined) : undefined;
  const cdxApiSecret = broker === 'COINDCX'
    ? (await getLiveTradingCredential('cdxApiSecret') ?? undefined) : undefined;
  return executor.cancelAll(symbol, { aoSession, binanceApiKey, binanceSecret, cdxApiKey, cdxApiSecret });
}

// Re-export capabilities so UI can query without importing executor files directly
export type { OrderTypeCapability } from './execution/ExecutionProvider';

export function getExecutorCapabilities(assetSrc: string) {
  const executor = EXECUTOR_MAP[assetSrc as SupportedAssetSrc];
  return executor?.capabilities ?? null;
}

// Re-export for any legacy import
export type { ExecutionFill };
