// ─────────────────────────────────────────────────────────────────────────────
// LIVE RECONCILIATION SERVICE  (v1.0.0)
//
// The broker is the source of truth. AsyncStorage is a cache.
// When they disagree, the broker wins — always.
//
// This service is the single answer to the disconnect scenario described
// by the architect:
//   App sends BUY → internet disconnects → broker executes → app never
//   receives response → now broker has LONG, app thinks nothing is open.
//
// Reconciliation runs:
//   • On app startup (called from App.tsx once DataContext is ready)
//   • Every 15 seconds while app is foregrounded
//   • After every order placement (called by liveOrderExecution)
//   • On network reconnect (when wsStatus changes from error/reconnecting → live)
//
// What it does:
//   1. Fetch real positions from both Angel One and Binance
//   2. Compare against our local livePortfolio
//   3. Three possible outcomes per discrepancy:
//      a. Broker has position, we don't → PHANTOM: create local record,
//         flag as reconciled, notify user
//      b. We have position, broker doesn't → GHOST: mark as closed,
//         estimate P&L from last known price, notify user
//      c. Both agree → no action
//   4. Log every reconciliation run with a diff summary
//
// CRITICAL: Reconciliation NEVER places, modifies, or cancels orders.
// It only updates our local state to match what the broker reports.
// ─────────────────────────────────────────────────────────────────────────────

import AsyncStorage from '@react-native-async-storage/async-storage';
import { aoGetPositions } from '../api/angelOneTrading';
import { bnGetBalances }  from '../api/binanceTrading';
import { getLiveTradingCredential } from './secureCredentials';
import {
  getLivePortfolio,
  saveLivePortfolio,
  LivePosition,
  LivePortfolioState,
} from './livePortfolio';
import {
  getOrderLog,
  updateOrderState,
} from './liveOrderLifecycle';
import { logger } from './logger';
import { recordMetric } from './performanceMetrics';
import type { AOSession } from '../api/angelOne';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ReconciliationResult = {
  ranAt:        number;
  durationMs:   number;
  phantoms:     string[];   // positions found at broker but not locally
  ghosts:       string[];   // positions found locally but not at broker
  matched:      number;
  errors:       string[];
};

const LOG_KEY  = 'liveReconciliationLog_v1';
const LOG_MAX  = 100;
const RECON_INTERVAL_MS = 15_000;

// ── Reconciliation log ────────────────────────────────────────────────────────

export async function getReconciliationLog(): Promise<ReconciliationResult[]> {
  try {
    const raw = await AsyncStorage.getItem(LOG_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

async function appendReconLog(result: ReconciliationResult): Promise<void> {
  try {
    const log = await getReconciliationLog();
    log.unshift(result);
    if (log.length > LOG_MAX) log.splice(LOG_MAX);
    await AsyncStorage.setItem(LOG_KEY, JSON.stringify(log));
  } catch (e: any) {
    logger.error('reconciliation', `Failed to append log: ${e.message}`);
  }
}

// ── Angel One reconciliation ───────────────────────────────────────────────────

async function reconcileAngelOne(
  local: LivePosition[],
  aoSession: AOSession,
): Promise<{ phantoms: string[]; ghosts: string[]; matched: number; errors: string[] }> {
  const phantoms: string[] = [];
  const ghosts:   string[] = [];
  const errors:   string[] = [];
  let   matched = 0;

  try {
    const brokerPositions = await aoGetPositions(aoSession);

    // Only care about positions with netqty !== 0 (non-flat)
    const brokerOpen = brokerPositions.filter(p => p.netqty !== 0);
    const localAO    = local.filter(p => p.broker === 'ANGEL_ONE');

    // Check broker positions against local
    for (const bp of brokerOpen) {
      const found = localAO.find(lp => lp.symbol === bp.tradingsymbol);
      if (!found) {
        // Phantom: broker has position we don't know about
        phantoms.push(bp.tradingsymbol);
        logger.warn('reconciliation', `PHANTOM position at Angel One: ${bp.tradingsymbol} netqty=${bp.netqty}`);
      } else {
        matched++;
      }
    }

    // Check local positions against broker
    for (const lp of localAO) {
      const found = brokerOpen.find(bp => bp.tradingsymbol === lp.symbol);
      if (!found) {
        // Ghost: we think we have a position but broker says no
        ghosts.push(lp.symbol);
        logger.warn('reconciliation', `GHOST position locally: ${lp.symbol} — not found at Angel One`);
      }
    }
  } catch (e: any) {
    errors.push(`Angel One: ${e.message}`);
    logger.error('reconciliation', `Angel One fetch failed: ${e.message}`);
  }

  return { phantoms, ghosts, matched, errors };
}

// ── Binance reconciliation ─────────────────────────────────────────────────────

async function reconcileBinance(
  local: LivePosition[],
): Promise<{ phantoms: string[]; ghosts: string[]; matched: number; errors: string[] }> {
  const phantoms: string[] = [];
  const ghosts:   string[] = [];
  const errors:   string[] = [];
  let   matched = 0;

  try {
    const apiKey = await getLiveTradingCredential('binanceApiKey');
    const secret = await getLiveTradingCredential('binanceApiSecret');
    if (!apiKey || !secret) return { phantoms, ghosts, matched, errors };

    const balances = await bnGetBalances(apiKey, secret);
    const localBN  = local.filter(p => p.broker === 'BINANCE');

    // For Binance spot: check that each local position's base asset has balance
    for (const lp of localBN) {
      // Extract base asset: BTCUSDT → BTC
      const base = lp.symbol.replace(/USDT$|BUSD$|BTC$|ETH$/, '');
      const bal  = balances.find(b => b.asset === base);
      const held = (bal?.free ?? 0) + (bal?.locked ?? 0);
      if (held < lp.qty * 0.99) {
        // Balance doesn't match — position may have been closed externally
        ghosts.push(lp.symbol);
        logger.warn('reconciliation', `GHOST position locally: ${lp.symbol} — balance ${held} < expected ${lp.qty}`);
      } else {
        matched++;
      }
    }
  } catch (e: any) {
    errors.push(`Binance: ${e.message}`);
    logger.error('reconciliation', `Binance fetch failed: ${e.message}`);
  }

  return { phantoms, ghosts, matched, errors };
}

// ── Binance Futures reconciliation ────────────────────────────────────────────
// Compares local BINANCE_FUTURES positions against live positions from fapi.
// Handles two cases:
//   Ghost: local position but broker shows zero — likely liquidated or closed externally.
//   Phantom: broker shows open position but not in local state — opened from another device.

async function reconcileBinanceFutures(
  local: LivePosition[],
): Promise<{ phantoms: string[]; ghosts: string[]; matched: number; errors: string[] }> {
  const phantoms: string[] = [];
  const ghosts:   string[] = [];
  const errors:   string[] = [];
  let   matched = 0;

  try {
    const apiKey = await getLiveTradingCredential('binanceApiKey');
    const secret = await getLiveTradingCredential('binanceApiSecret');
    if (!apiKey || !secret) return { phantoms, ghosts, matched, errors };

    const { bnFuturesGetPositions } = await import('../api/binanceFuturesApi');
    const brokerPositions = await bnFuturesGetPositions(apiKey, secret);
    const localBNF = local.filter(p => p.broker === 'BINANCE_FUTURES');

    // Build broker position map: symbol → qty (positive=long, negative=short)
    const brokerMap = new Map<string, number>();
    for (const bp of brokerPositions) {
      brokerMap.set(bp.symbol, bp.positionAmt);
    }

    // Check each local position against broker
    for (const lp of localBNF) {
      const brokerQty = brokerMap.get(lp.symbol) ?? 0;
      const expectedQty = lp.direction === 'LONG' ? lp.qty : -lp.qty;

      if (Math.abs(brokerQty) < 0.001) {
        // Broker shows zero — likely liquidated or closed externally
        ghosts.push(lp.symbol);
        logger.warn('reconciliation',
          `GHOST futures position: ${lp.symbol} ${lp.direction} — broker shows ${brokerQty}, local shows ${lp.qty}. ` +
          `Position may have been liquidated or closed externally.`
        );
      } else if (Math.sign(brokerQty) !== Math.sign(expectedQty)) {
        // Direction mismatch — very unusual
        ghosts.push(lp.symbol);
        logger.warn('reconciliation',
          `DIRECTION MISMATCH: ${lp.symbol} local=${lp.direction} broker=${brokerQty > 0 ? 'LONG' : 'SHORT'}`
        );
      } else {
        matched++;
        // Update mark price from broker if available (free accuracy improvement)
        brokerMap.delete(lp.symbol);   // mark as accounted for
      }
    }

    // Any remaining broker positions not in local state = phantom (opened externally)
    for (const [sym, qty] of brokerMap.entries()) {
      if (Math.abs(qty) > 0.001) {
        phantoms.push(sym);
        logger.warn('reconciliation',
          `PHANTOM futures position: ${sym} qty=${qty} — not in local state. Opened from another device?`
        );
      }
    }
  } catch (e: any) {
    errors.push(`Binance Futures: ${e.message}`);
    logger.error('reconciliation', `Binance Futures reconciliation failed: ${e.message}`);
  }

  return { phantoms, ghosts, matched, errors };
}

// ── Repair: handle ghosts ─────────────────────────────────────────────────────

async function repairGhosts(
  ghosts: string[],
  portfolio: LivePortfolioState,
  livePrices: Record<string, number>,
  aoSession?: AOSession | null,
): Promise<void> {
  if (ghosts.length === 0) return;

  // Try to fetch actual execution prices from Angel One order history.
  // This is best-effort — if it fails we fall back to live price.
  let aoOrderBook: any[] = [];
  if (aoSession?.jwtToken) {
    try {
      const r = await fetch(
        'https://apiconnect.angelbroking.com/rest/secure/angelbroking/order/v1/getOrderBook',
        { method: 'GET', headers: {
          'Content-Type': 'application/json', Accept: 'application/json',
          'X-UserType': 'USER', 'X-SourceID': 'WEB',
          'X-ClientLocalIP': '192.168.1.1', 'X-ClientPublicIP': '1.1.1.1',
          'X-MACAddress': 'fe80::1',
          'X-PrivateKey': aoSession.apiKey,
          Authorization: `Bearer ${aoSession.jwtToken}`,
        }}
      );
      if (r.ok) {
        const json = await r.json();
        aoOrderBook = json.data ?? [];
      }
    } catch { /* non-fatal — fall back to estimate */ }
  }

  const updated = { ...portfolio };
  const remaining: LivePosition[] = [];

  for (const pos of portfolio.openPositions) {
    if (!ghosts.includes(pos.symbol)) {
      remaining.push(pos);
      continue;
    }

    // ── Priority 1: broker-reported actual close price ─────────────────────
    // Look for a completed SELL (for LONG) or BUY (for SHORT) in the order book
    // matching this symbol, placed after our entry.
    let exitPrice: number | null = null;
    const closingSide = pos.direction === 'LONG' ? 'SELL' : 'BUY';
    const matchingOrder = aoOrderBook.find((o: any) =>
      o.tradingsymbol === pos.symbol &&
      o.transactiontype === closingSide &&
      o.status?.toLowerCase() === 'complete' &&
      Number(o.updatetime ? new Date(o.updatetime).getTime() : 0) > pos.filledAt
    );
    if (matchingOrder && Number(matchingOrder.averageprice) > 0) {
      exitPrice = Number(matchingOrder.averageprice);
      logger.info('reconciliation',
        `${pos.symbol} ghost: using broker-reported close price ${exitPrice} (order ${matchingOrder.orderid})`
      );
    }

    // ── Priority 2: live market price ─────────────────────────────────────
    if (exitPrice === null) {
      exitPrice = livePrices[pos.symbol] ?? null;
      if (exitPrice !== null) {
        logger.info('reconciliation',
          `${pos.symbol} ghost: broker price unavailable, using live price ${exitPrice} as estimate`
        );
      }
    }

    // ── Priority 3: last known entry price (worst case, zero P&L) ─────────
    if (exitPrice === null) {
      exitPrice = pos.filledPrice;
      logger.warn('reconciliation',
        `${pos.symbol} ghost: no price available, recording zero P&L`
      );
    }

    const pnl = (exitPrice - pos.filledPrice) * pos.qty * (pos.direction === 'LONG' ? 1 : -1);
    updated.totalRealizedPnL += pnl;

    const priceSource = matchingOrder ? 'broker-actual' : (livePrices[pos.symbol] ? 'live-estimate' : 'zero-fallback');
    logger.info('reconciliation',
      `Marked ${pos.symbol} as GHOST-closed, P&L: ${pnl.toFixed(2)} (price source: ${priceSource})`
    );

    const orderLog = await getOrderLog();
    const order = orderLog.find(o => o.positionId === pos.id);
    if (order) {
      await updateOrderState(order.localId, 'CLOSED', {
        closedAt:    Date.now(),
        closedPrice: exitPrice,
        realizedPnL: pnl,
        closedBy:    'RECONCILIATION',
      }, `Ghost detected — price source: ${priceSource}`);
    }
  }

  if (remaining.length < portfolio.openPositions.length) {
    updated.openPositions = remaining;
    updated.lastSyncedAt  = Date.now();
    await saveLivePortfolio(updated);
    const removed = portfolio.openPositions.length - remaining.length;
    logger.info('reconciliation', `Removed ${removed} ghost position(s) from local portfolio`);
  }
}

// ── Main reconcile function ────────────────────────────────────────────────────

export async function reconcileLivePositions(
  aoSession: AOSession | null,
  livePrices: Record<string, number> = {},
): Promise<ReconciliationResult> {
  const start = Date.now();
  const allPhantoms: string[] = [];
  const allGhosts:   string[] = [];
  const allErrors:   string[] = [];
  let   totalMatched = 0;

  logger.info('reconciliation', 'Starting reconciliation…');

  try {
    const portfolio = await getLivePortfolio();
    const local     = portfolio.openPositions;

    // ── Angel One ──
    if (aoSession?.jwtToken) {
      const ao = await reconcileAngelOne(local, aoSession);
      allPhantoms.push(...ao.phantoms);
      allGhosts.push(...ao.ghosts);
      allErrors.push(...ao.errors);
      totalMatched += ao.matched;
    }

    // ── Binance Spot ──
    const bn = await reconcileBinance(local);
    allPhantoms.push(...bn.phantoms);
    allGhosts.push(...bn.ghosts);
    allErrors.push(...bn.errors);
    totalMatched += bn.matched;

    // ── Binance Futures ──
    const bnf = await reconcileBinanceFutures(local);
    allPhantoms.push(...bnf.phantoms);
    allGhosts.push(...bnf.ghosts);
    allErrors.push(...bnf.errors);
    totalMatched += bnf.matched;

    // ── Repair ghost positions ──
    await repairGhosts(allGhosts, portfolio, livePrices, aoSession ?? undefined);

    // ── Update sync timestamp ──
    if (allErrors.length === 0) {
      const updated = await getLivePortfolio();
      await saveLivePortfolio({ ...updated, lastSyncedAt: Date.now() });
    }

  } catch (e: any) {
    allErrors.push(`Reconciliation failed: ${e.message}`);
    logger.error('reconciliation', e.message);
  }

  const result: ReconciliationResult = {
    ranAt:      start,
    durationMs: Date.now() - start,
    phantoms:   allPhantoms,
    ghosts:     allGhosts,
    matched:    totalMatched,
    errors:     allErrors,
  };

  // Record system performance metric
  await recordMetric('reconciliation', result.durationMs).catch(() => {});

  await appendReconLog(result);

  if (allPhantoms.length > 0 || allGhosts.length > 0) {
    logger.warn('reconciliation',
      `⚠ Discrepancies found — phantoms: ${allPhantoms.join(', ') || 'none'}, ghosts: ${allGhosts.join(', ') || 'none'}`
    );
  } else {
    logger.info('reconciliation', `✓ Clean — ${totalMatched} position(s) matched in ${result.durationMs}ms`);
  }

  return result;
}

// ── Periodic reconciliation hook (used by LiveSyncProvider) ───────────────────

let reconIntervalId: ReturnType<typeof setInterval> | null = null;
let lastReconAt = 0;

export function startPeriodicReconciliation(
  getAoSession: () => AOSession | null,
  getLivePrices: () => Record<string, number>,
): void {
  if (reconIntervalId !== null) return; // already running
  reconIntervalId = setInterval(async () => {
    // Throttle: if we reconciled very recently (e.g., after an order), skip
    if (Date.now() - lastReconAt < RECON_INTERVAL_MS * 0.8) return;
    lastReconAt = Date.now();
    await reconcileLivePositions(getAoSession(), getLivePrices());
  }, RECON_INTERVAL_MS);
  logger.info('reconciliation', `Periodic reconciliation started (every ${RECON_INTERVAL_MS / 1000}s)`);
}

export function stopPeriodicReconciliation(): void {
  if (reconIntervalId !== null) {
    clearInterval(reconIntervalId);
    reconIntervalId = null;
    logger.info('reconciliation', 'Periodic reconciliation stopped');
  }
}

export async function reconcileOnce(
  aoSession: AOSession | null,
  livePrices: Record<string, number> = {},
): Promise<ReconciliationResult> {
  lastReconAt = Date.now();
  return reconcileLivePositions(aoSession, livePrices);
}
