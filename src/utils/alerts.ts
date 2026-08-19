import AsyncStorage from '@react-native-async-storage/async-storage';
import { KVStore } from '../services/storage';

export type PriceAlert = {
  id: string;
  symbol: string;
  condition: 'ABOVE' | 'BELOW';
  targetPrice: number;
  triggered: boolean;
  createdAt: number;
};

const KEY = 'priceAlerts';

// Notification handler is set in notifications.ts via requestPermission()
// Removed from here to prevent top-level crash on Hermes

export async function getAlerts(): Promise<PriceAlert[]> {
  const raw = await KVStore.get(KEY);
  try { return raw ? JSON.parse(raw) : []; } catch (e: any) { console.warn('[alerts] corrupt storage:', e?.message); return []; }
}

export async function addAlert(a: Omit<PriceAlert, 'id' | 'triggered' | 'createdAt'>): Promise<PriceAlert[]> {
  const alerts = await getAlerts();
  const newAlert: PriceAlert = { ...a, id: Date.now().toString(), triggered: false, createdAt: Date.now() };
  const updated = [newAlert, ...alerts];
  await KVStore.set(KEY, JSON.stringify(updated));
  return updated;
}

export async function deleteAlert(id: string): Promise<PriceAlert[]> {
  const alerts = await getAlerts();
  const updated = alerts.filter(a => a.id !== id);
  await KVStore.set(KEY, JSON.stringify(updated));
  return updated;
}

// Call this on every price tick — checks all active alerts for that symbol and fires local notifications
const checkAlertsInFlight = new Set<string>();
export async function checkAlerts(symbol: string, currentPrice: number) {
  if (checkAlertsInFlight.has(symbol)) return await getAlerts(); // a check for this exact symbol is already in progress; let it finish rather than racing it
  checkAlertsInFlight.add(symbol);
  try {
    const alerts = await getAlerts();
    let changed = false;
    for (const a of alerts) {
      if (a.triggered || a.symbol !== symbol) continue;
      const hit = a.condition === 'ABOVE' ? currentPrice >= a.targetPrice : currentPrice <= a.targetPrice;
      if (hit) {
        a.triggered = true;
        changed = true;
        // Use central notification service (handles dedup + settings)
        import('../services/notifications').then(({ notifyPriceAlert }) => {
          notifyPriceAlert(symbol, a.condition, a.targetPrice).catch(() => {});
        }).catch(() => {});
      }
    }
    if (changed) await KVStore.set(KEY, JSON.stringify(alerts));
    return alerts;
  } finally {
    checkAlertsInFlight.delete(symbol); // ALWAYS released, even on early return or exception
  }
}

// ── Pattern alert notification ────────────────────────────────────────────
// Fires a local push notification when the Pattern Validation Framework
// confirms a chart pattern. Called from watchlistScanner.ts per cycle.
// Idempotent: if the OS cannot deliver the notification, it is swallowed.
// Does NOT store alerts in AsyncStorage (one-shot fire-and-forget).
export async function notifyPatternConfirmed(
  patternName: string,
  symbol:      string,
  confidence:  number,
  direction:   string,
): Promise<void> {
  try {
    const icon = direction === 'bullish' ? '🟢' : direction === 'bearish' ? '🔴' : '🟡';
    const Notifs = await import('expo-notifications');
    await Notifs.scheduleNotificationAsync({
      content: {
        title: `${icon} Pattern Confirmed: ${symbol}`,
        body:  `${patternName} confirmed — ${direction.toUpperCase()} · Confidence ${confidence}/100`,
        sound: true},
      trigger: null});
  } catch (e: any) {
    // Notification delivery failure is non-fatal — scanner continues normally
    console.warn('[alerts] notifyPatternConfirmed failed:', e?.message);
  }
}
