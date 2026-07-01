import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { PaperPosition } from './paperPortfolio';
import { PaperTradeRecord } from './paperTradeJournal';

// Dedup layer: tracks recently-sent notification keys with a short cooldown
// window, so a noisy scan loop (or a price oscillating right at a
// threshold) can never fire the same notification twice in quick
// succession. Cheap, persisted, no extra infra needed.
const DEDUP_WINDOW_MS = 2 * 60 * 1000;
const inFlightKeys = new Set<string>(); // synchronous in-memory lock - closes the race the AsyncStorage round-trip alone can't, since checking that is itself async
async function shouldSend(key: string): Promise<boolean> {
  if (inFlightKeys.has(key)) return false; // a call for this exact key is already mid-flight; don't let a second one slip through the await gap below
  inFlightKeys.add(key);
  try {
    const raw = await AsyncStorage.getItem('notifDedup_' + key);
    if (raw && Date.now() - parseInt(raw, 10) < DEDUP_WINDOW_MS) return false;
    await AsyncStorage.setItem('notifDedup_' + key, String(Date.now()));
    return true;
  } catch { return true; } // fail open — better to occasionally double-notify than to silently never notify
  finally { inFlightKeys.delete(key); } // ALWAYS released, even on early return or exception, so a key can never be permanently stuck
}

// Reuses the exact expo-notifications API already wired in alerts.ts —
// scheduleNotificationAsync with trigger:null for immediate local
// notifications. The notification HANDLER is registered once, globally, in
// alerts.ts (Notifications.setNotificationHandler) — not repeated here,
// since registering it twice would just be redundant, not additive.
// requestNotifPermission from alerts.ts should be called once at app
// startup; this module only sends notifications, assuming permission was
// already granted via that existing flow.

export async function notifyTradeOpened(position: PaperPosition): Promise<void> {
  if (!(await shouldSend(`opened_${position.symbol}_${position.entryTime}`))) return;
  const qualityText = position.tradeQuality ? ` · Quality ${position.tradeQuality.score}/100 (${position.tradeQuality.grade})` : '';
  await Notifications.scheduleNotificationAsync({
    content: {
      title: `📈 Paper trade opened: ${position.symbol}`,
      body: `${position.direction} ${position.qty.toFixed(2)} @ ${position.entryPrice.toFixed(2)} — confidence ${position.aiConfidence.toFixed(0)}/100${qualityText}`,
      sound: true,
    },
    trigger: null,
  });
}

export async function notifyTradeClosed(record: PaperTradeRecord): Promise<void> {
  if (!(await shouldSend(`closed_${record.id}`))) return;
  const emoji = record.pnl >= 0 ? '✅' : '🔴';
  await Notifications.scheduleNotificationAsync({
    content: {
      title: `${emoji} Paper trade closed: ${record.symbol}`,
      body: `${record.exitReason} — P&L: ${record.pnl >= 0 ? '+' : ''}${record.pnl.toFixed(2)} (${record.pnlPct.toFixed(2)}%)`,
      sound: true,
    },
    trigger: null,
  });
}

export async function notifyStopLossHit(symbol: string, pnl: number): Promise<void> {
  if (!(await shouldSend(`sl_${symbol}_${Math.round(pnl)}`))) return;
  await Notifications.scheduleNotificationAsync({
    content: { title: `🛑 Stop Loss hit: ${symbol}`, body: `Closed at a loss of ${pnl.toFixed(2)}`, sound: true },
    trigger: null,
  });
}

export async function notifyTakeProfitHit(symbol: string, pnl: number): Promise<void> {
  if (!(await shouldSend(`tp_${symbol}_${Math.round(pnl)}`))) return;
  await Notifications.scheduleNotificationAsync({
    content: { title: `🎯 Take Profit hit: ${symbol}`, body: `Closed at a profit of +${pnl.toFixed(2)}`, sound: true },
    trigger: null,
  });
}

export async function notifyTrailingStopActivated(symbol: string, newStop: number): Promise<void> {
  if (!(await shouldSend(`trail_${symbol}_${Math.round(newStop)}`))) return;
  await Notifications.scheduleNotificationAsync({
    content: { title: `📊 Trailing stop moved: ${symbol}`, body: `New stop level: ${newStop.toFixed(2)}`, sound: false },
    trigger: null,
  });
}

export async function notifyDailySummary(tradesCount: number, netPnl: number): Promise<void> {
  await Notifications.scheduleNotificationAsync({
    content: {
      title: `📋 Daily paper trading summary`,
      body: `${tradesCount} trade${tradesCount === 1 ? '' : 's'} today — net P&L: ${netPnl >= 0 ? '+' : ''}${netPnl.toFixed(2)}`,
      sound: false,
    },
    trigger: null,
  });
}
