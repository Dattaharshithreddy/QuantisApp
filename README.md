# QUANTIS AI Trading Terminal — v4.5.4

A production-grade React Native / Expo trading app with on-device ML, paper trading, and real-time market data.

---

## Feature Summary

### Core Platform
- Live market data: Angel One (NSE), Binance (Crypto), Alpha Vantage (US stocks), ExchangeRate API (Forex)
- Dark / Light theme (TradingView-style palette)
- Bottom tab navigation: Markets · Chart · Risk · Journal · Alerts · More
- Search any symbol: 2000+ Binance pairs, any NSE stock, any US stock, any forex pair
- Local candle caching with background refresh and stale-data fallback
- Automatic gap detection and repair in loaded price series
- Retry with exponential backoff on all data sources
- Centralized logger with in-memory ring buffer

### Candlestick Chart
- Native SVG rendering — no WebView, no third-party chart library
- Horizontal pinch-to-zoom (15–200 candles visible)
- **Vertical pinch-to-zoom (NEW)** — zoom the price scale independently
- Pan-to-scroll history with momentum and auto-load of older bars
- Double-tap resets both zoom axes
- Fullscreen expand button
- Overlay toggles: MA (20/50), Volume Profile, Bollinger Bands, Keltner Channel, Donchian Channel, Fibonacci levels, Pivot Points
- Live price tick overlay on last candle
- Crosshair with OHLCV detail panel

### AI / ML Pipeline
- On-device neural network (MLP + Logistic Regression ensemble)
- 38 engineered features: EMA, SMA, MACD, RSI, Stochastic RSI, ATR, Bollinger, Keltner, Donchian, OBV, MFI, CMF, VWAP, ADX, Parabolic SAR, candlestick patterns, market structure (swing highs/lows, BOS/CHoCH), time features, multi-horizon returns
- Walk-forward validation (4 folds) — no lookahead, no data leakage
- Multi-horizon prediction (1/3/5/10/20 bars)
- Seeded PRNG for reproducible training
- Warm-start: loads saved weights from AsyncStorage, continues training
- **Dynamic button label**: shows "Predict" when model is fresh, "Train & Predict" when retraining is needed
- Post-prediction message explains what happened (retrained / reused / rejected)
- Force Retrain button always retrains regardless of freshness
- Per-symbol/timeframe model persistence in AsyncStorage
- AI Chat (conversational, grounded in live price + order book + ML signal)
- Claude AI Copilot with order book + volume profile context

### Production Model Evaluation
- Step 1: Full production strategy (LONG + SHORT) with default parameters
- Step 2: Horizon comparison (LONG-only, for consistent relative ranking)
- Step 3: Model comparison — NN vs LR vs Ensemble
- Feature importance (permutation-based, leak-safe)
- Baseline comparison: Buy & Hold, EMA Crossover, SMA Crossover, RSI Strategy, MACD, Random Entry
- **Background execution** — runs while you navigate anywhere in the app
- Live step-by-step progress per combination
- Task persists if you leave the screen, reconnects on return
- Notifications on completion — tap notification opens the screen

### Execution Optimizer
- Sweeps SL ATR multiplier (1.0–2.5×), TP ATR multiplier (2.0–4.0×), max holding bars (20/40/60), risk % (1/2%)
- Generalization check on a second seed to prevent overfitting
- BASELINE label clearly shows "Best Horizon, Default Execution" (not global defaults)
- **Background execution** with same architecture as Production Evaluation

### Professional Backtesting Engine
- Walk-forward (train on first half, test on second half, bar-by-bar)
- Verified anti-leakage: features at any bar are byte-identical regardless of future data
- Fixed-fractional position sizing, ATR-based SL/TP, fee + slippage deduction
- Monte Carlo (bootstrap resampling), sensitivity analysis, regime analysis, model stability checks
- Verification screen with 8-module test suite

### Paper Trading
- Long and Short positions
- AUTO and MANUAL execution modes
- **Symmetric margin model**: both LONG and SHORT debit cash on open, return margin + P&L on close
- Portfolio equity, cash balance, unrealized P&L, realized P&L, daily P&L all internally consistent
- Stop Loss, Take Profit, trailing stop auto-management
- Position scoring (trade quality grade A–F)
- Daily loss limit enforcement
- Notifications for trade opened, closed, SL hit, TP hit, trailing stop move, daily summary
- **Notification tap opens Paper Trading screen directly**
- Journal & Analytics view with win rate, profit factor, drawdown, Sharpe

### Scanner
- Automatic scan every 5 minutes (always 15m timeframe — stated clearly in UI)
- Manual Scan Now — **background execution**, instant button feedback
- Live per-symbol step progress (✓ / ⟳ / ✗)
- Notifications on scan completion with signal count
- **Notification tap opens Scanner screen directly**
- Opportunity ranking: top signals, longs, shorts, confidence, risk/reward, recently changed
- Regime filter (Disabled / Bull Only / Trending Only / Avoid Low Vol / Avoid Ranging)
- Multiple watchlists
- Reconnects to running scan on navigation return

### Navigation & UX
- **All tasks (eval, optimizer, scanner) run in background** — back button and tabs work immediately
- Training loops yield every 10 epochs — JS event loop stays responsive during ML training
- `InteractionManager.runAfterInteractions` defers heavy work until navigation animations finish
- Notification tap routing: Scanner → Scanner screen, PaperTrading → Paper Trading, Eval/Optimizer → Production Evaluation
- Current-route guard prevents notification tap from ejecting you if already on the target screen
- "Running in background" notification fires when you navigate away from a running task (blur listener with ref pattern — no premature firing on task start)
- Stale-task recovery on next launch: tasks interrupted by process kill show as "interrupted" tombstone

### Risk Manager
- Position sizing calculator (Kelly Criterion, fixed fractional)
- Daily loss limit with lockout
- Exposure by asset class

### Additional Screens
- Alerts (price target push notifications)
- Multi-chart layout (4 charts)
- Options Strategy Builder (Black-Scholes, multi-leg payoff diagrams)
- Portfolio (real holdings from Angel One)
- Correlation Matrix
- Economic Calendar
- Strategy Screener (RSI oversold/overbought, MA breaks)
- Voice summary (on-device TTS)

---

## Current Version

| Field | Value |
|---|---|
| Version | 4.5.4 |
| versionCode | 55 |
| Date | 2026-07-03 |
| Min SDK | Android (Expo SDK 51) |

---

## Changelog (recent)

| Version | Summary |
|---|---|
| 4.5.4 | Vertical chart zoom: pinch up/down to zoom price scale (0.5×–20×). Double-tap resets both axes |
| 4.5.3 | Paper trading notifications now open Paper Trading screen on tap (data.screen routing) |
| 4.5.2 | Training loops fully async with yield every 10 epochs — navigation responsive throughout ML training |
| 4.5.1 | evaluateAllHorizons made async with yields between horizons |
| 4.5.0 | Screen audit: load() no longer called every second on Scanner, optimTask guard fixed, interrupted status on Scanner card |
| 4.4.9 | Fixed premature "running in background" notification on task start (useFocusEffect ref pattern). Fixed notification tap ejecting user from screen (route guard) |
| 4.4.8 | Scanner blur listener and notification routing (Scanner → ScannerDashboard) |
| 4.4.7 | InteractionManager.runAfterInteractions, navigation ref, notification tap opens correct screen, blur listener |
| 4.4.6 | UI clarity: Step 1 (LONG+SHORT) vs Step 2 (LONG-only) labeling in Production Evaluation |
| 4.4.5 | try/finally removeRunningId in all 3 task loops — AsyncStorage cleanup guaranteed |
| 4.4.4 | Removed AppState backgrounding→failed logic. Stale-task recovery via AsyncStorage on next launch |
| 4.4.3 | Scanner wired to background task architecture. Scanner progress per symbol |
| 4.4.2 | Background task system: EvalTaskContext, ProductionEvaluation as pure observer |
| 4.4.1 | CI fix: expo-splash-screen pinned to ~0.27.7 for SDK 51 |
| 4.4.0 | Dynamic Predict/Train & Predict button, scanner 15m transparency card, ETA multi-item fix, button lag fix, stale-label flicker fix |
| 4.3.5 | SHORT cash accounting fix, white-flash splash fix, Android haptic removed |

---

## Setup

```bash
npm install
npx expo start
```

Scan QR with Expo Go, or build APK:

```bash
npm install -g eas-cli
eas login
eas build -p android --profile production
```

---

## Project Structure

```
QuantisApp/
├── App.tsx                          # Root + notification response handler
├── src/
│   ├── api/                         # Data sources
│   │   ├── angelOne.ts              # NSE live data
│   │   ├── binance.ts               # Crypto WebSocket + REST
│   │   ├── alphaVantage.ts          # US stocks
│   │   └── assets.ts                # Asset universe
│   ├── context/
│   │   ├── DataContext.tsx          # Live prices
│   │   ├── ThemeContext.tsx         # Dark/light
│   │   ├── ScannerService.tsx       # Auto-scan interval
│   │   └── EvalTaskContext.tsx      # Background task manager (eval/optim/scanner)
│   ├── utils/
│   │   ├── mlSignal.ts              # ML pipeline, trainWithEarlyStopping (async)
│   │   ├── backtest.ts              # Backtesting engine, fitEnsemble (async)
│   │   ├── horizonEvaluation.ts     # Horizon sweep (async, yields between horizons)
│   │   ├── productionEvaluation.ts  # Production eval orchestration
│   │   ├── modelOptimization.ts     # Execution optimizer
│   │   ├── paperTradingEngine.ts    # Paper trade open/close (symmetric margin)
│   │   ├── paperPortfolio.ts        # Portfolio state + computePortfolioValue
│   │   ├── paperNotifications.ts    # Paper trade notifications (data.screen routing)
│   │   ├── navigationRef.ts         # Module-level nav ref + navigate functions
│   │   ├── indicators.ts            # 30+ technical indicators
│   │   └── alerts.ts                # Push notification handler
│   ├── components/
│   │   ├── CandlestickChart.tsx     # Native SVG chart (h + v zoom)
│   │   ├── EvalTaskCard.tsx         # Floating background task card
│   │   └── Common.tsx               # Shared UI components
│   ├── screens/
│   │   ├── ChartScreen.tsx
│   │   ├── ProductionEvaluationScreen.tsx  # Pure observer of EvalTaskContext
│   │   ├── ScannerDashboardScreen.tsx      # Pure observer of EvalTaskContext
│   │   ├── PaperTradingScreen.tsx
│   │   └── ...
│   └── navigation/index.tsx         # Navigation container + ref wiring
├── app.json                         # v4.5.4, versionCode 55
└── src/buildInfo.ts                 # Build metadata
```

---

## Architecture Notes

### Background Task System
`EvalTaskContext` owns all evaluation, optimization, and scanner tasks. Screens are pure observers — they read task state from context and display it. Task execution continues regardless of which screen is active. On app process kill, stale running IDs are detected via AsyncStorage on next launch and shown as `interrupted` tombstones.

### ML Responsiveness
All training loops (`trainWithEarlyStopping`, `fitEnsemble`, `walkForwardValidate`) yield to the JS event loop every 10 epochs via `await new Promise(r => setTimeout(r, 0))`. This keeps navigation responsive during the 2–5 minute evaluation runs without changing the training math in any way (verified by A/B comparison: 321 parameters, max weight difference = 0.0).

### Cash Accounting (Paper Trading)
Symmetric margin model: both LONG and SHORT open debit `(positionValue + entryFee)` from cash. LONG close returns `exitNotional - closeFee`. SHORT close returns `2 × entryNotional - exitNotional - closeFee` (margin returned + P&L). Verified across all 4 scenarios (LONG win/loss, SHORT win/loss).
