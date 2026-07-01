import { Candle } from './indicators';
import { MLPrediction } from './mlSignal';
import { calculatePnL, calculatePnLPct, directionMultiplier } from './pnlCalculator';
import { computeTradeEconomics } from './tradeEconomics';
import { calcPositionSize, getRiskSettings, addToDailyPnL } from './riskManager';
import { checkRiskGate, getPaperRiskExtras } from './paperRiskControls';
import { checkRegimeFilter, getRegimeFilterMode } from './regimeFilter';
import { PaperPosition, savePortfolio, getPortfolio } from './paperPortfolio';
import { recordCompletedTrade, buildTradeRecord, getPaperTrades } from './paperTradeJournal';
import { notifyTradeOpened, notifyTradeClosed, notifyStopLossHit, notifyTakeProfitHit, notifyTrailingStopActivated } from './paperNotifications';
import { getIndicatorSnapshot } from './liveIndicatorSnapshot';
import { fromSinglePrediction } from './tradeQuality';
import { logger } from './logger';

// LONG and SHORT share this exact same engine — every function below is
// parameterized by `position.direction`, never duplicated per-side. The one
// helper, sideMultiplier, is what every P&L/comparison formula in this file
// is built from.

const FEE_PCT = 0.1;
const SLIPPAGE_PCT = 0.05;

// Was a private duplicate of the same +1/-1 mapping now centralized in
// pnlCalculator.ts. Kept as a local alias so non-P&L call sites below
// (slippage direction, break-even comparison) don't need to change.
const sideMultiplier = directionMultiplier;

// Entry/exit prices always incorporate ADVERSE slippage relative to the
// direction being traded: a LONG entry buys slightly above market and a
// LONG exit sells slightly below; a SHORT entry sells slightly below market
// and a SHORT exit (buy-to-cover) buys slightly above — verified directly
// before writing this (see conversation: entry/exit slippage direction test).
function applyEntrySlippage(price: number, direction: 'LONG' | 'SHORT'): number {
  return direction === 'LONG' ? price * (1 + SLIPPAGE_PCT / 100) : price * (1 - SLIPPAGE_PCT / 100);
}
function applyExitSlippage(price: number, direction: 'LONG' | 'SHORT'): number {
  return direction === 'LONG' ? price * (1 - SLIPPAGE_PCT / 100) : price * (1 + SLIPPAGE_PCT / 100);
}

export type OpenAttemptResult = { opened: boolean; reason: string; position?: PaperPosition };

// Opens a new paper position — LONG from a BUY signal, SHORT from a SELL
// signal, through the exact same code path. MLPrediction's
// suggestedStopLoss/suggestedTakeProfit are always computed assuming a LONG
// (mlSignal.ts), so for a SHORT they're mirrored around the entry using the
// SAME ATR distance — not a separate ATR calculation, just reflected.
export async function attemptOpenPosition(
  symbol: string, timeframe: string, prediction: MLPrediction, currentPrice: number,
  recentCandles: Candle[], assetClass: string
): Promise<OpenAttemptResult> {
  if (prediction.action !== 'BUY' && prediction.action !== 'SELL') {
    return { opened: false, reason: `AI action is ${prediction.action} — nothing to open.` };
  }
  const direction: 'LONG' | 'SHORT' = prediction.action === 'BUY' ? 'LONG' : 'SHORT';

  const portfolio = await getPortfolio();
  if (portfolio.openPositions.some(p => p.symbol === symbol)) {
    return { opened: false, reason: `Already have an open position in ${symbol} — avoiding duplicate entries.` };
  }

  // Real execution-time regime filter — previously regime was only ever
  // analyzed AFTER trades closed; this is the first point where it can
  // actually block an entry.
  const regimeMode = await getRegimeFilterMode();
  let regimeCheck: { allowed: boolean; currentRegime: string; skipMessage?: string } | null = null;
  if (recentCandles.length) {
    regimeCheck = checkRegimeFilter(recentCandles, regimeMode);
    if (!regimeCheck.allowed) {
      return { opened: false, reason: regimeCheck.skipMessage! };
    }
  }

  const atrStopDist = Math.abs(prediction.suggestedEntry - prediction.suggestedStopLoss);
  const atrTpDist = Math.abs(prediction.suggestedTakeProfit - prediction.suggestedEntry);
  const stopLoss = direction === 'LONG' ? prediction.suggestedEntry - atrStopDist : prediction.suggestedEntry + atrStopDist;
  const takeProfit = direction === 'LONG' ? prediction.suggestedEntry + atrTpDist : prediction.suggestedEntry - atrTpDist;

  const settings = await getRiskSettings();

  // FIX (Paper Trading Audit — root cause): portfolioValue was previously
  // settings.accountSize, a static user-configurable risk-planning number
  // that has no necessary relationship to the actual paper portfolio's
  // real value. It happens to default to the same 100000 as a freshly
  // reset portfolio, which is why this specific bug wasn't about THIS
  // mismatch — but it's still wrong, and would silently misprice exposure
  // the moment account size and portfolio value diverge (e.g., after
  // any realized P&L, or if the user customizes Risk Settings).
  // Cost-basis (entryPrice * qty), not live mark-to-market, deliberately
  // matches how checkRiskGate already computes existing exposure below —
  // mixing a live-marked numerator with a cost-basis-computed exposure
  // check would itself be a fresh inconsistency.
  const realPortfolioValue = portfolio.cashBalance + portfolio.openPositions.reduce((s, p) => s + p.entryPrice * p.qty, 0);

  const riskExtras = await getPaperRiskExtras();
  const existingSymbolExposure = portfolio.openPositions.filter(p => p.symbol === symbol).reduce((s, p) => s + p.entryPrice * p.qty, 0);
  const maxSymbolNotional = realPortfolioValue * (riskExtras.maxExposurePerSymbolPct / 100);
  const remainingSymbolHeadroom = Math.max(0, maxSymbolNotional - existingSymbolExposure);

  // FIX (Paper Trading Audit — root cause of "first trade on a fresh
  // portfolio rejected for exceeding 30% exposure"): calcPositionSize
  // previously sized PURELY by dollar risk (riskAmount / stopDistance),
  // with no relationship to notional exposure at all. Verified directly
  // with realistic ETH numbers (a 1.13% ATR-to-price ratio — nothing
  // unusual): this produced an 86% notional position while still
  // correctly risking only ~1% in dollar terms if stopped out. The
  // exposure gate downstream was correctly catching this — it was never
  // the bug — but nothing upstream kept position SIZE consistent with
  // exposure limits in the first place. Now sized within both
  // constraints simultaneously from the start.
  const sizing = calcPositionSize(settings.accountSize, settings.riskPerTradePct, currentPrice, stopLoss, remainingSymbolHeadroom);
  if (sizing.qty <= 0) {
    return { opened: false, reason: 'Position sizing computed to zero units (stop-loss too close to entry, account size too small, or no remaining exposure headroom for this symbol).' };
  }

  // FIX (Phase 6 cash accounting audit): positionValue previously used the
  // raw currentPrice, not the actual entryPrice paid (entryPrice includes
  // slippage). This meant the cash debited at open was LESS than the real
  // cost — portfolio value immediately after opening only reflected the
  // fee, not the slippage, even though slippage is an immediately real
  // cost. Verified directly: with this bug, opening showed -fee only;
  // correctly, it should show -fee AND -slippage right away, since you
  // genuinely paid more than market price the instant you entered.
  // Computing entryPrice first and using it everywhere below fixes this.
  const entryPrice = applyEntrySlippage(currentPrice, direction);
  const positionValue = sizing.qty * entryPrice;
  const entryFee = positionValue * (FEE_PCT / 100);

  const recentTrades = await getPaperTrades();
  const gate = await checkRiskGate(portfolio, symbol, assetClass, positionValue, realPortfolioValue, recentTrades);

  // Task 4 (Paper Trading Audit) — full debug trace before every trade
  // attempt, pass or fail, so a future "rejected unexpectedly" report can
  // be diagnosed from logs alone without needing to re-derive all of this
  // from scratch again.
  logger.info('paperTradingEngine', JSON.stringify({
    symbol, direction, portfolioValue: realPortfolioValue, cashBalance: portfolio.cashBalance,
    existingSymbolExposure, maxSymbolNotional, remainingSymbolHeadroom,
    riskPerTradePct: settings.riskPerTradePct, accountSizeSetting: settings.accountSize,
    stopLoss, entryPrice, qty: sizing.qty, notionalExposure: positionValue,
    notionalExposurePct: realPortfolioValue > 0 ? (positionValue / realPortfolioValue) * 100 : null,
    maxExposurePerSymbolPct: riskExtras.maxExposurePerSymbolPct,
    leverage: 1, // no leverage concept exists anywhere in this engine — confirmed during the audit, not omitted
    gateAllowed: gate.allowed, rejectionReason: gate.allowed ? null : gate.reason,
  }));

  if (!gate.allowed) {
    return { opened: false, reason: gate.reason || 'Blocked by risk controls.' };
  }

  // FIX: this used to label marketRegime via a crude risk-score proxy
  // ('HIGH_RISK'/'NORMAL') that has nothing to do with actual market
  // regime (Bull/Bear/Range/volatility) — meaningless for Portfolio
  // Intelligence's "performance by market regime" breakdown. The real
  // regime check is already computed above (regimeCheck, from the filter
  // gate) — reusing its currentRegime label here instead of a second,
  // unrelated computation.
  const regimeForRecord = regimeCheck?.currentRegime ?? 'UNKNOWN';

  // Single Trade Quality Score implementation, computed once here and
  // persisted on the position — never recomputed later from a stale
  // snapshot, and never a second scoring formula.
  const qualitySnapshot = recentCandles.length ? getIndicatorSnapshot(recentCandles) : null;
  const qualityResult = recentCandles.length ? fromSinglePrediction(prediction, recentCandles, qualitySnapshot, symbol, assetClass, regimeForRecord) : null;

  // DIAGNOSTICS ONLY - computed and attached for later display in
  // Journal/Replay/Analytics. This does NOT participate in the gate
  // logic above in any way; the trade has already been fully accepted
  // by the time this line runs.
  const tradeEconomics = computeTradeEconomics(entryPrice, sizing.qty, direction, stopLoss, takeProfit, entryFee);

  const position: PaperPosition = {
    id: `${symbol}_${Date.now()}`,
    symbol, timeframe, assetClass, direction,
    entryTime: Date.now(), entryPrice, qty: sizing.qty,
    stopLoss, takeProfit,
    aiConfidence: prediction.confidence, riskScoreAtEntry: prediction.riskScore, tradeQuality: qualityResult?.quality ?? null, modelVersion: prediction.modelVersion, predictionHorizon: 3,
    entryReason: `Ensemble ${prediction.action}, ${(prediction.ensembleProbUp * 100).toFixed(1)}% P(up), confidence ${prediction.confidence.toFixed(0)}/100`,
    entryFee,
    maxUnrealizedProfit: 0, maxUnrealizedDrawdown: 0,
    tradeEconomics,
    entrySnapshot: { recentCandles: recentCandles.slice(-30), topFeatures: prediction.topFeatures, marketRegime: regimeForRecord, orderBookSnapshot: prediction.orderBookSnapshot },
  };

  portfolio.openPositions.push(position);
  // SHORT opens with a cash CREDIT (you receive proceeds from the sale,
  // held as collateral) rather than a debit — both sides still pay the
  // entry fee on the notional value.
  portfolio.cashBalance += direction === 'LONG' ? -(positionValue + entryFee) : (positionValue - entryFee);
  await savePortfolio(portfolio);
  notifyTradeOpened(position).catch(() => {});
  logger.info('paperTradingEngine', `Opened ${direction} ${symbol} qty=${sizing.qty} @ ${entryPrice.toFixed(2)}`);
  return { opened: true, reason: 'Position opened.', position };
}

export type CloseReason = 'STOP_LOSS' | 'TAKE_PROFIT' | 'MANUAL_EXIT' | 'AI_EXIT_SIGNAL';

const closingPositionIds = new Set<string>();

export async function closePosition(positionId: string, exitPrice: number, exitReason: CloseReason): Promise<void> {
  if (closingPositionIds.has(positionId)) {
    logger.info('paperTradingEngine', `closePosition skipped for ${positionId} - already being closed by another caller`);
    return; // a close for this exact position is already in flight from some other caller; don't double-process it
  }
  closingPositionIds.add(positionId);
  try {
    await closePositionInner(positionId, exitPrice, exitReason);
  } finally {
    closingPositionIds.delete(positionId); // ALWAYS released, even on early return or exception - a position can never get permanently stuck
  }
}

async function closePositionInner(positionId: string, exitPrice: number, exitReason: CloseReason): Promise<void> {
  const portfolio = await getPortfolio();
  const position = portfolio.openPositions.find(p => p.id === positionId);
  if (!position) return;

  const effectiveExit = applyExitSlippage(exitPrice, position.direction);
  const grossValue = effectiveExit * position.qty;
  const fees = grossValue * (FEE_PCT / 100);
  // FIX: pnl previously only subtracted the close-time fee — the entry fee
  // was already debited from cash at open but never re-included here,
  // meaning every reported pnl (and realizedPnL, and every Journal record)
  // silently overstated the true result by exactly the entry fee. Confirmed
  // via direct regression test before fixing.
  const pnl = calculatePnL({ entryPrice: position.entryPrice, exitPrice: effectiveExit, qty: position.qty, direction: position.direction, fees: fees + position.entryFee });
  // Gross P&L = same price-based calculation, zero fees - this is what lets
  // a user verify Gross - TotalFees = Net by hand from the Journal alone,
  // and is what makes a "TAKE_PROFIT hit but pnl is negative" result
  // self-explaining rather than looking like a bug: a thin gross profit
  // genuinely can be smaller than round-trip fees, and this number proves it.
  const grossPnl = calculatePnL({ entryPrice: position.entryPrice, exitPrice: effectiveExit, qty: position.qty, direction: position.direction, fees: 0 });

  // Closing a LONG returns the sale proceeds; closing a SHORT (buy-to-cover)
  // costs the buy-back notional — mirrored cash flow from the open above.
  portfolio.cashBalance += position.direction === 'LONG' ? grossValue - fees : -(grossValue + fees);
  portfolio.openPositions = portfolio.openPositions.filter(p => p.id !== positionId);
  portfolio.realizedPnL += pnl;
  await savePortfolio(portfolio);

  const pnlPct = calculatePnLPct(pnl, position.entryPrice, position.qty);
  const record = buildTradeRecord(position, Date.now(), effectiveExit, fees, grossValue * (SLIPPAGE_PCT / 100), exitReason, pnl, pnlPct, grossPnl);
  await recordCompletedTrade(record);
  await addToDailyPnL(pnl);

  if (exitReason === 'STOP_LOSS') notifyStopLossHit(position.symbol, pnl).catch(() => {});
  else if (exitReason === 'TAKE_PROFIT') notifyTakeProfitHit(position.symbol, pnl).catch(() => {});
  else notifyTradeClosed(record).catch(() => {});

  logger.info('paperTradingEngine', `Closed ${position.direction} ${position.symbol} @ ${effectiveExit.toFixed(2)}, pnl=${pnl.toFixed(2)}, reason=${exitReason}`);
}

export async function closePositionPartial(positionId: string, fraction: number, exitPrice: number): Promise<void> {
  if (fraction >= 1) return closePosition(positionId, exitPrice, 'MANUAL_EXIT');
  const portfolio = await getPortfolio();
  const position = portfolio.openPositions.find(p => p.id === positionId);
  if (!position) return;

  const closedQty = position.qty * fraction;
  const effectiveExit = applyExitSlippage(exitPrice, position.direction);
  const grossValue = effectiveExit * closedQty;
  const fees = grossValue * (FEE_PCT / 100);
  // FIX (same entry-fee bug as closePosition, proportionally split here):
  // only the FRACTION of the entry fee belonging to the qty actually being
  // closed counts toward this partial close's pnl — the remainder stays
  // attributed to the still-open remaining quantity.
  const attributedEntryFee = position.entryFee * fraction;
  const pnl = calculatePnL({ entryPrice: position.entryPrice, exitPrice: effectiveExit, qty: closedQty, direction: position.direction, fees: fees + attributedEntryFee });

  portfolio.cashBalance += position.direction === 'LONG' ? grossValue - fees : -(grossValue + fees);
  portfolio.realizedPnL += pnl;
  position.qty -= closedQty;
  position.entryFee -= attributedEntryFee;
  await savePortfolio(portfolio);
  await addToDailyPnL(pnl);
  logger.info('paperTradingEngine', `Partial close ${position.direction} ${position.symbol}: ${(fraction * 100).toFixed(0)}% @ ${effectiveExit.toFixed(2)}, pnl=${pnl.toFixed(2)}`);
}

export async function moveStopLoss(positionId: string, newStopLoss: number): Promise<void> {
  const portfolio = await getPortfolio();
  const position = portfolio.openPositions.find(p => p.id === positionId);
  if (!position) return;
  position.stopLoss = newStopLoss;
  await savePortfolio(portfolio);
}

export async function moveTakeProfit(positionId: string, newTakeProfit: number): Promise<void> {
  const portfolio = await getPortfolio();
  const position = portfolio.openPositions.find(p => p.id === positionId);
  if (!position) return;
  position.takeProfit = newTakeProfit;
  await savePortfolio(portfolio);
}

// Break-even: LONG triggers when price has risen favorably by the R-multiple;
// SHORT triggers when price has FALLEN favorably by the same multiple —
// mirrored comparison, same function.
export async function applyBreakEvenStop(positionId: string, currentPrice: number, triggerRMultiple = 1): Promise<boolean> {
  const portfolio = await getPortfolio();
  const position = portfolio.openPositions.find(p => p.id === positionId);
  if (!position) return false;
  const originalRisk = Math.abs(position.entryPrice - position.stopLoss);
  if (originalRisk <= 0) return false;
  const moved = (currentPrice - position.entryPrice) * sideMultiplier(position.direction);
  const stopIsStillAtRisk = position.direction === 'LONG' ? position.stopLoss < position.entryPrice : position.stopLoss > position.entryPrice;
  if (moved >= originalRisk * triggerRMultiple && stopIsStillAtRisk) {
    position.stopLoss = position.entryPrice;
    await savePortfolio(portfolio);
    logger.info('paperTradingEngine', `Break-even stop applied to ${position.direction} ${position.symbol}`);
    return true;
  }
  return false;
}

// Trailing stop: LONG trails below the highest price seen (only moves up);
// SHORT trails above the lowest price seen (only moves down) — same
// function, direction decides which way "tighter" means.
export async function applyTrailingStop(positionId: string, currentPrice: number, trailDistance: number): Promise<boolean> {
  const portfolio = await getPortfolio();
  const position = portfolio.openPositions.find(p => p.id === positionId);
  if (!position) return false;
  const candidateStop = position.direction === 'LONG' ? currentPrice - trailDistance : currentPrice + trailDistance;
  const improves = position.direction === 'LONG' ? candidateStop > position.stopLoss : candidateStop < position.stopLoss;
  if (improves) {
    position.stopLoss = candidateStop;
    await savePortfolio(portfolio);
    notifyTrailingStopActivated(position.symbol, candidateStop).catch(() => {});
    return true;
  }
  return false;
}

// Monitors every open position against live prices — SL/TP trigger
// direction is mirrored per-side (see checkExit logic verified before
// writing this), unrealized P&L uses the same sideMultiplier as everywhere else.
let monitorInFlight = false;

export async function monitorOpenPositions(livePrices: Record<string, number>): Promise<void> {
  if (monitorInFlight) {
    logger.info('paperTradingEngine', 'monitorOpenPositions skipped - previous invocation still closing positions');
    return; // skip this call entirely; the position is still open and will be caught by the next, non-overlapping call
  }
  monitorInFlight = true;
  try {
    const portfolio = await getPortfolio();
    const toClose: { id: string; price: number; reason: CloseReason }[] = [];

    portfolio.openPositions.forEach(position => {
      const cur = livePrices[position.symbol];
      if (cur == null) return;
      const unrealized = calculatePnL({ entryPrice: position.entryPrice, exitPrice: cur, qty: position.qty, direction: position.direction });
      position.maxUnrealizedProfit = Math.max(position.maxUnrealizedProfit, unrealized);
      position.maxUnrealizedDrawdown = Math.min(position.maxUnrealizedDrawdown, unrealized);

      if (position.direction === 'LONG') {
        if (cur <= position.stopLoss) toClose.push({ id: position.id, price: position.stopLoss, reason: 'STOP_LOSS' });
        else if (cur >= position.takeProfit) toClose.push({ id: position.id, price: position.takeProfit, reason: 'TAKE_PROFIT' });
      } else {
        if (cur >= position.stopLoss) toClose.push({ id: position.id, price: position.stopLoss, reason: 'STOP_LOSS' });
        else if (cur <= position.takeProfit) toClose.push({ id: position.id, price: position.takeProfit, reason: 'TAKE_PROFIT' });
      }
    });

    await savePortfolio(portfolio); // persist tracking-field updates before any close processes (see prior fix)

    for (const c of toClose) {
      await closePosition(c.id, c.price, c.reason);
    }
  } finally {
    monitorInFlight = false; // ALWAYS cleared, even if something above throws - monitoring can never be permanently locked out
  }
}

// Closes a position because a fresh AI signal now points the opposite way —
// e.g. a LONG closes if the latest prediction's action is SELL (or strongly
// bearish), and vice versa for a SHORT. Wired from the watchlist scanner.
export async function checkAIExitSignal(position: PaperPosition, latestPrediction: MLPrediction, currentPrice: number): Promise<boolean> {
  const opposingSignal = position.direction === 'LONG' ? latestPrediction.action === 'SELL' : latestPrediction.action === 'BUY';
  if (opposingSignal) {
    await closePosition(position.id, currentPrice, 'AI_EXIT_SIGNAL');
    return true;
  }
  return false;
}
