// ─────────────────────────────────────────────────────────────────────────────
// NOTIFICATION SERVICE
//
// Central service for all app notifications. Handles:
//   - Permission request on first launch
//   - FCM push token registration
//   - Local notification scheduling for all event types
//   - Notification tap → deep navigation
//   - Per-type enable/disable settings
//
// Notification types:
//   PRICE_ALERT    — price crossed user-set threshold
//   TRADE_OPENED   — paper/live position opened
//   TRADE_CLOSED   — paper/live position closed (with P&L)
//   SL_HIT         — stop loss triggered
//   TP_HIT         — take profit hit
//   EVAL_COMPLETE  — production evaluation finished
//   TRAIN_COMPLETE — ML model training finished
//   DAILY_SUMMARY  — end-of-day P&L summary
//   SCANNER_SIGNAL — scanner found high-quality opportunity
//   LIVE_FILL      — live order filled at broker
// ─────────────────────────────────────────────────────────────────────────────
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { KVStore } from './storage';
import { db, auth } from './firebase';
import { doc, setDoc, serverTimestamp } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { navigationRef } from '../utils/navigationRef';
import { logger } from '../utils/logger';

// ── Notification types ────────────────────────────────────────────────────────
export type NotifType =
  | 'PRICE_ALERT' | 'TRADE_OPENED' | 'TRADE_CLOSED'
  | 'SL_HIT' | 'TP_HIT' | 'EVAL_COMPLETE' | 'TRAIN_COMPLETE'
  | 'DAILY_SUMMARY' | 'SCANNER_SIGNAL' | 'LIVE_FILL';

export type NotifSettings = Record<NotifType, boolean>;

const DEFAULT_SETTINGS: NotifSettings = {
  PRICE_ALERT:    true,
  TRADE_OPENED:   true,
  TRADE_CLOSED:   true,
  SL_HIT:         true,
  TP_HIT:         true,
  EVAL_COMPLETE:  true,
  TRAIN_COMPLETE: false, // off by default — too frequent during learning
  DAILY_SUMMARY:  true,
  SCANNER_SIGNAL: true,
  LIVE_FILL:      true,
};

const SETTINGS_KEY = 'notificationSettings_v1';
const DEDUP_MS     = 2 * 60 * 1000; // 2 min cooldown per key

// ── Setup ─────────────────────────────────────────────────────────────────────
// Set handler ONCE at module level (idempotent)
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert:  true,
    shouldPlaySound:  true,
    shouldSetBadge:   false,
  }),
});

// ── Permission ────────────────────────────────────────────────────────────────
export async function requestPermission(): Promise<boolean> {
  const { status: existing } = await Notifications.getPermissionsAsync();
  if (existing === 'granted') {
    await registerFCMToken(); // refresh token on each launch
    return true;
  }
  const { status } = await Notifications.requestPermissionsAsync();
  if (status !== 'granted') {
    logger.warn('notifications', 'Permission not granted');
    return false;
  }
  logger.info('notifications', 'Permission granted');
  await registerFCMToken();
  return true;
}

// Register FCM push token with Firestore so Cloud Functions can reach this device
async function registerFCMToken(): Promise<void> {
  try {
    if (Platform.OS !== 'android') return;
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    const tokenData = await Notifications.getExpoPushTokenAsync({
      projectId: 'quantis-trading',
    });
    const token = tokenData.data;
    if (!token) return;
    await setDoc(doc(db, `users/${uid}/profile/fcmToken`), {
      token,
      updatedAt: serverTimestamp(),
      platform: Platform.OS,
    });
    logger.info('notifications', `FCM token registered: ${token.slice(0, 20)}...`);
  } catch (e: any) {
    logger.warn('notifications', `FCM token registration failed: ${e.message}`);
  }
}

// ── Cloud Function callers (for background notifications) ─────────────────────
// These call Firebase Cloud Functions which send FCM pushes even when app is killed.

export async function cloudNotifyEvalComplete(
  symbol: string, timeframe: string, returnPct: number, bestHorizon: number
): Promise<void> {
  try {
    const fns = getFunctions(undefined, 'asia-south1');
    const fn  = httpsCallable(fns, 'notifyEvalComplete');
    await fn({ symbol, timeframe, returnPct, bestHorizon });
    logger.info('notifications', `Cloud eval complete sent for ${symbol}/${timeframe}`);
  } catch (e: any) {
    logger.warn('notifications', `Cloud eval notify failed: ${e.message}`);
    // Fall back to local notification
    await notifyEvalComplete(symbol, timeframe, returnPct, bestHorizon);
  }
}

export async function cloudNotifyLiveFill(
  symbol: string, direction: string, qty: number, price: number, orderId: string
): Promise<void> {
  try {
    const fns = getFunctions(undefined, 'asia-south1');
    const fn  = httpsCallable(fns, 'notifyLiveFill');
    await fn({ symbol, direction, qty, price: String(price), orderId });
    logger.info('notifications', `Cloud live fill sent: ${orderId}`);
  } catch (e: any) {
    logger.warn('notifications', `Cloud live fill notify failed: ${e.message}`);
    await notifyLiveFill(symbol, direction, qty, price, orderId);
  }
}

// ── Settings ──────────────────────────────────────────────────────────────────
export async function getNotifSettings(): Promise<NotifSettings> {
  const raw = await KVStore.get(SETTINGS_KEY);
  try { return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}

export async function setNotifSetting(type: NotifType, enabled: boolean): Promise<void> {
  const settings = await getNotifSettings();
  settings[type] = enabled;
  await KVStore.set(SETTINGS_KEY, JSON.stringify(settings));
}

// ── Dedup ─────────────────────────────────────────────────────────────────────
const inFlight = new Set<string>();

async function shouldSend(key: string, type: NotifType): Promise<boolean> {
  const settings = await getNotifSettings();
  if (!settings[type]) return false;
  if (inFlight.has(key)) return false;
  inFlight.add(key);
  try {
    const raw = await KVStore.get('notifDedup_' + key);
    if (raw && Date.now() - parseInt(raw, 10) < DEDUP_MS) return false;
    await KVStore.set('notifDedup_' + key, String(Date.now()));
    return true;
  } catch { return true; }
  finally { inFlight.delete(key); }
}

// ── Core send ─────────────────────────────────────────────────────────────────
async function send(
  key: string,
  type: NotifType,
  title: string,
  body: string,
  data: Record<string, string> = {},
): Promise<void> {
  if (!(await shouldSend(key, type))) return;
  try {
    await Notifications.scheduleNotificationAsync({
      content: { title, body, sound: true, data: { type, ...data } },
      trigger: null,
    });
    logger.info('notifications', `Sent [${type}]: ${title}`);
  } catch (e: any) {
    logger.warn('notifications', `Failed to send [${type}]: ${e.message}`);
  }
}

// ── Notification types ────────────────────────────────────────────────────────

export async function notifyPriceAlert(
  symbol: string, condition: 'ABOVE' | 'BELOW', price: number
): Promise<void> {
  await send(
    `price_${symbol}_${condition}`,
    'PRICE_ALERT',
    `🎯 Price Alert: ${symbol}`,
    `${symbol} is now ${condition === 'ABOVE' ? 'above' : 'below'} ${price.toFixed(2)}`,
    { screen: 'Alerts', symbol },
  );
}

export async function notifyTradeOpened(
  symbol: string, direction: string, price: number, isLive: boolean
): Promise<void> {
  const mode = isLive ? '🔴 LIVE' : '📋 Paper';
  await send(
    `opened_${symbol}_${Date.now()}`,
    'TRADE_OPENED',
    `${mode} Trade Opened: ${symbol}`,
    `${direction} @ ${price.toFixed(2)}`,
    { screen: isLive ? 'LivePositions' : 'PaperTrading' },
  );
}

export async function notifyTradeClosed(
  symbol: string, pnl: number, pnlPct: number, isLive: boolean
): Promise<void> {
  const emoji = pnl >= 0 ? '✅' : '❌';
  const mode  = isLive ? 'LIVE' : 'Paper';
  await send(
    `closed_${symbol}_${Date.now()}`,
    'TRADE_CLOSED',
    `${emoji} ${mode} Trade Closed: ${symbol}`,
    `P&L: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} (${pnlPct.toFixed(2)}%)`,
    { screen: isLive ? 'LivePositions' : 'PaperTrading' },
  );
}

export async function notifyStopLoss(
  symbol: string, price: number, loss: number
): Promise<void> {
  await send(
    `sl_${symbol}_${Date.now()}`,
    'SL_HIT',
    `🛑 Stop Loss Hit: ${symbol}`,
    `Closed at ${price.toFixed(2)} · Loss: ${loss.toFixed(2)}`,
    { screen: 'PaperTrading' },
  );
}

export async function notifyTakeProfit(
  symbol: string, price: number, profit: number
): Promise<void> {
  await send(
    `tp_${symbol}_${Date.now()}`,
    'TP_HIT',
    `💰 Take Profit Hit: ${symbol}`,
    `Closed at ${price.toFixed(2)} · Profit: +${profit.toFixed(2)}`,
    { screen: 'PaperTrading' },
  );
}

export async function notifyEvalComplete(
  symbol: string, tf: string, returnPct: number, bestHorizon: number
): Promise<void> {
  const emoji = returnPct >= 0 ? '📈' : '📉';
  await send(
    `eval_${symbol}_${tf}`,
    'EVAL_COMPLETE',
    `${emoji} Evaluation Complete: ${symbol}/${tf}`,
    `Return: ${returnPct >= 0 ? '+' : ''}${returnPct.toFixed(1)}% · Best horizon: ${bestHorizon} bars`,
    { screen: 'ProductionEvaluation' },
  );
}

export async function notifyTrainingComplete(
  symbol: string, tf: string, accuracy: number
): Promise<void> {
  await send(
    `train_${symbol}_${tf}`,
    'TRAIN_COMPLETE',
    `🧠 Model Updated: ${symbol}/${tf}`,
    `Walk-forward accuracy: ${accuracy.toFixed(1)}%`,
    { screen: 'Chart', symbol, tf },
  );
}

export async function notifyDailySummary(
  totalPnL: number, winRate: number, trades: number
): Promise<void> {
  const emoji = totalPnL >= 0 ? '📊' : '📉';
  const date  = new Date().toLocaleDateString('en-IN');
  await send(
    `daily_${date}`,
    'DAILY_SUMMARY',
    `${emoji} Daily Summary — ${date}`,
    `P&L: ${totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(2)} · WR: ${winRate.toFixed(0)}% · ${trades} trades`,
    { screen: 'Journal' },
  );
}

export async function notifyScannerSignal(
  symbol: string, direction: string, confidence: number
): Promise<void> {
  await send(
    `scanner_${symbol}_${Date.now()}`,
    'SCANNER_SIGNAL',
    `🔍 Scanner Signal: ${symbol}`,
    `${direction} signal · Confidence: ${confidence.toFixed(0)}/100`,
    { screen: 'Chart', symbol },
  );
}

export async function notifyLiveFill(
  symbol: string, direction: string, qty: number, price: number, orderId: string
): Promise<void> {
  await send(
    `fill_${orderId}`,
    'LIVE_FILL',
    `✅ Live Order Filled: ${symbol}`,
    `${direction} ${qty} @ ${price.toFixed(4)} · ID: ${orderId.slice(0, 8)}`,
    { screen: 'LivePositions' },
  );
}

// ── Tap handler — navigate to correct screen ──────────────────────────────────
export function setupNotificationTapHandler(): () => void {
  const sub = Notifications.addNotificationResponseReceivedListener(response => {
    const data = response.notification.request.content.data as Record<string, string>;
    if (!data?.screen) return;

    // Wait for navigation to be ready
    setTimeout(() => {
      try {
        if (!navigationRef.isReady()) return;
        const screen = data.screen;

        if (screen === 'Chart' && data.symbol) {
          navigationRef.navigate('Chart' as never, { symbol: data.symbol } as never);
        } else if (['LivePositions', 'PaperTrading', 'Journal',
                    'Alerts', 'ProductionEvaluation'].includes(screen)) {
          navigationRef.navigate(screen as never);
        }
      } catch (e: any) {
        logger.warn('notifications', `Navigation failed: ${e.message}`);
      }
    }, 500);
  });

  return () => sub.remove();
}
