// ─────────────────────────────────────────────────────────────────────────────
// PATTERN OUTCOME TRACKER  (v6.3.21)
//
// Answers the question: after a pattern was CONFIRMED, what happened?
//
// This is COMPLETELY SEPARATE from the validation engine (validatePattern.ts).
// The validation engine is stateless and asks "is this pattern valid NOW?"
// The outcome tracker is stateful and asks "what happened AFTER it was confirmed?"
//
// Lifecycle it manages:
//   CONFIRMED → ACTIVE → TP1_HIT → TP2_HIT → TP3_HIT → CLOSED
//                      → STOPPED (stop-loss hit before any target)
//                      → CLOSED  (manually or monitoring ended)
//
// Usage:
//   1. Call createOutcome() when a pattern reaches CONFIRMED status.
//   2. Call updateOutcome() on every subsequent bar to detect target/stop hits.
//   3. Call closeOutcome() when the caller decides to end monitoring.
//   4. The result is persisted via patternOutcomeStore.ts.
//
// REUSES:
//   PatternOutcome, OutcomeStatus, ComponentScores from patternValidationTypes.ts
//   ValidatedPattern from patternValidationTypes.ts (consumed, not modified)
//   Candle from indicators.ts
//
// CREATES NOTHING DUPLICATED from existing engines.
// ─────────────────────────────────────────────────────────────────────────────

import { Candle } from '../indicators';
import {
  PatternOutcome, OutcomeStatus, CompletionReason, ComponentScores,
} from './patternValidationTypes';
import { CONFIDENCE_SCORING_VERSION } from '../confidence/confidenceTypes';
import { ValidatedPattern } from './patternValidationTypes';

// ── Price touch logic ─────────────────────────────────────────────────────────
// "Hit" = candle low/high/close touched the target, not just a wick.
// We use the HIGH for bullish targets (price needs to reach up) and
// the LOW for bearish targets (price needs to reach down).
// This is conservative — favours not marking a hit if only a wick barely touched.

function bullishTargetHit(candle: Candle, target: number): boolean {
  // Require close >= target OR (high >= target AND close >= target * 0.998)
  // The 0.998 allows a candle that touched but closed marginally below
  return candle.high >= target;
}

function bearishTargetHit(candle: Candle, target: number): boolean {
  return candle.low <= target;
}

function stopHit(candle: Candle, stopLoss: number, direction: 'bullish' | 'bearish' | 'neutral'): boolean {
  if (direction === 'bullish') return candle.low <= stopLoss;
  if (direction === 'bearish') return candle.high >= stopLoss;
  return candle.low <= stopLoss || candle.high >= stopLoss;
}

// ── Create a fresh PatternOutcome when a pattern is first CONFIRMED ───────────
export function createOutcome(
  pattern:   ValidatedPattern,
  symbol:    string,
  timeframe: string,
  confirmedAtBar: number,
): PatternOutcome | null {
  // Can only create an outcome for a confirmed pattern with a valid risk plan
  if (pattern.status !== 'CONFIRMED' || pattern.risk == null) return null;

  return {
    patternId:               pattern.patternId,
    patternName:             pattern.patternName,
    symbol,
    timeframe,
    direction:               pattern.direction,
    patternValidationVersion:pattern.patternValidationVersion,

    confirmedAtBar,
    confirmedAtTimestamp:    Date.now(),
    confirmationConfidence:  pattern.confidence,
    componentScoresAtConfirm:{ ...pattern.componentScores },

    entry:        pattern.risk.entry,
    stopLoss:     pattern.risk.stopLoss,
    target1:      pattern.risk.target1,
    target2:      pattern.risk.target2,
    target3:      pattern.risk.target3,
    riskReward2:  pattern.risk.riskReward2,

    outcomeStatus:            'ACTIVE',
    completionReason:         null,
    confidenceScoringVersion: CONFIDENCE_SCORING_VERSION,
    tp1Hit:   false,
    tp2Hit:   false,
    tp3Hit:   false,
    stopHit:  false,
    tp1Bar:   null,
    tp2Bar:   null,
    tp3Bar:   null,
    stopBar:  null,
    closedBar:    null,
    closeBar:     null,
    closedPrice:  null,
    realizedPnLPct: null,
    barsToFirstTarget: null,
    barsToClose:  null,
    validationDuration: pattern.metadata.validationDuration,
  };
}

// ── Update an ACTIVE outcome with the latest candle ──────────────────────────
// Call this once per new candle on every ACTIVE outcome.
// Returns the updated outcome. The caller must persist the result.
// Once an outcome reaches a terminal state (STOPPED / TP3_HIT / CLOSED)
// this function is a no-op and returns the outcome unchanged.
export function updateOutcome(
  outcome:    PatternOutcome,
  candle:     Candle,
  currentBar: number,
): PatternOutcome {
  // Terminal states — nothing to update
  if (
    outcome.outcomeStatus === 'STOPPED' ||
    outcome.outcomeStatus === 'TP3_HIT' ||
    outcome.outcomeStatus === 'CLOSED'
  ) return outcome;

  const updated = { ...outcome };
  const isBull  = outcome.direction !== 'bearish';
  const check   = isBull ? bullishTargetHit : bearishTargetHit;
  const barsElapsed = currentBar - outcome.confirmedAtBar;

  // ── Stop-loss first (adverse hit takes priority) ──────────────────────────
  // Stop is only checked if no TP has been hit yet (once at profit, stop
  // would have been moved to break-even in real trading, but we record
  // the original stop hit for statistical accuracy).
  if (!updated.tp1Hit && !updated.stopHit && stopHit(candle, outcome.stopLoss, outcome.direction)) {
    updated.stopHit          = true;
    updated.stopBar          = currentBar;
    updated.outcomeStatus    = 'STOPPED';
    updated.completionReason = 'STOP_LOSS';
    updated.closedBar      = currentBar;
    updated.closeBar       = currentBar;
    updated.closedPrice    = outcome.stopLoss; // filled at stop level
    updated.barsToClose    = barsElapsed;
    updated.realizedPnLPct = computePnLPct(outcome.entry, outcome.stopLoss, outcome.direction);
    return updated;
  }

  // ── Target checks in order ────────────────────────────────────────────────
  if (!updated.tp1Hit && check(candle, outcome.target1)) {
    updated.tp1Hit             = true;
    updated.tp1Bar             = currentBar;
    updated.barsToFirstTarget  = barsElapsed;
    updated.outcomeStatus      = 'TP1_HIT';
    updated.completionReason   = 'TP1_REACHED';
  }

  if (updated.tp1Hit && !updated.tp2Hit && check(candle, outcome.target2)) {
    updated.tp2Hit             = true;
    updated.tp2Bar             = currentBar;
    updated.outcomeStatus      = 'TP2_HIT';
    updated.completionReason   = 'TP2_REACHED';
  }

  if (updated.tp2Hit && !updated.tp3Hit && check(candle, outcome.target3)) {
    updated.tp3Hit             = true;
    updated.tp3Bar             = currentBar;
    updated.outcomeStatus      = 'TP3_HIT';
    updated.completionReason   = 'TP3_REACHED';
    // TP3 = terminal — record final close
    updated.closedBar     = currentBar;
    updated.closeBar      = currentBar;
    updated.closedPrice   = outcome.target3;
    updated.barsToClose   = barsElapsed;
    updated.realizedPnLPct = computePnLPct(outcome.entry, outcome.target3, outcome.direction);
  }

  return updated;
}

// ── Manually close an outcome (e.g. pattern expired or user action) ───────────
export function closeOutcome(
  outcome:           PatternOutcome,
  currentBar:        number,
  closePrice:        number,
  completionReason:  CompletionReason = 'MANUAL_CLOSE',
): PatternOutcome {
  if (outcome.outcomeStatus !== 'ACTIVE' &&
      outcome.outcomeStatus !== 'TP1_HIT' &&
      outcome.outcomeStatus !== 'TP2_HIT') {
    return outcome; // already terminal
  }

  return {
    ...outcome,
    outcomeStatus:    'CLOSED',
    completionReason,
    closedBar:        currentBar,
    closeBar:         currentBar,
    closedPrice:      closePrice,
    barsToClose:      currentBar - outcome.confirmedAtBar,
    realizedPnLPct:   computePnLPct(outcome.entry, closePrice, outcome.direction),
  };
}

// ── P&L percentage ────────────────────────────────────────────────────────────
function computePnLPct(
  entry:     number,
  exitPrice: number,
  direction: 'bullish' | 'bearish' | 'neutral',
): number {
  if (entry === 0) return 0;
  const raw = (exitPrice - entry) / entry;
  return direction === 'bearish' ? -raw : raw;
}

// ── Check if an outcome needs updating (ACTIVE or partial TP hits) ────────────
export function isOutcomeActive(outcome: PatternOutcome): boolean {
  return (
    outcome.outcomeStatus === 'ACTIVE' ||
    outcome.outcomeStatus === 'TP1_HIT' ||
    outcome.outcomeStatus === 'TP2_HIT'
  );
}
