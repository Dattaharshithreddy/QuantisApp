// ─────────────────────────────────────────────────────────────────────────────
// QUANTIS FIREBASE CLOUD FUNCTIONS
//
// Functions:
//   1. dailySummary     — scheduled 8:30 PM IST daily, sends P&L summary via FCM
//   2. evalComplete     — HTTP trigger from app after prod eval finishes
//   3. priceAlertCheck  — Firestore trigger when alert is added/updated
//   4. onUserCreate     — initialise new user document in Firestore
// ─────────────────────────────────────────────────────────────────────────────
import * as functions from 'firebase-functions/v2';
import * as admin from 'firebase-admin';

admin.initializeApp();
const db      = admin.firestore();
const fcm     = admin.messaging();

// ── Helpers ───────────────────────────────────────────────────────────────────
async function getFCMToken(uid: string): Promise<string | null> {
  const snap = await db.doc(`users/${uid}/profile/fcmToken`).get();
  return snap.exists ? (snap.data()?.token ?? null) : null;
}

async function sendPush(
  token: string,
  title: string,
  body: string,
  data: Record<string, string> = {},
): Promise<void> {
  await fcm.send({
    token,
    notification: { title, body },
    android: {
      priority: 'high',
      notification: { sound: 'default', channelId: 'quantis_alerts' },
    },
    data: { ...data, click_action: 'FLUTTER_NOTIFICATION_CLICK' },
  });
}

// ── 1. DAILY SUMMARY — fires at 8:30 PM IST (3:00 PM UTC) every day ──────────
export const dailySummary = functions.scheduler.onSchedule(
  {
    schedule:  '0 15 * * *', // 3:00 PM UTC = 8:30 PM IST
    timeZone:  'Asia/Kolkata',
    region:    'asia-south1',
  },
  async () => {
    functions.logger.info('dailySummary: starting');

    // Get all users who have FCM tokens
    const usersSnap = await db.collection('users').get();

    const promises = usersSnap.docs.map(async (userDoc) => {
      const uid   = userDoc.id;
      const token = await getFCMToken(uid);
      if (!token) return;

      // Read today's paper portfolio from Firestore
      const today   = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
      const pnlKey  = `dailyPnL_${today}`;
      const pnlSnap = await db.doc(`users/${uid}/kvstore/${pnlKey}`).get();

      let totalPnL  = 0;
      let trades    = 0;
      let winRate   = 0;

      if (pnlSnap.exists) {
        try {
          const d   = JSON.parse(pnlSnap.data()?.value ?? '{}');
          totalPnL  = d.totalPnL  ?? 0;
          trades    = d.trades    ?? 0;
          winRate   = d.winRate   ?? 0;
        } catch {}
      } else {
        // Try reading from paper portfolio directly
        const portSnap = await db.doc(`users/${uid}/kvstore/paperPortfolio`).get();
        if (!portSnap.exists) return; // no trading data at all
      }

      const emoji  = totalPnL >= 0 ? '📈' : '📉';
      const pnlStr = `${totalPnL >= 0 ? '+' : ''}₹${Math.abs(totalPnL).toFixed(2)}`;
      const title  = `${emoji} Quantis Daily Summary`;
      const body   = trades > 0
        ? `P&L: ${pnlStr} · ${trades} trades · ${winRate.toFixed(0)}% win rate`
        : 'No trades today. Markets waiting for your next move.';

      await sendPush(token, title, body, { screen: 'Journal', type: 'DAILY_SUMMARY' });
      functions.logger.info(`dailySummary: sent to ${uid}`);
    });

    await Promise.allSettled(promises);
    functions.logger.info('dailySummary: complete');
  },
);

// ── 2. EVAL COMPLETE — called by app after production evaluation finishes ─────
export const notifyEvalComplete = functions.https.onCall(
  { region: 'asia-south1' },
  async (request) => {
    const { symbol, timeframe, returnPct, bestHorizon } = request.data;
    const uid = request.auth?.uid;
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required');

    const token = await getFCMToken(uid);
    if (!token) return { sent: false, reason: 'no_token' };

    const emoji = (returnPct ?? 0) >= 0 ? '📈' : '📉';
    await sendPush(
      token,
      `${emoji} Eval Complete: ${symbol}/${timeframe}`,
      `Return: ${(returnPct ?? 0).toFixed(1)}% · Best horizon: ${bestHorizon ?? 3} bars`,
      { screen: 'ProductionEvaluation', type: 'EVAL_COMPLETE', symbol, timeframe },
    );
    return { sent: true };
  },
);

// ── 3. LIVE FILL NOTIFICATION — called by app after broker fills order ────────
export const notifyLiveFill = functions.https.onCall(
  { region: 'asia-south1' },
  async (request) => {
    const { symbol, direction, qty, price, orderId } = request.data;
    const uid = request.auth?.uid;
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required');

    const token = await getFCMToken(uid);
    if (!token) return { sent: false, reason: 'no_token' };

    await sendPush(
      token,
      `✅ Order Filled: ${symbol}`,
      `${direction} ${qty} @ ${parseFloat(price).toFixed(4)} · ID: ${String(orderId).slice(0, 8)}`,
      { screen: 'LivePositions', type: 'LIVE_FILL', symbol },
    );
    return { sent: true };
  },
);

// ── 4. PRICE ALERT — Firestore trigger when alert is marked triggered ─────────
export const onAlertTriggered = functions.firestore.onDocumentUpdated(
  {
    document: 'users/{uid}/kvstore/priceAlerts',
    region:   'asia-south1',
  },
  async (event) => {
    const uid     = event.params.uid;
    const before  = JSON.parse(event.data?.before.data()?.value ?? '[]');
    const after   = JSON.parse(event.data?.after.data()?.value ?? '[]');

    // Find newly triggered alerts
    const newlyTriggered = after.filter((a: any) =>
      a.triggered && !before.find((b: any) => b.id === a.id && b.triggered)
    );
    if (!newlyTriggered.length) return;

    const token = await getFCMToken(uid);
    if (!token) return;

    for (const alert of newlyTriggered) {
      const dir = alert.condition === 'ABOVE' ? 'above' : 'below';
      await sendPush(
        token,
        `🎯 Price Alert: ${alert.symbol}`,
        `${alert.symbol} is now ${dir} ${alert.targetPrice}`,
        { screen: 'Alerts', type: 'PRICE_ALERT', symbol: alert.symbol },
      ).catch(() => {});
    }
  },
);

// ── 5. ON USER CREATE — initialise Firestore user document ───────────────────
export const onUserCreate = functions.auth.onUserCreated(async (user) => {
  await db.doc(`users/${user.uid}/profile/meta`).set({
    createdAt:   admin.firestore.FieldValue.serverTimestamp(),
    email:       user.email ?? null,
    displayName: user.displayName ?? null,
    isAnonymous: user.providerData.length === 0,
  });
  functions.logger.info(`New user initialised: ${user.uid}`);
});

// ── 6. PRICE MONITOR — triggers when device relays a price update ─────────────
// Checks all user price alerts and open positions for SL/TP hits
export const priceMonitor = functions.firestore.onDocumentUpdated(
  {
    document: 'users/{uid}/prices/{symbol}',
    region:   'asia-south1',
  },
  async (event) => {
    const uid    = event.params.uid;
    const symbol = event.params.symbol;
    const data   = event.data?.after.data();
    if (!data) return;

    const price = data.price as number;
    if (!price || price <= 0) return;

    const token = await getFCMToken(uid);
    if (!token) return;

    // ── Check price alerts ───────────────────────────────────────────────────
    const alertsSnap = await db.doc(`users/${uid}/kvstore/priceAlerts`).get();
    if (alertsSnap.exists) {
      try {
        const alerts: any[] = JSON.parse(alertsSnap.data()?.value ?? '[]');
        const toTrigger = alerts.filter(a =>
          !a.triggered &&
          a.symbol === symbol &&
          (a.condition === 'ABOVE' ? price >= a.targetPrice : price <= a.targetPrice)
        );

        if (toTrigger.length > 0) {
          // Mark triggered in Firestore
          const updated = alerts.map(a =>
            toTrigger.find(t => t.id === a.id) ? { ...a, triggered: true } : a
          );
          await db.doc(`users/${uid}/kvstore/priceAlerts`).set(
            { value: JSON.stringify(updated) }, { merge: true }
          );

          // Send FCM for each triggered alert
          for (const alert of toTrigger) {
            const dir = alert.condition === 'ABOVE' ? 'above' : 'below';
            await sendPush(
              token,
              `🎯 Price Alert: ${symbol}`,
              `${symbol} hit ${alert.targetPrice} (now ${price.toFixed(2)})`,
              { screen: 'Alerts', type: 'PRICE_ALERT', symbol },
            ).catch(() => {});
          }
          functions.logger.info(`priceMonitor: ${toTrigger.length} alert(s) triggered for ${symbol}`);
        }
      } catch (e) { functions.logger.warn('priceMonitor: alert parse error', e); }
    }

    // ── Check open positions for SL/TP ───────────────────────────────────────
    const posSnap = await db.collection(`users/${uid}/positions`)
      .where('symbol', '==', symbol)
      .where('isOpen', '==', true)
      .get();

    for (const posDoc of posSnap.docs) {
      const pos = posDoc.data();
      const hitSL = pos.direction === 'LONG'
        ? price <= pos.stopLoss
        : price >= pos.stopLoss;
      const hitTP = pos.direction === 'LONG'
        ? price >= pos.takeProfit
        : price <= pos.takeProfit;

      if (hitSL || hitTP) {
        const type   = hitSL ? 'SL_HIT' : 'TP_HIT';
        const emoji  = hitSL ? '🛑' : '🎯';
        const label  = hitSL ? 'Stop Loss Hit' : 'Take Profit Hit';
        const pnlDir = (hitTP && pos.direction === 'LONG') || (hitSL && pos.direction === 'SHORT')
          ? '+' : '-';

        await sendPush(
          token,
          `${emoji} ${label}: ${symbol}`,
          `${pos.direction} position hit ${hitSL ? 'SL' : 'TP'} at ${price.toFixed(2)}`,
          { screen: 'Journal', type, symbol },
        ).catch(() => {});

        functions.logger.info(`priceMonitor: ${type} for ${posDoc.id} at ${price}`);
      }
    }
  },
);

// ── 7. SIGNAL MONITOR — triggers when ML signal changes ──────────────────────
// Sends scanner notification when a high-confidence signal appears
export const signalMonitor = functions.firestore.onDocumentUpdated(
  {
    document: 'users/{uid}/signals/{signalKey}',
    region:   'asia-south1',
  },
  async (event) => {
    const uid  = event.params.uid;
    const data = event.data?.after.data();
    if (!data) return;

    const { symbol, timeframe, action, confidence, direction } = data;
    const prevAction = event.data?.before.data()?.action;

    // Only notify on BUY/SELL signals with confidence > 65%
    if (action === 'HOLD' || confidence < 65) return;
    if (action === prevAction) return; // no change

    const token = await getFCMToken(uid);
    if (!token) return;

    const emoji = action === 'BUY' ? '🟢' : '🔴';
    await sendPush(
      token,
      `${emoji} Scanner Signal: ${symbol}`,
      `${action} ${direction} on ${timeframe} — ${confidence.toFixed(0)}% confidence`,
      { screen: 'Chart', type: 'SCANNER_SIGNAL', symbol, timeframe },
    );
    functions.logger.info(`signalMonitor: ${action} signal for ${symbol}/${timeframe}`);
  },
);
