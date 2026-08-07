// ─────────────────────────────────────────────────────────────────────────────
// BINANCE FUTURES PORTFOLIO  (v1.0.0)
//
// Paper trading portfolio for Binance USDT-Margined perpetual futures.
// Isolated margin model — each position has its own margin allocation.
// Funding payments are applied every 8 hours automatically.
//
// Key accounting rules:
//   open:  cashBalance -= isolatedMargin (margin locked per position)
//   close: cashBalance += isolatedMargin + pnl - closingFee
//   funding (every 8h): cashBalance += fundingPayment (can be positive or negative)
//   liquidation: position closed at liquidationPrice, margin returned = 0
// ─────────────────────────────────────────────────────────────────────────────

import AsyncStorage from '@react-native-async-storage/async-storage';
import { logger } from '../../logger';
import {
  BnFuturesPosition, BnFuturesSymbol, BnFundingPayment,
  BN_CONTRACT_SPECS, BnContractSpec,
  computeIsolatedMargin, computeLiquidationPrice, computeBnPnL,
  computeFundingPayment, isLiquidated, clampLeverage,
} from './bnFuturesTypes';

const PORTFOLIO_KEY  = 'bnFuturesPortfolio_v1';
const FUNDING_LOG_KEY = 'bnFundingLog_v1';
const DEFAULT_CAPITAL = 10_000;   // $10,000 USDT starting capital

export type BnFuturesPortfolioState = {
  usdtBalance:       number;
  initialCapital:    number;
  openPositions:     BnFuturesPosition[];
  totalRealizedPnL:  number;
  totalFundingPaid:  number;   // negative = paid, positive = received
  version:           number;
};

const DEFAULT_STATE: BnFuturesPortfolioState = {
  usdtBalance:      DEFAULT_CAPITAL,
  initialCapital:   DEFAULT_CAPITAL,
  openPositions:    [],
  totalRealizedPnL: 0,
  totalFundingPaid: 0,
  version:          1,
};

// ── Persistence ───────────────────────────────────────────────────────────────

export async function getBnFuturesPortfolio(): Promise<BnFuturesPortfolioState> {
  try {
    const raw = await AsyncStorage.getItem(PORTFOLIO_KEY);
    return raw ? { ...DEFAULT_STATE, ...JSON.parse(raw) } : { ...DEFAULT_STATE };
  } catch (e: any) {
    logger.error('bnFuturesPortfolio', `Read failed: ${e.message}`);
    return { ...DEFAULT_STATE };
  }
}

export async function saveBnFuturesPortfolio(state: BnFuturesPortfolioState): Promise<void> {
  try {
    await AsyncStorage.setItem(PORTFOLIO_KEY, JSON.stringify(state));
  } catch (e: any) {
    logger.error('bnFuturesPortfolio', `Save failed: ${e.message}`);
  }
}

export async function resetBnFuturesPortfolio(): Promise<void> {
  await AsyncStorage.multiRemove([PORTFOLIO_KEY, FUNDING_LOG_KEY]).catch(() => {});
}

// ── Funding log ───────────────────────────────────────────────────────────────

export async function getFundingLog(): Promise<BnFundingPayment[]> {
  try {
    const raw = await AsyncStorage.getItem(FUNDING_LOG_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

async function appendFundingEntry(entry: BnFundingPayment): Promise<void> {
  const log = await getFundingLog();
  log.unshift(entry);
  if (log.length > 500) log.splice(500);
  await AsyncStorage.setItem(FUNDING_LOG_KEY, JSON.stringify(log)).catch(() => {});
}

// ── Open position ─────────────────────────────────────────────────────────────

export type OpenBnFuturesResult =
  | { opened: true;  position: BnFuturesPosition }
  | { opened: false; reason: string };

export async function openBnFuturesPosition(params: {
  symbol:      BnFuturesSymbol;
  direction:   'LONG' | 'SHORT';
  qty:         number;
  entryPrice:  number;
  leverage:    number;
  stopLoss:    number;
  takeProfit:  number;
  signalSnapshot?: any;
}): Promise<OpenBnFuturesResult> {
  const portfolio = await getBnFuturesPortfolio();
  const spec      = BN_CONTRACT_SPECS[params.symbol];
  const leverage  = clampLeverage(params.leverage, params.symbol);

  // Validate qty against step size
  const steps     = Math.round(params.qty / spec.qtyStep);
  const qty       = parseFloat((steps * spec.qtyStep).toFixed(8));
  if (qty < spec.minQty) {
    return { opened: false, reason: `Minimum qty for ${params.symbol} is ${spec.minQty} contracts.` };
  }

  const notional        = qty * params.entryPrice;
  const isolatedMargin  = computeIsolatedMargin(qty, params.entryPrice, leverage, spec.takerFeeRate);
  const liqPrice        = computeLiquidationPrice(params.direction, params.entryPrice, leverage);

  // Duplicate guard — one position per symbol
  const existing = portfolio.openPositions.find(p => p.symbol === params.symbol);
  if (existing) {
    return { opened: false, reason: `Already have an open ${params.symbol} position. Close it first.` };
  }

  if (isolatedMargin > portfolio.usdtBalance) {
    return {
      opened: false,
      reason: `Insufficient balance. Need $${isolatedMargin.toFixed(2)}, have $${portfolio.usdtBalance.toFixed(2)} USDT.`};
  }

  const position: BnFuturesPosition = {
    id:              `bnf_${Date.now()}_${params.symbol}`,
    symbol:          params.symbol,
    direction:       params.direction,
    qty,
    leverage,
    entryPrice:      params.entryPrice,
    entryTime:       Date.now(),
    stopLoss:        params.stopLoss,
    takeProfit:      params.takeProfit,
    isolatedMargin,
    liquidationPrice: liqPrice,
    notionalValue:   notional,
    unrealisedPnL:   0,
    fundingAccrued:  0,
    lastFundingAt:   Date.now(),
    signalSnapshot:  params.signalSnapshot ?? null};

  portfolio.openPositions.push(position);
  portfolio.usdtBalance -= isolatedMargin;
  await saveBnFuturesPortfolio(portfolio);

  logger.info('bnFuturesPortfolio',
    `Opened ${params.direction} ${qty}×${params.symbol} @ $${params.entryPrice} ` +
    `${leverage}× | margin $${isolatedMargin.toFixed(2)} | liq $${liqPrice.toFixed(2)}`
  );

  return { opened: true, position };
}

// ── Close position ────────────────────────────────────────────────────────────

export type CloseBnFuturesResult =
  | { closed: true;  pnl: number; exitPrice: number; reason: string }
  | { closed: false; reason: string };

export async function closeBnFuturesPosition(
  positionId: string,
  exitPrice:  number,
  reason:     'STOP_LOSS' | 'TAKE_PROFIT' | 'MANUAL' | 'LIQUIDATION',
): Promise<CloseBnFuturesResult> {
  const portfolio = await getBnFuturesPortfolio();
  const idx       = portfolio.openPositions.findIndex(p => p.id === positionId);
  if (idx === -1) return { closed: false, reason: `Position ${positionId} not found.` };

  const pos  = portfolio.openPositions[idx];
  const spec = BN_CONTRACT_SPECS[pos.symbol];
  const pnl  = computeBnPnL(pos.direction, pos.entryPrice, exitPrice, pos.qty);
  const fee  = pos.qty * exitPrice * spec.takerFeeRate;

  // On liquidation: margin is forfeited (returned = 0 minus remaining margin)
  const marginReturned = reason === 'LIQUIDATION' ? 0 : pos.isolatedMargin;

  portfolio.openPositions.splice(idx, 1);
  portfolio.usdtBalance    += marginReturned + pnl - fee;
  portfolio.totalRealizedPnL += pnl - fee;
  await saveBnFuturesPortfolio(portfolio);

  logger.info('bnFuturesPortfolio',
    `Closed ${pos.symbol} ${pos.direction} @ $${exitPrice} | P&L $${pnl.toFixed(2)} | reason: ${reason}`
  );

  return { closed: true, pnl: pnl - fee, exitPrice, reason };
}

// ── Funding payment (called every 8 hours) ────────────────────────────────────

const FUNDING_INTERVAL_MS = 8 * 60 * 60 * 1000;   // 8 hours

export async function applyFundingPayments(
  currentPrices:  Record<string, number>,  // symbol → mark price
  fundingRates:   Record<string, number>,  // symbol → 8h funding rate
): Promise<BnFundingPayment[]> {
  const portfolio = await getBnFuturesPortfolio();
  if (!portfolio.openPositions.length) return [];

  const now      = Date.now();
  const payments: BnFundingPayment[] = [];

  for (const pos of portfolio.openPositions) {
    // Only apply if 8 hours have elapsed since last funding
    if (now - pos.lastFundingAt < FUNDING_INTERVAL_MS) continue;

    const markPrice  = currentPrices[pos.symbol] ?? pos.entryPrice;
    const rate       = fundingRates[pos.symbol]  ?? 0;
    const payment    = computeFundingPayment(pos.direction, pos.qty, markPrice, rate);

    pos.fundingAccrued  += payment;
    pos.lastFundingAt    = now;
    portfolio.usdtBalance += payment;
    portfolio.totalFundingPaid += payment;

    const entry: BnFundingPayment = {
      positionId:  pos.id,
      symbol:      pos.symbol,
      paidAt:      now,
      fundingRate: rate,
      payment,
      direction:   pos.direction};
    payments.push(entry);
    await appendFundingEntry(entry);

    logger.info('bnFuturesPortfolio',
      `Funding ${pos.symbol} ${pos.direction}: ${payment >= 0 ? '+' : ''}$${payment.toFixed(4)} ` +
      `(rate ${(rate * 100).toFixed(4)}%)`
    );
  }

  if (payments.length > 0) await saveBnFuturesPortfolio(portfolio);
  return payments;
}

// ── Live P&L update + SL/TP/Liquidation monitor ──────────────────────────────

export async function monitorBnFuturesPositions(
  livePrices:   Record<string, number>,
  fundingRates: Record<string, number> = {},
): Promise<void> {
  const portfolio = await getBnFuturesPortfolio();
  if (!portfolio.openPositions.length) return;

  // Apply funding first
  await applyFundingPayments(livePrices, fundingRates);

  // Re-read after funding (balance may have changed)
  const refreshed = await getBnFuturesPortfolio();
  let changed = false;
  const toClose: { pos: BnFuturesPosition; price: number; reason: 'STOP_LOSS' | 'TAKE_PROFIT' | 'LIQUIDATION' }[] = [];

  for (const pos of refreshed.openPositions) {
    const price = livePrices[pos.symbol];
    if (!price) continue;

    // Update unrealised P&L in place
    pos.unrealisedPnL = computeBnPnL(pos.direction, pos.entryPrice, price, pos.qty);
    changed = true;

    // Liquidation check (highest priority)
    if (isLiquidated(pos, price)) {
      toClose.push({ pos, price: pos.liquidationPrice, reason: 'LIQUIDATION' });
      continue;
    }

    // SL/TP check
    if (pos.direction === 'LONG') {
      if (price <= pos.stopLoss)   toClose.push({ pos, price, reason: 'STOP_LOSS' });
      if (price >= pos.takeProfit) toClose.push({ pos, price, reason: 'TAKE_PROFIT' });
    } else {
      if (price >= pos.stopLoss)   toClose.push({ pos, price, reason: 'STOP_LOSS' });
      if (price <= pos.takeProfit) toClose.push({ pos, price, reason: 'TAKE_PROFIT' });
    }
  }

  if (changed) await saveBnFuturesPortfolio(refreshed);

  for (const { pos, price, reason } of toClose) {
    await closeBnFuturesPosition(pos.id, price, reason);
    logger.info('bnFuturesPortfolio', `Auto-closed ${pos.symbol}: ${reason} @ $${price}`);
  }
}

// ── Update SL/TP ──────────────────────────────────────────────────────────────

export async function updateBnFuturesPosition(
  positionId: string,
  updates: Partial<Pick<BnFuturesPosition, 'stopLoss' | 'takeProfit'>>,
): Promise<boolean> {
  const portfolio = await getBnFuturesPortfolio();
  const idx = portfolio.openPositions.findIndex(p => p.id === positionId);
  if (idx === -1) return false;
  Object.assign(portfolio.openPositions[idx], updates);
  await saveBnFuturesPortfolio(portfolio);
  logger.info('bnFuturesPortfolio', `Updated position ${positionId}: ${JSON.stringify(updates)}`);
  return true;
}
