// ─────────────────────────────────────────────────────────────────────────────
// TRADE MANAGER  (v6.0.7)
//
// O(1) per candle per position. All decisions derived from already-precomputed
// engine outputs passed in as snapshots — zero indicator re-computation.
//
// Design: purely functional — receives position + candle snapshots, returns
// a TradeDecision that monitorOpenPositions applies to state. No async I/O,
// no AsyncStorage reads, no direct engine calls.
//
// Engines consumed (snapshots only, precomputed by caller):
//   ATR — trailDistance for ATR mode
//   MS  — most recent confirmed swing for SWING/STRUCTURE mode
//   SMC — nearest fresh Order Block for OB mode, OB freshness
//   FVG — open FVG proximity for re-entry filter
//   Regime — current regime label for regime exit + trail mode selection
//   MTF — overall alignment for confirming regime exit
// ─────────────────────────────────────────────────────────────────────────────
import { TradeManagementState } from './paperPortfolio';
import { directionMultiplier } from './pnlCalculator';

// ── Configuration (configurable at position open, frozen thereafter) ──────────
export type TradeManagementConfig = {
  // Break-even
  breakEvenAtR:         number;  // move stop to entry after this many R (default 1.0)

  // Partial take-profit levels (R-multiples) and size fractions
  tp:  { atR: number; fraction: number }[];
  // Default: [{atR:2, fraction:0.25}, {atR:3, fraction:0.35}, {atR:4, fraction:0.40}]

  // Trailing stop
  atrMultiplier:        number;  // distance = ATR × this (default 1.5)
  trailActivateAtR:     number;  // start trailing only after this R (default 1.0)

  // Time exit
  maxBarsHeld:          number;  // 0 = disabled (default 0)

  // Regime exit
  regimeExitEnabled:    boolean; // default true
  regimeExitMTFMin:     number;  // require |MTF overall| ≥ this before regime exit (-1 to +1)
};

export const DEFAULT_MGMT_CONFIG: TradeManagementConfig = {
  breakEvenAtR:       2.0,  // aligned to TP1 (2R) — break-even and first partial TP fire together
  tp: [
    { atR: 2.0, fraction: 0.25 },
    { atR: 3.0, fraction: 0.35 },
    { atR: 4.0, fraction: 0.40 },
  ],
  atrMultiplier:      1.5,
  trailActivateAtR:   1.0,
  maxBarsHeld:        0,
  regimeExitEnabled:  true,
  regimeExitMTFMin:   0.25,
};

// ── Engine snapshot — what the caller provides each candle ────────────────────
// All values come from already-precomputed arrays via O(1) index lookup.
// No candle scanning, no indicator calls inside this module.
export type TradeSnapshot = {
  currentPrice:  number;
  atr:           number;         // S.atrArr[i] from precomputeSeries
  // Most recent confirmed swing on the correct side of the trade
  // LONG: nearest swing LOW below current price (acts as trail support)
  // SHORT: nearest swing HIGH above current price (acts as trail resistance)
  swingTrailLevel: number | null; // from msStructure.majorHighs/majorLows
  // Nearest fresh OB in the trade direction (null if none)
  obTrailLevel:  number | null;  // from smcData.smcScoresArr[i]
  // Structure-based trail: last MS pivot on the correct side
  structureTrailLevel: number | null;  // from msStructure.scoresArr[i]
  // Regime for exit + trail mode selection
  regimeLabel:   string;         // from regimeData.latestRegime.label
  regimeBull:    number;         // 0–1
  regimeBear:    number;         // 0–1
  regimeVol:     number;         // 0–1
  mtfOverall:    number;         // -1 to +1, from mtfData
  // Bar index (for barsHeld tracking)
  barIndex:      number;
};

// ── Output — what the caller applies atomically ───────────────────────────────
export type TradeDecision = {
  newStop:         number | null;    // null = no change
  partialClose:    { fraction: number; reason: string } | null;
  fullClose:       { reason: string } | null;
  mgmtUpdate:      Partial<TradeManagementState>;
};

const NO_DECISION: TradeDecision = { newStop: null, partialClose: null, fullClose: null, mgmtUpdate: {} };

// ── Regime exit classification ─────────────────────────────────────────────────
// OBJECTIVE rules — based on named regime label and directional scores.
// Not a heuristic: if the regime is named STRONG_BEAR and the trade is LONG,
// the structural environment is explicitly against the position.
const BEAR_REGIMES = new Set(['STRONG_BEAR_TREND','BEAR_TREND','WEAK_BEAR_TREND']);
const BULL_REGIMES = new Set(['STRONG_BULL_TREND','BULL_TREND','WEAK_BULL_TREND']);

function isAdverseRegime(regimeLabel: string, direction: 'LONG' | 'SHORT'): boolean {
  if (direction === 'LONG' && BEAR_REGIMES.has(regimeLabel)) return true;
  if (direction === 'SHORT' && BULL_REGIMES.has(regimeLabel)) return true;
  // High volatility with no directional conviction is adverse for both sides
  if (regimeLabel === 'HIGH_VOLATILITY') return true;
  return false;
}

// ── Trail mode selection — uses regime, O(1) ──────────────────────────────────
// Called ONCE at entry. Regime provides the classification free of charge.
// Priority: trending → OB trail; ranging → swing trail; volatile → ATR trail.
// SCORING_V1: these thresholds are heuristic (documented inline).
export function selectTrailMode(
  regimeLabel: string,
  smcOBFresh:  boolean,  // is a fresh OB available in the trade direction?
  cfg: TradeManagementConfig
): TradeManagementState['trailMode'] {
  // Strong/moderate trend + fresh OB → use OB as structural anchor (tightest)
  if ((regimeLabel.includes('STRONG') || regimeLabel.includes('BULL') || regimeLabel.includes('BEAR'))
      && smcOBFresh) {
    return 'OB';
  }
  // Any trend without OB → structure trail (last confirmed swing pivot)
  if (regimeLabel.includes('TREND')) return 'STRUCTURE';
  // Sideways or mean-reversion → swing trail (looser, reduces whipsaws)
  if (regimeLabel === 'SIDEWAYS' || regimeLabel === 'MEAN_REVERSION') return 'SWING';
  // Breakout/high-vol → ATR trail (handles expanding volatility)
  return 'ATR';
}

// ── Initialize state at position open ─────────────────────────────────────────
export function initManagementState(
  entryPrice:   number,
  stopLoss:     number,
  direction:    'LONG' | 'SHORT',
  regimeLabel:  string,
  smcOBFresh:   boolean,
  cfg: TradeManagementConfig,
): TradeManagementState {
  const initialRisk = Math.abs(entryPrice - stopLoss);
  return {
    initialRisk,
    currentR:           0,
    breakEvenTriggered: false,
    trailMode:          selectTrailMode(regimeLabel, smcOBFresh, cfg),
    stopHistory:        [{ bar: 0, price: stopLoss, reason: 'initial' }],
    partialExits:       [],
    remainingFraction:  1.0,
    peakR:              0,
    lockedProfit:       0,
    barsHeld:           0,
    entryRegime:        regimeLabel,
  };
}

// ── Main per-candle evaluation — O(1) ────────────────────────────────────────
export function evaluateTradeManagement(
  direction:   'LONG' | 'SHORT',
  entryPrice:  number,
  currentStop: number,
  mgmt:        TradeManagementState,
  snap:        TradeSnapshot,
  cfg:         TradeManagementConfig,
): TradeDecision {
  const side    = directionMultiplier(direction);
  const risk    = mgmt.initialRisk > 0 ? mgmt.initialRisk : 1;
  const currentR = (snap.currentPrice - entryPrice) * side / risk;
  const peakR    = Math.max(mgmt.peakR, currentR);

  const updates: Partial<TradeManagementState> = {
    currentR,
    peakR,
    barsHeld: mgmt.barsHeld + 1,
  };

  // ── 1. Time exit ──────────────────────────────────────────────────────────
  if (cfg.maxBarsHeld > 0 && mgmt.barsHeld + 1 >= cfg.maxBarsHeld) {
    return { ...NO_DECISION, fullClose: { reason: 'TIME_EXIT' }, mgmtUpdate: updates };
  }

  // ── 2. Regime exit ────────────────────────────────────────────────────────
  // Only exit when: (a) regime is explicitly adverse AND (b) MTF alignment
  // confirms the adverse direction beyond the threshold.
  // Both conditions required: regime alone can be noisy; MTF confirms structure.
  if (cfg.regimeExitEnabled) {
    const mtfConfirms = direction === 'LONG'
      ? snap.mtfOverall <= -cfg.regimeExitMTFMin
      : snap.mtfOverall >= cfg.regimeExitMTFMin;
    if (isAdverseRegime(snap.regimeLabel, direction) && mtfConfirms) {
      return { ...NO_DECISION, fullClose: { reason: 'REGIME_EXIT' }, mgmtUpdate: updates };
    }
  }

  // ── 3. Partial take-profit levels ─────────────────────────────────────────
  const partialsTaken = mgmt.partialExits.length;
  let partialClose: TradeDecision['partialClose'] = null;
  let lockedProfit = mgmt.lockedProfit;

  for (let k = partialsTaken; k < cfg.tp.length; k++) {
    if (currentR >= cfg.tp[k].atR) {
      // Fix 5: clamp so misconfigured fractions (sum > 1) never go negative.
      const frac    = Math.min(cfg.tp[k].fraction, mgmt.remainingFraction);
      if (frac <= 0) break;
      const earnedR = cfg.tp[k].atR;
      const partialPnL = earnedR * risk * mgmt.remainingFraction * frac;
      lockedProfit += partialPnL;
      updates.partialExits = [
        ...(mgmt.partialExits),
        { bar: snap.barIndex, fraction: frac, price: snap.currentPrice, r: currentR },
      ];
      updates.remainingFraction = mgmt.remainingFraction - frac;
      updates.lockedProfit       = lockedProfit;
      partialClose = { fraction: frac, reason: `TP${k + 1}_${earnedR}R` };
      break; // one partial per candle — apply the rest next candle
    }
  }

  // ── 4. Break-even ─────────────────────────────────────────────────────────
  let newStop: number | null = null;
  const stopHistory = mgmt.stopHistory;

  if (!mgmt.breakEvenTriggered && currentR >= cfg.breakEvenAtR) {
    newStop = entryPrice;
    updates.breakEvenTriggered = true;
    updates.stopHistory = [...stopHistory, { bar: snap.barIndex, price: entryPrice, reason: 'break_even' }];
  }

  // ── 5. Trailing stop (only after trailActivateAtR) ────────────────────────
  if (peakR >= cfg.trailActivateAtR) {
    let candidateStop: number | null = null;

    switch (mgmt.trailMode) {
      case 'ATR': {
        // ATR trail: trail at currentPrice ± ATR × multiplier
        const dist    = snap.atr * cfg.atrMultiplier;
        const cand    = direction === 'LONG' ? snap.currentPrice - dist : snap.currentPrice + dist;
        candidateStop = cand;
        break;
      }
      case 'SWING': {
        // Swing trail: last confirmed swing on the protective side
        if (snap.swingTrailLevel !== null) candidateStop = snap.swingTrailLevel;
        break;
      }
      case 'STRUCTURE': {
        // Structure trail: last MS pivot level on the protective side
        if (snap.structureTrailLevel !== null) candidateStop = snap.structureTrailLevel;
        break;
      }
      case 'OB': {
        // OB trail: nearest fresh Order Block on the protective side
        if (snap.obTrailLevel !== null) candidateStop = snap.obTrailLevel;
        break;
      }
    }

    if (candidateStop !== null) {
      const improves = direction === 'LONG'
        ? candidateStop > (newStop ?? currentStop)
        : candidateStop < (newStop ?? currentStop);
      if (improves) {
        newStop = candidateStop;
        updates.stopHistory = [
          ...(updates.stopHistory ?? stopHistory),
          { bar: snap.barIndex, price: candidateStop, reason: `trail_${mgmt.trailMode.toLowerCase()}` },
        ];
      }
    }
  }

  return { newStop, partialClose, fullClose: null, mgmtUpdate: updates };
}

// ── Build a TradeSnapshot from already-precomputed S fields ─────────────────
// O(1): all lookups are array index reads.
// Called once per position per monitorOpenPositions tick from the EvalTaskContext
// or scanner — never inside featuresAt.
export function buildTradeSnapshot(
  barIndex:     number,
  currentPrice: number,
  direction:    'LONG' | 'SHORT',
  S: {
    atrArr:    (number | null)[];
    msStructure: {
      majorHighs: { index: number; price: number }[];
      majorLows:  { index: number; price: number }[];
      scoresArr:  ({ trendStrength: number; bosStrength?: number } | null)[];
    };
    smcData: {
      smcScoresArr: ({
        bullOBStrength: number; bearOBStrength: number;
        obFreshness: number; obConfidence: number;
        nearestOBDistance: number;
      } | null)[];
    };
    regimeData: {
      latestRegime: { label: string; bullScore: number; bearScore: number; volatilityScore: number } | null;
    };
    mtfData: {
      mtfScoresArr: ({ overallMTFScore: number } | null)[];
    };
  }
): TradeSnapshot {
  const i = barIndex;

  // ATR — O(1)
  const atr = S.atrArr[i] ?? 1;

  // Swing trail level — most recent swing on the protective side, O(1) via majorHighs/majorLows
  let swingTrailLevel: number | null = null;
  if (direction === 'LONG') {
    // For a LONG, trail at the nearest swing LOW below price (confirming support)
    const lows = S.msStructure.majorLows;
    for (let k = lows.length - 1; k >= 0; k--) {
      if (lows[k].price < currentPrice) { swingTrailLevel = lows[k].price; break; }
    }
  } else {
    const highs = S.msStructure.majorHighs;
    for (let k = highs.length - 1; k >= 0; k--) {
      if (highs[k].price > currentPrice) { swingTrailLevel = highs[k].price; break; }
    }
  }

  // Structure trail — same as swing (we use the most recent swing as structural pivot)
  const structureTrailLevel = swingTrailLevel;

  // OB trail — use nearest fresh OB level as structural anchor
  let obTrailLevel: number | null = null;
  const smcSnap = S.smcData.smcScoresArr[i];
  if (smcSnap && smcSnap.obFreshness > 0.5) {
    // nearestOBDistance is normalized [0,1]; approximate absolute price from ATR
    // The OB level itself is not stored in smcScores — use ATR-scaled distance as offset
    // This is a conservative approximation; OB exact price comes from orderBlocks.ts
    // but is not in the precomputed score array. Use price ± (1-obDistance) × ATR × 2.
    const obOffset = (1 - smcSnap.nearestOBDistance) * atr * 2;
    obTrailLevel = direction === 'LONG'
      ? currentPrice - obOffset
      : currentPrice + obOffset;
  }

  // Regime
  const regime = S.regimeData.latestRegime;
  const regimeLabel   = regime?.label ?? 'UNKNOWN';
  const regimeBull    = regime?.bullScore    ?? 0;
  const regimeBear    = regime?.bearScore    ?? 0;
  const regimeVol     = regime?.volatilityScore ?? 0;

  // MTF
  const mtfOverall = S.mtfData.mtfScoresArr[i]?.overallMTFScore ?? 0;

  return {
    currentPrice, atr,
    swingTrailLevel, obTrailLevel, structureTrailLevel,
    regimeLabel, regimeBull, regimeBear, regimeVol, mtfOverall,
    barIndex: i,
  };
}
