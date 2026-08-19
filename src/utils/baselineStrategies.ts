import { Candle, calcRSI } from './indicators';
import { ema, sma, macd } from './technicalIndicators';
import { simulateSignalStrategy, ExecConfig, ExecTrade, EquityPoint } from './strategyExecutor';
import { createRNG } from './seededRandom';
import { calculatePnLWithMultiplier, calculatePnLPct } from './pnlCalculator';

// Six standard baselines, every one of them run through the EXACT SAME
// execution core (simulateSignalStrategy) as the AI ensemble — same fees,
// same slippage, same ATR-based SL/TP, same position sizing. Any performance
// difference vs. the AI comes purely from signal quality, not favorable
// treatment. This is what makes "does the AI actually beat simple baselines"
// a meaningful question rather than a foregone conclusion either way.

export type BaselineName = 'BUY_HOLD' | 'EMA_CROSSOVER' | 'SMA_CROSSOVER' | 'RSI_STRATEGY' | 'MACD_STRATEGY' | 'RANDOM_ENTRY';

export type BaselineResult = { name: BaselineName; trades: ExecTrade[]; equityCurve: EquityPoint[] };

function crossedUp(prev: number | null, cur: number | null, prevRef: number | null, curRef: number | null): boolean {
  if (prev == null || cur == null || prevRef == null || curRef == null) return false;
  return prev <= prevRef && cur > curRef;
}

export function runBaseline(name: BaselineName, candles: Candle[], walkIndices: number[], atrArr: (number | null)[], config: ExecConfig): BaselineResult {
  if (name === 'BUY_HOLD') {
    // Buy & Hold is structurally different from the others — no stop-loss,
    // no take-profit, no re-entry: just buy once at the start of the walk
    // window and hold to the end. Giving it ATR-based SL/TP would defeat the
    // entire point of "hold regardless of drawdown", so it bypasses the
    // shared executor and is computed directly here instead.
    const first = candles[walkIndices[0]], last = candles[walkIndices[walkIndices.length - 1]];
    const entryPrice = first.close * (1 + config.slippagePct / 100);
    const exitPrice = last.close * (1 - config.slippagePct / 100);
    const qty = config.startingCapital / entryPrice;
    const entryFee = entryPrice * qty * (config.feePct / 100);
    const exitFee = exitPrice * qty * (config.feePct / 100);
    const pnl = calculatePnLWithMultiplier(entryPrice, exitPrice, qty, 1, entryFee + exitFee);
    const trade: ExecTrade = {
      entryTime: first.time, entryPrice, exitTime: last.time, exitPrice,
      stopLoss: 0, takeProfit: 0, qty, pnl, pnlPct: calculatePnLPct(pnl, entryPrice, qty),
      holdingBars: walkIndices.length - 1, holdingMs: last.time - first.time,
      entryReason: 'Buy & Hold — single entry at window start', exitReason: 'END_OF_DATA'};
    const equityCurve: EquityPoint[] = walkIndices.map(idx => ({
      time: candles[idx].time,
      equity: config.startingCapital + (candles[idx].close - first.close) * qty}));
    return { name, trades: [trade], equityCurve };
  }

  let getSignal: (idx: number) => { enter: boolean; reason: string };

  if (name === 'EMA_CROSSOVER') {
    const cl = candles.map(c => c.close);
    const fast = ema(cl, 9), slow = ema(cl, 21);
    getSignal = (idx) => ({ enter: crossedUp(fast[idx - 1], fast[idx], slow[idx - 1], slow[idx]), reason: 'EMA9 crossed above EMA21' });
  } else if (name === 'SMA_CROSSOVER') {
    const cl = candles.map(c => c.close);
    const fast = sma(cl, 10), slow = sma(cl, 30);
    getSignal = (idx) => ({ enter: crossedUp(fast[idx - 1], fast[idx], slow[idx - 1], slow[idx]), reason: 'SMA10 crossed above SMA30' });
  } else if (name === 'RSI_STRATEGY') {
    const rsiArr = candles.map((_, i) => i < 15 ? null : calcRSI(candles.slice(0, i + 1)));
    getSignal = (idx) => ({ enter: crossedUp(rsiArr[idx - 1], rsiArr[idx], 30, 30), reason: 'RSI crossed up through 30 (oversold bounce)' });
  } else if (name === 'MACD_STRATEGY') {
    const macdRes = macd(candles);
    getSignal = (idx) => ({
      enter: crossedUp(macdRes.macdLine[idx - 1], macdRes.macdLine[idx], macdRes.signal[idx - 1], macdRes.signal[idx]),
      reason: 'MACD line crossed above signal line'});
  } else {
    // RANDOM_ENTRY — the null-hypothesis baseline. Seeded for reproducibility.
    // Probability calibrated so its trade frequency is roughly comparable to
    // a typical active strategy on this data, rather than firing on every
    // single bar (which wouldn't be a meaningful comparison).
    const rng = createRNG(7);
    getSignal = () => ({ enter: rng() < 0.03, reason: 'Random entry (seeded, ~3% chance per bar)' });
  }

  const { trades, equityCurve } = simulateSignalStrategy(
    candles, walkIndices,
    (idx) => getSignal(idx),
    (idx) => atrArr[idx] ?? 0,
    config
  );
  return { name, trades, equityCurve };
}

export const ALL_BASELINES: BaselineName[] = ['BUY_HOLD', 'EMA_CROSSOVER', 'SMA_CROSSOVER', 'RSI_STRATEGY', 'MACD_STRATEGY', 'RANDOM_ENTRY'];
export const BASELINE_LABELS: Record<BaselineName, string> = {
  BUY_HOLD: 'Buy & Hold', EMA_CROSSOVER: 'EMA Crossover', SMA_CROSSOVER: 'SMA Crossover',
  RSI_STRATEGY: 'RSI Strategy', MACD_STRATEGY: 'MACD Strategy', RANDOM_ENTRY: 'Random Entry',
};
