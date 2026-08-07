// ─────────────────────────────────────────────────────────────────────────────
// EXECUTION ENGINE  (v6.0.8)
//
// Single source of truth for intracandle fill logic used by both paper trading
// (monitorOpenPositions) and any backtesting path.
//
// Implements:
//   1. Intracandle fill — uses candle High/Low to determine whether SL or TP
//      was reached inside the candle, not just at close.
//   2. Gap fill — when Open is already beyond SL or TP, fill at Open.
//   3. Ambiguity resolution — when both SL and TP are inside the same candle,
//      three configurable modes decide which executes first.
//   4. Execution metadata — records expectedFill, actualFill, gapSize,
//      slippagePaid, ambiguousCandle for downstream reporting.
//
// Proof of no lookahead (inline, §7):
//   The function receives a single completed candle [open, high, low, close].
//   All four OHLC values are final and known BEFORE the next candle opens.
//   No future candle prices are referenced. No array index beyond `candle` is
//   read. The candle is the "current" bar being evaluated at settlement time.
//
// Complexity: O(1) — fixed number of comparisons per candle, no loops.
// ─────────────────────────────────────────────────────────────────────────────

export type AmbiguityMode = 'CONSERVATIVE' | 'OPTIMISTIC' | 'RANDOM';

export type ExecutionConfig = {
  /** How to resolve candles where both SL and TP were touched. Default: CONSERVATIVE. */
  ambiguityMode: AmbiguityMode;
  /** Seed for RANDOM mode. Deterministic: same candle index → same outcome. */
  randomSeed:    number;
};

export const DEFAULT_EXECUTION_CONFIG: ExecutionConfig = {
  ambiguityMode: 'CONSERVATIVE',
  randomSeed:    42,
};

// ── Per-fill metadata ─────────────────────────────────────────────────────────
export type FillResult = {
  triggered:      boolean;
  fillType:       'STOP' | 'TP' | null;
  expectedPrice:  number;    // the SL or TP level that was breached
  actualFill:     number;    // price after gap adjustment (before slippage)
  gapSize:        number;    // |open - expectedPrice| when gapped; 0 otherwise
  wasGapFill:     boolean;   // true when Open was already beyond the level
  ambiguousCandle:boolean;   // both SL and TP touched in same candle
  slippagePaid:   number;    // |actualFill - effectiveFill| in price units; computed by caller
};

const NO_FILL: FillResult = {
  triggered: false, fillType: null,
  expectedPrice: 0, actualFill: 0,
  gapSize: 0, wasGapFill: false,
  ambiguousCandle: false, slippagePaid: 0,
};

// ── Deterministic pseudo-random for RANDOM mode ───────────────────────────────
// Uses a simple LCG seeded by (seed XOR barIndex) so the same candle always
// produces the same outcome regardless of call order.
function deterministicBool(seed: number, barIndex: number): boolean {
  const s = (seed ^ barIndex) >>> 0;
  const lcg = ((s * 1664525 + 1013904223) & 0xffffffff) >>> 0;
  return (lcg & 1) === 0;
}

// ── Core intracandle fill logic — O(1) ────────────────────────────────────────
//
// §7 PROOF OF NO LOOKAHEAD:
//   Input `candle` = {open, high, low, close} of the bar being settled.
//   These four values are finalized at candle close. The function is called
//   once per candle AFTER it closes (in monitorOpenPositions and backtest loops).
//   No field from a future candle is referenced anywhere in this function.
//   The `barIndex` is used only as an entropy source for RANDOM mode seeding —
//   it is the index of THIS candle, not a future one.
//
export function evaluateIntracandleFill(
  direction:  'LONG' | 'SHORT',
  stopLoss:   number,
  takeProfit: number,
  candle:     { open: number; high: number; low: number; close: number },
  barIndex:   number,
  cfg:        ExecutionConfig = DEFAULT_EXECUTION_CONFIG,
): FillResult {
  const { open } = candle;
  // Fix 7: normalize OHLC so high >= all prices and low <= all prices.
  // Malformed API responses (zero-volume candles on illiquid pairs, data
  // feed glitches) occasionally return inverted high/low. The normalization
  // is conservative — it never invents a range that didn't happen, it only
  // ensures the four OHLC values are self-consistent.
  const high = Math.max(candle.open, candle.high, candle.close);
  const low  = Math.min(candle.open, candle.low,  candle.close);

  // ── 1. Gap detection: did open skip past stop or TP? ────────────────────────
  // A gap occurs when the market opened at a price already beyond the level.
  // The fill is at Open (best achievable price); the gap loss is |open - level|.
  const stopGapped = direction === 'LONG'
    ? open <= stopLoss          // gapped down through long stop
    : open >= stopLoss;         // gapped up through short stop

  const tpGapped = direction === 'LONG'
    ? open >= takeProfit        // gapped up through long TP
    : open <= takeProfit;       // gapped down through short TP

  if (stopGapped) {
    return {
      triggered: true, fillType: 'STOP',
      expectedPrice: stopLoss,
      actualFill:    open,
      gapSize:       Math.abs(open - stopLoss),
      wasGapFill:    true,
      ambiguousCandle: tpGapped, // gapped through both (extremely rare)
      slippagePaid:  0,           // slippage applied by caller via applyExitSlippage
    };
  }

  if (tpGapped) {
    return {
      triggered: true, fillType: 'TP',
      expectedPrice: takeProfit,
      actualFill:    open,
      gapSize:       Math.abs(open - takeProfit),
      wasGapFill:    true,
      ambiguousCandle: false,
      slippagePaid:  0};
  }

  // ── 2. Intracandle reach: did High/Low touch SL or TP? ──────────────────────
  // Special case: synthetic 1-tick candle (open=high=low=close = current price).
  // A single price point cannot be in two places at once — no ambiguity is possible.
  // Evaluate directly without applying candle-based "both touched" logic.
  if (high === low) {
    const price = high; // all four OHLC values are identical
    if (direction === 'LONG') {
      if (price >= takeProfit) return { triggered: true, fillType: 'TP',   expectedPrice: takeProfit, actualFill: takeProfit, gapSize: 0, wasGapFill: false, ambiguousCandle: false, slippagePaid: 0 };
      if (price <= stopLoss)   return { triggered: true, fillType: 'STOP', expectedPrice: stopLoss,   actualFill: stopLoss,   gapSize: 0, wasGapFill: false, ambiguousCandle: false, slippagePaid: 0 };
    } else {
      if (price <= takeProfit) return { triggered: true, fillType: 'TP',   expectedPrice: takeProfit, actualFill: takeProfit, gapSize: 0, wasGapFill: false, ambiguousCandle: false, slippagePaid: 0 };
      if (price >= stopLoss)   return { triggered: true, fillType: 'STOP', expectedPrice: stopLoss,   actualFill: stopLoss,   gapSize: 0, wasGapFill: false, ambiguousCandle: false, slippagePaid: 0 };
    }
    return { ...NO_FILL };
  }

  const stopReached = direction === 'LONG'
    ? low  <= stopLoss          // wick reached the long stop
    : high >= stopLoss;         // wick reached the short stop

  const tpReached = direction === 'LONG'
    ? high >= takeProfit        // wick reached the long TP
    : low  <= takeProfit;       // wick reached the short TP

  if (!stopReached && !tpReached) return { ...NO_FILL };

  // ── 3. Ambiguity: both SL and TP touched in the same candle ─────────────────
  // We cannot know from OHLC alone which was hit first inside the candle.
  // EXCEPTION: when high === low (1-tick synthetic candle from live price feed),
  // the candle represents a single price point. If that price appears to touch
  // both SL and TP simultaneously, one of the checks must be wrong — a single
  // price cannot be both ≤ stopLoss and ≥ takeProfit unless SL > TP (corrupted
  // levels). In that edge case, resolve by which level the price is closer to.
  // This prevents the CONSERVATIVE mode from always declaring STOP_LOSS on
  // live ticks where the execution engine synthesises a 1-point candle.
  const ambiguous = stopReached && tpReached;

  if (ambiguous) {
    let stopFirst: boolean;
    switch (cfg.ambiguityMode) {
      case 'CONSERVATIVE': stopFirst = true;  break;
      case 'OPTIMISTIC':   stopFirst = false; break;
      case 'RANDOM':       stopFirst = deterministicBool(cfg.randomSeed, barIndex); break;
    }
    const fillType: 'STOP' | 'TP' = stopFirst ? 'STOP' : 'TP';
    const expectedPrice            = stopFirst ? stopLoss : takeProfit;
    return {
      triggered: true, fillType,
      expectedPrice,
      actualFill:    expectedPrice,   // no gap, level was inside the candle
      gapSize:       0,
      wasGapFill:    false,
      ambiguousCandle: true,
      slippagePaid:  0};
  }

  // ── 4. Unambiguous fill ──────────────────────────────────────────────────────
  if (stopReached) {
    return {
      triggered: true, fillType: 'STOP',
      expectedPrice: stopLoss, actualFill: stopLoss,
      gapSize: 0, wasGapFill: false, ambiguousCandle: false, slippagePaid: 0};
  }

  // tpReached
  return {
    triggered: true, fillType: 'TP',
    expectedPrice: takeProfit, actualFill: takeProfit,
    gapSize: 0, wasGapFill: false, ambiguousCandle: false, slippagePaid: 0};
}

// ── Execution statistics accumulator ─────────────────────────────────────────
// Aggregated by callers (backtest runner, validation engine) over a trade set.
export type ExecutionStats = {
  totalExits:       number;
  stopExits:        number;
  tpExits:          number;
  gapExits:         number;
  ambiguousExits:   number;
  avgSlippagePct:   number;   // mean |slippagePaid / expectedPrice| across all exits
  avgGapLossPct:    number;   // mean |gapSize / expectedPrice| across gap exits only
};

export function emptyExecutionStats(): ExecutionStats {
  return { totalExits: 0, stopExits: 0, tpExits: 0, gapExits: 0, ambiguousExits: 0, avgSlippagePct: 0, avgGapLossPct: 0 };
}

export function accumulateExecutionStats(
  stats: ExecutionStats, fill: FillResult & { slippagePaid: number },
): ExecutionStats {
  if (!fill.triggered) return stats;
  const n       = stats.totalExits + 1;
  const slipPct = fill.expectedPrice > 0 ? Math.abs(fill.slippagePaid) / fill.expectedPrice : 0;
  const gapPct  = fill.wasGapFill && fill.expectedPrice > 0 ? fill.gapSize / fill.expectedPrice : 0;
  const prevGapN = stats.gapExits;
  return {
    totalExits:     n,
    stopExits:      stats.stopExits     + (fill.fillType === 'STOP' ? 1 : 0),
    tpExits:        stats.tpExits       + (fill.fillType === 'TP'   ? 1 : 0),
    gapExits:       stats.gapExits      + (fill.wasGapFill ? 1 : 0),
    ambiguousExits: stats.ambiguousExits + (fill.ambiguousCandle ? 1 : 0),
    // Running mean without storing all values — Welford-style numerically stable update
    avgSlippagePct: stats.avgSlippagePct + (slipPct - stats.avgSlippagePct) / n,
    avgGapLossPct:  fill.wasGapFill && prevGapN + 1 > 0
      ? stats.avgGapLossPct + (gapPct - stats.avgGapLossPct) / (prevGapN + 1)
      : stats.avgGapLossPct};
}
