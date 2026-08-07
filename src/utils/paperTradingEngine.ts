import { Candle } from './indicators';
import { MLPrediction } from './mlSignal';
import { calculatePnL, calculatePnLPct, directionMultiplier } from './pnlCalculator';
import { computeTradeEconomics } from './tradeEconomics';
import { calcPositionSize, getRiskSettings, addToDailyPnL } from './riskManager';
import { checkRiskGate, getPaperRiskExtras } from './paperRiskControls';
import { checkRegimeFilter, getRegimeFilterMode } from './regimeFilter';
import { evaluateSignalGates } from './signalGates';
import { recordMetric } from './performanceMetrics';
import { recordShadowTrade } from './shadowTradeJournal';
import { PaperPosition, savePortfolio, getPortfolio } from './paperPortfolio';
import { recordCompletedTrade, buildTradeRecord, getPaperTrades } from './paperTradeJournal';
import { loadDriftState, saveDriftState, updateCUSUM, updatePageHinkley } from './modelHealth/driftDetector';
import { notifyTradeOpened, notifyTradeClosed, notifyStopLossHit, notifyTakeProfitHit, notifyTrailingStopActivated, notifyShadowEntryRecorded } from './paperNotifications';
import { getIndicatorSnapshot } from './liveIndicatorSnapshot';
import { fromSinglePrediction } from './tradeQuality';
import { logger } from './logger';
import { getActiveStrategyId } from './strategy/strategyStorage';
import { getProfile } from './strategy/strategyProfiles';
import { evaluateTradeManagement, initManagementState, DEFAULT_MGMT_CONFIG } from './tradeManager';
import { precomputeSMC } from './smc/smcEngine';
import { precomputeStructure } from './structure/marketStructure';
import { atr as atrFn } from './technicalIndicators';
import { evaluateIntracandleFill, DEFAULT_EXECUTION_CONFIG, FillResult } from './executionEngine';
import { evaluatePortfolioRisk, DEFAULT_PORTFOLIO_RISK_CONFIG } from './portfolioRiskEngine';

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

export type BlockedGateData = {
  gate: import('./shadowTradeJournal').GateType;
  reason: string;
  details?: Record<string, string | number>;
};

export type OpenAttemptResult = {
  opened: boolean;
  reason: string;
  position?: PaperPosition;
  // True when a Shadow Journal entry was written as part of this attempt.
  // The UI uses this directly — never infers from signal state or gate type.
  shadowRecorded: boolean;
};

// Opens a new paper position — LONG from a BUY signal, SHORT from a SELL
// signal, through the exact same code path. MLPrediction's
// suggestedStopLoss/suggestedTakeProfit are always computed assuming a LONG
// (mlSignal.ts), so for a SHORT they're mirrored around the entry using the
// SAME ATR distance — not a separate ATR calculation, just reflected.
export async function attemptOpenPosition(
  symbol: string, timeframe: string, prediction: MLPrediction, currentPrice: number,
  recentCandles: Candle[], assetClass: string,
  overallConfidence?: number,
  regimeLabelOverride?: string,
  marketContext?: import('./marketContextSnapshot').MarketContextSnapshot | null,
  bypassGates: boolean = false,
  // MTF-based readiness state computed by computeTradeReadiness Phase 1.
  // Passed from the UI so the execution engine respects the same MTF verdict.
  // null = non-chart caller (scanner, automation) — gates run from baseline READY.
  mtfReadinessState?: 'READY' | 'WAIT' | 'AVOID' | null,
): Promise<OpenAttemptResult> {
  const _paperTradeStart = Date.now();
  if (prediction.action !== 'BUY' && prediction.action !== 'SELL') {
    return { opened: false, reason: `AI action is ${prediction.action} — nothing to open.`, shadowRecorded: false };
  }
  const direction: 'LONG' | 'SHORT' = prediction.action === 'BUY' ? 'LONG' : 'SHORT';

  const portfolio = await getPortfolio();
  if (portfolio.openPositions.some(p => p.symbol === symbol)) {
    const dupReason = `Already have an open position in ${symbol} — avoiding duplicate entries.`;
    // Record in shadow journal regardless of bypassGates — this is a hard safety gate,
    // not an AI gate, so the user needs visibility that their override attempt failed here.
    const dupSignal = {
      action: prediction.action, confidence: overallConfidence ?? prediction.confidence,
      ensembleProbUp: prediction.ensembleProbUp, regime: regimeLabelOverride ?? 'UNKNOWN'};
    recordShadowTrade({ symbol, timeframe, direction: prediction.action === 'BUY' ? 'LONG' : 'SHORT',
      entryPrice: prediction.suggestedEntry, stopLoss: prediction.suggestedStopLoss,
      takeProfit: prediction.suggestedTakeProfit, blockReason: dupReason,
      blockGate: 'DUPLICATE_POSITION', signal: dupSignal, signalId: prediction.signalId,
      marketContext: marketContext ?? null }).catch(() => {});
    notifyShadowEntryRecorded(symbol, 'DUPLICATE_POSITION', dupReason).catch(() => {});
    logger.warn('paperTradingEngine', `DUPLICATE_POSITION blocked ${symbol} (bypassGates=${bypassGates})`);
    return { opened: false, reason: dupReason, shadowRecorded: true };
  }

  // Real execution-time regime filter — previously regime was only ever
  // analyzed AFTER trades closed; this is the first point where it can
  // actually block an entry.
  const regimeMode = await getRegimeFilterMode();
  let regimeCheck: { allowed: boolean; currentRegime: string; skipMessage?: string } | null = null;
  if (regimeLabelOverride) {
    // Use the regime already computed by regimeScore (System 1) — same source as the UI.
    // This eliminates the mismatch where the UI shows 'WEAK_BULL_TREND' but the gate
    // sees 'Range' from the independent EMA-based checkRegimeFilter (System 2).
    regimeCheck = { allowed: true, currentRegime: regimeLabelOverride };
    // Still apply the simple filter-mode gate (DISABLED / BULL_ONLY etc.) if active,
    // unless the user has explicitly overridden all gates.
    if (!bypassGates && regimeMode !== 'DISABLED') {
      const filterCheck = checkRegimeFilter(recentCandles, regimeMode);
      if (!filterCheck.allowed) return { opened: false, reason: filterCheck.skipMessage!, shadowRecorded: false };
    }
  } else if (recentCandles.length) {
    regimeCheck = checkRegimeFilter(recentCandles, regimeMode);
    if (!bypassGates && !regimeCheck.allowed) {
      return { opened: false, reason: regimeCheck.skipMessage!, shadowRecorded: false };
    }
  }

  // SL/TP anchored to currentPrice (the live price at the moment the trade button was pressed),
  // NOT to prediction.suggestedEntry (the close price at predict-time, which may be stale by
  // seconds or minutes — especially on override where the user reads a warning before confirming).
  // The ATR distances are still taken from the prediction (they are indicator-derived, not
  // price-level dependent) so the risk profile is unchanged. Only the anchor shifts to live price.
  const atrStopDist = Math.abs(prediction.suggestedEntry - prediction.suggestedStopLoss);
  const atrTpDist   = Math.abs(prediction.suggestedTakeProfit - prediction.suggestedEntry);
  const stopLoss   = direction === 'LONG' ? currentPrice - atrStopDist : currentPrice + atrStopDist;
  const takeProfit = direction === 'LONG' ? currentPrice + atrTpDist   : currentPrice - atrTpDist;
  // signalType is only known after evaluateSignalGates() runs later in this function.
  // It is NOT available here. Previously this line had `signalType` as a shorthand
  // property which caused a ReferenceError on every call — silently crashing the engine
  // before any gate check ran. Signal-gate shadow entries (REGIME/FILTER) re-use this
  // object and set signalType from signalGateResult at the point they record.
  const shadowSignal = {
    action: prediction.action, confidence: overallConfidence ?? prediction.confidence,
    ensembleProbUp: prediction.ensembleProbUp,
    regime: regimeCheck?.currentRegime ?? 'UNKNOWN',
    signalType: undefined as string | undefined,  // filled in by signal gate path below
  };

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

  // DIAGNOSTIC LOG — always emitted so qty=0 failures are provable from logs alone.
  // riskAmount = accountSize × riskPerTradePct%
  // perUnitRisk = |entry - stopLoss| (the ATR stop distance)
  // qty = floor(riskAmount / perUnitRisk)  →  goes to 0 when stopLoss is wider than riskAmount
  logger.info('paperTradingEngine', JSON.stringify({
    event:               'position_sizing',
    symbol,
    riskPerTradePct:     settings.riskPerTradePct,
    accountSize:         settings.accountSize,
    riskAmount:          +(settings.accountSize * settings.riskPerTradePct / 100).toFixed(2),
    currentPrice:        +currentPrice.toFixed(4),
    stopLoss:            +stopLoss.toFixed(4),
    perUnitRisk:         +Math.abs(currentPrice - stopLoss).toFixed(4),
    remainingHeadroom:   +remainingSymbolHeadroom.toFixed(2),
    qty:                 sizing.qty,
    positionValue:       +(sizing.positionValue ?? 0).toFixed(2),
    bypassGates}));

  if (sizing.qty <= 0) {
    const riskBudget = settings.accountSize * settings.riskPerTradePct / 100;
    const stopDist   = Math.abs(currentPrice - stopLoss);
    // Plain-language reason shown to the user — no math formula.
    // Full calculation is in the diagnostic log above (event: 'position_sizing').
    const sizingReason =
      `Your current risk setting (${settings.riskPerTradePct}% risk per trade) does not allow ` +
      `a position here — the stop-loss distance is too large for your risk budget.\n\n` +
      `To fix this: increase Risk Per Trade % in Risk Manager, or wait for a tighter entry ` +
      `with a closer stop-loss.`;
    const sizingSignal = {
      action: prediction.action, confidence: overallConfidence ?? prediction.confidence,
      ensembleProbUp: prediction.ensembleProbUp, regime: regimeCheck?.currentRegime ?? 'UNKNOWN'};
    recordShadowTrade({ symbol, timeframe, direction,
      entryPrice: prediction.suggestedEntry, stopLoss, takeProfit,
      blockReason: sizingReason, blockGate: 'POSITION_SIZING',
      signal: sizingSignal, signalId: prediction.signalId,
      gateDetails: {
        riskAmount:      +riskBudget.toFixed(2),
        perUnitRisk:     +stopDist.toFixed(4),
        riskPerTradePct: settings.riskPerTradePct,
        accountSize:     settings.accountSize,
        currentPrice:    +currentPrice.toFixed(4),
        stopLoss:        +stopLoss.toFixed(4)},
      marketContext: marketContext ?? null }).catch(() => {});
    logger.warn('paperTradingEngine',
      `POSITION_SIZING blocked ${symbol}: qty=0, stopDist=${stopDist.toFixed(4)}, riskBudget=${riskBudget.toFixed(2)}, bypassGates=${bypassGates}`);
    notifyShadowEntryRecorded(symbol, 'POSITION_SIZING', sizingReason).catch(() => {});
    return { opened: false, reason: sizingReason, shadowRecorded: true };
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
    stopLoss, entryPrice,
    initialSizingQty: sizing.qty / 1, // pre-REDUCE_SIZE value kept for audit trail
    qty: sizing.qty, // post-REDUCE_SIZE final value
    notionalExposure: (sizing as any).positionValue ?? positionValue,  // post-REDUCE_SIZE final value
    notionalExposurePct: realPortfolioValue > 0
      ? (((sizing as any).positionValue ?? positionValue) / realPortfolioValue) * 100 : null,
    maxExposurePerSymbolPct: riskExtras.maxExposurePerSymbolPct,
    leverage: 1, // no leverage concept exists anywhere in this engine — confirmed during the audit, not omitted
    gateAllowed: gate.allowed, rejectionReason: gate.allowed ? null : gate.reason}));

  if (!gate.allowed && !bypassGates) {
    const confGateData: BlockedGateData = {
      gate: 'CONFIDENCE', reason: gate.reason || 'Blocked by risk controls.',
      details: { confidence: +(overallConfidence ?? prediction.confidence).toFixed(1), regime: regimeCheck?.currentRegime ?? 'UNKNOWN' }};
    recordShadowTrade({ symbol, timeframe, direction, entryPrice: prediction.suggestedEntry,
      stopLoss, takeProfit, blockReason: confGateData.reason, blockGate: 'CONFIDENCE',
      signal: shadowSignal, signalId: prediction.signalId, gateDetails: confGateData.details,
      marketContext: marketContext ?? prediction.marketContext ?? null }).catch(() => {});
    notifyShadowEntryRecorded(symbol, 'CONFIDENCE', confGateData.reason).catch(() => {});
    return { opened: false, reason: confGateData.reason, gateData: confGateData, shadowRecorded: true };
  }

  // ── Portfolio Risk Engine — dynamic sizing + correlation gate ──────────
  // Runs after checkRiskGate (which enforces hard limits) and before
  // position construction. Uses already-computed confidence, ATR from
  // the prediction and recent candles. No engine re-runs.
  const lastCandle = recentCandles[recentCandles.length - 1];
  const atrForRisk = lastCandle ? Math.abs(lastCandle.high - lastCandle.low) * 1.5 : entryPrice * 0.015;
  const allClosedTrades = await getPaperTrades();
  const wins   = allClosedTrades.filter(t => t.pnl > 0);
  const losses = allClosedTrades.filter(t => t.pnl < 0);
  const winRatePct = allClosedTrades.length > 0 ? (wins.length / allClosedTrades.length) * 100 : 55;
  const avgWinPct  = wins.length   > 0 ? wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length   : 1.5;
  const avgLossPct = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length) : 1.0;
  // Build per-symbol candle series from open positions for dynamic correlation.
  // recentCandles is the candle history for the NEW position being opened.
  // Open positions have their entry-time candles stored in entrySnapshot.
  // This is the candle data already in memory — no new fetches.
  const candleSeries = [
    { symbol, candles: recentCandles },
    ...portfolio.openPositions
      .filter(p => p.entrySnapshot.recentCandles.length >= 30)
      .map(p => ({ symbol: p.symbol, candles: p.entrySnapshot.recentCandles })),
  ];

  const portfolioRiskResult = evaluatePortfolioRisk(
    portfolio,
    {
      symbol, direction, assetClass,
      entryPrice, stopLoss, takeProfit: prediction.suggestedTakeProfit ?? entryPrice + 3 * atrForRisk,
      confidence: overallConfidence ?? prediction.confidence,  // prefer live confidence over stale training-time value
      ensembleProb: prediction.ensembleProbUp,
      regimeLabel: regimeCheck?.currentRegime ?? 'UNKNOWN',
      mtfOverall: prediction.topFeatures.find(f => f.name === 'MTF overall score')?.value ?? 0,
      atr: atrForRisk,
      winRatePct, avgWinPct, avgLossPct,
      accountSize: settings.accountSize,
      baseRiskPct: settings.riskPerTradePct,
      feePct: FEE_PCT, slippagePct: SLIPPAGE_PCT,
      candleSeries},
    realPortfolioValue,
    DEFAULT_PORTFOLIO_RISK_CONFIG,
  );

  if (portfolioRiskResult.decision === 'BLOCK' && !bypassGates) {
    logger.info('paperTradingEngine', `Portfolio risk engine BLOCKED ${symbol}: ${portfolioRiskResult.reason}`);
    const pGD: BlockedGateData = { gate: 'PORTFOLIO_RISK', reason: `Portfolio risk limit: ${portfolioRiskResult.reason}`,
      details: { regime: regimeCheck?.currentRegime ?? 'UNKNOWN' } };
    recordShadowTrade({ symbol, timeframe, direction, entryPrice: prediction.suggestedEntry,
      stopLoss, takeProfit, blockReason: pGD.reason, blockGate: 'PORTFOLIO_RISK',
      signal: shadowSignal, signalId: prediction.signalId, gateDetails: pGD.details,
      marketContext: marketContext ?? prediction.marketContext ?? null }).catch(() => {});
    notifyShadowEntryRecorded(symbol, 'PORTFOLIO_RISK', pGD.reason).catch(() => {});
    return { opened: false, reason: pGD.reason, gateData: pGD, shadowRecorded: true };
  }

  // REDUCE_SIZE: replace sizing.qty with the portfolio-risk-engine quantity
  if (portfolioRiskResult.decision === 'REDUCE_SIZE' && portfolioRiskResult.recommendedPositionSize > 0) {
    const reducedQty = Math.max(1, Math.floor(portfolioRiskResult.recommendedPositionSize / entryPrice));
    // Override the sizing — immutable rebind
    (sizing as any).qty = reducedQty;
    (sizing as any).positionValue = reducedQty * entryPrice;
    logger.info('paperTradingEngine', `Portfolio risk engine REDUCED ${symbol} size: ${portfolioRiskResult.reason}`);
  }

  // ── Signal gates — shared with computeTradeReadiness (single source of truth) ──
  // evaluateSignalGates() runs the same regime + strategy gates that Trade Readiness
  // used. Using the same function guarantees that "READY" in the UI and "allowed"
  // in execution always agree on signal quality.
  // regimeCheck.currentRegime is regimeLabelOverride when provided from the UI
  // (= regimeSnap.label, same 11-label source as computeTradeReadiness).
  const regimeForRecord = regimeCheck?.currentRegime ?? 'UNKNOWN';
  const activeStratId = await getActiveStrategyId().catch(() => null);
  const activeProfile = activeStratId ? getProfile(activeStratId) : null;

  const signalGateStart = Date.now();
  const signalGateResult = evaluateSignalGates({
    regimeLabel:        regimeForRecord,
    direction,
    ensembleProbUp:     prediction.ensembleProbUp,
    confidence:         overallConfidence ?? prediction.confidence,
    horizons:           prediction.horizons ?? [],
    mtfReadinessState:  mtfReadinessState ?? null,
    strategyProfile:    activeProfile,
    // mtfSnap/signals/smc/patterns not available at execution time —
    // gates that require them pass conservatively (same as before).
    // Trade Readiness enforces those with full data from the chart engine.
  });
  recordMetric('signal_gates', Date.now() - signalGateStart).catch(() => {});

  if (!signalGateResult.allowed && !bypassGates) {
    const gateType: BlockedGateData['gate'] =
      signalGateResult.blockSource?.startsWith('STRATEGY') ? 'FILTER' : 'REGIME';
    const sgGD: BlockedGateData = {
      gate:    gateType,
      reason:  signalGateResult.reason,
      details: {
        regime:      regimeForRecord,
        signalType:  signalGateResult.signalType,
        blockSource: signalGateResult.blockSource ?? 'REGIME',
        ...(activeStratId ? { strategyId: activeStratId } : {})}};
    logger.info('paperTradingEngine', `Signal gate BLOCKED ${symbol} [${signalGateResult.blockSource}]: ${signalGateResult.reason}`);
    // Fill signalType on the shared shadowSignal object now that we have it.
    shadowSignal.signalType = signalGateResult.signalType;
    recordShadowTrade({ symbol, timeframe, direction, entryPrice: prediction.suggestedEntry,
      stopLoss, takeProfit, blockReason: sgGD.reason, blockGate: gateType,
      signal: shadowSignal, signalId: prediction.signalId, gateDetails: sgGD.details,
      marketContext: marketContext ?? prediction.marketContext ?? null }).catch(() => {});
    notifyShadowEntryRecorded(symbol, sgGD.gate, sgGD.reason).catch(() => {});
    return { opened: false, reason: sgGD.reason, gateData: sgGD, shadowRecorded: true };
  }

  // Single Trade Quality Score implementation, computed once here and
  // persisted on the position — never recomputed later from a stale
  // snapshot, and never a second scoring formula.
  const qualitySnapshot = recentCandles.length ? getIndicatorSnapshot(recentCandles) : null;
  const qualityResult = recentCandles.length ? fromSinglePrediction(prediction, recentCandles, qualitySnapshot, symbol, assetClass, regimeForRecord) : null;

  // FIX: positionValue and entryFee were computed from the original sizing.qty
  // BEFORE portfolioRiskEngine's REDUCE_SIZE block, which may change sizing.qty.
  // Recompute using sizing.positionValue, which REDUCE_SIZE always keeps in sync
  // with sizing.qty. This ensures cash debit, entryFee on the position, and the
  // trade economics display all reflect the actually-executed quantity.
  const finalPositionValue = (sizing as any).positionValue ?? sizing.qty * entryPrice;
  const finalEntryFee      = finalPositionValue * (FEE_PCT / 100);

  // DIAGNOSTICS ONLY - computed and attached for later display in
  // Journal/Replay/Analytics. This does NOT participate in the gate
  // logic above in any way; the trade has already been fully accepted
  // by the time this line runs.
  const tradeEconomics = computeTradeEconomics(entryPrice, sizing.qty, direction, stopLoss, takeProfit, finalEntryFee); // use post-REDUCE_SIZE fee — matches position.entryFee exactly

  const position: PaperPosition = {
    id: `${symbol}_${Date.now()}`,
    symbol, timeframe, assetClass, direction,
    entryTime: Date.now(), entryPrice, qty: sizing.qty,
    stopLoss, takeProfit,
    // signalId links this position back to its MLPrediction and guards against
    // duplicate shadow trades being recorded for the same signal (cross-journal check).
    signalId: prediction.signalId,
    aiConfidence: overallConfidence ?? prediction.confidence, riskScoreAtEntry: prediction.riskScore, tradeQuality: qualityResult?.quality ?? null, modelVersion: prediction.modelVersion, predictionHorizon: 3,
    entryReason: `Ensemble ${prediction.action}, ${(prediction.ensembleProbUp * 100).toFixed(1)}% P(up), confidence ${prediction.confidence.toFixed(0)}/100`,
    // Strategy tag: read at open time from AsyncStorage.
    // Optional — existing positions without it deserialize as undefined (= no strategy).
    strategyId:   await getActiveStrategyId().catch(() => null),
    strategyName: activeStratId ? (getProfile(activeStratId)?.name ?? null) : null,
    strategyIcon: activeStratId ? (getProfile(activeStratId)?.icon ?? null) : null,
    // Signal snapshot — the AI's original verdict at this moment, stored on every trade.
    // overrideUsed=true means the user pressed Override and bypassed a non-READY verdict.
    // overrideUsed=false means the signal passed normally (originalState will be 'READY').
    // Stored on all trades so analytics can compare outcomes across signal states:
    //   READY trades vs overridden WAIT trades vs overridden AVOID trades.
    signalSnapshot: {
      // ── Decision — why did the AI make this decision? ──────────────────────
      originalState:     signalGateResult.state,
      overrideUsed:      bypassGates && signalGateResult.state !== 'READY',
      blockSource:       signalGateResult.blockSource,
      blockReason:       signalGateResult.reason,
      signalType:        signalGateResult.signalType,
      mtfReadinessState: (mtfReadinessState === 'READY' || mtfReadinessState === 'WAIT' || mtfReadinessState === 'AVOID')
        ? mtfReadinessState : null,
      // ── AI Metadata — which model, at what confidence, under what conditions? ──
      confidence:     overallConfidence ?? prediction.confidence,
      ensembleProbUp: prediction.ensembleProbUp,
      modelVersion:   prediction.modelVersion,
      regimeLabel:    regimeForRecord,
      strategyId:     activeStratId ?? null,
      capturedAt:     Date.now()},
    entryFee: finalEntryFee, // FIX: use post-REDUCE_SIZE fee (in sync with stored qty)
    maxUnrealizedProfit: 0, maxUnrealizedDrawdown: 0,
    // FIX: Initialize peak-profit withdrawal tracking fields (Audit item #2 and #3).
    // Both start at 0 — peakProfit grows whenever unrealized exceeds it; maxProfitWithdrawn
    // grows whenever (peakProfit - currentUnrealizedPnL) exceeds the previous max.
    peakProfit: 0, maxProfitWithdrawn: 0,
    tradeEconomics,
    entrySnapshot: { recentCandles: recentCandles.slice(-30), topFeatures: prediction.topFeatures, marketRegime: regimeForRecord, orderBookSnapshot: prediction.orderBookSnapshot, marketContext: marketContext ?? prediction.marketContext ?? null },
    // Fix 2: compute OB freshness directly from the SMC engine on recentCandles.
    // topFeatures only contains the top-N influential features by XAI weight;
    // 'SMC OB freshness' may not appear, silently defaulting to false.
    // Using the engine directly guarantees the real value regardless of ranking.
    // This is O(n) over recentCandles (≤30 bars stored at entry) — negligible.
    mgmt: (() => {
      let obFresh = false;
      if (recentCandles.length >= 10) {
        try {
          const atrArr = atrFn(recentCandles, 14);
          const msStr  = precomputeStructure(recentCandles, atrArr);
          const smcD   = precomputeSMC(recentCandles, atrArr, msStr);
          const lastSMC = smcD.smcScoresArr[recentCandles.length - 1];
          if (lastSMC) {
            obFresh = prediction.action === 'BUY'
              ? lastSMC.obFreshness > 0.5
              : lastSMC.bearOBStrength > 0.2;
          }
        } catch { /* engine error — default to false, trail mode falls back to STRUCTURE */ }
      }
      return initManagementState(
        entryPrice, stopLoss, direction, regimeForRecord, obFresh, DEFAULT_MGMT_CONFIG,
      );
    })()};

  // Cash balance guard: ensure sufficient cash before deducting.
  // calcPositionSize caps notional by remainingSymbolHeadroom, but doesn't
  // know about current cashBalance — a position could theoretically exceed
  // available cash if fees push it over, or after consecutive rapid opens.
  const totalCost = finalPositionValue + finalEntryFee;
  if (portfolio.cashBalance < totalCost) {
    logger.warn('paperTradingEngine', `Insufficient cash: need ${totalCost.toFixed(2)}, have ${portfolio.cashBalance.toFixed(2)} — blocking ${symbol}`);
    const cashGD: BlockedGateData = { gate: 'CASH',
      reason: `Insufficient cash balance (${portfolio.cashBalance.toFixed(2)}) to fund this position (${totalCost.toFixed(2)}).`,
      details: { cashBalance: +portfolio.cashBalance.toFixed(2), required: +totalCost.toFixed(2) } };
    recordShadowTrade({ symbol, timeframe, direction, entryPrice: prediction.suggestedEntry,
      stopLoss, takeProfit, blockReason: cashGD.reason, blockGate: 'CASH',
      signal: shadowSignal, signalId: prediction.signalId, gateDetails: cashGD.details,
      marketContext: marketContext ?? prediction.marketContext ?? null }).catch(() => {});
    notifyShadowEntryRecorded(symbol, 'CASH', cashGD.reason).catch(() => {});
    return { opened: false, reason: cashGD.reason, gateData: cashGD, shadowRecorded: true };
  }

  portfolio.openPositions.push(position);
  // CASH ACCOUNTING FIX: previously SHORT open ADDED positionValue to cash
  // (modeling real short-selling margin mechanics where you receive sale proceeds).
  // This caused cash to increase above starting capital when opening a SHORT,
  // which is wrong for a paper trading simulator where users expect any open
  // position to consume capital, not create it.
  // Now symmetric: both LONG and SHORT debit (positionValue + entryFee) on open.
  portfolio.cashBalance -= totalCost;
  await savePortfolio(portfolio);
  notifyTradeOpened(position).catch(() => {});
  logger.info('paperTradingEngine', `Opened ${direction} ${symbol} qty=${sizing.qty} @ ${entryPrice.toFixed(2)}`);

  // FIX #2 (Page-Hinkley): update feature drift monitor with driftScore from this prediction.
  // driftScore = mean |z-score| of live features vs training distribution (0 = no drift).
  // Non-blocking — feature drift tracking failure is never fatal to a trade open.
  if (prediction.driftScore != null) {
    loadDriftState(symbol, timeframe).then(driftState => {
      const updated = updatePageHinkley(driftState, prediction.driftScore);
      return saveDriftState(symbol, timeframe, updated);
    }).catch((e: any) => {
      logger.warn('paperTradingEngine', `Page-Hinkley update failed for ${symbol}: ${e?.message}`);
    });
  }
  recordMetric('paper_trade', Date.now() - _paperTradeStart).catch(() => {});
  return { opened: true, reason: 'Position opened.', position, shadowRecorded: false };
}

// CloseReason: the engine-level exit reason stored on journal records.
// MANUAL_EXIT is kept as a legacy alias — new code should use MANUAL_CLOSE.
// TIME_EXIT fires when maxBarsHeld (from strategy profile) is reached.
export type CloseReason =
  | 'STOP_LOSS'        // initial stop hit at a loss
  | 'TRAILING_STOP'    // trailing stop hit while in profit
  | 'BREAK_EVEN_STOP'  // break-even stop hit (near-zero P&L)
  | 'TAKE_PROFIT'
  | 'MANUAL_CLOSE'
  | 'MANUAL_EXIT'
  | 'TIME_EXIT'
  | 'AI_EXIT_SIGNAL'
  // FIX (Audit item #1): PARTIAL_CLOSE records the fraction of a position closed
  // via closePositionPartial(). Previously partial closes updated realizedPnL on
  // the portfolio without writing any journal record, causing Portfolio Realized P&L
  // to diverge from the sum seen in Analytics/Trade Review. Now every partial close
  // writes a record with this exitReason so all screens see identical totals.
  | 'PARTIAL_CLOSE';

const closingPositionIds = new Set<string>();

export async function closePosition(positionId: string, exitPrice: number, exitReason: CloseReason, fill?: FillResult): Promise<void> {
  if (closingPositionIds.has(positionId)) {
    logger.info('paperTradingEngine', `closePosition skipped for ${positionId} - already being closed by another caller`);
    return;
  }
  closingPositionIds.add(positionId);
  try {
    await closePositionInner(positionId, exitPrice, exitReason, fill);
  } finally {
    closingPositionIds.delete(positionId);
  }
}

async function closePositionInner(positionId: string, exitPrice: number, exitReason: CloseReason, fill?: FillResult): Promise<void> {
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

  // Margin model cash return:
  //   LONG close:  +exitNotional - closeFees           (received sale proceeds)
  //   SHORT close: +2*entryNotional - exitNotional - closeFees
  //                = margin returned + P&L (entry-exit)*qty - fees
  //   Both keep cash below starting capital until trade closes, and net
  //   cash change over the round-trip equals the true P&L. Verified.
  const entryNotional = position.entryPrice * position.qty;
  portfolio.cashBalance += position.direction === 'LONG'
    ? grossValue - fees
    : 2 * entryNotional - grossValue - fees;
  portfolio.openPositions = portfolio.openPositions.filter(p => p.id !== positionId);
  portfolio.realizedPnL += pnl;
  await savePortfolio(portfolio);

  const pnlPct = calculatePnLPct(pnl, position.entryPrice, position.qty);
  const fillWithSlippage: FillResult | undefined = fill
    ? { ...fill, slippagePaid: Math.abs(effectiveExit - fill.actualFill) }
    : undefined;
  const record = buildTradeRecord(position, Date.now(), effectiveExit, fees, grossValue * (SLIPPAGE_PCT / 100), exitReason, pnl, pnlPct, grossPnl, fillWithSlippage);
  await recordCompletedTrade(record);

  // FIX #2: Wire drift detector — update CUSUM with trade outcome.
  // y_actual: 1 if direction matched pnl sign (model was right), 0 otherwise.
  // y_predicted: ensembleProbUp from the entry prediction (stored on position).
  // Non-blocking: drift state failure is non-fatal to trade close.
  try {
    const wasCorrect: 0 | 1 = (
      (position.direction === 'LONG'  && pnl > 0) ||
      (position.direction === 'SHORT' && pnl < 0)
    ) ? 1 : 0;
    const ensembleProb = position.entrySnapshot?.topFeatures ? 0.5 : 0.5; // fallback
    const aiConf = (position.aiConfidence ?? 50) / 100;  // stored as 0–100
    const driftState = await loadDriftState(position.symbol, position.timeframe);
    const updated = updateCUSUM(driftState, wasCorrect, aiConf);
    await saveDriftState(position.symbol, position.timeframe, updated);
  } catch (e: any) {
    logger.warn('paperTradingEngine', `Drift update failed for ${position.symbol}: ${e?.message}`);
  }

  await addToDailyPnL(pnl);

  // Dispatch the correct notification based on enriched exit reason.
  // TRAILING_STOP and BREAK_EVEN_STOP are profitable/neutral stop exits —
  // they must never show the "Closed at a loss" message.
  switch (exitReason) {
    case 'TAKE_PROFIT':
      notifyTakeProfitHit(position.symbol, pnl).catch(() => {});
      break;
    case 'TRAILING_STOP':
      notifyStopLossHit(position.symbol, pnl).catch(() => {}); // pnl>0 → shows profit message
      break;
    case 'BREAK_EVEN_STOP':
      notifyStopLossHit(position.symbol, pnl).catch(() => {}); // pnl≈0 → shows break-even message
      break;
    case 'STOP_LOSS':
      notifyStopLossHit(position.symbol, pnl).catch(() => {});
      break;
    default:
      // TIME_EXIT, AI_EXIT_SIGNAL, MANUAL_CLOSE, MANUAL_EXIT: general close notification
      notifyTradeClosed(record).catch(() => {});
      break;
  }

  logger.info('paperTradingEngine', `Closed ${position.direction} ${position.symbol} @ ${effectiveExit.toFixed(2)}, pnl=${pnl.toFixed(2)}, reason=${exitReason}`);
}

export async function closePositionPartial(positionId: string, fraction: number, exitPrice: number): Promise<void> {
  if (fraction >= 1) return closePosition(positionId, exitPrice, 'MANUAL_CLOSE');
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

  const entryNotionalPartial = position.entryPrice * closedQty;
  portfolio.cashBalance += position.direction === 'LONG'
    ? grossValue - fees
    : 2 * entryNotionalPartial - grossValue - fees; // margin model, proportional
  portfolio.realizedPnL += pnl;
  position.qty -= closedQty;
  position.entryFee -= attributedEntryFee;
  await savePortfolio(portfolio);
  await addToDailyPnL(pnl);

  // FIX (Audit item #1 — root cause of Portfolio Realized P&L ≠ Trade Review/Analytics sum):
  // Partial closes were updating portfolio.realizedPnL (+= pnl) but NEVER writing a
  // PaperTradeRecord to the journal. This caused:
  //   portfolio.realizedPnL       = sum of ALL closed pnl (full + partial)
  //   sum(trades[].pnl)           = sum of FULL closes ONLY
  // Result: Portfolio screen showed a HIGHER realized P&L than Analytics "best trade" sum
  // and Trade Review totals, because partial-close P&L existed in realizedPnL but not
  // in the journal that Analytics and Trade Review both read.
  //
  // Fix: record a journal entry for every partial close. The record carries:
  //   - grossPnl / pnl / pnlPct for the PARTIAL qty only (not the full original position)
  //   - exitReason: 'PARTIAL_CLOSE' so Analytics/Journal can distinguish partial from full
  //   - maxUnrealizedProfit / peakProfit / maxProfitWithdrawn: snapshotted at partial-close
  //     time (the remaining open portion continues tracking from here)
  //   - qty: the CLOSED fraction's quantity (closedQty), not position.qty (which is post-deduction)
  //
  // IMPORTANT: position.qty has already been decremented above, so we reconstruct closedQty here.
  const closedQtyForRecord = position.qty / (1 - fraction) * fraction; // = original_qty * fraction; position.qty is already reduced
  const grossPnlPartial = calculatePnL({ entryPrice: position.entryPrice, exitPrice: effectiveExit, qty: closedQtyForRecord, direction: position.direction, fees: 0 });
  const pnlPctPartial   = calculatePnLPct(pnl, position.entryPrice, closedQtyForRecord);

  // Build a synthetic PaperPosition snapshot representing the CLOSED portion only.
  // We clone the key identity/metadata fields from the live position, but override
  // qty and entryFee to reflect only the fraction that was just closed.
  const partialSnapshot = {
    ...position,
    id: `${position.id}_partial_${Date.now()}`, // unique id so it appears as a separate journal entry
    qty:      closedQtyForRecord,
    entryFee: attributedEntryFee,
    // Peak metrics up to this moment — the remaining open portion inherits the live position's
    // running values (unchanged above) and continues from here.
    maxUnrealizedProfit:  position.maxUnrealizedProfit,
    maxUnrealizedDrawdown: position.maxUnrealizedDrawdown,
    peakProfit:           position.peakProfit ?? Math.max(0, position.maxUnrealizedProfit),
    maxProfitWithdrawn:   position.maxProfitWithdrawn ?? 0,
  };

  const partialRecord = buildTradeRecord(
    partialSnapshot as any,
    Date.now(), effectiveExit, fees, grossValue * (SLIPPAGE_PCT / 100),
    'PARTIAL_CLOSE', pnl, pnlPctPartial, grossPnlPartial,
  );
  await recordCompletedTrade(partialRecord);

  logger.info('paperTradingEngine', `Partial close ${position.direction} ${position.symbol}: ${(fraction * 100).toFixed(0)}% @ ${effectiveExit.toFixed(2)}, pnl=${pnl.toFixed(2)}, journal entry created (id=${partialRecord.id})`);
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

// Fix 3: Lightweight structural trailing snapshot.
// Derives swing/structure/OB levels from the stored recentCandles (≤30 bars)
// without calling any full engine. O(k) where k = stored candle count ≤ 30.
//
// PROOF OF NO LOOKAHEAD:
//   entrySnapshot.recentCandles was finalized at position-open time (historical).
//   currentPrice is the live tick — only used as a directional reference to
//   select BELOW (for LONG support) or ABOVE (for SHORT resistance).
//   No candle beyond the stored array is referenced.
//
// PROOF OF NO REPAINTING:
//   Swing levels are determined by comparing adjacent candle highs/lows
//   (a bar is a swing low if its low < the lows of the 2 bars on each side).
//   These comparisons are over past candles only. The most recent candle
//   cannot be a confirmed swing (needs at least 1 candle after it to confirm)
//   so we scan only candles[0..n-2].
function buildStructuralTrailingSnap(
  candles:       { high: number; low: number; close: number; open: number; volume: number; time: number }[],
  currentPrice:  number,
  direction:     'LONG' | 'SHORT',
  atrEst:        number,
): {
  swingTrailLevel:     number | null;
  structureTrailLevel: number | null;
  obTrailLevel:        number | null;
} {
  const n = candles.length;
  if (n < 5) return { swingTrailLevel: null, structureTrailLevel: null, obTrailLevel: null };

  // ── Swing level: scan backwards for the nearest confirmed swing ──────────
  // A swing low is confirmed when its low < the lows of both its neighbours.
  // A swing high is confirmed when its high > the highs of both its neighbours.
  // We stop at n-2 to ensure at least one confirming candle exists to the right.
  let swingLevel: number | null = null;
  for (let i = n - 2; i >= 1; i--) {
    if (direction === 'LONG') {
      // Look for a swing low below current price — acts as trailing support
      if (candles[i].low < candles[i - 1].low && candles[i].low < candles[i + 1].low &&
          candles[i].low < currentPrice) {
        swingLevel = candles[i].low;
        break;
      }
    } else {
      // Look for a swing high above current price — acts as trailing resistance
      if (candles[i].high > candles[i - 1].high && candles[i].high > candles[i + 1].high &&
          candles[i].high > currentPrice) {
        swingLevel = candles[i].high;
        break;
      }
    }
  }

  // ── Structure level: use swing level as structural pivot (same concept) ───
  // For the purposes of lightweight trailing, the nearest confirmed swing
  // IS the structural level. Full structure engine computes BOS/CHoCH chains
  // but those require candle history beyond the 30-bar snapshot.
  const structureLevel = swingLevel;

  // ── OB level: approximate using the body of the candle that preceded ──────
  // a significant move. An order block is the last bearish candle before a
  // bullish impulse (for LONG) or the last bullish candle before a bearish
  // impulse (for SHORT). We use a lightweight heuristic: find the candle
  // whose body midpoint is nearest to currentPrice ± 1.5 ATR (the approximate
  // OB zone). This requires no engine and no future data.
  let obLevel: number | null = null;
  const obZone = direction === 'LONG'
    ? currentPrice - 1.5 * atrEst   // expected OB below for LONG
    : currentPrice + 1.5 * atrEst;  // expected OB above for SHORT
  let bestOBDist = Infinity;
  // Scan all candles except the last (current) for an OB candidate
  for (let i = 0; i < n - 1; i++) {
    const mid = (candles[i].open + candles[i].close) / 2;
    const isBullish = candles[i].close > candles[i].open;
    // For LONG trail: look for bearish candle bodies below current price
    // For SHORT trail: look for bullish candle bodies above current price
    const isOBType = direction === 'LONG' ? !isBullish : isBullish;
    if (isOBType) {
      const dist = Math.abs(mid - obZone);
      if (dist < bestOBDist && dist < 2 * atrEst) {
        bestOBDist = dist;
        // Trail at the far edge of the OB body (protective side)
        obLevel = direction === 'LONG'
          ? Math.min(candles[i].open, candles[i].close)  // bottom of bearish body
          : Math.max(candles[i].open, candles[i].close); // top of bullish body
      }
    }
  }

  return { swingTrailLevel: swingLevel, structureTrailLevel: structureLevel, obTrailLevel: obLevel };
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
    const toClose:      { id: string; price: number; reason: CloseReason; fill?: FillResult }[] = [];
    const toPartial:    { id: string; fraction: number; price: number }[] = [];
    // Fix 2: prevent the same positionId from appearing in toClose twice.
    // This can happen when evaluateTradeManagement emits fullClose (regime/time
    // exit) and evaluateIntracandleFill ALSO triggers on the same candle (SL/TP
    // reached simultaneously). Both independently push to toClose; the second
    // call to closePositionInner is always a no-op (position already gone), but
    // the Set eliminates the redundant async call entirely.
    const closedThisPass = new Set<string>();

    portfolio.openPositions.forEach(position => {
      const cur = livePrices[position.symbol];
      // Fix 1: reject any price that would corrupt position metrics.
      // Math.max(prev, NaN) = NaN — once set, stays NaN permanently.
      if (cur == null || !Number.isFinite(cur) || cur <= 0) {
        if (__DEV__ && cur !== undefined) {
          logger.warn('paperTradingEngine', `${position.symbol}: invalid live price (${cur}) — skipped`);
        }
        return;
      }
      const unrealized = calculatePnL({ entryPrice: position.entryPrice, exitPrice: cur, qty: position.qty, direction: position.direction });

      // FIX (Audit items #2, #3, #4): ALL peak/excursion metrics must update on EVERY tick.
      // Previously only maxUnrealizedProfit and maxUnrealizedDrawdown were updated; peakProfit
      // and maxProfitWithdrawn did not exist at all. These are now initialized at open (see
      // attemptOpenPosition above) and updated here on every price update without exception.
      //
      //   maxUnrealizedProfit = MFE = highest favorable unrealized P&L ever seen (>= 0 clamp)
      //   maxUnrealizedDrawdown = MAE = most adverse unrealized P&L ever seen (<= 0)
      //   peakProfit           = max(peakProfit, unrealized) — tracks the running peak
      //                          (same as maxUnrealizedProfit when positive, but continues
      //                           tracking even if unrealized dips into negative territory
      //                           then bounces — maxUnrealizedProfit would have already
      //                           clamped at the prior peak in that scenario)
      //   maxProfitWithdrawn   = max(maxProfitWithdrawn, peakProfit - unrealized)
      //                          — the largest "profit given back" from peak ever seen
      //
      // Formula (per-tick, must NEVER be skipped):
      //   peak = max(peak, currentUnrealizedPnL)
      //   profitWithdrawn = peak - currentUnrealizedPnL
      //   maxProfitWithdrawn = max(maxProfitWithdrawn, profitWithdrawn)

      position.maxUnrealizedProfit  = Math.max(position.maxUnrealizedProfit,  unrealized);
      position.maxUnrealizedDrawdown = Math.min(position.maxUnrealizedDrawdown, unrealized);

      // peakProfit and maxProfitWithdrawn — always present after v6.9.3 (initialized to 0 at open).
      // Guard with ?? 0 for backward-compat with any serialized position that predates these fields.
      const prevPeak           = position.peakProfit         ?? 0;
      const prevMaxWithdrawn   = position.maxProfitWithdrawn ?? 0;
      const newPeak            = Math.max(prevPeak, unrealized);
      const profitWithdrawn    = Math.max(0, newPeak - unrealized); // never negative
      position.peakProfit         = newPeak;
      position.maxProfitWithdrawn = Math.max(prevMaxWithdrawn, profitWithdrawn);

      // Trade management: break-even, trailing, partial TP, time/regime exit
      if (position.mgmt) {
        const ec  = position.entrySnapshot.recentCandles;
        const lc  = ec[ec.length - 1];
        // FIX: single-candle ATR estimate was wildly wrong for tight-range candles
        // (e.g. 9:15 AM open with 0.20-wide candle → atrEst=0.30 → trail stop placed
        // 0.30 away from current price → triggered on next tick).
        // Use rolling average of last 10 candles' true range for a stable estimate,
        // with a floor of initialRisk * 0.5 so the trail is never closer than
        // half the original risk distance.
        const atrWindow = ec.slice(-10);
        const rawAtr = atrWindow.length > 0
          ? atrWindow.reduce((sum, c) => sum + Math.abs(c.high - c.low), 0) / atrWindow.length
          : (lc ? Math.abs(lc.high - lc.low) : 1);
        const initialRiskFloor = (position.mgmt.initialRisk ?? 0) * 0.5;
        const atrEst = Math.max(rawAtr * 1.5, initialRiskFloor);
        // Fix 3: build real structural levels from stored recentCandles.
        // O(k) where k ≤ 30 — no full engine recompute.
        const structSnap = buildStructuralTrailingSnap(ec, cur, position.direction, atrEst);
        const snap = {
          currentPrice: cur, atr: atrEst,
          swingTrailLevel:     structSnap.swingTrailLevel,
          obTrailLevel:        structSnap.obTrailLevel,
          structureTrailLevel: structSnap.structureTrailLevel,
          regimeLabel: position.mgmt.entryRegime,
          regimeBull: 0, regimeBear: 0, regimeVol: 0, mtfOverall: 0,
          barIndex: position.mgmt.barsHeld};
        const dec = evaluateTradeManagement(
          position.direction, position.entryPrice, position.stopLoss,
          position.mgmt, snap, DEFAULT_MGMT_CONFIG,
        );
        Object.assign(position.mgmt, dec.mgmtUpdate);
        if (dec.newStop !== null) position.stopLoss = dec.newStop;
        if (dec.partialClose) toPartial.push({ id: position.id, fraction: dec.partialClose.fraction, price: cur });
        if (dec.fullClose && !closedThisPass.has(position.id)) {
          // Use the reason from tradeManager (TIME_EXIT, regime exit, etc.) if provided
          const mgmtReason = (dec.fullClose as any).reason as import('./paperTradingEngine').CloseReason | undefined;
          toClose.push({ id: position.id, price: cur, reason: mgmtReason ?? 'MANUAL_CLOSE' });
          closedThisPass.add(position.id);
        }
      }

      // Intracandle execution via executionEngine. Live ticks deliver a
      // single price, so we synthesise a 1-tick candle (all OHLC = cur).
      // Backtest callers pass real OHLC directly to evaluateIntracandleFill
      // and then call closePosition(id, fill.actualFill, reason, fill).
      const tickCandle = { open: cur, high: cur, low: cur, close: cur };
      const fill = evaluateIntracandleFill(
        position.direction, position.stopLoss, position.takeProfit,
        tickCandle, position.mgmt?.barsHeld ?? 0, DEFAULT_EXECUTION_CONFIG,
      );
      if (fill.triggered && !closedThisPass.has(position.id)) {
        // Determine the precise stop exit reason from stopHistory.
        // The last stopHistory entry tells us why the stop was where it was:
        //   'initial'     → original stop, never moved → pure STOP_LOSS
        //   'break_even'  → stop moved to entry price → BREAK_EVEN_STOP
        //   'trail_*'     → stop trailed above entry → TRAILING_STOP
        // For TP hits, always use TAKE_PROFIT regardless.
        let reason: CloseReason;
        if (fill.fillType === 'TP') {
          reason = 'TAKE_PROFIT';
        } else {
          const lastStopMove = position.mgmt?.stopHistory?.at(-1)?.reason ?? 'initial';
          if (lastStopMove === 'break_even') {
            reason = 'BREAK_EVEN_STOP';
          } else if (lastStopMove.startsWith('trail_')) {
            reason = 'TRAILING_STOP';
          } else {
            reason = 'STOP_LOSS';
          }
        }
        toClose.push({ id: position.id, price: fill.actualFill, reason, fill });
        closedThisPass.add(position.id);
      }
    });

    await savePortfolio(portfolio); // persist tracking-field updates before any close processes (see prior fix)

    for (const p of toPartial) {
      await closePositionPartial(p.id, p.fraction, p.price);
    }
    for (const c of toClose) {
      await closePosition(c.id, c.price, c.reason, c.fill);
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
