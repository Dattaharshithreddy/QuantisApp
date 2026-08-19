import { Candle } from './indicators';

export type SwingPoint = { index: number; price: number; type: 'high' | 'low' };

// Fractal-style swing detection: a bar is a swing high if it's the highest
// of the `lookback` bars on each side; swing low is the mirror.
export function detectSwings(c: Candle[], lookback = 3): SwingPoint[] {
  const swings: SwingPoint[] = [];
  for (let i = lookback; i < c.length - lookback; i++) {
    const window = c.slice(i - lookback, i + lookback + 1);
    if (c[i].high === Math.max(...window.map(x => x.high))) swings.push({ index: i, price: c[i].high, type: 'high' });
    else if (c[i].low === Math.min(...window.map(x => x.low))) swings.push({ index: i, price: c[i].low, type: 'low' });
  }
  return swings;
}

export type StructureSignal = 'HH' | 'HL' | 'LH' | 'LL' | 'NONE';

// Classic price-structure sequencing: compares the latest two swing highs
// and the latest two swing lows to classify Higher-High/Higher-Low (uptrend
// structure) vs Lower-High/Lower-Low (downtrend structure).
export function classifyStructure(swings: SwingPoint[]): { highs: StructureSignal; lows: StructureSignal } {
  const highs = swings.filter(s => s.type === 'high');
  const lows = swings.filter(s => s.type === 'low');
  const highSig: StructureSignal = highs.length >= 2 ? (highs[highs.length - 1].price > highs[highs.length - 2].price ? 'HH' : 'LH') : 'NONE';
  const lowSig: StructureSignal = lows.length >= 2 ? (lows[lows.length - 1].price > lows[lows.length - 2].price ? 'HL' : 'LL') : 'NONE';
  return { highs: highSig, lows: lowSig };
}

export type BOSEvent = { index: number; type: 'BOS_BULL' | 'BOS_BEAR' | 'CHOCH_BULL' | 'CHOCH_BEAR' };

// Break of Structure (price breaks beyond the most recent swing in the
// direction of the prevailing trend — trend continuation) vs Change of
// Character (price breaks the most recent swing AGAINST the prevailing
// trend — first warning sign of a potential reversal). This is a simplified,
// rule-based heuristic version of the smart-money-concepts definitions, not
// a institutional order-flow-validated implementation.
export function detectBOSCHoCH(c: Candle[], swings: SwingPoint[]): BOSEvent[] {
  const events: BOSEvent[] = [];
  const highs = swings.filter(s => s.type === 'high');
  const lows = swings.filter(s => s.type === 'low');
  if (highs.length < 2 || lows.length < 2) return events;

  const trendUp = highs[highs.length - 1].price > highs[highs.length - 2].price &&
                   lows[lows.length - 1].price > lows[lows.length - 2].price;
  const lastHigh = highs[highs.length - 1];
  const lastLow = lows[lows.length - 1];

  for (let i = Math.max(lastHigh.index, lastLow.index) + 1; i < c.length; i++) {
    if (c[i].close > lastHigh.price) events.push({ index: i, type: trendUp ? 'BOS_BULL' : 'CHOCH_BULL' });
    if (c[i].close < lastLow.price) events.push({ index: i, type: !trendUp ? 'BOS_BEAR' : 'CHOCH_BEAR' });
  }
  return events;
}

export type TrendDirection = 'UPTREND' | 'DOWNTREND' | 'RANGING';

export function detectTrendDirection(c: Candle[], emaShort: (number | null)[], emaLong: (number | null)[]): TrendDirection {
  const i = c.length - 1;
  if (emaShort[i] == null || emaLong[i] == null) return 'RANGING';
  const diff = (emaShort[i]! - emaLong[i]!) / emaLong[i]!;
  if (diff > 0.003) return 'UPTREND';
  if (diff < -0.003) return 'DOWNTREND';
  return 'RANGING';
}

export type VolatilityRegime = 'LOW' | 'NORMAL' | 'HIGH' | 'EXTREME';

export function detectVolatilityRegime(historicalVol: number, lookbackAvg: number): VolatilityRegime {
  if (lookbackAvg === 0) return 'NORMAL';
  const ratio = historicalVol / lookbackAvg;
  if (ratio < 0.6) return 'LOW';
  if (ratio < 1.4) return 'NORMAL';
  if (ratio < 2.2) return 'HIGH';
  return 'EXTREME';
}

// Classic floor-trader pivot points from the prior period's H/L/C
export function classicPivots(prevHigh: number, prevLow: number, prevClose: number) {
  const pp = (prevHigh + prevLow + prevClose) / 3;
  const r1 = 2 * pp - prevLow, s1 = 2 * pp - prevHigh;
  const r2 = pp + (prevHigh - prevLow), s2 = pp - (prevHigh - prevLow);
  const r3 = prevHigh + 2 * (pp - prevLow), s3 = prevLow - 2 * (prevHigh - pp);
  return { pp, r1, r2, r3, s1, s2, s3 };
}

// Fibonacci retracement levels between a swing high and swing low
export function fibonacciLevels(swingHigh: number, swingLow: number) {
  const range = swingHigh - swingLow;
  return {
    level0: swingHigh, level236: swingHigh - range * 0.236, level382: swingHigh - range * 0.382,
    level500: swingHigh - range * 0.5, level618: swingHigh - range * 0.618, level786: swingHigh - range * 0.786,
    level100: swingLow};
}

// Session/period high-low aggregation — given intraday candles and a bucket
// size in milliseconds (e.g. one trading day), returns the high/low per bucket.
export function periodHighLow(c: Candle[], bucketMs: number) {
  const buckets = new Map<number, { high: number; low: number }>();
  c.forEach(x => {
    const key = Math.floor(x.time / bucketMs);
    const existing = buckets.get(key);
    if (!existing) buckets.set(key, { high: x.high, low: x.low });
    else { existing.high = Math.max(existing.high, x.high); existing.low = Math.min(existing.low, x.low); }
  });
  return Array.from(buckets.entries()).map(([key, v]) => ({ bucketStart: key * bucketMs, ...v }));
}
