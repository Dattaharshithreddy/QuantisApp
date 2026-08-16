// ─────────────────────────────────────────────────────────────────────────────
// PRICE RELAY SERVICE
//
// Writes live prices to Firestore so Cloud Functions can:
//   1. Check price alerts when price crosses threshold
//   2. Monitor open positions for SL/TP hits
//   3. Track scanner signals for background notifications
//
// Throttle strategy:
//   Write to Firestore only when price changes > 0.05% OR > 60s since last write.
//   This keeps Firestore writes ~1440/day per symbol (well within free tier).
//
// Firestore path: /users/{uid}/prices/{symbol}
// ─────────────────────────────────────────────────────────────────────────────
import { db, auth } from './firebase';
import { doc, setDoc, serverTimestamp } from 'firebase/firestore';
import { logger } from '../utils/logger';
console.log('[QUANTIS_DIAG] priceRelay: module loaded');


const PRICE_CHANGE_THRESHOLD = 0.0005; // 0.05% change triggers write
const MAX_WRITE_INTERVAL_MS  = 60_000; // write at least every 60s (keepalive)
const MIN_WRITE_INTERVAL_MS  = 5_000;  // never write more than once per 5s

// Track last written state per symbol
const lastWritten: Record<string, { price: number; time: number }> = {};

// Write throttle timers
const pendingWrites: Record<string, ReturnType<typeof setTimeout>> = {};

export function relayPrice(
  symbol: string,
  price:  number,
  chg:    number,
): void {
  if (!auth.currentUser || price <= 0) return;

  const last = lastWritten[symbol];
  const now  = Date.now();

  // Check if write is needed
  const priceChangePct = last ? Math.abs((price - last.price) / last.price) : 1;
  const timeSinceLast  = last ? now - last.time : Infinity;

  const shouldWrite =
    priceChangePct >= PRICE_CHANGE_THRESHOLD ||
    timeSinceLast  >= MAX_WRITE_INTERVAL_MS;

  if (!shouldWrite) return;

  // Throttle: cancel pending write, schedule new one
  if (pendingWrites[symbol]) clearTimeout(pendingWrites[symbol]);

  pendingWrites[symbol] = setTimeout(async () => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;

    try {
      await setDoc(
        doc(db, `users/${uid}/prices/${symbol}`),
        { price, chg, updatedAt: serverTimestamp(), symbol },
        { merge: true },
      );
      lastWritten[symbol] = { price, time: Date.now() };
      delete pendingWrites[symbol];
    } catch (e: any) {
      logger.warn('priceRelay', `Write failed for ${symbol}: ${e.message}`);
    }
  }, MIN_WRITE_INTERVAL_MS);
}

// Write ML signal to Firestore when action changes (for scanner notifications)
let lastSignal: Record<string, string> = {};

export async function relaySignal(
  symbol:     string,
  timeframe:  string,
  action:     string,
  confidence: number,
  direction:  string,
): Promise<void> {
  const key = `${symbol}_${timeframe}`;
  if (lastSignal[key] === action) return; // no change — skip write
  lastSignal[key] = action;

  const uid = auth.currentUser?.uid;
  if (!uid) return;

  try {
    await setDoc(
      doc(db, `users/${uid}/signals/${key}`),
      { symbol, timeframe, action, confidence, direction,
        updatedAt: serverTimestamp() },
      { merge: true },
    );
    logger.info('priceRelay', `Signal relayed: ${symbol}/${timeframe} ${action} (${confidence}%)`);
  } catch (e: any) {
    logger.warn('priceRelay', `Signal write failed: ${e.message}`);
  }
}

// Write open position to Firestore for server-side SL/TP monitoring
export async function relayPosition(
  positionId:  string,
  symbol:      string,
  direction:   'LONG' | 'SHORT',
  entryPrice:  number,
  stopLoss:    number,
  takeProfit:  number,
  isOpen:      boolean,
): Promise<void> {
  const uid = auth.currentUser?.uid;
  if (!uid) return;

  try {
    if (isOpen) {
      await setDoc(
        doc(db, `users/${uid}/positions/${positionId}`),
        { symbol, direction, entryPrice, stopLoss, takeProfit,
          isOpen: true, updatedAt: serverTimestamp() },
        { merge: true },
      );
    } else {
      // Mark closed — Cloud Function will stop monitoring
      await setDoc(
        doc(db, `users/${uid}/positions/${positionId}`),
        { isOpen: false, closedAt: serverTimestamp() },
        { merge: true },
      );
    }
  } catch (e: any) {
    logger.warn('priceRelay', `Position write failed: ${e.message}`);
  }
}
