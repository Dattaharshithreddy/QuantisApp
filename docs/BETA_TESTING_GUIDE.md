# QUANTIS Beta Testing Guide

**Version:** v1.0.0  
**For:** Beta testers (5–10 trusted traders)

---

## What you're testing

QUANTIS is a mobile trading terminal that uses a 116-feature AI model to generate BUY/SELL signals for Indian equities, crypto, NSE futures, and Binance perpetual futures. You are testing the complete app — AI predictions, paper trading, futures, risk management, and the AI coach.

**This is a beta. Expect rough edges.** Your job is to find them.

---

## Ground rules

1. **Paper trading only for the first 2 weeks.** Do not connect a real broker until you understand the app.
2. **If you use live trading, use minimum position sizes.** The AI is not a guarantee.
3. **Report everything** — crashes, confusing UI, wrong numbers, missing features, unclear terminology.
4. **The Shadow Journal is worth checking.** It records every signal the AI blocked. Check it daily.

---

## How to report an issue

Send a message with:

1. **What you were doing** — which screen, what action
2. **What happened** — exact error or unexpected behaviour
3. **Crash ID** — if the app crashed, go to More → Health Dashboard and copy the Crash ID
4. **Build version** — visible in More → Health Dashboard
5. **Screenshot** — if relevant

---

## What to test (suggested sequence)

### Week 1 — Paper Trading

- [ ] Complete the onboarding tutorial
- [ ] Open the chart for NIFTY50, RELIANCE, or BTCUSD
- [ ] Run at least 5 predictions
- [ ] Place at least 5 paper trades — both LONG and SHORT
- [ ] Let some trades hit their stop loss naturally (don't manually close everything)
- [ ] Check the Shadow Journal after 3 days

### Week 2 — Analytics and Futures

- [ ] Check More → AI Trading Coach (needs 10+ trades first)
- [ ] Open More → Portfolio Risk Manager with some paper positions open
- [ ] Open More → NSE Futures → Trade 1 lot of NIFTY or BANKNIFTY
- [ ] Open More → Crypto Futures → Trade 0.001 BTC at 10× leverage
- [ ] Check the MTM log after your NSE futures position is held overnight
- [ ] Deliberately set a stop loss close to current price and watch it auto-close

### Week 3 — Live Trading (optional, minimum size)

- [ ] Connect Angel One or Binance in More → Broker Connection
- [ ] Toggle PAPER/LIVE on the chart
- [ ] Place one real order with minimum position size
- [ ] Check More → Audit Trail after the order fills
- [ ] Check More → Health Dashboard after a live trade

### Throughout — Report these specifically

- Any screen that crashes
- Any number that looks wrong (price, P&L, confidence)
- Any term you didn't understand (use the ? buttons — if there isn't one where you need it, that's a bug)
- Any flow that felt confusing or required guesswork
- Any feature you expected but couldn't find

---

## Features to specifically try

| Feature | Where | What to check |
|---|---|---|
| AI Prediction | Chart → Run Prediction | Does READY/WAIT/AVOID make sense for the market? |
| Shadow Journal | More → Shadow Journal | Are the blocked signals being recorded? |
| Gate Analytics | More → Gate Analytics | Which gates fire most often? |
| Trading Coach | More → AI Trading Coach | Are the insights specific to your trading? |
| Portfolio Risk | More → Portfolio Risk Manager | Does the exposure number look correct? |
| Health Dashboard | More → Health Dashboard | Are broker status and WebSocket health accurate? |
| Onboarding | Settings → Restart Tutorial | Does it explain things clearly to a new user? |
| Help buttons | ? buttons throughout | Are the explanations clear and accurate? |

---

## Known limitations (not bugs)

- NSE and Binance futures are paper only — live futures execution is planned for v1.5
- The AI Coach needs 10+ completed trades before showing insights
- Prediction takes 3–8 seconds on first run (model initialisation); subsequent predictions are faster
- The performance dashboard populates over time — empty on first launch

---

## Thank you

Beta feedback is the highest-value input at this stage of development. Every real user issue you find is more useful than any feature that could be added. Be specific, be honest, and tell us when something doesn't make sense.
