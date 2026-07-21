// ─────────────────────────────────────────────────────────────────────────────
// LIVE POSITION MONITOR  (v1.0.0)
//
// Monitors open live positions (Angel One + Binance) for SL/TP breaches
// using current prices from DataContext. When a breach is detected, places
// a market close order via the appropriate executor.
//
// Called from watchlistScanner on every price cycle — same cadence as paper
// position monitoring. Runs only when app is in foreground (background
// monitoring requires a server-side webhook — documented limitation).
//
// Deduplication: a Set<string> of in-flight closes prevents double-closing
// if the price update fires twice before the close order resolves.
//
// Close flow:
//   LONG hits SL → SELL market reduceOnly (Binance) / SELL CARRYFORWARD (AO NFO)
//   LONG hits TP → same
//   SHORT hits SL → BUY market
//   SHORT hits TP → BUY market
// ─────────────────────────────────────────────────────────────────────────────

import { getLivePortfolio, removeLivePosition, LivePosition } from './livePortfolio';
import { notifyLiveOrderFilled }   from './paperNotifications';
import { cancelLiveOrder }         from './liveOrderExecution';
import { logger }                  from './logger';
import type { AOSession }          from '../api/angelOne';

const CLOSING_IN_FLIGHT = new Set<string>(); // position IDs currently being closed

// ── Close helpers ─────────────────────────────────────────────────────────────

async function closeLivePosition(
  pos:       LivePosition,
  reason:    'STOP_LOSS' | 'TAKE_PROFIT',
  price:     number,
  aoSession: AOSession | null,
): Promise<void> {
  if (CLOSING_IN_FLIGHT.has(pos.id)) return;
  CLOSING_IN_FLIGHT.add(pos.id);
  logger.info('liveMonitor', `${reason}: ${pos.symbol} ${pos.direction} @ ${price.toFixed(4)}`);

  try {
    if (pos.broker === 'BINANCE' || pos.broker === 'BINANCE_FUTURES') {
      const { bnFuturesClosePosition } = await import('../api/binanceFuturesApi');
      const { getLiveTradingCredential } = await import('./secureCredentials');
      const apiKey = await getLiveTradingCredential('binanceApiKey');
      const secret = await getLiveTradingCredential('binanceApiSecret');
      if (!apiKey || !secret) throw new Error('Binance API keys not configured');

      if (pos.broker === 'BINANCE_FUTURES') {
        await bnFuturesClosePosition(pos.symbol, pos.qty, pos.direction, apiKey, secret);
      } else {
        // Binance spot — place a SELL market order
        const { bnPlaceOrder } = await import('../api/binanceTrading');
        await bnPlaceOrder(
          { symbol: pos.symbol, side: pos.direction === 'LONG' ? 'SELL' : 'BUY',
            type: 'MARKET', quantity: pos.qty },
          apiKey, secret,
        );
      }

      const pnl = (price - pos.entryPrice) * pos.qty * (pos.direction === 'LONG' ? 1 : -1);
      await removeLivePosition(pos.id, pnl);
      await notifyLiveOrderFilled(pos.symbol, pos.direction === 'LONG' ? 'SHORT' : 'LONG',
        pos.qty, price, '$', pos.broker === 'BINANCE_FUTURES' ? 'Binance Perps' : 'Binance');

    } else if (pos.broker === 'ANGEL_ONE' || pos.broker === 'ANGEL_ONE_FUTURES') {
      if (!aoSession?.jwtToken) throw new Error('Angel One session expired');
      const { aoPlaceOrder } = await import('../api/angelOneTrading');
      const productType = pos.broker === 'ANGEL_ONE_FUTURES' ? 'CARRYFORWARD' : 'INTRADAY';
      const txnType     = pos.direction === 'LONG' ? 'SELL' : 'BUY';
      await aoPlaceOrder({
        variety: 'NORMAL', tradingsymbol: pos.symbol,
        symboltoken: (pos as any).aoToken ?? '',
        transactiontype: txnType,
        exchange: pos.broker === 'ANGEL_ONE_FUTURES' ? 'NFO' : 'NSE',
        ordertype: 'MARKET', producttype: productType as any,
        duration: 'DAY', price: 0, squareoff: 0, stoploss: 0, quantity: pos.qty,
        uniqueorderid: `monitor_close_${pos.id}_${Date.now()}`,
      }, aoSession);

      const pnl = (price - pos.entryPrice) * pos.qty * (pos.direction === 'LONG' ? 1 : -1);
      await removeLivePosition(pos.id, pnl);
      await notifyLiveOrderFilled(pos.symbol, pos.direction === 'LONG' ? 'SHORT' : 'LONG',
        pos.qty, price, '₹', pos.broker === 'ANGEL_ONE_FUTURES' ? 'Angel One NFO' : 'Angel One');
    }

    logger.info('liveMonitor', `Closed ${pos.symbol} on ${reason} @ ${price.toFixed(4)}`);
  } catch (e: any) {
    logger.error('liveMonitor', `Failed to close ${pos.symbol}: ${e.message}`);
  } finally {
    CLOSING_IN_FLIGHT.delete(pos.id);
  }
}

// ── Main monitoring function ──────────────────────────────────────────────────

/**
 * Called on every price update cycle (same as monitorOpenPositions for paper).
 * Checks all live positions for SL/TP breaches and closes automatically.
 */
export async function monitorLivePositions(
  prices:    Record<string, { price: number }>,
  aoSession: AOSession | null,
): Promise<void> {
  let portfolio;
  try { portfolio = await getLivePortfolio(); } catch { return; }
  if (!portfolio.openPositions.length) return;

  await Promise.allSettled(portfolio.openPositions.map(async pos => {
    // Map position symbol to price key
    // Paper and live may use different symbol formats — try both
    const priceInfo = prices[pos.symbol]
      ?? Object.values(prices).find((_, k) => k === pos.symbol);
    if (!priceInfo) return;

    const price = priceInfo.price;
    if (!price || price <= 0) return;

    const isLong = pos.direction === 'LONG';

    // Stop-loss breach
    if (pos.stopLoss > 0) {
      const slBreached = isLong ? price <= pos.stopLoss : price >= pos.stopLoss;
      if (slBreached) {
        await closeLivePosition(pos, 'STOP_LOSS', price, aoSession);
        return;
      }
    }

    // Take-profit breach
    if (pos.takeProfit > 0) {
      const tpBreached = isLong ? price >= pos.takeProfit : price <= pos.takeProfit;
      if (tpBreached) {
        await closeLivePosition(pos, 'TAKE_PROFIT', price, aoSession);
      }
    }
  }));
}
