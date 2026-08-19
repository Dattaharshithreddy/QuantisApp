// ─────────────────────────────────────────────────────────────────────────────
// LIVE ORDER LIFECYCLE  (v1.0.0)
//
// Every real order moves through a well-defined set of states.
// This file owns the lifecycle type, the append-only order log,
// and the state-transition helpers.
//
// Lifecycle:
//   CREATED       → order object built locally, not yet sent to broker
//   SUBMITTED     → placed with broker API, awaiting acknowledgement
//   ACKNOWLEDGED  → broker accepted the order (has an orderId)
//   FILLED        → fully executed, position is open
//   PARTIALLY_FILLED → some shares filled, remainder still working
//   CLOSED        → position closed (by SL, TP, or manual close)
//   CANCELLED     → order cancelled before fill
//   REJECTED      → broker rejected the order
//   FAILED        → network/timeout failure before broker confirmed receipt
//
// Design rules:
//   • States only move FORWARD. No valid transition goes backward.
//   • AsyncStorage is a cache. Broker is always source of truth on FILLED state.
//   • Every state transition is logged with a timestamp and reason.
//   • orderLog is append-only — never mutated, only appended.
// ─────────────────────────────────────────────────────────────────────────────

import AsyncStorage from '@react-native-async-storage/async-storage';
import { KVStore } from '../services/storage';
import { logger } from './logger';

// ── Types ─────────────────────────────────────────────────────────────────────

export type LiveOrderState =
  | 'CREATED'
  | 'SUBMITTED'
  | 'ACKNOWLEDGED'
  | 'FILLED'
  | 'PARTIALLY_FILLED'
  | 'CLOSED'
  | 'CANCELLED'
  | 'REJECTED'
  | 'FAILED';

export type LiveOrderStateTransition = {
  from:      LiveOrderState;
  to:        LiveOrderState;
  at:        number;          // Unix ms
  reason?:   string;
};

export type LiveOrderRecord = {
  // ── Identity ───────────────────────────────────────────────────────────────
  localId:       string;      // QUANTIS-generated, stable across lifecycle
  brokerOrderId: string | null; // null until ACKNOWLEDGED
  broker:        'ANGEL_ONE' | 'BINANCE';
  symbol:        string;
  direction:     'LONG' | 'SHORT';
  assetSrc:      'ao' | 'binance';

  // ── Order parameters ───────────────────────────────────────────────────────
  requestedQty:   number;
  requestedPrice: number;     // 0 for market orders
  orderType:      'MARKET' | 'LIMIT';
  stopLoss:       number;
  takeProfit:     number;

  // ── Execution results ──────────────────────────────────────────────────────
  filledQty:    number;
  filledPrice:  number;
  fees:         number;
  filledAt:     number | null;

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  state:        LiveOrderState;
  history:      LiveOrderStateTransition[];
  createdAt:    number;
  updatedAt:    number;

  // ── Linked portfolio position ──────────────────────────────────────────────
  positionId:   string | null;  // set when FILLED
  closedBy?:    'STOP_LOSS' | 'TAKE_PROFIT' | 'MANUAL' | 'RECONCILIATION';
  closedAt?:    number;
  closedPrice?: number;
  realizedPnL?: number;
};

// ── Valid forward transitions ─────────────────────────────────────────────────

const VALID_TRANSITIONS: Partial<Record<LiveOrderState, LiveOrderState[]>> = {
  CREATED:          ['SUBMITTED', 'FAILED'],
  SUBMITTED:        ['ACKNOWLEDGED', 'REJECTED', 'FAILED', 'CANCELLED'],
  ACKNOWLEDGED:     ['FILLED', 'PARTIALLY_FILLED', 'CANCELLED', 'REJECTED'],
  PARTIALLY_FILLED: ['FILLED', 'CANCELLED'],
  FILLED:           ['CLOSED'],
};

export function isValidTransition(from: LiveOrderState, to: LiveOrderState): boolean {
  return (VALID_TRANSITIONS[from] ?? []).includes(to);
}

// ── Terminal states ────────────────────────────────────────────────────────────

export const TERMINAL_STATES: LiveOrderState[] = [
  'CLOSED', 'CANCELLED', 'REJECTED', 'FAILED',
];

export function isTerminal(state: LiveOrderState): boolean {
  return TERMINAL_STATES.includes(state);
}

// ── AsyncStorage persistence ───────────────────────────────────────────────────

const KEY     = 'liveOrderLog_v1';
const MAX_LOG = 1000;

export async function getOrderLog(): Promise<LiveOrderRecord[]> {
  try {
    const raw = await KVStore.get(KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e: any) {
    logger.error('orderLifecycle', `Failed to read order log: ${e.message}`);
    return [];
  }
}

export async function appendOrder(record: LiveOrderRecord): Promise<void> {
  try {
    const log = await getOrderLog();
    log.unshift(record);
    if (log.length > MAX_LOG) log.splice(MAX_LOG);
    await KVStore.set(KEY, JSON.stringify(log));
  } catch (e: any) {
    logger.error('orderLifecycle', `Failed to append order: ${e.message}`);
  }
}

export async function updateOrderState(
  localId: string,
  to: LiveOrderState,
  updates: Partial<LiveOrderRecord> = {},
  reason?: string,
): Promise<LiveOrderRecord | null> {
  try {
    const log = await getOrderLog();
    const idx = log.findIndex(o => o.localId === localId);
    if (idx === -1) {
      logger.warn('orderLifecycle', `Order ${localId} not found in log`);
      return null;
    }
    const order = log[idx];
    if (!isValidTransition(order.state, to)) {
      logger.warn('orderLifecycle', `Invalid transition ${order.state} → ${to} for ${localId}`);
      return order;
    }
    const transition: LiveOrderStateTransition = {
      from: order.state, to, at: Date.now(), reason};
    log[idx] = {
      ...order,
      ...updates,
      state:     to,
      updatedAt: Date.now(),
      history:   [...order.history, transition]};
    await KVStore.set(KEY, JSON.stringify(log));
    logger.info('orderLifecycle', `${localId} ${order.state} → ${to}${reason ? ` (${reason})` : ''}`);
    return log[idx];
  } catch (e: any) {
    logger.error('orderLifecycle', `Failed to update order ${localId}: ${e.message}`);
    return null;
  }
}

// ── Factory helper ─────────────────────────────────────────────────────────────

export function createOrderRecord(params: {
  broker:        'ANGEL_ONE' | 'BINANCE';
  symbol:        string;
  direction:     'LONG' | 'SHORT';
  assetSrc:      'ao' | 'binance';
  requestedQty:  number;
  requestedPrice: number;
  orderType:     'MARKET' | 'LIMIT';
  stopLoss:      number;
  takeProfit:    number;
}): LiveOrderRecord {
  const now = Date.now();
  return {
    localId:        `lo_${now}_${Math.random().toString(36).slice(2, 7)}`,
    brokerOrderId:  null,
    positionId:     null,
    filledQty:      0,
    filledPrice:    0,
    fees:           0,
    filledAt:       null,
    state:          'CREATED',
    history:        [{ from: 'CREATED', to: 'CREATED', at: now, reason: 'Order object created' }],
    createdAt:      now,
    updatedAt:      now,
    ...params};
}
