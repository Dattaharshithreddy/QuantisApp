# QUANTIS — End-to-End Release Test Script
**Version:** 6.9.9  
**Run before:** Every release build, every major change to trading logic

This script validates the complete user journey. Run it on a physical Android device with a funded paper account. Each section is a separate test pass — mark ✓ pass or ✗ fail with notes.

---

## Setup

- [ ] Install the release APK (not the Expo dev build)
- [ ] Connect to Angel One OR use simulator mode
- [ ] Ensure live price feed is active (green indicator on chart)
- [ ] Reset paper trading account to ₹10,00,000 in Settings

---

## Pass 1: Prediction → Paper Trade

### 1.1 Signal generation
- [ ] Open chart for NIFTY50 or RELIANCE
- [ ] Tap "Run Prediction"
- [ ] Prediction returns within 5 seconds
- [ ] Signal shows one of: READY / WAIT / AVOID
- [ ] Confidence score displayed (0–100)
- [ ] Regime label shown (e.g. BULL_TREND)

### 1.2 READY signal — paper trade
- [ ] With READY signal, tap "▲ Open Long" or "▼ Open Short"
- [ ] Position appears in paper portfolio immediately
- [ ] Entry price matches chart price at time of tap
- [ ] Stop loss and take profit shown correctly
- [ ] Shadow journal entry created (check Shadow Journal screen)

### 1.3 WAIT signal — override path
- [ ] Navigate to a symbol showing WAIT
- [ ] Confirm trade button is amber / shows caution text
- [ ] Tap override — confirm dialog appears
- [ ] Complete override — position opens
- [ ] Override flag recorded in signal snapshot (check Analytics)

### 1.4 AVOID signal
- [ ] Navigate to symbol showing AVOID
- [ ] Confirm trade button is red / outlined
- [ ] Tapping shows override warning with reason
- [ ] Override → position opens (verify override captured in journal)

### 1.5 Position monitoring
- [ ] Paper position appears in More → Paper Trading
- [ ] Unrealised P&L updates live as price moves
- [ ] Wait for SL or TP hit (or manually close)
- [ ] Position closes and appears in trade history
- [ ] Realised P&L recorded correctly
- [ ] Cash balance updated

---

## Pass 2: Prediction → Live Trade → Confirmation

> ⚠️ This pass uses real money. Use minimum position size.

### 2.1 PAPER/LIVE mode toggle
- [ ] Open ChartScreen for an AO/Binance asset
- [ ] Toggle appears below chart header
- [ ] Default is PAPER — confirm
- [ ] Tapping LIVE with no broker session → error message shown
- [ ] Connect Angel One session in Settings
- [ ] Toggle to LIVE — "REAL MONEY" label appears

### 2.2 Order confirmation flow
- [ ] With LIVE mode active, run prediction
- [ ] Tap trade button on READY signal
- [ ] OrderConfirmationScreen appears
- [ ] Shows symbol, direction, qty, price, stop loss, take profit
- [ ] "Cancel" returns to chart — no order placed
- [ ] "Confirm" → order submitted → loading indicator

### 2.3 Fill and position
- [ ] Order fills (MARKET order fills immediately)
- [ ] LivePositionsScreen shows position
- [ ] Order lifecycle: SUBMITTED → ACKNOWLEDGED → FILLED (check Audit Trail)
- [ ] Live P&L updates

### 2.4 Close position
- [ ] Close position manually from LivePositionsScreen
- [ ] Order placed to close
- [ ] Position removed from live positions
- [ ] Realised P&L shows in Live P&L screen

---

## Pass 3: NSE Futures

### 3.1 Open futures position
- [ ] More → Futures Trading
- [ ] Select NIFTY, current month
- [ ] Select 1 lot, LONG direction
- [ ] Margin requirement shown (should be ~₹1.5–2L for 1 NIFTY lot)
- [ ] Tap "Open Long"
- [ ] Position appears in Futures Positions

### 3.2 Position monitoring
- [ ] Live P&L updates every 5 seconds (PaperTradingMonitor tick)
- [ ] MTM settled P&L shows separately
- [ ] SL/TP displayed — tap to edit — value updates after edit

### 3.3 SL/TP hit (simulate by setting SL close to current price)
- [ ] Set SL to current price - 0.1%
- [ ] Wait for position to auto-close (within 5-10 seconds)
- [ ] Confirm it closed with correct P&L
- [ ] MTM log entry appears

### 3.4 Close manually
- [ ] Open another position
- [ ] Tap "Close Position (Market)"
- [ ] Confirm dialog → close
- [ ] Position gone, P&L recorded

---

## Pass 4: Binance Perpetual Futures

### 4.1 Open position
- [ ] More → Crypto Futures
- [ ] Select BTCUSDT, 10× leverage
- [ ] Enter 0.001 contracts, LONG
- [ ] Check margin, notional, liquidation price shown
- [ ] Tap "Open Long"
- [ ] Position in Crypto Futures Positions

### 4.2 Liquidation price visible
- [ ] Liquidation price shown in position card
- [ ] Distance from current price shown (e.g. "15.2% away")
- [ ] If < 5%, warning badge appears

### 4.3 Funding rate (after 8 hours — simulate by setting lastFundingAt in storage)
- [ ] Skip for quick release test — verify in extended testing

### 4.4 SL/TP edit
- [ ] Tap SL value → text input appears
- [ ] Enter new value → submit
- [ ] Value updates in position card
- [ ] Monitor respects new SL on next tick

---

## Pass 5: Kill Switch

### 5.1 Kill switch activation
- [ ] Have at least one live position open
- [ ] Navigate to Kill Switch screen
- [ ] Tap "Activate Kill Switch"
- [ ] Confirm dialog → activate
- [ ] All live orders cancelled
- [ ] Switch enters ACTIVE state
- [ ] Cannot place new live orders while active

### 5.2 Kill switch deactivation
- [ ] Tap "Deactivate"
- [ ] Confirm
- [ ] Live trading re-enabled

---

## Pass 6: Reconciliation

### 6.1 Startup reconciliation
- [ ] Close app
- [ ] Reopen app
- [ ] Check Health Dashboard → Last Reconciliation timestamp updated
- [ ] No ghost/phantom positions reported (unless expected)

### 6.2 Reconciliation log
- [ ] More → Audit Trail → Reconciliation tab
- [ ] Recent recon runs listed
- [ ] "Clean" status if no discrepancies

---

## Pass 7: Portfolio Risk Manager

### 7.1 With no positions
- [ ] More → Portfolio Risk Manager
- [ ] Shows "No open positions" or zero exposure
- [ ] Risk level: LOW

### 7.2 With positions across accounts
- [ ] Open paper trade + futures position
- [ ] Navigate to Portfolio Risk Manager
- [ ] Total capital shown (all accounts)
- [ ] Total notional shown
- [ ] Leverage calculated
- [ ] Concentration risk shows largest position
- [ ] VaR₉₅ computed

### 7.3 Risk level changes
- [ ] With only equity positions → LOW or MODERATE
- [ ] With high-leverage Binance futures → HIGH or VERY_HIGH
- [ ] Risk factors listed in red banner

---

## Pass 8: AI Trading Coach

### 8.1 Insufficient data
- [ ] On fresh account with < 10 trades → "Building your profile" message

### 8.2 With trade history
- [ ] After 10+ paper trades → insights appear
- [ ] At least one of: override insight, confidence insight, regime insight
- [ ] Each shows sample size

### 8.3 Futures summary
- [ ] With futures positions → "FUTURES ACCOUNTS" panel visible
- [ ] NSE and Binance balances and return % shown

---

## Pass 9: Health Dashboard

- [ ] Broker status correct (connected/not)
- [ ] WebSocket status shown
- [ ] Last reconciliation time fresh (< 30 seconds if positions open)
- [ ] Crash reports: 0 during this test run
- [ ] All sections load without error

---

## Pass 10: System Checks

### 10.1 App backgrounding
- [ ] Open with live position
- [ ] Background app for 60 seconds
- [ ] Return to foreground
- [ ] Reconciliation triggered (check Health Dashboard)
- [ ] Position P&L updated

### 10.2 Memory / performance
- [ ] Run app for 30 minutes across multiple screens
- [ ] No memory warnings
- [ ] Chart still loads in < 3 seconds after 30 minutes of use

### 10.3 Crash log (end of test run)
- [ ] Health Dashboard → Crash Reports: 0 crashes during test run
- [ ] Any crashes found must be investigated before release

---

## Sign-off

| Tester | Date | Device | Android Version | Result |
|--------|------|--------|-----------------|--------|
| | | | | ✓ / ✗ |

**Blocking issues (must fix before release):**
- 

**Non-blocking issues (log for v1.1):**
- 

**Release approved:** ☐ Yes  ☐ No
