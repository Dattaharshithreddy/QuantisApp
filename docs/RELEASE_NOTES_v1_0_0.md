# QUANTIS v1.0.0 — Release Notes

**Release Date:** July 2026  
**Build Version:** 6.9.9  
**Platform:** Android (React Native / Expo 51)  
**Status:** v1.0 Feature Complete

---

## What is QUANTIS?

QUANTIS is an AI-powered algorithmic trading terminal for Android. It combines a 116-feature machine learning ensemble with real-time market data, multi-timeframe signal gating, paper and live trading execution, NSE and Binance futures support, portfolio risk management, and a personal AI trading coach — in a single mobile application.

---

## v1.0.0 — Complete Feature Set

### AI Prediction Engine
- 116-feature ML vector across 8 sub-engines: SMC, FVG, multi-timeframe, regime, structure, volume, patterns, and core technical
- Neural Network + Logistic Regression ensemble with confidence calibration
- Trade Readiness: READY / WAIT / AVOID with full signal gate evaluation
- 11-label Regime Engine: STRONG_BULL_TREND through HIGH_VOLATILITY
- 4 Strategy Profiles: SCALPING, INTRADAY, SWING, POSITION
- Market Context: Indian (VIX, FII/DII, PCR, breadth, sectors) + Crypto (Fear & Greed, BTC dominance, funding, OI)

### Trading
- **Paper Trading** — Full simulation with live prices, zero risk, complete analytics
- **Live Trading** — Angel One (NSE/BSE equities) and Binance (crypto spot) with order lifecycle, idempotency, and reconciliation
- **NSE Futures** — Lot-based sizing, SPAN margin, daily MTM settlement, expiry tracking
- **Binance Perpetual Futures** — Explicit leverage (1×–125×), isolated margin, 8-hour funding payments, liquidation price computation
- **Shadow Journal** — Every blocked signal recorded; post-facto outcome tracking
- **Kill Switch** — Immediate cancel of all live orders

### Risk & Monitoring
- **Portfolio Risk Manager** — Unified view across all 4 account types; parametric VaR₉₅/₉₉, concentration risk, leverage, drawdown, INR-equivalent totals
- **Real-time SL/TP monitoring** — 5-second tick across paper, live, NSE futures, and Binance perpetuals
- **MTM Settlement** — Daily NSE futures settlement at 3:30pm IST
- **Funding Payments** — 8-hourly Binance perpetual funding applied automatically
- **Liquidation Detection** — Binance positions force-closed at liquidation price in paper trading

### Reliability Infrastructure
- **Order Lifecycle** — CREATED → SUBMITTED → ACKNOWLEDGED → FILLED → CLOSED with audit log
- **Broker Reconciliation** — Ghost/phantom detection and automatic repair; runs on startup, foreground, reconnect, and every 15 seconds
- **Idempotency** — IN_FLIGHT guard (duplicate press) + broker client order ID (network timeout retry)
- **Crash Reporter** — Global JS error capture, sanitised stack traces, local persistence, optional Sentry forwarding
- **Security Audit** — 5 automated checks per build version; runs non-blocking on startup
- **Error Boundary** — Crash ID displayed to user, persistent error log

### Analytics & Intelligence
- **AI Trading Coach** — 8 personalised insight generators; unlocks at 10 trades; optional Anthropic API narrative
- **Performance Dashboard** — System latency for all 8 critical paths (prediction, gates, broker ACK, fill time, reconciliation)
- **Health Dashboard** — Broker status, WebSocket health, reconciliation log, crash count; long-press for Developer Support
- **Audit Trail** — Full order event timeline + reconciliation log
- **Gate Analytics** — Which signal gates fire, which pass, and the win rate of trades gated by each
- **Market Context Analytics** — Win rate by VIX regime, Fear & Greed bucket, FII/DII bias

### Developer & Operations
- **Support Bundle** — Sanitised diagnostic JSON with crash summary, performance stats, security audit, reconciliation summary, portfolio risk; Copy + Share
- **Developer Support Screen** — Hidden (long-press Health Dashboard title 3s)
- **CI/CD** — GitHub Actions: validate → test → build on every commit; PR checks; nightly APK build at 2am IST
- **11 Test Suites, 345+ automated tests**

### User Experience
- **Onboarding** — 10-step first-run tutorial; experience selection; conditional broker setup screen for live users; skip; restart from Settings
- **Contextual Tooltips** — One-time tips on Health Dashboard, Portfolio Risk, Trading Coach; dismiss forever
- **Help System** — `?` buttons with bottom sheet explanations for VaR, Regime, Confidence, Profit Factor, Margin Utilisation, Funding Rate, Liquidation, READY, WAIT, AVOID
- **Dark and Light themes**

### Documentation
- `docs/E2E_TEST_SCRIPT.md` — 10-pass manual release checklist
- `docs/RELEASE_PROCESS.md` — Version bumping, signing, rollback procedure
- `docs/TROUBLESHOOTING.md` — Every known failure mode with cause and fix

---

## Known Limitations (v1.0)

These are deliberate scope decisions, not bugs:

| Area | Status |
|---|---|
| Live NSE Futures execution | Paper only. Live execution planned for v1.5. |
| Live Binance Futures execution | Paper only. Live execution planned for v1.5. |
| Options trading | Not included. Planned for v2.0. |
| Push notifications for trade events | Planned for v1.1. |
| CSV/PDF performance reports | Planned for v1.1. |
| Multi-device sync | Planned for v1.2. |
| AI model drift detection UI | Engine exists (`driftDetector.ts`), UI planned for v1.1. |

---

## Upgrade Notes

This is the first public release. No migration required.

---

## Breaking Changes

None. First release.

---

## Security

- All API keys stored in `expo-secure-store` (hardware-backed encryption on Android)
- No credentials ever written to AsyncStorage, logs, or crash reports
- Automated security audit runs on every build version
- All network calls use HTTPS/TLS exclusively

---

## v1.1 Roadmap (after beta feedback)

1. Push notifications for SL/TP hits and live order fills
2. Watchlists with price alerts
3. CSV and PDF performance report export
4. Confidence calibration chart (data already collected, UI pending)
5. Drift detection UI surfaced on chart screen
6. Enhanced AI Coach mentor framing (forward-looking recommendations)
7. Live Binance futures execution (paper layer is complete and correct)

---

*QUANTIS is a tool for informed trading decisions. It does not guarantee profits. All trading involves risk of loss. Always trade within your means.*
