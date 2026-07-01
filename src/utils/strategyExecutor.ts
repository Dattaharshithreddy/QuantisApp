import { Candle } from './indicators';
import { calculatePnLWithMultiplier, calculatePnLPct, directionMultiplier } from './pnlCalculator';

// Generic, reusable trade-execution core. Both the AI ensemble strategy AND
// every baseline strategy run through this EXACT same function — same fee
// handling, same slippage, same SL/TP/timeout logic, same position sizing.
// This is what makes "does the AI actually beat Buy & Hold / EMA crossover /
// etc." a fair comparison: any performance difference comes from the
// quality of the entry/exit SIGNAL, never from one strategy getting
// favorable execution treatment the others didn't.

export type ExecConfig = {
  startingCapital: number;
  feePct: number;
  slippagePct: number;
  riskPerTradePct: number;
  atrStopMultiplier: number;
  atrTargetMultiplier: number;
  maxHoldingBars: number;
};

export type ExitReason = 'TAKE_PROFIT' | 'STOP_LOSS' | 'TIMEOUT' | 'END_OF_DATA';

export type ExecTrade = {
  entryTime: number; entryPrice: number;
  exitTime: number; exitPrice: number;
  stopLoss: number; takeProfit: number;
  qty: number; pnl: number; pnlPct: number;
  holdingBars: number; holdingMs: number;
  entryReason: string; exitReason: ExitReason;
  direction?: 'LONG' | 'SHORT'; // optional: omitted by existing long-only callers (baselines, sensitivity, threshold/horizon evaluation, model comparison), populated by the short-aware path
};

export type EquityPoint = { time: number; equity: number };

export type ExecResult = { trades: ExecTrade[]; equityCurve: EquityPoint[] };

// `getSignal(idx)` returns true if the strategy wants to enter a LONG at
// this bar's close. `getATR(idx)` supplies the ATR value used for SL/TP —
// callers pass in a precomputed, causal ATR series so every strategy uses
// the same real volatility measure for risk sizing (not a fixed % each, to
// keep it realistic and consistent across strategies).
export function simulateSignalStrategy(
  candles: Candle[],
  walkIndices: number[],
  getSignal: (idx: number) => { enter: boolean; direction?: 'LONG' | 'SHORT'; reason: string },
  getATR: (idx: number) => number,
  config: ExecConfig
): ExecResult {
  const trades: ExecTrade[] = [];
  const equityCurve: EquityPoint[] = [];
  let equity = config.startingCapital;
  let inPosition = false;
  let entryIdx = -1, entryPrice = 0, stopLoss = 0, takeProfit = 0, qty = 0, entryFeeAmt = 0, entryReason = '';
  let direction: 'LONG' | 'SHORT' = 'LONG';

  for (let k = 0; k < walkIndices.length; k++) {
    const idx = walkIndices[k];
    const bar = candles[idx];

    if (inPosition) {
      // Mirrored exactly like paperTradingEngine.ts's monitorOpenPositions:
      // LONG's stop sits below entry (hit on the way down), SHORT's stop
      // sits above entry (hit on the way up) - and the reverse for target.
      const hitStop = direction === 'LONG' ? bar.low <= stopLoss : bar.high >= stopLoss;
      const hitTarget = direction === 'LONG' ? bar.high >= takeProfit : bar.low <= takeProfit;
      const barsHeld = idx - entryIdx;
      const timedOut = barsHeld >= config.maxHoldingBars;

      let exitPrice: number | null = null, exitReason: ExitReason | null = null;
      if (hitStop) { exitPrice = direction === 'LONG' ? stopLoss * (1 - config.slippagePct / 100) : stopLoss * (1 + config.slippagePct / 100); exitReason = 'STOP_LOSS'; }
      else if (hitTarget) { exitPrice = direction === 'LONG' ? takeProfit * (1 - config.slippagePct / 100) : takeProfit * (1 + config.slippagePct / 100); exitReason = 'TAKE_PROFIT'; }
      else if (timedOut) { exitPrice = bar.close; exitReason = 'TIMEOUT'; }
      else if (k === walkIndices.length - 1) { exitPrice = bar.close; exitReason = 'END_OF_DATA'; }

      if (exitPrice != null && exitReason) {
        const exitFeeAmt = exitPrice * qty * (config.feePct / 100);
        const pnl = calculatePnLWithMultiplier(entryPrice, exitPrice, qty, directionMultiplier(direction), entryFeeAmt + exitFeeAmt);
        const pnlPct = calculatePnLPct(pnl, entryPrice, qty);
        equity += pnl;
        trades.push({
          entryTime: candles[entryIdx].time, entryPrice, exitTime: bar.time, exitPrice,
          stopLoss, takeProfit, qty, pnl, pnlPct,
          holdingBars: barsHeld, holdingMs: bar.time - candles[entryIdx].time,
          entryReason, exitReason, direction,
        });
        inPosition = false;
      } else {
        const markedPnl = calculatePnLWithMultiplier(entryPrice, bar.close, qty, directionMultiplier(direction));
        equityCurve.push({ time: bar.time, equity: equity + markedPnl });
        continue;
      }
    }

    if (!inPosition) {
      const sig = getSignal(idx);
      if (sig.enter) {
        const atrAtBar = getATR(idx);
        if (atrAtBar > 0) {
          direction = sig.direction ?? 'LONG'; // omitted by existing callers - defaults to exactly their current behavior
          const rawEntry = bar.close;
          entryPrice = direction === 'LONG' ? rawEntry * (1 + config.slippagePct / 100) : rawEntry * (1 - config.slippagePct / 100);
          stopLoss = direction === 'LONG' ? rawEntry - config.atrStopMultiplier * atrAtBar : rawEntry + config.atrStopMultiplier * atrAtBar;
          takeProfit = direction === 'LONG' ? rawEntry + config.atrTargetMultiplier * atrAtBar : rawEntry - config.atrTargetMultiplier * atrAtBar;
          const riskAmount = equity * (config.riskPerTradePct / 100);
          const perUnitRisk = Math.abs(entryPrice - stopLoss);
          qty = perUnitRisk > 0 ? riskAmount / perUnitRisk : 0;
          entryFeeAmt = entryPrice * qty * (config.feePct / 100);
          entryIdx = idx;
          entryReason = sig.reason;
          inPosition = qty > 0;
        }
      }
    }
    equityCurve.push({ time: bar.time, equity });
  }

  return { trades, equityCurve };
}

// ─────────────────────────────────────────────────
// DIAGNOSTIC-AWARE EXECUTION — for the AI ensemble specifically
// ─────────────────────────────────────────────────
// A separate function from simulateSignalStrategy above (not because it's
// untouched — both now support SHORT via the same direction-mirrored SL/TP
// and the same centralized P&L calculator — but because this one ALSO
// tracks a full per-bar decision stream, which the 5 other long-only
// callers of simulateSignalStrategy (baselines, sensitivity analysis,
// threshold/horizon evaluation, model comparison) have no use for and were
// deliberately left unaffected by getting an optional, defaulted field
// rather than a new required parameter). This function uses the SAME
// trade math (entry/exit/fees/slippage/sizing/direction — shared, not
// reimplemented differently) but tracks a full per-bar decision stream:
// every single walked bar gets a record of what the signal wanted to do and,
// if no trade was taken, exactly why not. This is what makes "why was this
// BUY/SELL skipped" and "signal distribution" answerable at all — that
// information didn't exist anywhere before, only executed trades did.

export type SkipReason =
  | 'BELOW_THRESHOLD'            // probability didn't cross the bullish or bearish threshold
  | 'MODEL_DISAGREEMENT'         // crossed threshold but the NN and LR pointed different ways
  | 'EXISTING_POSITION'          // a valid signal fired, but a trade was already open
  | 'INVALID_ATR'                // ATR was zero/unavailable, couldn't size stop-loss/take-profit
  | 'ZERO_POSITION_SIZE'         // position sizing computed to zero units
  | 'EXTREME_VOLATILITY_FILTER'  // blocked by the volatility-regime safety filter
  | 'CONSECUTIVE_LOSS_BREAKER';  // blocked by the consecutive-loss circuit breaker

export type BarDecision = {
  time: number;
  action: 'BUY' | 'SELL' | 'HOLD'; // BUY = bullish lean crossed threshold, SELL = bearish lean crossed threshold, HOLD = neither
  confidence: number;
  executed: boolean;
  skipReason?: SkipReason;
};

export type AISignalInfo = { ensembleProb: number; mlpProb: number; lrProb: number; agree: boolean; confidence: number };

export type DiagnosticExecConfig = ExecConfig & {
  useVolatilityFilter?: boolean;   // NEW real filter — skip entries while volatility regime is EXTREME
  maxConsecutiveLosses?: number;   // NEW real filter — stop opening new trades after N losses in a row (0/undefined = disabled)
};

export type DiagnosticExecResult = {
  trades: (ExecTrade & { entryConfidence: number; exitConfidence: number })[];
  equityCurve: EquityPoint[];
  barDecisions: BarDecision[];
};

export function simulateAIStrategyWithDiagnostics(
  candles: Candle[],
  walkIndices: number[],
  getSignal: (idx: number) => AISignalInfo,
  getATR: (idx: number) => number,
  getVolatilityExtreme: ((idx: number) => boolean) | null,
  config: DiagnosticExecConfig,
  buyThreshold: number
): DiagnosticExecResult {
  const trades: DiagnosticExecResult['trades'] = [];
  const equityCurve: EquityPoint[] = [];
  const barDecisions: BarDecision[] = [];
  let equity = config.startingCapital;
  let inPosition = false;
  let entryIdx = -1, entryPrice = 0, stopLoss = 0, takeProfit = 0, qty = 0, entryFeeAmt = 0, entryConfidence = 0;
  let direction: 'LONG' | 'SHORT' = 'LONG';
  let consecutiveLosses = 0;

  for (let k = 0; k < walkIndices.length; k++) {
    const idx = walkIndices[k];
    const bar = candles[idx];
    const sig = getSignal(idx);
    const action: BarDecision['action'] = sig.ensembleProb > buyThreshold ? 'BUY' : sig.ensembleProb < (1 - buyThreshold) ? 'SELL' : 'HOLD';

    if (inPosition) {
      const hitStop = direction === 'LONG' ? bar.low <= stopLoss : bar.high >= stopLoss;
      const hitTarget = direction === 'LONG' ? bar.high >= takeProfit : bar.low <= takeProfit;
      const barsHeld = idx - entryIdx;
      const timedOut = barsHeld >= config.maxHoldingBars;

      let exitPrice: number | null = null, exitReason: ExitReason | null = null;
      if (hitStop) { exitPrice = direction === 'LONG' ? stopLoss * (1 - config.slippagePct / 100) : stopLoss * (1 + config.slippagePct / 100); exitReason = 'STOP_LOSS'; }
      else if (hitTarget) { exitPrice = direction === 'LONG' ? takeProfit * (1 - config.slippagePct / 100) : takeProfit * (1 + config.slippagePct / 100); exitReason = 'TAKE_PROFIT'; }
      else if (timedOut) { exitPrice = bar.close; exitReason = 'TIMEOUT'; }
      else if (k === walkIndices.length - 1) { exitPrice = bar.close; exitReason = 'END_OF_DATA'; }

      if (exitPrice != null && exitReason) {
        const exitFeeAmt = exitPrice * qty * (config.feePct / 100);
        const pnl = calculatePnLWithMultiplier(entryPrice, exitPrice, qty, directionMultiplier(direction), entryFeeAmt + exitFeeAmt);
        const pnlPct = calculatePnLPct(pnl, entryPrice, qty);
        equity += pnl;
        consecutiveLosses = pnl <= 0 ? consecutiveLosses + 1 : 0;
        trades.push({
          entryTime: candles[entryIdx].time, entryPrice, exitTime: bar.time, exitPrice,
          stopLoss, takeProfit, qty, pnl, pnlPct,
          holdingBars: barsHeld, holdingMs: bar.time - candles[entryIdx].time,
          entryReason: `Ensemble P(up)=${(entryConfidence).toFixed(1)}% confidence`, exitReason,
          entryConfidence, exitConfidence: sig.confidence, direction,
        });
        inPosition = false;
        barDecisions.push({ time: bar.time, action, confidence: sig.confidence, executed: true });
        equityCurve.push({ time: bar.time, equity });
        continue;
      } else {
        barDecisions.push({ time: bar.time, action, confidence: sig.confidence, executed: false, skipReason: 'EXISTING_POSITION' });
        const markedPnl = calculatePnLWithMultiplier(entryPrice, bar.close, qty, directionMultiplier(direction));
        equityCurve.push({ time: bar.time, equity: equity + markedPnl });
        continue;
      }
    }

    // Not in a position — decide whether to open one, and if not, exactly why not.
    let skipReason: SkipReason | undefined;
    let executed = false;

    if (action === 'HOLD') {
      skipReason = 'BELOW_THRESHOLD';
    } else if (!sig.agree) {
      skipReason = 'MODEL_DISAGREEMENT';
    } else if (config.maxConsecutiveLosses && consecutiveLosses >= config.maxConsecutiveLosses) {
      skipReason = 'CONSECUTIVE_LOSS_BREAKER';
    } else if (config.useVolatilityFilter && getVolatilityExtreme?.(idx)) {
      skipReason = 'EXTREME_VOLATILITY_FILTER';
    } else {
      const atrAtBar = getATR(idx);
      if (!(atrAtBar > 0)) {
        skipReason = 'INVALID_ATR';
      } else {
        const candidateDirection: 'LONG' | 'SHORT' = action === 'BUY' ? 'LONG' : 'SHORT';
        const rawEntry = bar.close;
        const candidateEntryPrice = candidateDirection === 'LONG' ? rawEntry * (1 + config.slippagePct / 100) : rawEntry * (1 - config.slippagePct / 100);
        const candidateStop = candidateDirection === 'LONG' ? rawEntry - config.atrStopMultiplier * atrAtBar : rawEntry + config.atrStopMultiplier * atrAtBar;
        const riskAmount = equity * (config.riskPerTradePct / 100);
        const perUnitRisk = Math.abs(candidateEntryPrice - candidateStop);
        const candidateQty = perUnitRisk > 0 ? riskAmount / perUnitRisk : 0;
        if (candidateQty <= 0) {
          skipReason = 'ZERO_POSITION_SIZE';
        } else {
          direction = candidateDirection;
          entryPrice = candidateEntryPrice; stopLoss = candidateStop;
          takeProfit = candidateDirection === 'LONG' ? rawEntry + config.atrTargetMultiplier * atrAtBar : rawEntry - config.atrTargetMultiplier * atrAtBar;
          qty = candidateQty;
          entryFeeAmt = entryPrice * qty * (config.feePct / 100);
          entryIdx = idx; entryConfidence = sig.confidence;
          inPosition = true; executed = true;
        }
      }
    }

    barDecisions.push({ time: bar.time, action, confidence: sig.confidence, executed, skipReason: executed ? undefined : skipReason });
    equityCurve.push({ time: bar.time, equity });
  }

  return { trades, equityCurve, barDecisions };
}
