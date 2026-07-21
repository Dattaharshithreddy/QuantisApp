// ─────────────────────────────────────────────────────────────────────────────
// LIQUIDITY DETECTION  (v5.5.1 — M2 causal fix)
//
// v5.5.1 change: levels are now built INCREMENTALLY as bar i advances.
// Only swings confirmed at or before bar i (index <= i - lookback) are visible.
// This eliminates the lookahead where a future swing could form a cluster
// with past swings, making that cluster appear earlier than it should.
//
// Architecture: monotonic pointer pattern (same as marketStructure.ts v4.7.1).
//   ptrH / ptrL advance forward — each swing visited O(1) amortized.
//   At each bar i, we recluster only the newly confirmed swings and merge
//   them into the running level set. Total: O(n + s log s).
//
// Behaviour on the LAST bar is identical to the old implementation:
//   all swings are confirmed, so the full set of levels is the same.
//   The only difference is that early bars see fewer levels (correct).
// ─────────────────────────────────────────────────────────────────────────────
import { Candle } from '../indicators';
import { DetectedLiquidity, DetectedSweep, SMCConfig } from './smcTypes';
import { PrecomputedStructure } from '../structure/marketStructure';

// ── Merge a single new swing price into a running cluster set ─────────────────
// Finds an existing cluster within EQUAL_TOL of price; if found, merges it in
// (updates running mean and touch count). Otherwise creates a new 1-touch entry.
// Returns only levels with touches ≥ 2 as an active liquidity level.
function mergeIntoLevels(
  levels: Map<number, { sum: number; count: number }>,
  price: number,
  equalTol: number
): void {
  for (const [key, entry] of levels) {
    const mean = entry.sum / entry.count;
    if (Math.abs(price - mean) / mean < equalTol) {
      entry.sum   += price;
      entry.count += 1;
      // Update the map key to the new mean
      levels.delete(key);
      levels.set(entry.sum / entry.count, entry);
      return;
    }
  }
  // No existing cluster — create new single-touch entry
  levels.set(price, { sum: price, count: 1 });
}

function levelsToDetected(
  levels: Map<number, { sum: number; count: number }>,
  type: 'buy_side' | 'sell_side',
  swept: Map<number, { swept: boolean; bar: number | null }>
): DetectedLiquidity[] {
  const result: DetectedLiquidity[] = [];
  for (const [price, entry] of levels) {
    if (entry.count < 2) continue;
    const sw = swept.get(price);
    result.push({
      price,
      type,
      touches:  entry.count,
      swept:    sw?.swept    ?? false,
      sweepBar: sw?.bar      ?? null,
    });
  }
  return result;
}

function detectSweepAt(c: Candle, i: number, level: DetectedLiquidity): DetectedSweep | null {
  if (level.type === 'buy_side') {
    if (c.high > level.price && c.close < level.price) {
      const range = c.high - c.low || 1;
      return { index: i, type: 'buy_side_sweep', levelPrice: level.price,
        wickSize: c.high - level.price, wickRatio: (c.high - c.close) / range, closeBack: true };
    }
  } else {
    if (c.low < level.price && c.close > level.price) {
      const range = c.high - c.low || 1;
      return { index: i, type: 'sell_side_sweep', levelPrice: level.price,
        wickSize: level.price - c.low, wickRatio: (c.close - c.low) / range, closeBack: true };
    }
  }
  return null;
}

export function computeDetectedLiquidity(
  candles: Candle[],
  msStructure: PrecomputedStructure,
  cfg: SMCConfig
): {
  levelsAtBar: (DetectedLiquidity[] | null)[];
  sweepsAtBar: (DetectedSweep | null)[];
} {
  const n = candles.length;
  const levelsAtBar: (DetectedLiquidity[] | null)[] = new Array(n).fill(null);
  const sweepsAtBar: (DetectedSweep | null)[]        = new Array(n).fill(null);

  const { majorHighs, majorLows } = msStructure;
  // lookback for major swings is 5
  const LOOKBACK = 5;

  // Running cluster maps: price-key → { sum, count }
  // Using Map so we can update keys when the mean shifts after a merge
  const buyMap  = new Map<number, { sum: number; count: number }>();
  const sellMap = new Map<number, { sum: number; count: number }>();

  // Sweep tracking: once a level is swept it stays swept
  const buySwept  = new Map<number, { swept: boolean; bar: number | null }>();
  const sellSwept = new Map<number, { swept: boolean; bar: number | null }>();

  // Monotonic pointers into sorted swing arrays (sorted by index asc, guaranteed by detectSwings)
  let ptrH = 0, ptrL = 0;

  for (let i = LOOKBACK; i < n; i++) {
    // ── Advance pointers: admit newly confirmed swings ────────────────────
    // A swing at index j with LOOKBACK=5 is confirmed at bar j+5, i.e. j <= i-5
    while (ptrH < majorHighs.length && majorHighs[ptrH].index <= i - LOOKBACK) {
      mergeIntoLevels(buyMap, majorHighs[ptrH].price, cfg.equalTol);
      ptrH++;
    }
    while (ptrL < majorLows.length && majorLows[ptrL].index <= i - LOOKBACK) {
      mergeIntoLevels(sellMap, majorLows[ptrL].price, cfg.equalTol);
      ptrL++;
    }

    // ── Build current level snapshot ──────────────────────────────────────
    const buyLevels  = levelsToDetected(buyMap,  'buy_side',  buySwept);
    const sellLevels = levelsToDetected(sellMap, 'sell_side', sellSwept);
    const allLevels  = [...buyLevels, ...sellLevels];

    if (allLevels.length === 0) continue;

    // ── Sweep detection ───────────────────────────────────────────────────
    const c = candles[i];
    let latestSweep: DetectedSweep | null = null;

    for (const level of allLevels) {
      if (level.swept) continue;
      const sweep = detectSweepAt(c, i, level);
      if (sweep) {
        // Mark as swept in tracking maps for subsequent bars
        const sweptMap = level.type === 'buy_side' ? buySwept : sellSwept;
        sweptMap.set(level.price, { swept: true, bar: i });
        latestSweep = sweep;
      }
    }

    levelsAtBar[i] = allLevels;
    sweepsAtBar[i] = latestSweep;
  }

  return { levelsAtBar, sweepsAtBar };
}
