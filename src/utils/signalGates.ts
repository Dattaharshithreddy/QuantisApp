// ─────────────────────────────────────────────────────────────────────────────
// SIGNAL GATES  (v1.0.0)
//
// Single shared source of truth for signal-quality decisions.
//
// DESIGN CONTRACT:
//   This module answers one question: "Is this signal good enough to trade?"
//   It does NOT answer: "Does the account have room for this trade?"
//   Account safety (exposure, daily loss, cash, position limits) is handled
//   exclusively in paperTradingEngine.ts and must never move here.
//
// Callers:
//   computeTradeReadiness() — reads the output to produce READY/WAIT/AVOID
//   attemptOpenPosition()  — reads the output to enforce signal gates in
//                            execution, using the SAME regime label and
//                            strategy profile as the UI computed readiness from.
//
// This eliminates the class of bugs where:
//   Trade Readiness = READY  (regime gate passed in the UI)
//   attemptOpenPosition = BLOCKED by regime  (different classifier, same data)
//
// Inputs:
//   regimeLabel        — from regimeSnap.label (regime engine, 11-label set).
//                        When regimeLabelOverride is passed to attemptOpenPosition,
//                        it is this label (same source). Never the EMA-based
//                        checkRegimeFilter label.
//   direction          — 'LONG' | 'SHORT', from prediction.action
//   ensembleProbUp     — 0–1, from prediction.ensembleProbUp
//   confidence         — 0–100, live overall confidence
//   horizons           — prediction.horizons for classifySignalType
//   strategyProfile    — optional; when null no strategy gates run
//   mtfSnap            — optional; when null MTF-requiring strategy gates PASS
//                        (conservative default — don't block when data absent)
//   mtfSignals         — for BOS gate; empty array → BOS gate passes conservatively
//   smcSnap            — for SMC OB gate; null → gate passes conservatively
//   validatedPatterns  — for pattern gate; empty → gate passes conservatively
//
// Output:
//   SignalGateResult:
//     allowed     — false = block this trade
//     state       — READY | WAIT | AVOID (mirrors TradeReadinessState)
//     reason      — human-readable block reason (empty when allowed)
//     blockSource — which gate blocked (for analytics)
//     signalType  — derived signal type (reused by callers for logging)
// ─────────────────────────────────────────────────────────────────────────────

import {
  classifySignalType,
  evaluateRegimeGate,
  SignalType,
} from './regimeFilter';
import { applyStrategyFilter, StrategyFilterInputs } from './strategy/strategyFilter';
import type { StrategyProfile } from './strategy/strategyTypes';
import type { MTFScores, TFSignal, Timeframe } from './mtf/mtfTypes';
import type { ValidatedPattern } from './patternValidation/patternValidationTypes';

// ── Types ─────────────────────────────────────────────────────────────────────

export type SignalGateState = 'READY' | 'WAIT' | 'AVOID';

export type SignalGateBlockSource =
  | 'REGIME'
  | 'REGIME_FILTER_MODE'   // user-configured mode gate (BULL_ONLY etc)
  | 'STRATEGY_REGIME'      // strategy profile's allowedRegimes/blockRegimes
  | 'STRATEGY_CONFIDENCE'
  | 'STRATEGY_MTF'
  | 'STRATEGY_BOS'
  | 'STRATEGY_PATTERN'
  | 'STRATEGY_SMC';

export type SignalGateResult = {
  allowed:     boolean;
  state:       SignalGateState;
  reason:      string;
  blockSource: SignalGateBlockSource | null;
  signalType:  SignalType;
};

export type SignalGateInputs = {
  // Regime — MUST be from regimeSnap.label (regime engine), not checkRegimeFilter
  regimeLabel:       string;
  // Prediction outputs
  direction:         'LONG' | 'SHORT';
  ensembleProbUp:    number;
  confidence:        number;   // 0–100 live confidence
  horizons:          { horizon: number; probUp: number }[];
  // MTF-based readiness state from computeTradeReadiness Phase 1.
  // When provided, this is the authoritative signal-quality verdict from the
  // full chart engine (htfBias, chochAlignment, overallMTFScore). Signal gates
  // can only RAISE this state (WAIT→AVOID), never lower it (AVOID→READY).
  // When null (scanner/automation with no chart context), defaults to 'READY'
  // so gates still run and can block — conservative fallback.
  mtfReadinessState?: 'READY' | 'WAIT' | 'AVOID' | null;
  // Strategy — optional
  strategyProfile?:  StrategyProfile | null;
  // Engine snapshots — all optional; gates pass conservatively when absent
  mtfSnap?:          MTFScores | null;
  mtfSignals?:       TFSignal[];
  baseTF?:           Timeframe;
  smcBullOBStrength?:number;
  smcBearOBStrength?:number;
  validatedPatterns?:ValidatedPattern[];
};

// ── Shared evaluation ──────────────────────────────────────────────────────────

/**
 * Evaluates signal-quality gates using the same inputs and thresholds
 * regardless of whether called from computeTradeReadiness or attemptOpenPosition.
 *
 * Account safety gates (exposure, daily loss, cash) are NOT here.
 */
export function evaluateSignalGates(inputs: SignalGateInputs): SignalGateResult {
  const {
    regimeLabel, direction, ensembleProbUp, confidence, horizons,
    mtfReadinessState = null,
    strategyProfile = null,
    mtfSnap = null,
    mtfSignals = [],
    baseTF = '15m',
    smcBullOBStrength = 0,
    smcBearOBStrength = 0,
    validatedPatterns = [],
  } = inputs;

  // ── Baseline: MTF-based state from Phase 1 (Trade Readiness) ─────────────
  // When the chart engine already computed a readiness state (htfBias, CHoCH,
  // overallMTFScore), that is the authoritative starting point. Signal gates
  // below can only RAISE this (WAIT→AVOID), never lower (AVOID→READY).
  // When null (non-chart callers), we start at 'READY' and let gates decide.
  let currentState: SignalGateState = mtfReadinessState ?? 'READY';

  // If MTF already said AVOID, the regime/strategy gates can still run for
  // logging purposes but cannot rescue the signal.
  // If MTF said WAIT or READY, regime/strategy gates can raise to WAIT or AVOID.

  // ── 1. Signal type classification ─────────────────────────────────────────
  const signalType = classifySignalType(direction, ensembleProbUp, regimeLabel, horizons);

  // ── 2. Regime gate ────────────────────────────────────────────────────────
  const regimeGate = evaluateRegimeGate(regimeLabel, signalType, confidence);
  if (regimeGate.decision === 'BLOCK') {
    // Regime block is always AVOID — hard, unconditional
    return {
      allowed:     false,
      state:       'AVOID',
      reason:      regimeGate.reason,
      blockSource: 'REGIME',
      signalType,
    };
  }

  // ── 3. Strategy profile gates ─────────────────────────────────────────────
  if (strategyProfile) {
    const sfInputs: StrategyFilterInputs = {
      predictionAction:     direction === 'LONG' ? 'BUY' : 'SELL',
      predictionDirection:  direction === 'LONG' ? 'UP' : 'DOWN',
      predictionConfidence: confidence,
      predictionHorizons:   horizons,
      ensembleProbUp,
      mtfSnap:              mtfSnap ?? null,
      mtfSignals,
      baseTF,
      regimeLabel,
      smcBullOBStrength,
      smcBearOBStrength,
      validatedPatterns,
      signalType,
      tradeDirection:       direction,
    };

    const sfResult = applyStrategyFilter(strategyProfile, sfInputs);
    if (!sfResult.allowed) {
      const src = sfResult.blockSource;
      const blockSource: SignalGateBlockSource =
        src === 'REGIME'      ? 'STRATEGY_REGIME'
        : src === 'CONFIDENCE' ? 'STRATEGY_CONFIDENCE'
        : src === 'MTF'        ? 'STRATEGY_MTF'
        : src === 'BOS'        ? 'STRATEGY_BOS'
        : src === 'PATTERN'    ? 'STRATEGY_PATTERN'
        : src === 'SMC'        ? 'STRATEGY_SMC'
        : 'REGIME';

      const gateState: SignalGateState = src === 'REGIME' ? 'AVOID' : 'WAIT';
      // Raise currentState — never lower. AVOID stays AVOID.
      const raised: SignalGateState =
        currentState === 'AVOID' || gateState === 'AVOID' ? 'AVOID'
        : gateState === 'WAIT'   ? 'WAIT'
        : currentState;

      return {
        allowed:     false,
        state:       raised,
        reason:      sfResult.blockReason ?? `${strategyProfile.name} strategy gate blocked`,
        blockSource,
        signalType,
      };
    }
  }

  // ── All signal gates passed — return the MTF baseline state ───────────────
  // If MTF said WAIT, gates all passed but signal is still WAIT (not READY).
  // Gates passing does NOT upgrade a WAIT to READY — only MTF Phase 1 can do that.
  const allowed = currentState === 'READY';
  return {
    allowed,
    state:       currentState,
    reason:      currentState === 'WAIT'
      ? 'Signal quality gates passed but MTF alignment is insufficient for a READY signal.'
      : currentState === 'AVOID'
      ? 'Higher timeframe structure is opposing this trade direction.'
      : '',
    blockSource: allowed ? null : 'REGIME',
    signalType,
  };
}
