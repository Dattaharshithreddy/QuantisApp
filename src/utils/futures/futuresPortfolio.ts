// ─────────────────────────────────────────────────────────────────────────────
// FUTURES PORTFOLIO  (v1.0.0)
//
// Persists open futures paper positions separately from equity paper positions.
// Key difference from equity: only MARGIN is debited on open, not full notional.
// MTM settlement debits/credits the margin account daily.
//
// Futures paper account starts separate from the equity paper account.
// This mirrors how real trading works — futures requires a dedicated F&O
// trading account and margin pool, separate from equity holdings.
// ─────────────────────────────────────────────────────────────────────────────

import AsyncStorage from '@react-native-async-storage/async-storage';
import { KVStore } from '../../services/storage';
import { logger } from '../logger';
import {
  FuturesPosition, MtmSettlement,
  computeFuturesPnL, LOT_SIZES, MARGIN_PCT,
  FuturesUnderlying,
} from './futuresTypes';

const PORTFOLIO_KEY  = 'futuresPortfolio_v1';
const MTM_LOG_KEY    = 'futuresMtmLog_v1';
const DEFAULT_CAPITAL = 500_000;   // ₹5 lakh default futures paper capital

export type FuturesPortfolioState = {
  cashBalance:        number;   // available margin (not invested)
  initialCapital:     number;
  openPositions:      FuturesPosition[];
  totalRealizedPnL:   number;
  totalMtmSettled:    number;
  lastSyncAt:         number;
  version:            number;
};

const DEFAULT_STATE: FuturesPortfolioState = {
  cashBalance:      DEFAULT_CAPITAL,
  initialCapital:   DEFAULT_CAPITAL,
  openPositions:    [],
  totalRealizedPnL: 0,
  totalMtmSettled:  0,
  lastSyncAt:       0,
  version:          1,
};

// ── Persistence ───────────────────────────────────────────────────────────────

export async function getFuturesPortfolio(): Promise<FuturesPortfolioState> {
  try {
    const raw = await KVStore.get(PORTFOLIO_KEY);
    return raw ? { ...DEFAULT_STATE, ...JSON.parse(raw) } : { ...DEFAULT_STATE };
  } catch (e: any) {
    logger.error('futuresPortfolio', `Read failed: ${e.message}`);
    return { ...DEFAULT_STATE };
  }
}

export async function saveFuturesPortfolio(state: FuturesPortfolioState): Promise<void> {
  try {
    await KVStore.set(PORTFOLIO_KEY, JSON.stringify(state));
  } catch (e: any) {
    logger.error('futuresPortfolio', `Save failed: ${e.message}`);
  }
}

export async function resetFuturesPortfolio(): Promise<void> {
  await KVStore.remove(PORTFOLIO_KEY).catch(() => {});
  await KVStore.remove(MTM_LOG_KEY).catch(() => {});
}

// ── MTM log ───────────────────────────────────────────────────────────────────

export async function getMtmLog(): Promise<MtmSettlement[]> {
  try {
    const raw = await KVStore.get(MTM_LOG_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

async function appendMtmEntry(entry: MtmSettlement): Promise<void> {
  const log = await getMtmLog();
  log.unshift(entry);
  if (log.length > 500) log.splice(500);
  await KVStore.set(MTM_LOG_KEY, JSON.stringify(log)).catch(() => {});
}

// ── Open position ─────────────────────────────────────────────────────────────

export type OpenFuturesResult =
  | { opened: true;  position: FuturesPosition }
  | { opened: false; reason: string };

export async function openFuturesPosition(params: {
  underlying:    FuturesUnderlying;
  contractSymbol: string;
  direction:     'LONG' | 'SHORT';
  lots:          number;
  entryPrice:    number;
  stopLoss:      number;
  takeProfit:    number;
  expiry:        number;
  expiryLabel:   string;
  signalSnapshot?: any;
}): Promise<OpenFuturesResult> {
  const portfolio = await getFuturesPortfolio();
  const lotSize   = LOT_SIZES[params.underlying];
  const qty       = params.lots * lotSize;
  const notional  = params.entryPrice * qty;
  const marginPct = MARGIN_PCT[params.underlying] / 100;
  const margin    = notional * marginPct;
  const fee       = notional * 0.0002;   // approx brokerage + STT + exchange charges

  // Validate
  if (params.lots <= 0) {
    return { opened: false, reason: 'Lot count must be at least 1.' };
  }
  if (margin + fee > portfolio.cashBalance) {
    return {
      opened: false,
      reason: `Insufficient margin. Required: ₹${(margin + fee).toFixed(0)}, Available: ₹${portfolio.cashBalance.toFixed(0)}.`};
  }
  // Duplicate position guard
  const existing = portfolio.openPositions.find(p => p.underlying === params.underlying);
  if (existing) {
    return {
      opened: false,
      reason: `Already have an open ${params.underlying} futures position. Close it before opening another.`};
  }

  const position: FuturesPosition = {
    id:             `fut_${Date.now()}_${params.underlying}`,
    underlying:     params.underlying,
    contractSymbol: params.contractSymbol,
    direction:      params.direction,
    lots:           params.lots,
    lotSize,
    qty,
    entryPrice:     params.entryPrice,
    entryTime:      Date.now(),
    expiry:         params.expiry,
    expiryLabel:    params.expiryLabel,
    stopLoss:       params.stopLoss,
    takeProfit:     params.takeProfit,
    notionalValue:  notional,
    marginBlocked:  margin,
    mtmSettledPnL:  0,
    lastMtmPrice:   params.entryPrice,
    lastMtmAt:      Date.now(),
    signalSnapshot: params.signalSnapshot ?? null};

  portfolio.openPositions.push(position);
  portfolio.cashBalance -= (margin + fee);
  await saveFuturesPortfolio(portfolio);

  logger.info('futuresPortfolio',
    `Opened ${params.direction} ${params.underlying} ${params.lots} lots @ ${params.entryPrice} ` +
    `| margin ₹${margin.toFixed(0)} | notional ₹${notional.toFixed(0)}`
  );

  return { opened: true, position };
}

// ── Close position ────────────────────────────────────────────────────────────

export type CloseFuturesResult = {
  closed:      true;
  totalPnL:    number;   // full P&L including all MTM already settled
  cashPnL:     number;   // P&L for today (not yet MTM settled)
  exitPrice:   number;
  reason:      string;
} | { closed: false; reason: string };

export async function closeFuturesPosition(
  positionId: string,
  exitPrice:  number,
  reason:     'STOP_LOSS' | 'TAKE_PROFIT' | 'MANUAL' | 'EXPIRY',
): Promise<CloseFuturesResult> {
  const portfolio = await getFuturesPortfolio();
  const idx       = portfolio.openPositions.findIndex(p => p.id === positionId);
  if (idx === -1) return { closed: false, reason: `Position ${positionId} not found.` };

  const pos       = portfolio.openPositions[idx];
  // P&L from lastMtmPrice to exit (today's portion not yet settled)
  const cashPnL   = computeFuturesPnL(pos.direction, pos.lastMtmPrice, exitPrice, pos.lots, pos.lotSize);
  // Total P&L = already-settled MTM + today's portion
  const totalPnL  = pos.mtmSettledPnL + cashPnL;
  const fee       = pos.notionalValue * 0.0002;

  portfolio.openPositions.splice(idx, 1);
  // Return margin + today's P&L (settled MTM was already credited during hold)
  portfolio.cashBalance    += pos.marginBlocked + cashPnL - fee;
  portfolio.totalRealizedPnL += totalPnL - fee;

  await saveFuturesPortfolio(portfolio);

  logger.info('futuresPortfolio',
    `Closed ${pos.underlying} ${pos.lots} lots @ ${exitPrice} | totalPnL ₹${totalPnL.toFixed(0)} | reason: ${reason}`
  );

  return { closed: true, totalPnL, cashPnL, exitPrice, reason };
}

// ── Daily MTM settlement ──────────────────────────────────────────────────────
// Called once per day at ~3:30pm IST (after market close).
// Debits/credits the difference from lastMtmPrice to today's close price.
// This mirrors NSE's daily MTM settlement process.

export async function runMtmSettlement(
  settlementPrices: Record<string, number>,  // underlying → settlement price
): Promise<MtmSettlement[]> {
  const portfolio    = await getFuturesPortfolio();
  const settlements: MtmSettlement[] = [];

  for (const pos of portfolio.openPositions) {
    const settlePrice = settlementPrices[pos.underlying];
    if (!settlePrice) continue;

    const pnlForDay    = computeFuturesPnL(pos.direction, pos.lastMtmPrice, settlePrice, pos.lots, pos.lotSize);
    pos.mtmSettledPnL += pnlForDay;
    pos.lastMtmPrice   = settlePrice;
    pos.lastMtmAt      = Date.now();

    portfolio.cashBalance    += pnlForDay;  // MTM credit/debit to margin account
    portfolio.totalMtmSettled += pnlForDay;

    const entry: MtmSettlement = {
      positionId:    pos.id,
      settledAt:     Date.now(),
      settlePrice,
      pnlForDay,
      cumulativeMtm: pos.mtmSettledPnL};
    settlements.push(entry);
    await appendMtmEntry(entry);

    logger.info('futuresPortfolio',
      `MTM settled ${pos.underlying}: ₹${pnlForDay.toFixed(0)} (cumulative: ₹${pos.mtmSettledPnL.toFixed(0)})`
    );
  }

  if (settlements.length > 0) await saveFuturesPortfolio(portfolio);
  return settlements;
}

// ── SL/TP monitoring ──────────────────────────────────────────────────────────

export async function monitorFuturesPositions(
  livePrices: Record<string, number>,
): Promise<void> {
  const portfolio = await getFuturesPortfolio();
  if (!portfolio.openPositions.length) return;

  let changed = false;
  const toClose: { pos: FuturesPosition; price: number; reason: 'STOP_LOSS' | 'TAKE_PROFIT' | 'EXPIRY' }[] = [];

  for (const pos of portfolio.openPositions) {
    const price = livePrices[pos.underlying] ?? livePrices[pos.contractSymbol];
    if (!price) continue;

    // Check expiry
    if (Date.now() >= pos.expiry) {
      toClose.push({ pos, price, reason: 'EXPIRY' });
      continue;
    }

    // Check SL/TP
    if (pos.direction === 'LONG') {
      if (price <= pos.stopLoss)  toClose.push({ pos, price, reason: 'STOP_LOSS' });
      if (price >= pos.takeProfit) toClose.push({ pos, price, reason: 'TAKE_PROFIT' });
    } else {
      if (price >= pos.stopLoss)  toClose.push({ pos, price, reason: 'STOP_LOSS' });
      if (price <= pos.takeProfit) toClose.push({ pos, price, reason: 'TAKE_PROFIT' });
    }
  }

  for (const { pos, price, reason } of toClose) {
    await closeFuturesPosition(pos.id, price, reason);
    changed = true;
    logger.info('futuresPortfolio', `Auto-closed ${pos.underlying} futures: ${reason} @ ${price}`);
  }
}

// ── Update SL/TP ──────────────────────────────────────────────────────────────

export async function updateFuturesPosition(
  positionId: string,
  updates: Partial<Pick<FuturesPosition, 'stopLoss' | 'takeProfit'>>,
): Promise<boolean> {
  const portfolio = await getFuturesPortfolio();
  const idx = portfolio.openPositions.findIndex(p => p.id === positionId);
  if (idx === -1) return false;
  Object.assign(portfolio.openPositions[idx], updates);
  await saveFuturesPortfolio(portfolio);
  logger.info('futuresPortfolio', `Updated position ${positionId}: ${JSON.stringify(updates)}`);
  return true;
}
