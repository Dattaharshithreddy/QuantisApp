import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { PaperPosition } from './paperPortfolio';
import { PaperTradeRecord } from './paperTradeJournal';

// ── Dedup layer ───────────────────────────────────────────────────────────────
// Prevents the same notification firing twice within a cooldown window.
// Covers both races: the AsyncStorage async gap (inFlightKeys) and
// price oscillation right at a threshold (DEDUP_WINDOW_MS).

const DEDUP_WINDOW_MS = 2 * 60 * 1000;
const inFlightKeys = new Set<string>();

async function shouldSend(key: string): Promise<boolean> {
  if (inFlightKeys.has(key)) return false;
  inFlightKeys.add(key);
  try {
    const raw = await AsyncStorage.getItem('notifDedup_' + key);
    if (raw && Date.now() - parseInt(raw, 10) < DEDUP_WINDOW_MS) return false;
    await AsyncStorage.setItem('notifDedup_' + key, String(Date.now()));
    return true;
  } catch { return true; }
  finally { inFlightKeys.delete(key); }
}

async function send(
  key: string,
  title: string,
  body: string,
  data: Record<string, string>,
  sound = true,
): Promise<void> {
  if (!(await shouldSend(key))) return;
  await Notifications.scheduleNotificationAsync({
    content: { title, body, sound, data },
    trigger: null,
  });
}

// ── Paper trading ─────────────────────────────────────────────────────────────

export async function notifyTradeOpened(position: PaperPosition): Promise<void> {
  const qualityText = position.tradeQuality
    ? ` · Quality ${position.tradeQuality.score}/100 (${position.tradeQuality.grade})` : '';
  await send(
    `opened_${position.symbol}_${position.entryTime}`,
    `📈 Paper trade opened: ${position.symbol}`,
    `${position.direction} ${position.qty.toFixed(2)} @ ${position.entryPrice.toFixed(2)} — confidence ${position.aiConfidence.toFixed(0)}/100${qualityText}`,
    { screen: 'PaperTrading' },
  );
}

export async function notifyTradeClosed(record: PaperTradeRecord): Promise<void> {
  const emoji = record.pnl >= 0 ? '✅' : '🔴';
  await send(
    `closed_${record.id}`,
    `${emoji} Paper trade closed: ${record.symbol}`,
    `${record.exitReason} — P&L: ${record.pnl >= 0 ? '+' : ''}${record.pnl.toFixed(2)} (${record.pnlPct.toFixed(2)}%)`,
    { screen: 'PaperJournal' },
  );
}

export async function notifyStopLossHit(symbol: string, pnl: number): Promise<void> {
  await send(
    `sl_${symbol}_${Math.round(pnl)}`,
    `🛑 Stop Loss hit: ${symbol}`,
    `Closed at a loss of ${pnl.toFixed(2)}. Tap to review.`,
    { screen: 'PaperJournal' },
  );
}

export async function notifyTakeProfitHit(symbol: string, pnl: number): Promise<void> {
  await send(
    `tp_${symbol}_${Math.round(pnl)}`,
    `🎯 Take Profit hit: ${symbol}`,
    `Closed at a profit of +${pnl.toFixed(2)}. Tap to review.`,
    { screen: 'PaperJournal' },
  );
}

export async function notifyTrailingStopActivated(symbol: string, newStop: number): Promise<void> {
  await send(
    `trail_${symbol}_${Math.round(newStop)}`,
    `📊 Trailing stop moved: ${symbol}`,
    `New stop level: ${newStop.toFixed(2)}`,
    { screen: 'PaperTrading' },
    false,
  );
}

export async function notifyDailySummary(tradesCount: number, netPnl: number): Promise<void> {
  await send(
    `daily_summary_${new Date().toDateString()}`,
    `📋 Daily paper trading summary`,
    `${tradesCount} trade${tradesCount === 1 ? '' : 's'} today — net P&L: ${netPnl >= 0 ? '+' : ''}${netPnl.toFixed(2)}`,
    { screen: 'PaperJournal' },
    false,
  );
}

// ── Shadow Journal ────────────────────────────────────────────────────────────
// Fired when the engine blocks a trade and writes a shadow entry.
// Helps user know something was tracked even when they're not on the screen.

export async function notifyShadowEntryRecorded(
  symbol: string,
  gate: string,
  reason: string,
): Promise<void> {
  // DUPLICATE_POSITION and POSITION_SIZING are execution failures —
  // use a different tone (warning, not opportunity)
  const isExecutionFailure = gate === 'DUPLICATE_POSITION' || gate === 'POSITION_SIZING';
  const title = isExecutionFailure
    ? `⚠️ Trade not opened: ${symbol}`
    : `🔍 Signal blocked: ${symbol}`;
  const body = isExecutionFailure
    ? `${reason.split('\n')[0]} Tap to see details.`
    : `Saved to Shadow Journal. Tap to review what would have happened.`;
  await send(
    `shadow_${symbol}_${gate}_${Math.floor(Date.now() / 60000)}`,  // group by minute
    title,
    body,
    { screen: 'ShadowJournal' },
    false,  // non-intrusive for AI gate blocks
  );
}

// ── Live trading ──────────────────────────────────────────────────────────────
// These fire from liveOrderExecution.ts after broker confirmation.

export async function notifyLiveOrderFilled(
  symbol:      string,
  direction:   'LONG' | 'SHORT',
  qty:         number,
  filledPrice: number,
  currency:    '₹' | '$',
  broker:      string,
  lots?:       number,
  lotSize?:    number,
): Promise<void> {
  const side     = direction === 'LONG' ? 'Buy' : 'Sell';
  const qtyStr   = lots != null && lotSize != null
    ? `${lots} lot${lots !== 1 ? 's' : ''} (${qty} units)`
    : qty.toFixed(lots == null ? 4 : 0);
  await send(
    `live_fill_${symbol}_${Math.floor(Date.now() / 5000)}`,
    `✅ Order Filled: ${symbol}`,
    `${side} ${qtyStr} @ ${currency}${filledPrice.toFixed(2)} · ${broker}`,
    { screen: 'LivePositions' },
  );
}

export async function notifyLiveOrderFailed(
  symbol: string,
  reason: string,
): Promise<void> {
  await send(
    `live_fail_${symbol}_${Math.floor(Date.now() / 5000)}`,
    `❌ Order Failed: ${symbol}`,
    `${reason.split('\n')[0]} Tap for details.`,
    { screen: 'LivePositions' },
  );
}

export async function notifyPreFlightFailed(
  symbol: string,
  code:   string,
  reason: string,
): Promise<void> {
  const emoji = code === 'MARKET_CLOSED' ? '⏰' :
                code === 'INSUFFICIENT_MARGIN' ? '💰' :
                code === 'TRADING_SUSPENDED' ? '🚫' : '⚠️';
  await send(
    `preflight_${symbol}_${code}_${Math.floor(Date.now() / 30000)}`,
    `${emoji} Order blocked: ${symbol}`,
    reason.split('\n')[0],
    { screen: 'LivePositions' },
  );
}

// ── AI Signal notifications ───────────────────────────────────────────────────
// Only fires when scanner detects a READY signal (not WAIT/AVOID) to avoid spam.

export async function notifySignalReady(
  symbol:     string,
  direction:  'LONG' | 'SHORT',
  confidence: number,
  tf:         string,
): Promise<void> {
  const arrow = direction === 'LONG' ? '▲' : '▼';
  await send(
    `signal_${symbol}_${tf}_${Math.floor(Date.now() / (5 * 60 * 1000))}`, // group per 5min
    `🔮 READY signal: ${symbol}`,
    `${arrow} ${direction} · ${confidence.toFixed(0)}% confidence · ${tf} chart`,
    { screen: 'Chart', symbol },
  );
}

// ── Override recorded ─────────────────────────────────────────────────────────

export async function notifyOverrideRecorded(
  symbol:    string,
  direction: 'LONG' | 'SHORT',
  rdState:   'WAIT' | 'AVOID',
): Promise<void> {
  await send(
    `override_${symbol}_${Math.floor(Date.now() / 5000)}`,
    `⚡ Override opened: ${symbol}`,
    `${direction} position opened against AI ${rdState} signal. Monitoring active.`,
    { screen: 'PaperTrading' },
    false,
  );
}

// ── Scheduled notifications — work even when app is killed ───────────────────
// These use a future trigger time so the OS delivers them independently
// of whether the app JS runtime is running.

/**
 * Schedules a daily market-open reminder for NSE at 9:15 AM IST.
 * IST = UTC+5:30, so 9:15 AM IST = 3:45 AM UTC.
 * Called once at app startup — cancels previous before scheduling.
 * Only fires on weekdays (Mon–Fri) — we schedule 5 days at once.
 */
export async function scheduleMarketOpenReminders(): Promise<void> {
  // Cancel any previously scheduled market open reminders
  const existing = await Notifications.getAllScheduledNotificationsAsync();
  for (const n of existing) {
    if ((n.content.data as any)?.type === 'market_open') {
      await Notifications.cancelScheduledNotificationAsync(n.identifier);
    }
  }

  // Schedule for the next 7 days — skip Sat (day 6) and Sun (day 0)
  // expo-notifications 0.28.x DateTriggerInput: { type: 'date', timestamp: number }
  const now = new Date();
  for (let i = 1; i <= 7; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() + i);
    const weekday = d.getUTCDay();  // 0=Sun, 6=Sat
    if (weekday === 0 || weekday === 6) continue;

    // 3:45 AM UTC = 9:15 AM IST
    d.setUTCHours(3, 45, 0, 0);
    if (d.getTime() <= Date.now()) continue;

    await Notifications.scheduleNotificationAsync({
      content: {
        title: '📈 NSE Market Open',
        body:  'Market is open. Check your watchlist and open positions.',
        sound: false,
        data:  { type: 'market_open', screen: 'Chart' },
      },
      trigger: { type: 'date', timestamp: d.getTime() },
    });
  }
}

/**
 * Schedules a Binance Futures funding rate reminder (every 8 hours: 00:00, 08:00, 16:00 UTC).
 * Useful if user has open perp positions.
 */
export async function scheduleFundingRateReminder(symbol: string): Promise<void> {
  const fundingHours = [0, 8, 16];
  const now = new Date();
  const utcH = now.getUTCHours();
  const nextFunding = fundingHours.find(h => h > utcH) ?? 24;

  const d = new Date(now);
  d.setUTCHours(nextFunding === 24 ? 0 : nextFunding, 1, 0, 0);
  if (nextFunding === 24) d.setUTCDate(d.getUTCDate() + 1);
  if (d.getTime() <= Date.now()) return;

  // expo-notifications 0.28.x DateTriggerInput: { type: 'date', timestamp: number }
  await Notifications.scheduleNotificationAsync({
    content: {
      title: `⚡ Funding rate: ${symbol}`,
      body:  'Funding payment applied to your perpetual futures position.',
      sound: false,
      data:  { type: 'funding_rate', screen: 'LivePositions', symbol },
    },
    trigger: { type: 'date', timestamp: d.getTime() },
  });
}


