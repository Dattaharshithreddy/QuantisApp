# Quantis — AI Trading Terminal (Native Android App)

A complete React Native / Expo project for a native Android trading app with:
- Live market data (Angel One SmartAPI, Binance WebSocket, Alpha Vantage, ExchangeRate API)
- AI Copilot powered by Claude — institutional-grade trade analysis
- **Risk Manager** — position sizing calculator, daily loss limit, Kelly Criterion
- **Trade Journal** — log trades, win rate / profit factor / drawdown analytics
- **Price Alerts** — push notifications when price targets are hit
- Candlestick charts with MA, Volume Profile (native SVG, no web view)
- Dark / Light theme (TradingView palette)

---

## 1. Prerequisites

Install once on your computer:

```bash
# Node.js LTS
https://nodejs.org

# Expo CLI (installed automatically via npx, no global install needed)
```

You do **not** need Android Studio to test the app — Expo Go on your phone is enough for development. You only need a build step (EAS Build, cloud-based, free tier) to get a real installable `.apk`.

---

## 2. Setup

```bash
# 1. Unzip this project, then inside the folder:
npm install

# 2. Start the dev server
npx expo start
```

A QR code appears in your terminal.

**To test instantly on your phone (no APK needed yet):**
1. Install **Expo Go** from the Play Store
2. Scan the QR code with the Expo Go app
3. The app loads live on your phone — try Markets, Chart, Risk Manager, Journal, Alerts

---

## 3. Build a real installable APK

This uses **EAS Build** — Expo's free cloud build service. No Android Studio needed.

```bash
npm install -g eas-cli
eas login          # create a free Expo account if you don't have one
eas build:configure
eas build -p android --profile production
```

This uploads your code to Expo's servers, builds a real signed `.apk`/`.aab`, and gives you a download link in ~10–15 minutes. Install that APK directly on your phone (enable "Install from unknown sources" if prompted).

**Alternative — build locally** (requires Android Studio + SDK installed):
```bash
npx expo run:android
```

---

## 4. Connecting Live Data

Open the app → **Settings** tab:

**Angel One (Nifty, Bank Nifty, NSE stocks)**
- Get API key at smartapi.angelbroking.com → Create App
- Enter API Key, Client Code, PIN, and a fresh 6-digit TOTP
- **Important:** unlike the web version, the native app does NOT need a CORS proxy server — Angel One's API works directly because CORS only restricts browsers, not native apps. This is a real advantage of the native build.

**Alpha Vantage (US stocks + live news)**
- Free key at alphavantage.co
- Paste into Settings → enables AAPL/NVDA/TSLA/MSFT + real news feed

**Binance & Forex** — connect automatically, no key required.

---

## 5. Project Structure

```
QuantisApp/
├── App.tsx                      # Root component, providers
├── src/
│   ├── api/                     # All external data fetchers
│   │   ├── angelOne.ts          # NSE live data (no proxy needed natively)
│   │   ├── binance.ts           # Crypto WebSocket
│   │   ├── forex.ts             # Forex rates
│   │   ├── alphaVantage.ts      # US stocks + news
│   │   ├── claude.ts            # AI analysis
│   │   └── assets.ts            # Asset universe config
│   ├── context/
│   │   ├── ThemeContext.tsx     # Dark/light theme
│   │   └── DataContext.tsx      # Central live price state
│   ├── utils/
│   │   ├── indicators.ts        # MA, RSI, Volume Profile, simulation engine
│   │   ├── riskManager.ts       # Position sizing, Kelly, daily loss limit
│   │   ├── journal.ts           # Trade logging + performance stats
│   │   └── alerts.ts            # Price alerts + push notifications
│   ├── components/
│   │   ├── CandlestickChart.tsx # Native SVG chart
│   │   └── Common.tsx           # Shared UI (cards, pills, buttons)
│   ├── screens/
│   │   ├── MarketsScreen.tsx    # Watchlist
│   │   ├── ChartScreen.tsx      # Chart + AI Copilot
│   │   ├── RiskManagerScreen.tsx
│   │   ├── JournalScreen.tsx
│   │   ├── AlertsScreen.tsx
│   │   └── SettingsScreen.tsx
│   └── navigation/index.tsx     # Bottom tab navigator
├── package.json
├── app.json
└── babel.config.js
```

---

## 6. Notes on the AI Copilot

The Claude API call in `src/api/claude.ts` calls `api.anthropic.com` directly from the device. For a published app you'd typically route this through your own backend to keep your API key server-side rather than embedding it client-side — this starter calls it directly for simplicity during development.

---

## 7. What's Tier 1 vs. what's next

**Built (Tier 1 + core terminal):**
- ✅ Risk Manager (position sizing, Kelly Criterion, daily loss limit lockout)
- ✅ Trade Journal (win rate, profit factor, R:R, max drawdown, best setup tag)
- ✅ Price Alerts (push notifications)
- ✅ Live charts (Angel One / Binance / Alpha Vantage) with MA + Volume Profile
- ✅ AI Copilot with order book + volume profile reasoning

**Not yet built (future additions):**
- Backtesting engine
- Multi-leg options strategy builder with live Greeks
- Portfolio view pulling real holdings from Angel One
- Economic calendar
- Multi-chart layout

---

## 8. Tier 2 & Tier 3 features (added)

**Tier 2:**
- ✅ **Options Strategy Builder** — Black-Scholes pricing, multi-leg payoff diagrams (straddle, strangle, iron condor, spreads), net Greeks (Delta/Gamma/Theta/Vega)
- ✅ **Portfolio** — real holdings + live P&L pulled directly from your Angel One account
- ✅ **Correlation Matrix** — see which of your watched assets move together (hidden concentration risk)
- ✅ **Economic Calendar** — upcoming FOMC, RBI MPC, CPI, NFP, earnings season, OPEC+ dates

**Tier 3:**
- ✅ **Multi-Chart Layout** — 4 charts stacked, tap any symbol to swap it
- ✅ **Strategy Screener** — scans your watchlist for oversold/overbought RSI and MA trend breaks
- ✅ **Voice Summary** — tap 🔊 on any screener result to hear a spoken market summary (on-device text-to-speech)
- ✅ **Paper Trading Mode** — toggle in Risk Manager to clearly separate practice trades from real ones

**Navigation:** these live under the new **"More"** tab (☰) to keep the bottom bar uncluttered — Markets, Chart, Risk, Journal, Alerts, More.

**Note on Voice:** full voice *command* input (speak a query, get a spoken answer) needs a custom native speech-recognition module not available in Expo Go without a custom dev client. What's built is the practical half — tap-to-speak summaries via on-device TTS, fully working in Expo Go as-is.

---

## 9. On-device Neural Network Signal (new)

A genuine feedforward neural network (1 hidden layer, backpropagation, trained with gradient descent) now runs **on-device** in `src/utils/neuralNet.ts` + `src/utils/mlSignal.ts`. Available on the Chart screen as **🧠 NEURAL NET SIGNAL**.

**What it actually does:**
- Trains from scratch on whichever asset you're viewing, using only that asset's own recent candles
- 9 engineered features per bar: 1-bar and 5-bar returns, 10-bar momentum, RSI, distance from MA20/MA50, volume z-score, volatility, wick ratio — all computed with **no lookahead** (only data available at that point in time)
- Predicts probability that price will be higher 3 bars ahead
- Reports **chronological out-of-sample accuracy** (last 20% of data, never shuffled into training) — not an inflated in-sample number
- Shows top contributing features for explainability

**What it honestly is NOT:**
- Not a guarantee of correct decisions — no model can promise that in markets
- Trained on a small sample (typically 60-130 bars per asset) — financial time series this short are noisy; expect accuracy to hover near 50-60% most of the time, and the app says so explicitly when accuracy is weak
- A complement to the Claude AI Copilot's reasoning, not a replacement — when you run Claude analysis after training the neural net, its signal gets passed into the prompt as one minor weighted input, explicitly labeled as low-sample-size

**Verified:** the backprop math was functionally tested (not just syntax-checked) against three cases — perfect learning on XOR (confirms gradients are correct), ~87% accuracy on a noisy-but-real synthetic signal (confirms it learns genuine patterns), and ~50-55% on pure random noise (confirms it doesn't fake-learn structure that isn't there).

---

## 10. Search Any Symbol (new)

You're no longer limited to the ~28 built-in assets. Tap **"+ Add Symbol"** on Markets, or **"🔍 Search any symbol"** on the Chart screen, to search:

- **Crypto** — any of Binance's 2000+ live USDT trading pairs
- **NSE Stocks/Index** — any NSE-listed stock or index, resolved against Angel One's official public scrip master file (same source algo-trading tools use to map symbol→token)
- **US Stocks** — any globally listed stock via Alpha Vantage's symbol search (needs your AV key)
- **Forex** — any currency pair available from the live rates feed

Tap a result to add it to your watchlist and open its chart immediately — live data starts right away if a connection exists for that source (Binance/AO/AV), or shows clearly as `◎ SIMULATED` if not. Long-press any custom-added symbol in Markets to remove it.

**What changed under the hood:** Angel One lookups now carry their own instrument token/exchange directly on each asset (resolved at search time from the real scrip master), instead of being limited to a small hardcoded map — this is what makes "any NSE stock" actually work, not just the original 13.

---

## 11. Bug Fixes — round 2

**1. AI Copilot ("Claude is not connecting") — real bug, now fixed**
The Claude API call had **no authentication header at all**. This worked invisibly in the original web/artifact prototype because Claude.ai's sandbox auto-injects credentials — but a standalone native app must supply its own key. Fixed:
- Added required `x-api-key` and `anthropic-version` headers
- Corrected the model identifier
- Added an **Anthropic API key field in Settings** (top of the screen, since it's required) — get one at console.anthropic.com (a separate, usage-billed API key, not your claude.ai login)
- Clear in-app warnings if the key is missing, plus specific error messages for invalid-key (401) vs rate-limit (429) cases instead of a generic failure

**2. Chart not expanding — real bug, now fixed**
The chart's width was read once from `Dimensions.get('window')` at module load time and frozen forever — if that initial measurement ran before native layout was ready (a known Android timing issue), the chart could get stuck at the wrong size permanently. Replaced with the reactive `useWindowDimensions()` hook. Also added a genuine **⛶ fullscreen expand button** on every chart for a proper full-screen view.

**3. Price Alerts — couldn't pick any symbol — real bug, now fixed**
The alert symbol picker was hardcoded to the first 12 built-in assets with no way to type or search anything else. Now shows every asset you're tracking (built-ins + anything added via Symbol Search) and includes a **"🔍 Search any symbol"** shortcut that jumps to Symbol Search and pre-fills the alert form with whatever you pick.

**4. Markets filter bar — redesigned**
Replaced the plain text pill row with icons, per-category live counts, larger touch targets, and a clearer active-state (filled accent background vs. outline) so it actually reads well at a glance.

---

## 12. Bug Fixes — round 3

**1. Neural Net "memory" — was a dead write, now actually works**
Confirmed: every tap of TRAIN & PREDICT created a brand-new randomly-initialized network and saved its weights afterward, but nothing ever loaded them back. Fixed — it now loads last session's saved weights for that symbol (if shape-compatible) and continues training from there (warm start), so repeated use genuinely accumulates learning instead of restarting from scratch every time. The UI now shows "♻ Continued training" vs "🆕 First training run" so this is visible, not silent.

**2. Soft normalization leak — fixed**
Feature normalization (mean/std) was previously computed across the full dataset (train+test combined) before splitting — meaning the test set's scale technically benefited from statistics that included the test period. Now computed from the training portion only, then applied identically to both train and test. Out-of-sample accuracy numbers are now slightly more rigorous.

**3. Stocks showing wrong/frozen prices — root cause found and fixed**
Alpha Vantage's free tier allows only **25 requests/day total**. With several stocks polling every 65 seconds, this exhausts within minutes — after which every poll fails silently, and the price was left **frozen forever** at its last value with no indication it had gone stale. Added a staleness sweep: any "live" price untouched for 3+ minutes automatically reverts to clearly-labeled simulated data. Also added an explicit rate-limit warning in Settings so this isn't a mystery.

**4. Built-in assets couldn't be removed — fixed**
The original ~28 assets are hardcoded in code, not stored data, so there was no way to "delete" them. Added a hidden-assets list (separate from the custom watchlist) — long-press any asset, built-in or custom, to remove it from view. A "Restore defaults" link appears in Markets whenever anything is hidden.

**5. Layout clipping — root cause found and fixed**
Every screen was importing `SafeAreaView` from React Native's **core** library — which has always been an unreliable no-op on Android (this is a long-documented platform limitation; iOS-only in practice). The project already had the correct replacement (`react-native-safe-area-context`) installed and wrapping the whole app, but no individual screen actually used it. Fixed across all 14 screens + the chart component. Also added trailing padding to horizontal scroll rows (symbol pills, timeframe buttons) so the last item never sits flush against the screen edge.

---

## 13. Major feature additions — round 4

**1. Simulation removed completely**
Every trace of fabricated/simulated price and candle data has been deleted from the codebase — `simCandles()` no longer exists at all. If an asset has no connected live source, you now see an explicit "No live data source connected" message instead of a chart, never a number that looks real but isn't. Gold and Crude Oil were removed from the default list entirely since this app never had a real data source wired up for them — they only ever showed fabricated candles. Price status is now three real states: `live`, `stale` (a real source went quiet — Alpha Vantage's 25-req/day limit is the most common cause — last real price is shown frozen and clearly flagged), or `none` (never received real data).

**2. Real pinch-to-zoom and pan-to-scroll-history**
The chart now supports genuine multi-touch gestures via `react-native-gesture-handler`:
- **Pinch** to zoom in/out (changes how many candles are visible, 15–200 range)
- **Drag horizontally** to scroll back through history
- When you drag back far enough to reach the oldest currently-loaded candle, the chart automatically fetches an earlier real batch from Binance or Angel One and prepends it — so you can keep scrolling back through actual history, not just what was initially loaded. A "Loading earlier data…" indicator shows during the fetch, and a "⏵ Jump to live" button appears whenever you've scrolled away from the present.
- **Honest limitation:** Alpha Vantage's free intraday endpoint already returns its maximum available window with no further pagination support, so AV-sourced stocks can't load additional history beyond what's initially fetched — pinch/zoom still works, but panning won't extend further back for those.
- **Note on testing:** the gesture math was implemented using react-native-gesture-handler's well-documented component API (not the newer reanimated-worklet-based Gesture API, to keep state updates as plain, predictable React state). I cannot simulate real multi-touch input in this environment the way I could unit-test the neural network's math — gesture *feel* (sensitivity, smoothness) should be verified on a real device, though the underlying view-window logic (what range of data to show, when to trigger history loading) was reasoned through carefully.

**3. AI Chat — conversational, grounded in live data**
New 💬 Chat button next to ANALYZE on the Chart screen opens a full conversational interface where you can ask anything in your own words — "predict where this is headed," "give me entry, target, and stop-loss," "what's the order book saying" — and get a grounded answer, not a guess:
- On open, it pulls a fresh snapshot of live price, recent candles, RSI/MA, order book (if Angel One depth is available), recent news, and a quick on-device ML read — all sent as real context with every message via Anthropic's `system` parameter
- Multi-turn — follow-up questions work naturally, with full conversation history sent each call (required since the API itself is stateless)
- A "↻ Refresh data" button lets you manually re-pull live context mid-conversation, since prices can move during a longer chat
- If no live source is connected for the symbol, it refuses to chat about fabricated numbers and tells you to connect one first — same honesty principle as the rest of the app

---

## 14. Three more real bugs found and fixed

**1. Pan-to-scroll-history wasn't working — confirmed**
`PanGestureHandler` and `PinchGestureHandler` were nested as parent/child with no `simultaneousHandlers` configuration — a well-documented react-native-gesture-handler gotcha where two handlers compete for the same touch and only one wins. The inner pinch handler very plausibly claimed every touch sequence, meaning pan likely never activated at all. Rewritten using RNGH's modern `Gesture.Simultaneous(panGesture, pinchGesture)` composition API, which is the library's own documented, recommended way to make pan + pinch genuinely work together. `.runOnJS(true)` keeps the callbacks as plain JS updating normal React state — no reanimated worklets needed.

**2. Order book — confirmed real gap, not a connection problem**
The data was always correct: `DataContext.tsx` pulls real 5-level market depth from Angel One's `FULL` quote mode and stores it per-symbol. The bug was that **no UI ever displayed it** — it was only ever used silently as text fed into the AI Copilot's prompts. Added a real Order Book card on the Chart screen for Angel One assets: live bid/ask depth, a buy/sell pressure bar, and total buy/sell quantity — directly from the same data that was already being fetched correctly.

**3. "Only MA and volume showing, no candles"**
Re-read the rendering code line by line and could not find a code-level bug causing this specifically — candles render after MA lines (so they're on top, not hidden behind), and all three (candles/MA/volume) come from the same data array, so if one renders the others should too. Couldn't reproduce or confirm this one without seeing it — if it persists after this update, a screenshot would help pin down the actual cause rather than guessing further.

---

## 15. Institutional-grade feature engineering — what was built, and what's honestly out of reach

You asked for a comprehensive institutional-grade feature list. Before listing what's built, here's what's **not possible** in this app and why — pretending otherwise would be dishonest:

**Genuinely not feasible here:**
- **LSTM / Transformer / CNN** — these require GPU training infrastructure. This app runs plain JavaScript on your phone's CPU; there's no way to train these architectures from scratch on-device at meaningful scale.
- **XGBoost / LightGBM** — no mobile-compatible JS-native implementation exists without heavy native modules that would break Expo Go.
- **10,000–50,000 historical bars** — free broker/exchange APIs cap historical data (Binance: 1000/call; Angel One: similar limits). Real institutional infra uses paid data vendors for this depth.
- **True SHAP** — computationally expensive even server-side; what's implemented is an honest weight-based heuristic, explicitly labeled as such.
- **Order flow microstructure** (footprint delta, iceberg detection, absorption), **options put/call ratio**, **liquidation heatmaps**, **whale alerts**, **social sentiment**, **DXY/VIX** — all require paid specialized data vendors with no free, reliable API available to wire up.

**What's genuinely built — real math, verified working:**

*New indicator library (`technicalIndicators.ts`)* — EMA, SMA, MACD, Stochastic RSI, ROC, Momentum, CCI, Williams %R, TSI, ATR, Bollinger Bands + width, Keltner Channel, Donchian Channel, Historical Volatility, OBV, MFI, CMF, Volume Oscillator, Accumulation/Distribution, Relative Volume, VWAP, ADX, Parabolic SAR, multi-horizon returns. Sanity-tested against known mathematical properties (EMA reacts faster than SMA to jumps, RSI hits 0/100 on pure losses/gains, ATR stays positive, Bollinger bands stay correctly ordered) — all passed.

*Market structure (`marketStructure.ts`)* — swing high/low detection, HH/HL/LH/LL classification, simplified BOS/CHoCH heuristic, classic floor pivots, Fibonacci retracement levels, trend direction, volatility regime classification.

*Candlestick patterns (`candlePatterns.ts`)* — Doji, Hammer, Pin Bar, Bullish/Bearish Engulfing, Morning/Evening Star, Inside/Outside Bar.

*Time features (`timeFeatures.ts`)* — hour, day of week, month, weekend flag, trading session (Asia/London/NY/overlap).

*Real free data sources added* — Binance Futures funding rate + open interest + long/short ratio (`cryptoDerivatives.ts`), Fear & Greed Index (`sentiment.ts`) — both genuinely free, no key, real public APIs.

*Multi-horizon prediction* — trains across 1/3/5/10/20-bar horizons instead of just 3, each with its own out-of-sample accuracy.

*Genuine ensemble* — a structurally different second model (logistic regression, its own gradient descent, separate from the neural net) trained on the same ~30 features, combined via averaging. "Ensemble agreement" tells you whether both model families actually agree, not just one model's opinion presented twice.

*Walk-forward validation* — instead of one static 80/20 split, slides 4 training/testing windows forward across time and averages out-of-sample accuracy — substantially more rigorous than a single holdout, since it tests generalization across multiple periods.

*Buy/Hold/Sell + ATR-based SL/TP + risk/confidence scores* — derived from ensemble agreement and horizon consensus, with stop-loss/take-profit computed from real ATR (1.5×/2.5×, a standard risk convention), not arbitrary numbers.

**Verified before integration:** every new indicator was unit-tested for mathematical correctness in isolation, and the full pipeline was then integration-tested end-to-end against 200 bars of synthetic data — zero crashes, zero NaN values across 754 checked outputs, sane value ranges throughout.

---

## 16. Codebase Audit + Priority 1 (Data Pipeline) Implementation

A full feature-by-feature audit was performed against a 10-priority institutional-grade roadmap before any new code was written. Full audit table is in the implementation report delivered alongside this update. Priority 1 (Data Pipeline) is now complete:

- **Local candle caching** (`candleCache.ts`) — AsyncStorage-backed, per-timeframe TTL (1m→60s through 1W→4h), chart renders instantly from cache while a fresh fetch runs in the background
- **Automatic gap detection + repair** (`gapDetection.ts`) — scans every loaded series for missing bars, attempts a real re-fetch of that exact window from the same source, never fabricates filler data
- **Retry with exponential backoff** (`retry.ts`) — applied to Binance klines, Angel One candles, and Alpha Vantage — with a `shouldRetry` predicate so AV's rate-limit errors are deliberately NOT retried (retrying would burn through the 25/day budget faster, not help)
- **Centralized logger** (`logger.ts`) — in-memory ring buffer + console, replaces silent `catch(_){}` swallowing
- **Stale-cache fallback** — if a network fetch fails but cached data exists, the chart keeps showing the last real data with a clear "may be outdated" flag instead of going blank

All new logic was functionally tested (not just syntax-checked): gap detection correctly identifies injected gaps, candle merging dedupes by timestamp with fresh data winning conflicts, and retry logic was verified to both succeed-after-transient-failure and correctly skip non-retryable errors.

---

## 17. Training Metadata Bug — Root Cause Found and Fixed

**Investigated as requested, root cause confirmed:** the storage layer was never the problem — `AsyncStorage.setItem` always fully overwrites on every save, verified directly in code. The real causes were:

1. **No race-condition guard existed.** If a user trained, then loaded more history and trained again before the first run finished, training time scales with candle count — the older, slower call could complete *after* the newer one and silently overwrite it with stale numbers. Fixed with a request-token ref in `ChartScreen.tsx`: every training run gets a unique ID, and any result returning after a newer run has started is explicitly discarded rather than applied.
2. **Metadata wasn't persisted/reloaded independently of live state.** Switching assets reset the Signal Engine card to blank `idle` — never stale, but also never showing the last real training for that symbol. Fixed by writing a dedicated `ModelMetadata` record (full overwrite, never merged) immediately after every successful training, with an explicit reload on symbol switch — so the UI always reflects either a fresh run or the last real persisted one, never nothing and never something stale.
3. **Bonus bug found while fixing this:** `dayOfWeekNorm` was computed but never included in the returned feature vector — a genuine off-by-one between `FEATURE_NAMES` (31 entries) and the actual feature array (30 values), meaning the 31st feature name was silently mismatched against undefined data. Fixed and verified programmatically (38 names = 38 values after the Priority 2 additions, confirmed via an exact array-length check, not manual counting).

All training runs now log entry/exit candle counts via the new logger, so any future metadata discrepancy is immediately traceable instead of requiring guesswork.

---

## 18. Priority 8 — Professional Backtesting Engine

Built `src/utils/backtest.ts` + `src/screens/BacktestScreen.tsx` (Markets → More → Backtesting). Trains a fresh, throwaway model once on the first half of history, then walks forward bar-by-bar through the second half using the exact same causal feature pipeline as live prediction — verified with a dedicated anti-leakage test (see below) before anything else was built on top of it.

**Verified correctness, in order:**
1. **Anti-leakage proof**: built two candle series identical for 200 bars, then diverging into a fantasy future (price growing to 5.58×10²⁹) for one of them. Confirmed features at bars 25/50/100/150/195 are byte-identical between both — proves the pipeline genuinely cannot see the future, regardless of how dramatically different it is.
2. **Trade math**: P&L, fee deduction, slippage (adverse on both entry and exit), drawdown calculation, and fixed-fractional position sizing all verified against hand-calculated expected values.
3. **Full end-to-end replica run** (Node, faithful port of the real engine) against two scenarios: pure random walk produced 2 trades, 50% win rate, ~0% return (correctly finds no fake edge in noise); a series with genuine trend/momentum structure produced 37 trades, 75.7% win rate, 3.02 profit factor, 69.3% return (correctly detects and profits from real structure when it exists). Same engine, opposite results — exactly what a trustworthy backtester should do.

---

## 19. Backtest Verification & Stress Test Suite

Built 8 new modules (`seededRandom.ts`, `strategyExecutor.ts`, `baselineStrategies.ts`, `monteCarlo.ts`, `sensitivityAnalysis.ts`, `regimeAnalysis.ts`, `modelStability.ts`, `engineValidation.ts`) + `VerificationScreen.tsx`. Two real bugs were found and fixed while building this — exactly the kind of thing this exercise is supposed to catch:

1. **Reproducibility was previously false.** Model weight init used JS's non-seedable `Math.random()` — "rerun with the same data gives the same result" was assumed, not true. Fixed with a seeded PRNG (mulberry32), verified bit-identical across reruns with the same seed, and genuinely different with a different seed.
2. **My first Monte Carlo design was mathematically wrong.** Pure permutation of the same trade returns, compounded multiplicatively, is provably order-invariant — `(1+r1)(1+r2)...(1+rn)` gives an identical final value regardless of multiplication order. A direct test confirmed this (three different orderings produced the same result to floating-point precision). Fixed by switching to **bootstrap resampling with replacement**, the statistically correct technique, re-verified to produce genuine variance.

See the full report delivered alongside this update for results, including an honest negative finding from end-to-end testing.

---

## 20. Production Model Evaluation Suite

Built the real evaluation engine (`maxHistoryFetch.ts`, `featureContribution.ts`, `horizonEvaluation.ts`, `thresholdEvaluation.ts`, `modelComparison.ts`, `productionEvaluation.ts` + `ProductionEvaluationScreen.tsx`), wired to fetch real market data via paginated Binance history (Binance caps each call at 1000 bars; this chains calls backward for genuinely deeper history) and run the actual 38-feature production pipeline — not synthetic data.

**Critical limitation, stated upfront rather than glossed over**: this development sandbox has no network access to `api.binance.com` (verified directly — a raw `curl` returned "Host not in allowlist"). I cannot pre-run this against real BTCUSDT/ETHUSDT/SOLUSDT/BNBUSDT data myself. The engine is fully real and will produce genuine results once run in the actual app on a device with real internet access — see exact steps below.

**Two real bugs found and fixed while building this:**
1. **My own code, not Binance, was missing 30-minute candle support.** I almost shipped a comment blaming "Binance doesn't offer a native 30m interval" — checked before trusting that claim, and it was wrong. Binance does support 30m; my own `TF_BN`/`TF_AO` mappings just never included it. Fixed in both `binance.ts` and `angelOne.ts`.
2. **The held-out validation set for feature-importance analysis came out empty.** Discovered via a mechanics test: trying to carve a test set from the thin leftover buffer between training and the walk-forward boundary frequently left 0 samples (silent NaN, no crash). Fixed by restructuring into a genuine three-way split (train / properly-sized validation / walk-forward), re-verified to produce a real, non-empty validation set (66 samples, valid accuracy, real feature ranking in the mechanics test).

---

## 21. Phase 1 — Bug Fixes (Trading Assistant)

Investigated each reported bug against real code before writing any fix, per instruction. Full report below.
