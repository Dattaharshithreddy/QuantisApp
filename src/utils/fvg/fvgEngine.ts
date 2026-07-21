// ─────────────────────────────────────────────────────────────────────────────
// FVG ENGINE  (v4.9.0)
//
// DETECTION RULES (ICT mechanical, objective from OHLCV):
//
//   Bullish FVG at bar i:
//     candles[i-2].low > candles[i].high
//     — The gap between candle[i-2].low and candle[i].high was never traded.
//     — gapHigh = candles[i-2].low   (top boundary of the unfilled zone)
//     — gapLow  = candles[i].high    (bottom boundary)
//
//   Bearish FVG at bar i:
//     candles[i-2].high < candles[i].low
//     — gapHigh = candles[i].low     (top boundary)
//     — gapLow  = candles[i-2].high  (bottom boundary)
//
//   Fill status (deterministic):
//     partial: price entered the zone but did not close through the midpoint
//     filled:  price closed beyond the midpoint (≥50% of gap covered)
//       NOTE: some ICT practitioners use 50% fill as "filled" vs full close-
//       through. This engine uses midpoint-close for reproducibility.
//
//   No lookahead: FVG at bar i is detected using candles[i-2], [i-1], [i].
//   All three bars are available at bar i — causal.
//
// Reuse: no swing detection, no BOS, no liquidity logic from other modules.
// ─────────────────────────────────────────────────────────────────────────────
import { Candle } from '../indicators';
import {
  DetectedFVG, FVGCluster, FVGScores, FVGConfig,
  DEFAULT_FVG_CONFIG, FVG_FEATURE_NAMES, ScoredFVG,
} from './fvgTypes';
import { scoreFVG, scoreCluster, toFVGScores } from './fvgScore';

export { FVG_FEATURE_NAMES };
export type { FVGScores };

export type PrecomputedFVG = {
  fvgScoresArr: (FVGScores | null)[];
  // Snapshot arrays for UI display
  activeBullFVGs: (DetectedFVG[] | null)[];
  activeBearFVGs: (DetectedFVG[] | null)[];
};

// ── Status update (deterministic) ─────────────────────────────────────────────
function updateFVGStatus(fvg: DetectedFVG, c: Candle): void {
  if (fvg.status === 'filled') return;
  const { gapHigh, gapLow, direction } = fvg;
  const mid = (gapHigh + gapLow) / 2;
  const range = gapHigh - gapLow || 1;

  if (direction === 'bullish') {
    // Bullish FVG fills when price comes down into the zone from above
    if (c.low < gapHigh) {
      const penetration = Math.min(gapHigh, Math.max(gapLow, gapHigh - (gapHigh - c.low)));
      fvg.fillPct = Math.min(1, (gapHigh - Math.max(gapLow, c.low)) / range);
      fvg.status  = c.close < mid ? 'filled' : 'partial';
    }
  } else {
    // Bearish FVG fills when price comes up into the zone from below
    if (c.high > gapLow) {
      fvg.fillPct = Math.min(1, (Math.min(gapHigh, c.high) - gapLow) / range);
      fvg.status  = c.close > mid ? 'filled' : 'partial';
    }
  }
}

// ── Cluster detection (O(k²) on active FVGs, k ≤ 40 → O(1)) ─────────────────
function detectClusters(
  bullFVGs: ScoredFVG[],
  bearFVGs: ScoredFVG[],
  atr: number,
  cfg: FVGConfig
): { bull: FVGCluster | null; bear: FVGCluster | null } {
  function buildCluster(fvgs: ScoredFVG[], dir: 'bullish'|'bearish'): FVGCluster | null {
    if (fvgs.length < 2) return null;
    const sorted = [...fvgs].sort((a, b) => a.gapLow - b.gapLow);
    let best: FVGCluster | null = null;
    let clStart = 0;
    for (let k = 1; k <= sorted.length; k++) {
      const isEnd = k === sorted.length ||
        sorted[k].gapLow - sorted[k-1].gapHigh > atr * cfg.clusterGapAtr;
      if (isEnd) {
        const count = k - clStart;
        if (count >= 2) {
          const members = sorted.slice(clStart, k);
          const str = scoreCluster(count, members.map(f => f.strength));
          const cand: FVGCluster = {
            direction:   dir,
            clusterHigh: Math.max(...members.map(f => f.gapHigh)),
            clusterLow:  Math.min(...members.map(f => f.gapLow)),
            count,
            strength:    str,
          };
          if (!best || str > best.strength) best = cand;
        }
        clStart = k;
      }
    }
    return best;
  }
  return {
    bull: buildCluster(bullFVGs, 'bullish'),
    bear: buildCluster(bearFVGs, 'bearish'),
  };
}

// ── Main precompute ────────────────────────────────────────────────────────────
// O(n): each bar creates at most one FVG and updates k ≤ cfg.maxActive FVGs.
// No swing detection, no BOS, no calls to structure or SMC engines.
export function precomputeFVG(
  candles: Candle[],
  atrArr: (number | null)[],
  cfg: FVGConfig = DEFAULT_FVG_CONFIG
): PrecomputedFVG {
  const n = candles.length;
  const fvgScoresArr:   (FVGScores | null)[]   = new Array(n).fill(null);
  const activeBullFVGs: (DetectedFVG[] | null)[] = new Array(n).fill(null);
  const activeBearFVGs: (DetectedFVG[] | null)[] = new Array(n).fill(null);

  let bullActive: DetectedFVG[] = [];
  let bearActive: DetectedFVG[] = [];
  let lastBullIdx: number | null = null;
  let lastBearIdx: number | null = null;

  for (let i = 2; i < n; i++) {
    const c    = candles[i];
    const atr  = (atrArr[i] ?? (c.high - c.low)) || 1;
    const prev = candles[i - 1];
    const prev2= candles[i - 2];

    // ── Step 1: update status of active FVGs ──────────────────────────────
    const nextBull: DetectedFVG[] = [];
    const nextBear: DetectedFVG[] = [];

    for (const fvg of bullActive) {
      updateFVGStatus(fvg, c);
      fvg.age++;
      if (fvg.status !== 'filled' && fvg.age <= cfg.maxAge) nextBull.push(fvg);
    }
    for (const fvg of bearActive) {
      updateFVGStatus(fvg, c);
      fvg.age++;
      if (fvg.status !== 'filled' && fvg.age <= cfg.maxAge) nextBear.push(fvg);
    }

    // ── Step 2: detect new FVG at bar i ───────────────────────────────────
    // Bullish: prev2.low > c.high — gap between prev2 low and current high
    if (prev2.low > c.high) {
      const fvg: DetectedFVG = {
        index:        i,
        direction:    'bullish',
        gapHigh:      prev2.low,
        gapLow:       c.high,
        gapSize:      prev2.low - c.high,
        status:       'unfilled',
        fillPct:      0,
        age:          0,
        prevFVGIndex: lastBullIdx,
      };
      nextBull.push(fvg);
      lastBullIdx = i;
    }

    // Bearish: prev2.high < c.low — gap between prev2 high and current low
    if (prev2.high < c.low) {
      const fvg: DetectedFVG = {
        index:        i,
        direction:    'bearish',
        gapHigh:      c.low,
        gapLow:       prev2.high,
        gapSize:      c.low - prev2.high,
        status:       'unfilled',
        fillPct:      0,
        age:          0,
        prevFVGIndex: lastBearIdx,
      };
      nextBear.push(fvg);
      lastBearIdx = i;
    }

    // Trim to maxActive (keep freshest)
    bullActive = nextBull.slice(-cfg.maxActive);
    bearActive = nextBear.slice(-cfg.maxActive);

    // ── Step 3: score and aggregate ───────────────────────────────────────
    const scoredBull = bullActive.map(f => scoreFVG(f, atr, cfg));
    const scoredBear = bearActive.map(f => scoreFVG(f, atr, cfg));

    // Nearest unfilled or partial in each direction
    const price     = c.close;
    const bestBull  = scoredBull
      .filter(f => f.status !== 'filled')
      .sort((a, b) => Math.abs(price - a.gapHigh) - Math.abs(price - b.gapHigh))[0] ?? null;
    const bestBear  = scoredBear
      .filter(f => f.status !== 'filled')
      .sort((a, b) => Math.abs(price - a.gapLow) - Math.abs(price - b.gapLow))[0] ?? null;

    const { bull: bullCluster, bear: bearCluster } = detectClusters(scoredBull, scoredBear, atr, cfg);
    const topCluster = (!bullCluster && !bearCluster) ? null
      : (!bullCluster) ? bearCluster
      : (!bearCluster) ? bullCluster
      : bullCluster.strength >= bearCluster.strength ? bullCluster : bearCluster;

    fvgScoresArr[i]   = toFVGScores(bestBull, bestBear, topCluster, price, atr);
    activeBullFVGs[i] = bullActive.length > 0 ? [...bullActive] : null;
    activeBearFVGs[i] = bearActive.length > 0 ? [...bearActive] : null;
  }

  return { fvgScoresArr, activeBullFVGs, activeBearFVGs };
}

// ── O(1) feature lookup ────────────────────────────────────────────────────────
export function getFVGFeaturesAt(fvg: PrecomputedFVG, i: number): number[] {
  const s = fvg.fvgScoresArr[i];
  if (!s) return new Array(8).fill(0);
  return [
    s.bullFVGStrength, s.bearFVGStrength, s.nearestFVGDistance,
    s.gapFillPct, s.fvgAge, s.clusterScore, s.fvgConfidence, s.fvgBias,
  ];
}
