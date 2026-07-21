import { Candle } from './indicators';
import { detectSwings, classifyStructure, classicPivots, fibonacciLevels } from './marketStructure';
import { detectPatterns, PatternMatch } from './candlePatterns';

// A UI-facing snapshot of CURRENT market structure — separate from the ML
// training pipeline deliberately. Swing-high/low classification needs bars
// AFTER a point to confirm it, which is fine for describing the market RIGHT
// NOW (this function), but would leak future information if used to label
// historical bars during training (which is why it's excluded from
// mlSignal.ts's per-bar feature vector — see the comment there).
export type MarketStructureSnapshot = {
  patterns: PatternMatch[];
  structureHighs: 'HH' | 'LH' | 'NONE';
  structureLows: 'HL' | 'LL' | 'NONE';
  pivots: ReturnType<typeof classicPivots> | null;
  fib: ReturnType<typeof fibonacciLevels> | null;
  lastSwingHigh: number | null;
  lastSwingLow: number | null;
};

export function getMarketStructureSnapshot(candles: Candle[]): MarketStructureSnapshot | null {
  if (candles.length < 30) return null;

  const patterns = detectPatterns(candles);
  const swings = detectSwings(candles, 3);
  const structure = classifyStructure(swings);

  const highs = swings.filter(s => s.type === 'high');
  const lows = swings.filter(s => s.type === 'low');
  const lastSwingHigh = highs.length ? highs[highs.length - 1].price : null;
  const lastSwingLow = lows.length ? lows[lows.length - 1].price : null;

  // Pivots from the most recent complete 20-bar window (same rolling
  // approximation used in the ML feature, kept consistent for the UI)
  const window = candles.slice(-20);
  const pivots = window.length === 20
    ? classicPivots(Math.max(...window.map(c => c.high)), Math.min(...window.map(c => c.low)), window[window.length - 1].close)
    : null;

  const fib = (lastSwingHigh != null && lastSwingLow != null && lastSwingHigh > lastSwingLow)
    ? fibonacciLevels(lastSwingHigh, lastSwingLow) : null;

  return {
    patterns,
    structureHighs: structure.highs === 'HH' ? 'HH' : structure.highs === 'LH' ? 'LH' : 'NONE',
    structureLows: structure.lows === 'HL' ? 'HL' : structure.lows === 'LL' ? 'LL' : 'NONE',
    pivots, fib, lastSwingHigh, lastSwingLow,
  };
}
