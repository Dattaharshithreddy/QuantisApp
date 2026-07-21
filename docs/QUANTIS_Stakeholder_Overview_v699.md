# QUANTIS — AI Trading Terminal
## Non-Technical Stakeholder Overview
**Version 6.9.9 · July 2026 · © 2026 Datta Harshith Reddy**

> 26 Screens & Features · 116 AI Signal Inputs · 4 Live Data Sources · 100% On-Device ML

QUANTIS is a mobile trading application that puts professional-grade tools into the hands of individual traders — live market data, AI-powered signals, safe paper trading practice, and a complete analysis suite, all running on an Android phone with no monthly subscription fees.

---

## 1. The Problem QUANTIS Solves

Most individual traders face three painful gaps between them and professional trading desks:

**No Real-Time Intelligence.** Retail traders check prices manually and rely on intuition. Professional desks have algorithms that scan hundreds of assets every few seconds and flag opportunities automatically.

**No Safe Practice Environment.** Learning to trade with real money is expensive. Without a realistic simulator that behaves exactly like the live market, mistakes cost real money.

**Data Scattered Across Apps.** Charts are in one app, news in another, risk calculations in a spreadsheet, and trade logs somewhere else. There is no single tool that connects everything.

QUANTIS addresses all three by combining live data, AI analysis, a paper trading simulator, and a full analytics suite in one mobile app.

---

## 2. Live Market Data

Before any analysis can happen, the app needs accurate, real-time prices. QUANTIS connects to four professional data sources simultaneously:

**Four Live Data Sources.** Angel One (Indian stocks and indices including Nifty and Bank Nifty), Binance (2,000+ crypto pairs with real-time futures data via WebSocket), Alpha Vantage (US stocks including Apple and NVIDIA), and live forex rates — all updating in real time. Prices update every second, the same technology used by professional trading terminals.

**Crypto Futures Data.** For cryptocurrency assets, QUANTIS pulls real-time funding rates, open interest, and long/short ratios from Binance futures — the same data professional crypto desks monitor to gauge market positioning and sentiment.

**Live Candle Continuation.** When a new candle opens on a crypto chart, QUANTIS receives real-time OHLCV updates via Binance kline WebSocket — the current bar updates live, tick by tick, rather than waiting for it to close.

**Search Any Symbol.** Type any stock name, index, or crypto symbol and the app finds it instantly. Indian stocks are resolved from the official NSE database. Crypto covers every Binance trading pair.

**Smart Data Caching.** Charts load instantly from a local cache. In the background, the app quietly fetches the latest data and updates seamlessly. If the internet connection drops, the last known prices remain visible with a clear label.

---

## 3. Professional Charts

Charts are built natively — no web browser inside the app — so they are fast, crisp, and respond instantly to touch.

**Candlestick Charts.** Industry-standard format used by every professional platform. Each bar shows opening price, closing price, highest point, and lowest point.

**Pinch to Zoom — Both Directions.** Pinch horizontally to see more or fewer candles. Pinch vertically to zoom the price scale independently. Drag left and right to scroll back through history. Double-tap to reset both axes.

**Technical Overlays.** Moving Averages, Bollinger Bands, Fibonacci levels, Pivot Points, Keltner Channel, Donchian Channel, and Volume Profile.

---

## 4. AI Signal — The Brain of the App

A real neural network runs entirely on your phone, with no data sent to external servers.

**On-Device Neural Network.** The AI trains itself on the specific asset you are looking at, using its own recent price history. It learns patterns from 116 different measurements — momentum, trend strength, volume behaviour, candlestick patterns, Smart Money Concepts (order blocks, liquidity levels, fair value gaps), market structure, and time effects — and predicts whether price is likely to be higher or lower in the next few bars.

**Why 116 Inputs?** Earlier versions used 37–38 inputs. The AI now incorporates a full layer of professional Smart Money Concepts analysis — break-of-structure signals, order block strength, fair value gaps, premium and discount zones, and multi-timeframe trend alignment. These are the same concepts used by institutional traders when reading markets.

**Multi-Engine Confidence Score.** Rather than a single confidence number, QUANTIS assembles evidence from nine separate analytical engines — neural network accuracy, multi-timeframe alignment, Smart Money Concepts, market structure, fair value gaps, volume analysis, pattern recognition, regime analysis, and calibration history — and combines them into one overall confidence score. Each dimension is shown individually so traders can see exactly why the AI is confident or cautious.

**BUY / HOLD / SELL Signal.** After training, the AI produces a clear direction, a confidence score from 0–100, and a risk level. It also suggests where to place a Stop Loss and Take Profit based on the asset's own recent volatility, anchored to the live price at the moment the trade button is pressed — not the stale price from when the AI ran.

**Plain-English Explanation.** A dedicated card translates the AI's reasoning into plain language — what the signal is, why, and what would need to change for a different outcome. The recommendation is shown first, followed by the evidence.

**AI Copilot.** A conversational chat lets traders ask questions in plain English: "Is this a good entry point?", "What does the order book suggest?", "Give me a stop-loss level." Powered by Claude (Anthropic), grounded in QUANTIS's own live analysis.

---

## 5. Trade Readiness — Should You Enter Right Now?

Knowing the AI says BUY is not enough. Trade Readiness asks: "Are all the conditions aligned for this trade to work right now?"

**Three States.** READY (all signal quality gates passed — open the trade), WAIT (conditions not yet aligned — wait for improvement), or AVOID (the signal conflicts with higher-timeframe structure — do not take this trade).

**What It Checks.** Whether the higher timeframe agrees with the trade direction, whether momentum is building or weakening, whether key structural levels support the entry, and whether the active strategy profile's specific requirements are met.

**Single Source of Truth.** The same logic that produces READY/WAIT/AVOID in the UI is the exact same logic the paper trading engine uses when deciding whether to open a trade. There is no hidden divergence between what the screen shows and what the engine does.

---

## 6. The Override System

When a trade is WAIT or AVOID, the user has two options:

**Cancel → Shadow Journal.** The trade is recorded in the Shadow Journal as a counterfactual — tracking what would have happened if the blocked trade had been taken. This allows traders to evaluate whether the AI's caution was warranted.

**Override → Real Paper Trade.** The trade opens, bypassing the signal quality gates. The paper journal permanently records the AI's original verdict — what state it was (WAIT or AVOID), which gate blocked it, what the reason was, the signal type, the confidence score, and the model version. Six months later, traders can query: "When I overrode regime blocks, what was my win rate?"

**Override History on Screen.** Before pressing Override, the prediction screen shows the user's override history with outcomes: "Override history: 4 trades · 3W 1L · 75% WR" — giving useful context instead of a meaningless count.

---

## 7. Market Context — The Broader Picture

Individual chart analysis tells you what one asset is doing. Market context tells you what the overall environment is doing.

**Indian Market Context.** For NSE assets: India VIX (the fear index), Market Breadth (how many stocks are advancing), FII/DII flows (institutional money movement), Put/Call Ratio (options sentiment), and Sector Strength.

**Crypto Market Context.** For crypto assets: Fear & Greed Index, BTC Dominance, Total Market Trend, Funding Rate, Open Interest, and Stablecoin Dominance.

**Displayed With Every Prediction.** Market context is shown alongside every AI signal so traders can see whether the broader environment supports or contradicts the trade.

**Stored With Every Trade.** The market context at the moment a paper trade opens is frozen permanently with that trade. Months later, traders can review what the environment looked like at entry and whether it explains the outcome.

**Context Analytics.** A dedicated screen answers: "What is my win rate when Fear & Greed is Extreme Greed?", "Do I perform better when India VIX is low?", "What is my profit factor when Funding Rate is in Extreme Long?" These analytics build automatically from stored context snapshots.

---

## 8. Strategy Profiles

Four built-in profiles, each with its own rules about when a signal is good enough to act on:

**Scalping.** Very short-term. High confidence required. Tight stops. ⚡

**Intraday.** Same-day trading. Balanced risk. 📊

**Swing.** Multi-day. Trend-following. Requires structural confirmation. 🌊

**Position.** Multi-week. Requires strong multi-timeframe alignment. 🏔

The active strategy profile is respected consistently across Live Prediction, Trade Readiness, Paper Trading, and Production Evaluation.

---

## 9. Production Evaluation — Testing the AI

Before relying on any AI signal, traders need to know: "Has this actually worked on real historical data?"

**What It Does.** Fetches years of real historical data, trains the AI on the first portion, then simulates trading with the rest — data the model has never seen. Measures profit and loss, win rate, drawdown, and compares the AI against six simple baseline strategies.

**Strategy Evaluation.** Evaluates all four strategy profiles independently on the same historical data — showing which profile would have performed best for that specific asset and timeframe.

**Regime × Strategy × Horizon Analysis.** Breaks down performance by market regime (Bull Trend, Bear Trend, Sideways, High Volatility, and 7 others), showing which strategy works best in each environment and which prediction horizon performs best in each regime.

**Model Comparison.** Compares the Neural Network alone, Logistic Regression alone, and the Ensemble — showing whether combining models genuinely helps or whether one model dominates.

**Runs in the Background.** Evaluation runs in the background while you use the rest of the app. A notification arrives when it finishes.

---

## 10. Paper Trading — Practice Without Risk

**Simulator.** Open long (buy) or short (sell) positions on any tracked asset. The app calculates position size based on risk settings, tracks profit and loss in real time, and automatically closes positions when Stop Loss or Take Profit is hit.

**Signal Snapshot.** Every paper trade permanently records the AI's complete decision at entry: signal state, confidence score, model version, market regime, strategy profile, and whether the trade was opened normally or via override.

**Shadow Journal.** When a trade is blocked and the user chooses not to override, it is automatically recorded as a counterfactual — showing what would have happened.

**AUTO and MANUAL Modes.** MANUAL requires user confirmation for each trade. AUTO opens and manages trades automatically based on AI signals.

**Smart Notifications.** Push notifications for Stop Loss hit, Take Profit reached, trade opened, trade closed, and a daily summary.

---

## 11. Analytics

**Trade Journal.** Automatically records entry price, exit price, reason, profit/loss, and the AI signal that triggered each trade.

**Paper Analytics.** Win rate, profit factor, maximum drawdown, Sharpe ratio, best and worst trades, performance by asset class and regime.

**Context Analytics.** Win rate by Fear & Greed zone, profit factor by Funding Rate, win rate by India VIX range, performance by overall market sentiment.

**Override Analytics.** How often overrides succeed, broken down by the reason the AI originally blocked the trade.

**Gate Analytics.** Which AI quality gates are most useful — and which ones may be too conservative for a given trading style.

**Shadow Journal Analytics.** How blocked trades would have performed — allowing evaluation of whether the AI's caution was statistically justified.

---

## 12. Additional Tools

**Risk Manager.** Position size calculator, daily loss limit, Kelly Criterion, exposure management by asset class.

**Backtesting Engine.** Historical simulation with realistic costs and slippage, Monte Carlo analysis, and sensitivity testing.

**Strategy Screener.** Automatically scans all watched assets for specific technical setups.

**AI Scanner.** Checks every watchlist symbol every 5 minutes for BUY or SELL signals. Runs in the background.

**Price Alerts.** Push notification when any asset hits a target price.

**Economic Calendar.** Upcoming high-impact events: Fed meetings, RBI decisions, CPI, NFP, earnings, OPEC+.

**Correlation Matrix.** Shows how strongly different assets in your watchlist move together — revealing hidden concentration risk.

**Options Strategy Builder.** Build and visualise multi-leg options strategies with profit/loss diagrams and live Greeks.

**Portfolio.** Real holdings from Angel One with live profit/loss.

**Multi-Chart Layout.** Watch four markets simultaneously.

---

## 13. What Makes QUANTIS Different

**Privacy First.** The AI trains and runs 100% on-device. Trading data never leaves the phone.

**Honest About Uncertainty.** QUANTIS reports actual out-of-sample accuracy and warns clearly when it is too low to be useful.

**Single Source of Truth.** The same signal-quality logic used in the UI is used in the execution engine. READY in the UI means allowed in the engine. There is no hidden divergence.

**Permanent Decision Record.** Every paper trade stores the AI's complete decision at entry — not just the outcome. This enables evidence-based questions months later: "Do high-confidence signals actually win more? Which model version performed better? Were my overrides profitable?"

**Professional Architecture.** Long tasks run in the background while the rest of the app is fully usable.

**No Subscriptions Required.** Core functionality uses free public APIs. No paid data subscription is required.

---

*v6.9.9 · Android · July 2026 · © 2026 Datta Harshith Reddy · QUANTIS AI Trading Terminal*
