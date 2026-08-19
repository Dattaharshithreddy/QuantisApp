# QUANTIS Troubleshooting Guide

## Live Trading Issues

### "Angel One not connected" on live trade
**Cause:** JWT session expired (Angel One sessions last ~24h).  
**Fix:** More → Broker Connection → Reconnect Angel One.  
**Prevention:** App auto-reconnects on foreground return. If this happens repeatedly, check your network and credentials.

### Order placed but position not appearing
**Cause:** Fill confirmation delayed or missed due to network interruption.  
**What happens automatically:** The reconciliation service detects this within 15 seconds and repairs the local state.  
**Manual fix:** Pull-to-refresh on Live Positions screen, or check More → Audit Trail for the order status.

### "Ghost position" in Audit Trail
**Meaning:** QUANTIS detected a position at your broker that it doesn't have locally. This happens when an order fills during a network outage.  
**Automatic fix:** Reconciliation creates the local record and marks it as `RECONCILIATION`-sourced.  
**No action needed** unless the ghost position is unexpected (i.e. you did not place that trade).

### "Phantom position" in Audit Trail
**Meaning:** QUANTIS has a local position record but the broker says it's not open. The position was likely closed externally (stop-loss at broker level, margin call, or manual close via broker app).  
**Automatic fix:** Reconciliation marks it closed and estimates the P&L.  
**Manual check:** Verify in your broker app that the position is actually closed.

### IN_FLIGHT error when placing order
**Cause:** You tapped the trade button twice quickly.  
**Fix:** Wait for the first order to complete. The IN_FLIGHT guard prevents duplicate orders.

---

## Futures Issues

### "Insufficient margin" when opening futures
**Cause:** Available margin in the futures paper account is too low.  
**Fix:** More → Futures Settings → increase starting capital, or close existing positions to free margin.

### Futures SL/TP not triggering
**Cause:** The PaperTradingMonitor may not have ticked yet (runs every 5 seconds).  
**Verification:** Check that the app is foregrounded — monitoring pauses when backgrounded.  
**Manual check:** Pull-to-refresh on Futures Positions screen to see current P&L.

### Liquidation not happening (Binance futures)
**Cause:** Liquidation only fires during a monitor tick when the live price is below/above the liquidation price.  
**Note:** In paper trading, liquidation is simulated on the next 5-second tick, not in real-time. Real Binance futures liquidation is handled by the exchange itself.

---

## AI / Prediction Issues

### Prediction takes more than 10 seconds
**Cause:** Candle data fetch (cache miss) or slow network.  
**Fix:** Pull-to-refresh on the chart to reload candles. If persistent, check network connection.

### "AVOID" showing constantly
**Cause:** This is correct behaviour in high-volatility or bearish regimes. The AI is protecting you.  
**Check:** More → Gate Analytics to see which gate is blocking.  
**Override:** You can still trade with the override button — the decision is yours.

### Trading Coach shows "Building your profile"
**Cause:** Fewer than 10 completed paper trades.  
**Fix:** Complete at least 10 paper trades (any combination of wins/losses) for insights to appear.

---

## Data / Chart Issues

### Chart shows no data / stuck on loading
**Cause:** Angel One data API unreachable, or session expired.  
**Fix:** Check Broker Connection screen. Reconnect if session shows expired.  
**Alternative:** Switch to Binance data source for crypto symbols.

### Prices not updating
**Cause:** WebSocket disconnected.  
**Visible indicator:** Status dot on chart turns red.  
**Automatic fix:** LiveSyncProvider attempts reconnection automatically.  
**Manual fix:** Background and foreground the app to trigger reconnect.

---

## App Performance

### App slow after extended use
**Cause:** React Native memory accumulation over many chart renders.  
**Fix:** Close and reopen the app. State is persisted — no data is lost.

### Chart overlays disappearing
**Cause:** Re-render cleared overlay state.  
**Fix:** Navigate away from chart and back. Overlays are recomputed on load.

---

## Crash Recovery

### App crashed and I had an open live position
1. Reopen the app
2. Reconciliation runs automatically on startup within 15 seconds
3. Check Live Positions — position should appear
4. If not, check More → Audit Trail for the order status
5. If the position is missing and the broker shows it open, it will appear as a "ghost" and be repaired automatically

### Crash reports in Health Dashboard
1. Note the Crash ID and screen name
2. Reproduce the crash if possible
3. File a bug with: crash ID, screen, what you were doing, device model, Android version
4. Clear the crash log after noting details

---

## Resetting Paper Accounts

**Paper equity account:** More → Settings → Reset Paper Account  
**NSE futures account:** More → Futures Settings → NSE Futures → Reset Paper Account  
**Binance futures account:** More → Futures Settings → Crypto Futures → Reset Paper Account

⚠️ Resets are permanent and cannot be undone. All positions and trade history are lost.

---

## Getting Support

Include in your bug report:
1. Crash ID (from Health Dashboard if applicable)
2. Build version (visible in Health Dashboard)
3. Device model and Android version
4. What you were doing when the issue occurred
5. Screenshot if relevant
