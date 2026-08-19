# QUANTIS — Complete Technical Documentation
**Reverse-engineered directly from the production source code.**
**Every claim is grounded in a specific file and function.**

Version 6.9.9 · July 2026 · © 2026 Datta Harshith Reddy

---

## Table of Contents

1. Project Overview
2. Complete Feature List
3. Markets Screen
4. Chart Screen
5. Machine Learning Engine
6. Prediction System
7. Confidence Engine
8. Trade Readiness & Signal Gates
9. Smart Money Concepts (SMC) Engine
10. Multi-Timeframe (MTF) Engine
11. Market Context Engine
12. Strategy Profile System
13. Training Status System
14. Verification & Stress Testing
15. Paper Trading
16. Shadow Journal
17. Override System
18. Signal Snapshot (Permanent Decision Record)
19. Production Evaluation (Extended)
20. Market Context Analytics
21. Journal & Analytics
22. Alerts
23. AI Chat / Copilot
24. Data Sources
25. Storage
26. Performance
27. Security
28. Test Suite
29. Current Limitations
30. Technical Debt
31. Changelog (v4.5.4 → v6.9.9)

---

## 1. Project Overview

### Purpose
QUANTIS is a React Native / Expo Android (and iOS-compatible) trading terminal. It combines live multi-source market data, a homegrown 116-feature machine-learning signal engine, multi-engine confidence scoring, paper trading with full risk management, Smart Money Concepts analysis, and a background task architecture that keeps long-running evaluations alive while the user navigates freely. It does not place real trades — all paper trading is explicitly simulated.

### Supported Asset Classes
Verified from `src/api/assets.ts` `Asset['type']` union: `INDEX`, `STOCK`, `FOREX`, `CRYPTO`, `COMMODITY`.

### Supported Data Sources
Four real source codes in `assets.ts`: `'ao'` (Angel One — Indian exchanges), `'av'` (Alpha Vantage — US stocks), `'binance'` (crypto), `'forex'` (live spot-rate only). `'sim'` was removed — no fabricated data sources remain.

### Overall Architecture
A single Expo/React Native app. `App.tsx` wraps everything in `GestureHandlerRootView` and a `DataContext` provider. Navigation is `src/navigation/index.tsx` using React Navigation bottom tabs (Markets, Chart, Risk, Journal, Alerts, More) plus a stack for modal/secondary screens.

### Folder Structure (verified)
```
src/
  api/          — external data source clients
  components/   — shared UI components (MarketContextCard, Common, etc.)
  context/      — DataContext, EvalTaskContext, ScannerService, ThemeContext
  hooks/        — useRunProgress
  navigation/   — index.tsx
  screens/      — 26 screens
  theme/        — colors.ts
  utils/        — 84+ flat files + subdirectory modules:
    confidence/         — multi-engine confidence scoring
    cryptoMarketContext/ — crypto market context (Fear/Greed, BTC Dom, Funding, OI)
    fvg/                — Fair Value Gap engine
    marketContext/      — Indian market context (VIX, Breadth, FII/DII, PCR, Sectors)
    modelHealth/        — drift detection (CUSUM + Page-Hinkley)
    mtf/                — multi-timeframe engine + trade readiness
    patternValidation/  — pattern lifecycle, outcome tracking, risk engine
    regime/             — 11-label market regime engine
    smc/                — Smart Money Concepts (order blocks, liquidity, FVG, PD zones)
    strategy/           — 4 strategy profiles, filter, storage, performance
    structure/          — market structure analysis (BOS, CHoCH, swings, trends)
    volume/             — anchored VWAP, volume profile, volume scoring
    xai/                — explainable AI (feature attribution, XAI scoring)
217 .ts/.tsx files total under src/
```

### Technology Stack (verified from package.json)
- React 18.2.0, React Native 0.74.5, Expo ~51.0.0
- Navigation: `@react-navigation/native` ^6, bottom-tabs, native-stack
- Gestures: `react-native-gesture-handler` ~2.16.1, `react-native-reanimated` ~3.10.1
- Storage: `@react-native-async-storage/async-storage` 1.23.1, `expo-secure-store` ~13.0.24
- Rendering: `react-native-svg` 15.2.0 (native SVG charts — no WebView)
- Other: expo-haptics, expo-linear-gradient, expo-notifications, expo-speech, expo-status-bar

No state-management library (Redux, MobX, Zustand) — plain React Context + useState/useReducer.

No ML/tensor library. The neural network and logistic regression in `neuralNet.ts` and `logisticRegression.ts` are hand-written, dependency-free TypeScript. This is deliberate and verifiable.

---

## 2. Complete Feature List

| Feature | Screen file | Status |
|---------|-------------|--------|
| Live market list | MarketsScreen.tsx | Implemented |
| Candlestick chart + gestures | ChartScreen.tsx | Implemented |
| ML signal/prediction | mlSignal.ts (engine) | Implemented |
| Multi-engine confidence | confidence/confidenceEngine.ts | Implemented |
| Trade Readiness (READY/WAIT/AVOID) | mtf/tradeReadiness.ts | Implemented |
| Smart Money Concepts analysis | smc/smcEngine.ts | Implemented |
| Market structure (BOS/CHoCH/swings) | structure/marketStructure.ts | Implemented |
| Fair Value Gaps | fvg/fvgEngine.ts | Implemented |
| Multi-timeframe alignment | mtf/mtfEngine.ts | Implemented |
| Signal gates (shared READY/WAIT/AVOID logic) | signalGates.ts | Implemented |
| XAI feature attribution | xai/xaiEngine.ts | Implemented |
| Model drift detection | modelHealth/driftDetector.ts | Implemented |
| Strategy profiles (4) | strategy/strategyProfiles.ts | Implemented |
| Strategy filter | strategy/strategyFilter.ts | Implemented |
| Indian Market Context (VIX/Breadth/FII/PCR) | marketContext/ | Implemented |
| Crypto Market Context (F&G/BTC Dom/Funding/OI) | cryptoMarketContext/ | Implemented |
| Market Context Snapshot (per-trade) | marketContextSnapshot.ts | Implemented |
| Signal Snapshot (per-trade AI decision record) | paperPortfolio.ts | Implemented |
| Override system (bypassGates) | paperTradingEngine.ts | Implemented |
| Shadow Journal | shadowTradeJournal.ts, ShadowJournalScreen.tsx | Implemented |
| Override log + outcome analytics | overrideLog.ts | Implemented |
| Paper trading | PaperTradingScreen.tsx, paperTradingEngine.ts | Implemented (simulated) |
| Paper trade journal | PaperJournalScreen.tsx, paperTradeJournal.ts | Implemented |
| Paper analytics | PaperAnalyticsScreen.tsx, paperAnalytics.ts | Implemented |
| Paper replay | PaperReplayScreen.tsx | Implemented |
| Gate analytics | GateAnalyticsScreen.tsx | Implemented |
| Market context analytics | MarketContextAnalyticsScreen.tsx, marketContextAnalytics.ts | Implemented |
| Production evaluation (extended) | ProductionEvaluationScreen.tsx, productionEvaluation.ts | Implemented |
| Strategy evaluation (within prod eval) | strategyEvaluation.ts | Implemented |
| Regime evaluation (within prod eval) | regimeEvaluation.ts | Implemented |
| Risk manager | RiskManagerScreen.tsx, riskManager.ts | Implemented |
| Price alerts | AlertsScreen.tsx, alerts.ts | Implemented |
| AI chat / copilot | AIChatScreen.tsx, api/claude.ts | Implemented |
| Symbol search | SymbolSearchScreen.tsx | Implemented |
| Verification & stress test | VerificationScreen.tsx | Implemented |
| Backtesting | BacktestScreen.tsx, backtest.ts | Implemented |
| Strategy screener | ScreenerScreen.tsx, screener.ts | Implemented |
| Multi-chart view | MultiChartScreen.tsx | Implemented |
| Correlation matrix | CorrelationScreen.tsx | Implemented |
| Economic calendar | CalendarScreen.tsx | Implemented |
| Options strategy builder | OptionsStrategyScreen.tsx | Implemented |
| Portfolio | PortfolioScreen.tsx | Implemented |
| Background scanner | ScannerDashboardScreen.tsx, ScannerService.tsx | Implemented (foreground-only — see Limitations) |
| Settings | SettingsScreen.tsx | Implemented |

---

## 3. Markets Screen

File: `src/screens/MarketsScreen.tsx`.

`allAssets` is the single master list combining `ASSETS` from `api/assets.ts` with custom-added symbols. Every screen that needs symbols reads from this same source — no screen has its own hardcoded symbol array.

A fixed `FILTERS` array (All, Index, Stocks, Crypto, Forex, Commodities) filters `allAssets` by `.type`, computed in one `useMemo` keyed on `[allAssets, filter]`.

Live prices arrive through DataContext; Binance symbols use a live WebSocket stream; AO/AV/forex sources are polled on an interval.

---

## 4. Chart Screen

Files: `src/screens/ChartScreen.tsx`, `src/components/CandlestickChart.tsx`.

### Execution flow
1. `ChartScreen` mounts. `loadCandles()` reads cache, fetches fresh data if stale, runs gap detection/repair, merges via `mergeCandles`, writes back to cache.
2. `CandlestickChart` receives `data={candles}` and renders via SVG.

### Live Candle Continuation (new v6.x)
For Binance crypto assets, `subscribeToBnKline()` (`api/binance.ts`) subscribes to the kline WebSocket stream. The current in-progress candle updates tick-by-tick on close events. Auto-continuation triggers when a candle closes — the next candle is appended seamlessly.

### Gesture System
`react-native-gesture-handler` Gesture API: `Gesture.Simultaneous(pan, pinch)` with `Gesture.Exclusive(doubleTap, singleTap)`.
- Horizontal pinch: adjusts `viewCount` (zoom level)
- Vertical pinch: adjusts `yScale` (price range compression/expansion, 0.5×–20×)
- Axis detection: `velocityY` vs `velocityX` on first `onUpdate`; axis fixed for gesture duration
- Double-tap: resets both axes
- Pan: scroll history with momentum; triggers `loadMoreHistory` at left edge

### Chart Caching TTLs (candleCache.ts)
1m=60s, 5m=3min, 15m=5min, 1h=15min, 4h=30min, 1D=1h, 1W=4h

---

## 5. Machine Learning Engine

Primary file: `src/utils/mlSignal.ts`. No external ML library — hand-written neural network and logistic regression.

### Feature Engineering — 116 Features
`FEATURE_NAMES` (verified, 116 entries) computed per bar in `featuresAt()`. Categories:

**Trend:** EMA(9/21/50/200), SMA(20/50), MACD, ADX, Parabolic SAR  
**Momentum:** RSI(14), Stochastic RSI, ROC, Momentum, CCI, Williams %R, TSI  
**Volatility:** ATR, Bollinger Bands + width, Keltner Channel, Historical Volatility  
**Volume:** OBV, MFI, CMF, Volume Oscillator, A/D, Relative Volume, VWAP  
**Structure:** swing highs/lows, BOS/CHoCH via `structureAnalyzer.ts`, Fibonacci, Pivots  
**SMC (new):** order block strength (bull/bear), OB confidence, OB freshness, PD bias, liquidity score, stop-hunt probability, FVG confidence, FVG bias, gap-fill percentage  
**Patterns:** doji, hammer, pin bar, engulfing, morning/evening star, inside/outside bar  
**MTF (new):** HTF bias, CHoCH alignment, overall MTF score  
**Regime (new):** 8 regime score features from `regimeEngine.ts` (bull score, bear score, trend regime, sideways, breakout, mean-reversion, volatility, confidence)  
**Time:** hour (sine-encoded), day of week, distance from SMA20, SAR distance, Donchian %, Keltner %, A/D slope, rolling pivot distance, candlestick pattern flag, multi-horizon returns (1/3/5/10/20 bars)

Runtime assertion: `features.length MUST === 116`. Any mismatch throws immediately.

**Deliberate exclusion:** raw swing-point classification (HH/HL/LH/LL) is excluded as a per-bar training feature because labelling a historical bar requires seeing bars *after* it — look-ahead bias. Shown in UI for current state only.

### Labels
For every bar `i` and horizon `h` in `HORIZONS = [1, 3, 5, 10, 20]`: `label = 1 if candles[i+h].close > candles[i].close, else 0`. Binary classification — not a magnitude regression.

### Normalisation
Z-score (mean/std) computed from training split only, applied to both splits. Test statistics never leak into training.

### Models

**Neural Network** (`neuralNet.ts`, class `MLP`):
- Single hidden layer, `hiddenSize = 8`
- He weight initialisation (`scale = sqrt(2 / inputSize)`), injectable RNG (Math.random live, seeded for backtests)
- Hidden: tanh. Output: sigmoid. Loss: binary cross-entropy
- L2 regularisation

**Logistic Regression** (`logisticRegression.ts`): linear + sigmoid, gradient descent. One pair per horizon. Ensemble uses `effectiveHorizon`'s models.

### Training
`trainWithEarlyStopping`: validates every 5 epochs, patience=3. maxEpochs: 50 (warm+retrain), 100 (cold), 0 (reuse). Yields to JS event loop every 10 epochs — navigation stays responsive during training.

### Smart Retraining Decision
- `forceRetrain` (Train Now) → always retrain
- No prior metadata → always retrain
- `newCandles >= NEW_CANDLES_THRESHOLD (20)` → retrain
- Model age `>= STALE_THRESHOLD_MS (4h)` → retrain
- Otherwise → reuse, 0 training epochs

### Model Acceptance
`ACCEPT_TOLERANCE = 2` (percentage points). New model accepted if no prior exists, or if validation accuracy is within 2pp of previous accepted model. Otherwise rejected — new weights discarded.

### Walk-Forward Validation
`walkForwardValidate` (4 folds): trains LR per fold on expanding training window, evaluates on next chunk. Produces real confusion matrix for Precision/Recall/F1.

### Horizon and Threshold Optimisation
`modelOptimization.ts` runs `pickBestHorizon` / `pickBestThreshold` against real backtested evidence per (symbol, timeframe). Persisted under `optimalConfig_${symbol}_${timeframe}`.

### Versioning
- Architecture Version (`ARCHITECTURE_VERSION = 1`): static code constant
- Training Run Number: increments on every attempt (trained + rejected, not reuse)
- Accepted Model Version (`modelVersion`): increments only on accepted retrain

### Model Health — Drift Detection (`modelHealth/driftDetector.ts`)
Two independent monitors using CUSUM (Cumulative Sum) and Page-Hinkley tests:
- **CUSUM on prediction accuracy residuals:** detects sustained bias (model correct 60% in training, now 45% live)
- **Page-Hinkley on feature mean shift:** detects distribution drift (live features consistently higher/lower than training distribution)
Both are O(1) per observation — no historical replay required.

---

## 6. Prediction System

Exact flow inside `trainAndPredictInner`:

1. Features built per-bar into matrix X
2. Per-horizon MLPs trained/reused; `effectiveHorizon`'s model produces `mlpProbUp`
3. Logistic Regression trained/reused, produces `lrProbUp`
4. Ensemble: `mlpWeight = max(0, primaryValidationAccuracy-50)`, `lrWeight = max(0, lrTestAccuracy-50)`. `ensembleProbUp` = accuracy-weighted average
5. Direction: UP if `ensembleProbUp > threshold (0.55)`, DOWN if `< 1-threshold`, else NEUTRAL
6. Agreement: `ensembleAgree = (lrProbUp>0.5) === (mlpProbUp>0.5)`
7. Action: BUY requires UP + agree; SELL requires DOWN + agree; else HOLD

High probability can still produce HOLD: ensemble clears threshold while the two underlying models disagree (e.g. NN=0.80, LR=0.45) → `ensembleAgree = false`.

### Risk Score
`riskScore = clamp(0,100, horizonSpread×150 + atrPct×8)` — horizon disagreement + current volatility.

### Trade Levels
`entry = currentPrice` (live price at trade-open time, **not** the stale `lastClose` at predict time — corrected in v6.x). `stopLoss = entry ∓ 1.5×ATR`, `takeProfit = entry ± 2.5×ATR`. Fixed R:R 2.5/1.5 ≈ 1.67 — flagged in Limitations.

---

## 7. Confidence Engine

Files: `src/utils/confidence/confidenceEngine.ts`, `confidenceScore.ts`, `confidenceTypes.ts`.

**Multi-engine confidence scoring** assembles `ConfidenceInputs` from existing engine outputs and calls `scoreConfidence()`. O(1) per prediction — no model re-pass, no indicator recomputation.

Nine scoring dimensions (each with own weight and threshold):
1. ML accuracy (validation + walk-forward accuracy)
2. Ensemble agreement (NN vs LR direction agreement)
3. Multi-timeframe alignment (HTF bias + CHoCH alignment)
4. Smart Money Concepts (OB strength, confidence, PD bias, liquidity)
5. Market structure (BOS confidence, swing strength, trend persistence)
6. Fair Value Gap alignment (FVG confidence, bias, gap-fill %)
7. Volume confirmation (OBV, MFI, volume oscillator)
8. Pattern confirmation (validated pattern confidence)
9. Calibration history (actual vs predicted accuracy)

Each dimension displayed individually in `PredictionCard`. Overall score shown as 0–100 with grade (A+/A/B/C/D/F).

---

## 8. Trade Readiness & Signal Gates

Files: `src/utils/mtf/tradeReadiness.ts`, `src/utils/signalGates.ts`.

### Trade Readiness (`computeTradeReadiness`)
Phase 1 — MTF-based state derivation (primary decision):
- `htfAgrees = mtfSnap.htfBias === 0 || mtfSnap.htfBias === tradeDir`
- `chochBlock = tradeDir !== 0 && CHoCH alignment opposes direction`
- State: HOLD→WAIT, `!htfAgrees || chochBlock`→AVOID, `|overallMTFScore| < 0.15`→WAIT, else→READY

Phase 2 — Signal gates via `evaluateSignalGates()` (shared with execution engine):

### Signal Gates (`evaluateSignalGates`) — Single Source of Truth
Both `computeTradeReadiness` and `attemptOpenPosition` call this same function with the same `regimeLabel` (`regimeSnap.label` from the 11-label regime engine). Guarantees that READY in the UI means ALLOWED in the execution engine.

Inputs: `regimeLabel`, `direction`, `ensembleProbUp`, `confidence`, `horizons`, `mtfReadinessState` (Phase 1 result), `strategyProfile`, `mtfSnap`, `mtfSignals`, `smcSnap`, `validatedPatterns`.

Rules:
- `mtfReadinessState` is the baseline — gates can only RAISE state (WAIT→AVOID), never lower (AVOID→READY)
- Regime gate: `evaluateRegimeGate(regimeLabel, signalType, confidence)` — per-regime `REGIME_RULES` with `minConfidence`, `blockedSignals`, `allowedSignals`
- Strategy filter: `applyStrategyFilter(profile, inputs)` — regime list, confidence floor, BOS requirement, MTF alignment, pattern confirmation, SMC OB strength
- `allowed = currentState === 'READY'` — gates passing does NOT upgrade WAIT to READY

### Signal Type Classification (`classifySignalType`)
Derives signal type from horizon probability spread:
- Regime override: `MEAN_REVERSION/SIDEWAYS`→MR, `BREAKOUT`→BR
- `longAligned < 0.40`→COUNTER_TREND
- `spread > 0.12 && shortAligned > 0.60`→BREAKOUT
- else→TREND

### Three User States
- READY → direct paper trade, no dialog
- WAIT or AVOID → override dialog shown
  - Cancel → Shadow Journal (counterfactual)
  - Override & Enter → real paper trade, `bypassGates=true`

---

## 9. Smart Money Concepts (SMC) Engine

Files: `src/utils/smc/smcEngine.ts`, `orderBlocks.ts`, `liquidity.ts`, `premiumDiscount.ts`, `smcScore.ts`, `smcTypes.ts`.

Version v4.8.0. Called once from `precomputeSeries()`. Returns per-bar score array for O(1) lookup in `featuresAt()`.

Produces:
- `bullOBStrength`, `bearOBStrength` — order block strength per direction
- `obConfidence` — how structurally clean the most recent OB is
- `obFreshness` — how recently the OB was formed
- `pdBias` — premium/discount zone directional bias (-1 to +1)
- `liquidityScore` — equal highs/lows and stop-hunt probability
- `stopHuntProb` — probability of imminent liquidity sweep

These 7 values appear in `FEATURE_NAMES` and in `ConfidenceInputs.smcSnap`.

---

## 10. Multi-Timeframe (MTF) Engine

Files: `src/utils/mtf/mtfEngine.ts`, `mtfScore.ts`, `mtfTypes.ts`.

Computes alignment across multiple timeframes relative to the chart's base timeframe (`baseTF`). `MTFScores` snapshot contains:
- `overallMTFScore` — weighted aggregate of TF alignment (-1 to +1)
- `htfBias` — higher timeframe directional bias (1=bullish, -1=bearish, 0=neutral)
- `chochAlignment` — whether a Change of Character is forming against trade direction
- Per-TF signals (`TFSignal[]`): direction, BOS detected, CHoCH forming, bar count since event

Used by Trade Readiness, strategy filter (`requireMTFAlignment`, `requireBOS`), and `signalGates.ts`.

---

## 11. Market Context Engine

### Indian Market Context
Files: `src/utils/marketContext/marketContextFetch.ts`, `marketContextTypes.ts`, `marketContextFeatures.ts`.

Fetches: India VIX (current, SMA5/20, trend, regime: LOW<12/NORMAL/HIGH/EXTREME), Market Breadth (A/D ratio, advance-decline trend, breadth thrust), FII/DII flows (net cash, rolling 5-day, bias), Put/Call Ratio (current, SMA5, contrarian signals), Sector Strength (6 sectors, leader, participation %).

### Crypto Market Context
Files: `src/utils/cryptoMarketContext/cryptoMarketContextFetch.ts`, `cryptoMarketContextTypes.ts`, `cryptoMarketContextFeatures.ts`, `marketContextRouter.ts`.

Fetches: Fear & Greed Index (0-100, classification, trend), BTC Dominance (%, 24h change, regime), Total Market Cap (24h change, regime), Funding Rate (8h rate, annualised, sentiment), Open Interest (USD, 24h change, conviction: BULLISH/BEARISH/WEAK), Stablecoin Dominance (%, trend, RISK_ON/NEUTRAL/RISK_OFF).

### Market Context Snapshot (`marketContextSnapshot.ts`)
Discriminated union: `{ kind: 'INDIAN', ctx, capturedAt } | { kind: 'CRYPTO', ctx, capturedAt } | { kind: 'NONE', capturedAt }`.

`captureSnapshot(unified)` — freezes a `UnifiedMarketContext` at a point in time.
`summariseContext(snap)` — produces a flat `ContextSummary` with all analytics-ready fields.
`isContextAvailable(snap)` — safe null-check.

Stored on `PaperPosition.entrySnapshot.marketContext` and `PaperTradeRecord.marketContext`.

### Display
`MarketContextCard.tsx` — purely presentational, zero engine calls. Shows relevant metrics for the asset type (Indian or Crypto). Renders "Market Context unavailable" when data fetch failed — never hidden.

---

## 12. Strategy Profile System

Files: `src/utils/strategy/strategyProfiles.ts`, `strategyFilter.ts`, `strategyTypes.ts`, `strategyStorage.ts`, `strategyPerformance.ts`.

### Four Profiles
| ID | Name | Icon | primaryHorizon | minConfidence | atrStop | atrTarget | maxBarsHeld |
|----|------|------|---------------|---------------|---------|-----------|-------------|
| SCALPING | Scalping | ⚡ | 1 | 55 | 1.0 | 1.5 | 5 |
| INTRADAY | Intraday | 📊 | 3 | 45 | 1.5 | 2.5 | 20 |
| SWING | Swing | 🌊 | 5 | 40 | 2.0 | 3.5 | 60 |
| POSITION | Position | 🏔 | 10 | 35 | 2.5 | 4.0 | 200 |

### Strategy Filter Gates (`applyStrategyFilter`)
Applied in order (all evaluated — no short-circuit):
1. `allowedRegimes` / `blockRegimes` — AVOID severity
2. `minConfidence` floor — WAIT severity
3. `requireMTFAlignment` — MTF `overallMTFScore >= MTF_ALIGN_MIN` — WAIT
4. `requireBOS` — Break of Structure detected on baseTF — WAIT
5. `requirePatternConfirm` — validated pattern confidence >= 60% — WAIT
6. `requireSMC` — SMC OB strength >= `SMC_OB_MIN` — WAIT

### Strategy Scope
The active strategy is respected by: Live Prediction (Trade Readiness), Paper Trading (execution gate), Trade Readiness display, and Production Evaluation (strategy evaluation mode). Settings selection does NOT limit Production Evaluation — that screen evaluates all 4 profiles independently by default.

---

## 13. Training Status System

Files: `trainingHistory.ts`, `sampleHistory.ts`, `PredictionSourceCard.tsx`, `TrainingStatusCard.tsx`.

Status values (exactly 5): `'trained' | 'reused' | 'skipped' | 'rejected' | 'failed'`

Capped at 20 entries per (symbol, timeframe). `Prediction Source Card` reads every field directly from the live `MLPrediction` object — cannot disagree with the prediction it describes.

---

## 14. Verification & Stress Testing

Files: `VerificationScreen.tsx`, `stressTest.ts`, `productionEvaluation.ts`, `horizonEvaluation.ts`, `thresholdEvaluation.ts`.

Two modes:
1. **Single-Symbol Deep Dive:** engine validation, Monte Carlo, sensitivity analysis, regime breakdown, stability over time
2. **Batch Stress Test:** `MultiSymbolSelector` against `allAssets`; per-combo progress with ETA via `useRunProgress`

Confusion matrix / Precision / Recall / F1 derived from `walkForwardValidate` — not separately invented.

`multiSourceFetch.ts` classifies each asset: `full_pagination` (Binance, Angel One), `single_call_capped` (Alpha Vantage), `unsupported` (forex). Unsupported assets are explicitly skipped, never silently faked.

---

## 15. Paper Trading

Files: `paperTradingEngine.ts`, `paperPortfolio.ts`, `paperRiskControls.ts`, `riskManager.ts`, `PaperTradingScreen.tsx`.

### attemptOpenPosition Signature
```ts
attemptOpenPosition(
  symbol, timeframe, prediction, currentPrice,
  recentCandles, assetClass,
  overallConfidence?,    // live multi-engine confidence
  regimeLabelOverride?,  // from regimeSnap.label — same source as Trade Readiness
  marketContext?,        // frozen snapshot
  bypassGates?,          // true = user pressed Override
  mtfReadinessState?,    // Phase 1 MTF verdict from computeTradeReadiness
)
```

### Gate Ordering
1. Prediction action check (not BUY/SELL → return)
2. **Duplicate position check** (same symbol already open → return, no shadow)
3. Regime filter mode gate (BULL_ONLY etc — skipped when `bypassGates=true`)
4. `checkRiskGate` — daily loss, max positions, exposure (account safety — always enforced, even on override)
5. Portfolio risk engine BLOCK — correlation, drawdown (skipped when `bypassGates=true`)
6. `evaluateSignalGates` — shared regime+strategy gates (skipped when `bypassGates=true`)
7. Zero position size check (always enforced)
8. Cash gate (always enforced)

### Trade Levels
`atrStopDist` and `atrTpDist` from prediction (indicator-derived, correct). Anchored to `currentPrice` (live candle close at trade-open time) — NOT `prediction.suggestedEntry` (stale predict-time price). This prevents immediate TP/SL hits caused by price movement between prediction and button press.

### Symmetric Margin Model
- OPEN (both): `cashBalance -= positionValue + entryFee`
- LONG close: `cashBalance += exitNotional - closeFee`
- SHORT close: `cashBalance += 2 × entryNotional - exitNotional - closeFee`

### signalId on Position
`position.signalId = prediction.signalId` — enables cross-journal idempotency check in Shadow Journal.

---

## 16. Shadow Journal

Files: `shadowTradeJournal.ts`, `ShadowJournalScreen.tsx`.

### Purpose
Records trades that were blocked by signal quality gates AND the user chose Cancel (not Override). Tracks counterfactual performance — what would have happened if the blocked trade had been taken.

### Deduplication (3 rules)
1. Same `signalId` already in shadow journal (any state) → skip
2. OPEN shadow exists for same symbol+timeframe+direction → skip
3. **Cross-journal idempotency (v6.x):** `signalId` already consumed by a real open position (checked via `getPortfolio()`) → skip. Prevents phantom shadows from race conditions.

### ShadowTrade Fields
Includes `blockGate` (typed: `'CONFIDENCE' | 'REGIME' | 'PORTFOLIO_RISK' | 'DUPLICATE' | 'CASH' | 'FILTER' | 'OTHER'`), full `signal` snapshot, `gateDetails`, `marketContext` (frozen snapshot), and `signalId`.

---

## 17. Override System

### Flow
1. WAIT/AVOID state → `handleOverrideTrade()` in `PredictionCard` shows Alert dialog
2. Cancel → `recordShadowTrade()` called → Shadow Journal
3. Override & Enter → `onPaperTrade(prediction, bypassGates=true, rdState)` called
4. `handlePaperTrade(prediction, bypassGates=true, mtfReadinessState)` in `useChartOverlays`
5. `attemptOpenPosition(..., bypassGates=true, mtfReadinessState)`
6. `evaluateSignalGates()` runs unconditionally — result stored on position as `signalSnapshot`
7. Account safety gates (cash, duplicate, zero size) enforced regardless of `bypassGates`
8. Position opens

### isSubmitting Guard
`useState<boolean>` in `PredictionCard`. Set to `true` on first tap. Reset in `.finally()` after `onPaperTrade` resolves. All three CTA buttons (`isReady`, `isWait`, `isAvoid`) get `disabled={isSubmitting}` and visual dimming — prevents double-tap race conditions and phantom shadows.

### Override History Display
`summariseOverrideOutcomes(log, 'AVOID')` in `overrideLog.ts` — async, cross-references override log entries against closed `PaperTradeRecord`s by symbol + timestamp proximity. Shows: "Override history: N trades · XW YL · Z% WR". `NaN` WR shows "awaiting outcome" when no settled trades yet.

---

## 18. Signal Snapshot (Permanent Decision Record)

Added to `PaperPosition` and `PaperTradeRecord` in v6.9.x. Populated for EVERY trade.

```ts
signalSnapshot: {
  // ── Decision ──────────────────────────────────────────────────────
  originalState:     'READY' | 'WAIT' | 'AVOID';  // AI's final verdict
  overrideUsed:      boolean;           // true = user bypassed a block
  blockSource:       string | null;     // null when READY
  blockReason:       string;            // empty when READY
  signalType:        string;            // TREND | BREAKOUT | MEAN_REVERSION | COUNTER_TREND
  mtfReadinessState: 'READY' | 'WAIT' | 'AVOID' | null;
  // ── AI Metadata ───────────────────────────────────────────────────
  confidence:        number;            // 0–100 live overall confidence at entry
  ensembleProbUp:    number;            // 0–1 raw model output
  modelVersion:      number;            // accepted model version number
  regimeLabel:       string;            // market regime at entry
  strategyId:        string | null;     // active strategy profile
  capturedAt:        number;            // Unix ms — immutable
}
```

`buildTradeRecord()` in `paperTradeJournal.ts` propagates `signalSnapshot` from position to the closed trade record. Enables future analytics: win rate by originalState, confidence calibration, model version comparison, signal type performance, override effectiveness by blockSource.

---

## 19. Production Evaluation (Extended)

Files: `productionEvaluation.ts`, `strategyEvaluation.ts`, `regimeEvaluation.ts`, `modelComparison.ts`, `horizonEvaluation.ts`.

### 10-Step Pipeline
1. Primary backtest (LONG+SHORT, default config)
2. `fitEnsemble()` — produces `FittedEnsemble` with `regimeLabelAt(idx)` accessor (reads `S.regimeData` already in memory — zero extra `precomputeSeries()` calls)
3. `bucketTradesByRegime()` — regime breakdown from primary backtest
4. `evaluateAllHorizons()` — LONG-only sweep across H1/H3/H5/H10/H20
5. `evaluateThresholds()` — threshold sweep
6. `compareModels()` — NN vs LR vs Ensemble
7. `analyzeFeatureContribution()` — permutation importance on held-out test set
8. Baseline comparison (6 strategies)
9. **Strategy evaluation** (`evaluateStrategies()`) — all 4 profiles or selected only; per-strategy trades exposed via `StrategyEvalEntry.trades[]`
10. **Regime evaluation** (`evaluateRegimes()`) — groups primary, model, horizon, and strategy trades by regime using `FittedEnsemble.regimeLabelAt()`; produces `RegimeBreakdown[]` with `byModel`, `byHorizon`, `byStrategy` drill-downs

### Strategy Evaluation Mode
- `'ALL'` (default): evaluates all 4 profiles independently
- `'SELECTED'`: evaluates only the currently active profile (faster)
Each strategy uses its own `fitEnsemble()` with its `primaryHorizon` (different look-ahead labels require retraining). Trades carried in `StrategyEvalEntry.trades[]` for downstream regime bucketing.

### FittedEnsemble.regimeLabelAt
New accessor added to `FittedEnsemble` type and implementation. Reads from `S.regimeData.regimeArr[idx].label` — the `PrecomputedRegime` already computed when `fitEnsemble()` called `precomputeSeries()`. Zero additional computation.

### UI Sections in ProductionEvaluationScreen
- Step 1: Primary metrics (LONG+SHORT)
- Step 2: Horizon comparison
- Step 3: Model comparison (NN vs LR vs Ensemble)
- Step 4: Strategy evaluation (collapsible, amber header)
- Step 5: Market regime evaluation (collapsible, amber header)

---

## 20. Market Context Analytics

Files: `marketContextAnalytics.ts`, `MarketContextAnalyticsScreen.tsx`.

Pure aggregation over closed `PaperTradeRecord` objects carrying `marketContext` snapshots. Six analytics groups:

| Analytics | Asset | Buckets |
|-----------|-------|---------|
| Fear & Greed | Crypto | Extreme Fear / Fear / Neutral / Greed / Extreme Greed |
| Funding Rate | Crypto | Extreme Short / Short Biased / Neutral / Long Biased / Extreme Long |
| BTC Dominance | Crypto | Alt Season (<40%) / Balanced / BTC Lead / BTC Dominant (>60%) |
| India VIX | Indian | Low (<12) / Normal (12-20) / High (20-30) / Extreme (>30) |
| Market Breadth | Indian | Bullish / Neutral / Bearish |
| Overall Sentiment | Both | Bullish / Neutral / Bearish / Unavailable |

Each bucket: `{ wins, losses, winRate, profitFactor, avgPnlPct, netPnlPct, expectancy, trades }`. Best bucket highlighted per group based on combined score (winRate + profitFactor). Accessible from More → Context Analytics.

---

## 21. Journal & Analytics

### Paper Trade Journal (`paperTradeJournal.ts`)
Per completed trade: symbol, direction, entry/exit price, P&L (`pnl`/`pnlPct`), exit reason, holding duration, trade quality snapshot, market context snapshot, `signalSnapshot`, override info, strategy tag, management outcome, execution fill, review levels (SL/TP frozen at close).

### Paper Analytics (`paperAnalytics.ts`)
Win rate, profit factor, by-asset-class breakdown, by-regime breakdown, best/worst trade, most profitable symbol+timeframe, performance trend.

### Gate Analytics (`GateAnalyticsScreen.tsx`)
Analyses which signal quality gates have been most useful historically — which ones, when they block, turn out to be correct.

### Shadow Journal Analytics (`ShadowJournalScreen.tsx`)
Tracks counterfactual performance of blocked trades. Shows whether the AI's caution was statistically justified.

---

## 22. Alerts

`alerts.ts`, `AlertsScreen.tsx`. One type: `PriceAlert` with condition `'ABOVE' | 'BELOW'` vs `targetPrice`. Local-device notifications only — no server-side push. Fire while logic runs (foreground or scanner — see Limitations).

---

## 23. AI Chat / Copilot

Files: `AIChatScreen.tsx`, `api/claude.ts`.

Calls `https://api.anthropic.com/v1/messages` directly from device using user's own Anthropic API key (stored via `expo-secure-store`). Model: `claude-sonnet-4-6`. Context assembled by `buildChatContext`: latest OHLC candles, MA20/MA50, RSI, ML signal (non-blocking), recent news (Alpha Vantage only), order-book depth if available. Streaming response displayed in real time.

`analyzeWithClaude()` (AI Copilot): structured institutional-grade analysis grounded in 9-dimension confidence breakdown, market context, and prediction source.

---

## 24. Data Sources

| Source | File | Endpoint | Pagination | Retry | Caching |
|--------|------|----------|-----------|-------|---------|
| Binance (crypto) | `api/binance.ts` | `api.binance.com/api/v3/klines`, WebSocket kline stream | Full (`maxHistoryFetch.ts`) | withRetry, exp backoff | `candleCache.ts` |
| Angel One (NSE) | `api/angelOne.ts` | `apiconnect.angelbroking.com` | Full (`aoCandlesBefore`) | withRetry | Same |
| Alpha Vantage (US) | `api/alphaVantage.ts` | `www.alphavantage.co/query` | Single call only | withRetry | Same |
| Forex | `api/forex.ts` | `open.er-api.com/v6/latest/USD` | None (spot rate only) | None found | N/A |
| Anthropic (AI) | `api/claude.ts` | `api.anthropic.com/v1/messages` | N/A | Explicit 429 handling | N/A |

No proactive rate-limiting/throttling — `withRetry`'s exponential backoff is reactive only.

---

## 25. Storage

All persistence is AsyncStorage (plaintext JSON) except three credential types.

| Data | Key pattern | Lifetime |
|------|-------------|----------|
| Candle cache | `candleCache_${symbol}_${tf}` | TTL per timeframe; never auto-deleted |
| Model weights | `mlModel_${symbol}_${tf}_h${horizon}`, `lrModel_${symbol}_${tf}` | Indefinite, overwritten on accepted retrain |
| Model metadata | `mlMetadata_${symbol}_${tf}` | Indefinite |
| Training history | `trainingHistory_${symbol}_${tf}` | Capped at 20 |
| Sample history | `sampleHistory_${symbol}_${tf}` | Capped at 20 |
| Optimal config | `optimalConfig_${symbol}_${tf}` | Indefinite |
| Prediction history | per symbol/timeframe | Capped at 200 |
| Paper portfolio | `paperPortfolio` | Indefinite, user-resettable |
| Paper journal | `paperTradeJournal` | Indefinite, user-resettable |
| Shadow journal | `shadowTradeJournal` | Indefinite |
| Override log | `quantis_override_log` | Indefinite, append-only |
| Risk settings | `riskSettings`, `paperRiskExtras` | Indefinite |
| Price alerts | `priceAlerts` | Indefinite, user-deletable |
| Watchlists | `namedWatchlists`, `customWatchlist` | Indefinite |
| Strategy selection | `activeStrategyId` | Indefinite |
| Regime filter mode | `regimeFilterMode` | Indefinite |
| Background task IDs | `backgroundTaskContext__runningIds` | Per-session stale recovery |
| Credentials (secure) | `anthropicKey`, `avKey`, `aoSession` | Indefinite, expo-secure-store |

No automatic time-based cleanup for indefinite-lifetime keys.

---

## 26. Performance

- `candlesRequestRef` and `mlRequestRef` in `ChartScreen.tsx` prevent stale fetch results from overwriting newer data
- Training loops yield every 10 epochs — navigation stays responsive during ML training
- `InteractionManager.runAfterInteractions` defers evaluation work until navigation animations finish
- Background loading: cache shows stale data instantly while fresh fetch runs
- 500ms throttle on kline render updates — prevents excessive re-renders during live candle streaming
- `candlesRef` stabilises callbacks/memos that previously created new references on every kline tick
- `FlatList` used for Markets list (built-in virtualisation)

---

## 27. Security

- API keys (`anthropicKey`, `avKey`, `aoSession`) stored via `expo-secure-store`. One-time lazy migration from legacy plaintext AsyncStorage
- All other state (portfolio, journal, model weights) is plaintext AsyncStorage — appropriate for non-secret app state
- Risk gate checks (`paperRiskControls.ts`) enforce position size/exposure before any paper order executes
- `ErrorBoundary.tsx` exists as top-level React error boundary
- All logic runs on-device — no backend server

---

## 28. Test Suite

14 test files across the codebase:

| Test file | Coverage |
|-----------|----------|
| `__tests__/auditVerification.ts` | P&L calculation, portfolio invariants |
| `__tests__/backtestShort.test.ts` | Backtest engine |
| `__tests__/bugFixes.test.ts` | Regression tests for fixed bugs |
| `__tests__/candleCache.test.js` | Cache TTL, merge logic |
| `__tests__/journalFeatures.test.js` | Journal field propagation |
| `__tests__/marketContextIntegration.test.js` | Market context snapshot (43 tests) |
| `__tests__/pnlCalculator.test.ts` | P&L formula verification |
| `__tests__/regimeEvaluation.test.js` | Regime bucketing, comparison, ML isolation (32 tests) |
| `__tests__/strategyAndContextAnalytics.test.js` | Strategy scoring, context analytics (34 tests) |
| `confidence/__tests__/confidenceScore.comparison.test.js` | Multi-engine confidence scoring |
| `cryptoMarketContext/__tests__/cryptoMarketContext.test.js` | Crypto context types |
| `marketContext/__tests__/marketContext.test.js` | Indian context types |
| `strategy/__tests__/strategyFilter.invariant.test.js` | Strategy filter (28 invariants) |
| `strategy/__tests__/rollingWindow.test.js` | Rolling window calculations |

Total: 109+ passing tests across market context integration, strategy evaluation, regime evaluation, signal snapshot logic, and analytics bucketing.

---

## 29. Current Limitations

| Feature | Limitation | Impact | Fix |
|---------|------------|--------|-----|
| Forex evaluation | No historical OHLC endpoint | Skipped in Verification/Prod Eval | Integrate a real forex OHLC provider |
| Alpha Vantage history | Capped at one call, no pagination | Limited backtest depth for US stocks | Investigate AV paid tier |
| Risk:reward ratio | Fixed 2.5/1.5 constant | Same R:R regardless of structure | Structure-aware SL/TP |
| Background scanner | Foreground-only | Scanner stops when app is killed | Re-integrate background task when SDK compatible |
| Journal export | No CSV/PDF export | Can't get trade history out | Add export function |
| Rate limiting | Reactive retry only | Could trigger provider limits | Add proactive per-API rate limiter |
| Storage encryption | Only 3 credential keys encrypted | Portfolio/journal readable via ADB on rooted device | Consider secure-store for sensitive data |

---

## 30. Technical Debt

- Two separate journals (manual `journal.ts` vs paper `paperTradeJournal.ts`) with overlapping analytics computed in `tradeAnalytics.ts` vs `paperAnalytics.ts`
- `trainAndPredict` is a thin wrapper around `trainAndPredictInner` — intentional architecture (failure isolation), not duplication
- No CI/automated test runner configured in `package.json` — tests are run manually. The pattern (un-awaited fire-and-forget persistence calls) should be checked when new async recording functions are added
- No central error reporting — errors logged to in-memory ring buffer (logger.ts, capped at 200 entries) only

---

## 31. Changelog (v4.5.4 → v6.9.9)

| Version | Summary |
|---------|---------|
| **6.9.9** | Signal gates architecture: `evaluateSignalGates()` shared between `computeTradeReadiness` and `attemptOpenPosition` — single source of truth. `signalSnapshot` on every trade recording complete AI decision (Decision + AI Metadata). Override system: `bypassGates` parameter, account safety gates always enforced, override analytics with outcome-aware win rate display. Market context analytics screen (win rate by F&G, VIX, funding, sentiment). Strategy evaluation in Production Evaluation (all 4 profiles + mode toggle). Regime evaluation in Production Evaluation (performance by regime × model × horizon × strategy). `FittedEnsemble.regimeLabelAt()` accessor. `compareModelsWithTrades()`, `evaluateAllHorizonsWithTrades()` for downstream regime bucketing. Shadow Journal hardening: cross-journal idempotency via `signalId`. |
| **6.9.8** | Strategy profile evaluation integrated into Production Evaluation. `StrategyEvalEntry.trades[]` populated. Strategy mode toggle (All Strategies / Selected Only) in ProductionEvaluationScreen. `generateRecommendations` extended with strategy insights. |
| **6.9.7** | Market context analytics (6 bucket groups). `MarketContextAnalyticsScreen`. `summariseOverrideOutcomes()` with trade-record cross-reference. Override history display upgraded from count to wins/losses/win rate. |
| **6.9.6** | Market context integration into paper trading: `marketContext` snapshot on `PaperPosition`, `ShadowTrade`, `PaperTradeRecord`. `MarketContextCard` in prediction UI, paper journal, shadow journal. `captureSnapshot()`, `summariseContext()` in `marketContextSnapshot.ts`. |
| **6.9.5** | `bypassGates` parameter on `attemptOpenPosition`. WAIT/AVOID override dialog (Cancel → shadow, Override → real trade). `isSubmitting` guard prevents double-tap. Shadow journal cross-journal idempotency (Rule 3). `signalId` stored on `PaperPosition`. |
| **6.9.4** | SL/TP anchored to live `currentPrice` at trade-open time, not stale `prediction.suggestedEntry`. `handlePaperTrade` uses `candlesRef.current[last].close` as live price. Eliminates immediate TP/SL hits after override. |
| **6.9.3** | `evaluateSignalGates()` created as shared gate function. `mtfReadinessState` threaded from `PredictionCard` through `useChartOverlays` to `attemptOpenPosition`. Phase 1 MTF result is baseline — gates can only raise state, never lower. READY in UI = allowed in engine. |
| **6.9.2** | `signalSnapshot` added to `PaperPosition` and `PaperTradeRecord`. Populated on every trade (not just overrides). Decision section (state, override, block, signal type, MTF) + AI Metadata section (confidence, ensembleProbUp, modelVersion, regimeLabel, strategyId). |
| **6.9.1** | Strategy profiles system (SCALPING/INTRADAY/SWING/POSITION). `applyStrategyFilter()` with 6 gates. `strategyProfiles.ts`, `strategyFilter.ts`, `strategyStorage.ts`. Strategy context in Trade Readiness UI. Strategy tag on paper positions and journal records. |
| **6.9.0** | Multi-engine confidence scoring with 9 dimensions. `confidence/confidenceEngine.ts`, `confidenceScore.ts`. XAI engine (`xai/xaiEngine.ts`) for feature attribution. Model drift detection (`modelHealth/driftDetector.ts`) with CUSUM + Page-Hinkley. |
| **6.8.x** | SMC engine (`smc/`): order blocks, liquidity, premium/discount, SMC score. FVG engine (`fvg/`). Market structure engine (`structure/`). Pattern validation system (`patternValidation/`). 11-label regime engine (`regime/regimeEngine.ts`). Feature count raised from 37 to 116. |
| **6.5.0** | Paper trading accounting fix, confidence calibration fix, Binance kline WebSocket (`subscribeToBnKline`), AI Copilot prompt improvements, 500ms throttle + `candlesRef` performance optimisation. |
| **4.5.4** | Vertical chart zoom (0.5×–20×). Double-tap resets both axes. |
| **4.5.3** | Paper trading notification tap routing (all 6 notifications → Paper Trading screen). |
| **4.5.2** | Training loops async with yield every 10 epochs. Navigation fully responsive during ML training. |
| **4.5.1** | `evaluateAllHorizons` made async with yields between 5 horizon trains. |
| **4.5.0** | Scanner load() guard. Background task architecture hardening. |
| **4.4.x** | EvalTaskContext full background task system. Stale-task recovery via AsyncStorage. Scanner wired to background architecture. Notification routing (Scanner / PaperTrading / ProductionEval). |
| **4.3.x** | SHORT cash accounting symmetric margin model. P&L verification (4 scenarios). |

---

*v6.9.9 · React Native / Expo · On-Device ML · Android · July 2026 · © 2026 Datta Harshith Reddy*
