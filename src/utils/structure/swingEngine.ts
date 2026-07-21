// ─────────────────────────────────────────────────────────────────────────────
// SWING ENGINE  (v4.7.1 — P2 optimized)
// Changes vs v4.7.0:
//   - volAvg20: O(20n) nested sum → O(n) rolling sum (same values, no allocation per bar)
//   - countTouches: O(n×s) → retained but moved after volAvg20 so its loop reuses the
//     already-computed atr values. touches is not used in ML features (verified).
// ─────────────────────────────────────────────────────────────────────────────
import { Candle } from '../indicators';
import { detectSwings } from '../marketStructure';
import { Swing, SwingType } from './structureTypes';

export type SwingConfig = {
  lookback: 3 | 4 | 5 | 6 | 8 | 10;
};

const DEFAULT_CONFIG: SwingConfig = { lookback: 5 };

export function computeSwings(
  candles: Candle[],
  atrArr: (number | null)[],
  config: SwingConfig = DEFAULT_CONFIG
): Swing[] {
  const raw = detectSwings(candles, config.lookback);
  const n   = candles.length;

  // P2: rolling volume sum — O(n) instead of O(20n) nested loop
  // Produces identical values: volAvg20[i] = mean of candles[max(0,i-19)..i].volume
  const volAvg20 = new Float64Array(n);
  let volRun = 0;
  for (let i = 0; i < n; i++) {
    volRun += candles[i].volume;
    if (i >= 20) volRun -= candles[i - 20].volume;
    volAvg20[i] = volRun / Math.min(20, i + 1);
  }

  // countTouches: O(n) per swing (total O(n×s)).
  // touches is stored in the Swing struct but is NOT used in any ML feature
  // computation (verified: snapshotToScores and computeStructureAt do not read it).
  // It is kept for completeness and potential future UI use.
  function countTouches(swingIdx: number, swingPrice: number, swingType: SwingType): number {
    let touches = 0;
    for (let j = swingIdx + config.lookback + 1; j < n; j++) {
      const atr  = atrArr[j] ?? Math.abs(candles[j].close - candles[j].open);
      const zone = atr * 0.5;
      const ref  = swingType === 'high' ? candles[j].high : candles[j].low;
      if (Math.abs(swingPrice - ref) <= zone) touches++;
    }
    return touches;
  }

  return raw.map(s => {
    const atr = atrArr[s.index] ?? (candles[s.index].high - candles[s.index].low);

    const closeAfter = candles[s.index + 2]?.close ?? candles[s.index].close;
    const reaction   = Math.abs(s.price - closeAfter);
    const strength   = atr > 0 ? Math.min(1, reaction / (atr * 2)) : 0;

    const vol         = candles[s.index].volume;
    const avgVol      = volAvg20[s.index] || 1;
    const volumeScore = Math.min(1, vol / (avgVol * 2));

    const age    = (n - 1) - s.index;
    const touches = countTouches(s.index, s.price, s.type);

    return {
      index:            s.index,
      price:            s.price,
      type:             s.type,
      strength,
      volumeScore,
      age,
      touches,
      confirmationBars: config.lookback,
    } satisfies Swing;
  });
}

export function causalSwings(swings: Swing[], i: number, lookback: number): Swing[] {
  return swings.filter(s => s.index <= i - lookback);
}
