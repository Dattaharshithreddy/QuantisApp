// ─────────────────────────────────────────────────────────────────────────────
// STRATEGY FILTER  (v1.0.0)
//
// ══════════════════════════════════════════════════════════════════════════════
// INVARIANT — enforced by design and verified by the test suite:
//
//   Changing the active strategy must not change any engine output.
//   It may only change whether a trade is accepted, filtered, or how
//   it is presented to the user.
//
// This module enforces that invariant structurally:
//   • It imports NO engine functions (no precomputeSeries, computeConfidence,
//     scoreRegime, computeAlignment, or any function that produces engine output)
//   • Every check is a READ + BOOLEAN GATE against a pre-computed value
//   • The engine inputs received by applyStrategyFilter() exit unchanged
//   • The only values it PRODUCES are: allowed, blockReason, blockSource,
//     and config overrides that downstream consumers apply to their own defaults
//
// Data flow:
//   Engine outputs (pre-computed, immutable)
//       ↓  read-only
//   applyStrategyFilter()
//       ↓  produces
//   StrategyFilterResult
//       ↓  consumed by
//   computeTradeReadiness() + attemptOpenPosition() + TradeReadinessCard
// ══════════════════════════════════════════════════════════════════════════════

import type { TFSignal, MTFScores, Timeframe } from '../mtf/mtfTypes';
import type { ValidatedPattern }               from '../patternValidation/patternValidationTypes';
import type { SignalType }                     from '../regimeFilter';
import { MTF_ALIGN_MIN, SMC_OB_MIN, StrategyFilterResult, StrategyProfile } from './strategyTypes';

// ── Input bag — all pre-computed engine outputs, passed in read-only ──────────
// No field here is produced by this module. Every field was computed upstream.
export type StrategyFilterInputs = {
  // Prediction engine outputs (from MLPrediction)
  predictionAction:    string;   // 'BUY' | 'SELL' | 'HOLD'
  predictionDirection: string;   // 'UP'  | 'DOWN' | 'NEUTRAL'
  predictionConfidence:number;   // 0–100, from confidenceEngine
  predictionHorizons:  { horizon: number; probUp: number }[];  // horizonResults[0..4]
  ensembleProbUp:      number;   // 0–1

  // MTF engine outputs (from precomputeMTF)
  mtfSnap:    MTFScores | null;
  mtfSignals: TFSignal[];        // latestSignals — per-TF detail
  baseTF:     Timeframe;

  // Regime engine output (from precomputeRegime)
  regimeLabel: string;           // e.g. 'STRONG_BULL_TREND'

  // SMC engine output (from precomputeSMC)
  smcBullOBStrength: number;     // 0–1
  smcBearOBStrength: number;     // 0–1

  // Pattern validation output (from patternValidationEngine)
  validatedPatterns: ValidatedPattern[];

  // Signal type — pre-classified by classifySignalType() before this call
  // Caller must derive this from prediction + regime before calling us.
  signalType: SignalType;

  // Derived trade direction for SMC gate (LONG/SHORT, from predictionAction)
  tradeDirection: 'LONG' | 'SHORT' | null;   // null when action = HOLD
};

// ── Gate result detail ────────────────────────────────────────────────────────
// Each gate check returns this shape — collected into the final result.
type GateResult = {
  passed:      boolean;
  blockReason: string;  // empty string when passed
  blockSource: StrategyFilterResult['blockSource'];
};

// ── Individual gate functions (one per requirement) ───────────────────────────
// Each function:
//   1. Checks if the gate is enabled in the profile (if not, returns passed)
//   2. Reads a single pre-computed value
//   3. Returns passed or blocked
//   COMPUTES NOTHING.

function gateRegime(
  profile: StrategyProfile,
  regimeLabel: string,
): GateResult {
  // Empty allowedRegimes = no regime filter (allow all)
  if (profile.allowedRegimes.length > 0 && !profile.allowedRegimes.includes(regimeLabel as any)) {
    return {
      passed: false,
      blockSource: 'REGIME',
      blockReason: `${profile.name} strategy requires regime in [${profile.allowedRegimes.join(', ')}]. ` +
                   `Current regime: ${regimeLabel}.`};
  }
  if (profile.blockRegimes.includes(regimeLabel as any)) {
    return {
      passed: false,
      blockSource: 'REGIME',
      blockReason: `${profile.name} strategy blocks ${regimeLabel} regime.`};
  }
  return { passed: true, blockReason: '', blockSource: undefined };
}

function gateSignalType(
  profile:    StrategyProfile,
  signalType: SignalType,
): GateResult {
  if (profile.blockSignalTypes.includes(signalType)) {
    return {
      passed: false,
      blockSource: 'SIGNAL_TYPE',
      blockReason: `${profile.name} strategy blocks ${signalType} signals. ` +
                   `Allowed signal types: ${profile.requireSignalTypes.join(', ') || 'any'}.`};
  }
  if (
    profile.requireSignalTypes.length > 0 &&
    !profile.requireSignalTypes.includes(signalType)
  ) {
    return {
      passed: false,
      blockSource: 'SIGNAL_TYPE',
      blockReason: `${profile.name} strategy requires signal type in [${profile.requireSignalTypes.join(', ')}]. ` +
                   `Current signal type: ${signalType}.`};
  }
  return { passed: true, blockReason: '', blockSource: undefined };
}

function gateConfidence(
  profile:    StrategyProfile,
  confidence: number,
): GateResult {
  if (confidence < profile.minConfidence) {
    return {
      passed: false,
      blockSource: 'CONFIDENCE',
      blockReason: `${profile.name} strategy requires confidence ≥ ${profile.minConfidence}. ` +
                   `Current confidence: ${confidence.toFixed(0)}/100.`};
  }
  return { passed: true, blockReason: '', blockSource: undefined };
}

function gateBOS(
  profile:    StrategyProfile,
  mtfSignals: TFSignal[],
  baseTF:     Timeframe,
): GateResult {
  if (!profile.requireBOS) return { passed: true, blockReason: '', blockSource: undefined };

  // Read bosDetected from the base TF signal.
  // latestSignals contains higher-TF signals only (engine design), so we check
  // any signal whose TF matches baseTF first, then fall back to checking
  // whether ANY signal has bosDetected (conservative — avoids false blocks
  // when the base TF signal is not in latestSignals).
  const baseTFSignal = mtfSignals.find(s => s.tf === baseTF);
  const anyBOS = baseTFSignal
    ? baseTFSignal.bosDetected
    : mtfSignals.some(s => s.bosDetected && s.barCount >= 10);

  if (!anyBOS) {
    return {
      passed: false,
      blockSource: 'BOS',
      blockReason: `${profile.name} strategy requires a Break of Structure (BOS) on the current timeframe. ` +
                   `No confirmed BOS detected.`};
  }
  return { passed: true, blockReason: '', blockSource: undefined };
}

function gateMTFAlignment(
  profile: StrategyProfile,
  mtfSnap: MTFScores | null,
): GateResult {
  if (!profile.requireMTFAlignment) {
    return { passed: true, blockReason: '', blockSource: undefined };
  }
  if (!mtfSnap) {
    return {
      passed: false,
      blockSource: 'MTF',
      blockReason: `${profile.name} strategy requires multi-timeframe alignment. MTF data unavailable.`};
  }
  const alignmentScore = Math.abs(mtfSnap.overallMTFScore);
  if (alignmentScore < MTF_ALIGN_MIN) {
    return {
      passed: false,
      blockSource: 'MTF',
      blockReason: `${profile.name} strategy requires MTF alignment > ${MTF_ALIGN_MIN}. ` +
                   `Current alignment: ${alignmentScore.toFixed(2)} (too weak).`};
  }
  return { passed: true, blockReason: '', blockSource: undefined };
}

function gatePattern(
  profile:           StrategyProfile,
  validatedPatterns: ValidatedPattern[],
): GateResult {
  if (!profile.requirePatternConfirm) {
    return { passed: true, blockReason: '', blockSource: undefined };
  }
  const hasConfirmed = validatedPatterns.some(
    vp => vp.status === 'CONFIRMED' &&
          vp.status !== 'FAILED' &&
          vp.status !== 'EXPIRED'
  );
  if (!hasConfirmed) {
    return {
      passed: false,
      blockSource: 'PATTERN',
      blockReason: `${profile.name} strategy requires a CONFIRMED chart pattern. ` +
                   `No confirmed pattern found.`};
  }
  return { passed: true, blockReason: '', blockSource: undefined };
}

function gateSMC(
  profile:           StrategyProfile,
  tradeDirection:    'LONG' | 'SHORT' | null,
  smcBullOBStrength: number,
  smcBearOBStrength: number,
): GateResult {
  if (!profile.requireSMC) {
    return { passed: true, blockReason: '', blockSource: undefined };
  }
  if (!tradeDirection) {
    return { passed: true, blockReason: '', blockSource: undefined };
  }

  // Read the directionally relevant OB strength
  const relevantStrength = tradeDirection === 'LONG' ? smcBullOBStrength : smcBearOBStrength;
  const dirLabel         = tradeDirection === 'LONG' ? 'bullish' : 'bearish';

  if (relevantStrength < SMC_OB_MIN) {
    return {
      passed: false,
      blockSource: 'SMC',
      blockReason: `${profile.name} strategy requires an Order Block (${dirLabel} OB strength ≥ ${SMC_OB_MIN}). ` +
                   `Current ${dirLabel} OB strength: ${relevantStrength.toFixed(2)}.`};
  }
  return { passed: true, blockReason: '', blockSource: undefined };
}

function gateRiskReward(
  profile:      StrategyProfile,
  atrStop:      number,   // distance from entry to SL in price units
  atrTarget:    number,   // distance from entry to TP in price units
): GateResult {
  // Only check when both values are meaningful (non-zero)
  if (atrStop <= 0 || atrTarget <= 0) {
    return { passed: true, blockReason: '', blockSource: undefined };
  }
  const rr = atrTarget / atrStop;
  if (rr < profile.minRiskReward) {
    return {
      passed: false,
      blockSource: 'RR',
      blockReason: `${profile.name} strategy requires R:R ≥ ${profile.minRiskReward}. ` +
                   `Current R:R: ${rr.toFixed(2)}.`};
  }
  return { passed: true, blockReason: '', blockSource: undefined };
}

// ── Main function ─────────────────────────────────────────────────────────────

/**
 * Applies the strategy profile as a filter gate over pre-computed engine outputs.
 *
 * INVARIANT: engine outputs in `inputs` are never modified and never re-computed.
 * Every check is a read + boolean comparison.
 *
 * @param profile   The active StrategyProfile (from strategyProfiles.ts)
 * @param inputs    Pre-computed engine outputs (read-only)
 * @param atrStop   ATR × profile.atrStopMultiplier — pre-computed by caller
 * @param atrTarget ATR × profile.atrTargetMultiplier — pre-computed by caller
 *
 * @returns StrategyFilterResult — allowed flag, block reason, config overrides
 */
export function applyStrategyFilter(
  profile:   StrategyProfile,
  inputs:    StrategyFilterInputs,
  atrStop:   number = 0,
  atrTarget: number = 0,
): StrategyFilterResult {

  // ── Run gates in priority order ───────────────────────────────────────────
  // Order matches the dependency hierarchy: regime → signal type → confidence
  // → structural requirements (BOS, MTF, pattern, SMC) → risk/reward.
  // First failure short-circuits: return immediately, don't run later gates.

  const regimeGate = gateRegime(profile, inputs.regimeLabel);
  if (!regimeGate.passed) {
    return blocked(regimeGate, profile);
  }

  const signalGate = gateSignalType(profile, inputs.signalType);
  if (!signalGate.passed) {
    return blocked(signalGate, profile);
  }

  const confGate = gateConfidence(profile, inputs.predictionConfidence);
  if (!confGate.passed) {
    return blocked(confGate, profile);
  }

  const bosGate = gateBOS(profile, inputs.mtfSignals, inputs.baseTF);
  if (!bosGate.passed) {
    return blocked(bosGate, profile);
  }

  const mtfGate = gateMTFAlignment(profile, inputs.mtfSnap);
  if (!mtfGate.passed) {
    return blocked(mtfGate, profile);
  }

  const patGate = gatePattern(profile, inputs.validatedPatterns);
  if (!patGate.passed) {
    return blocked(patGate, profile);
  }

  const smcGate = gateSMC(
    profile,
    inputs.tradeDirection,
    inputs.smcBullOBStrength,
    inputs.smcBearOBStrength,
  );
  if (!smcGate.passed) {
    return blocked(smcGate, profile);
  }

  const rrGate = gateRiskReward(profile, atrStop, atrTarget);
  if (!rrGate.passed) {
    return blocked(rrGate, profile);
  }

  // ── All gates passed — return allowed result with config overrides ─────────
  return {
    allowed:      true,
    blockReason:  undefined,
    blockSource:  undefined,

    // These overrides tell downstream consumers which config values to use.
    // They do NOT re-compute any engine output — they configure execution params.
    horizonOverride:        profile.primaryHorizon,
    minConfidenceOverride:  profile.minConfidence,
    reduceSizeOverride:     profile.reduceSizeThreshold,
    mgmtOverrides: {
      maxBarsHeld:          profile.maxBarsHeld,
      breakEvenAtR:         profile.breakEvenAtR,
      tp:                   profile.tp,
      atrStopMultiplier:    profile.atrStopMultiplier,
      atrTargetMultiplier:  profile.atrTargetMultiplier},
    riskPerTradePctOverride: profile.riskPerTradePct,

    strategyContext: {
      id:              profile.id,
      name:            profile.name,
      icon:            profile.icon,
      readinessContext: profile.readinessContext}};
}

// ── Helper: build a blocked result ────────────────────────────────────────────
function blocked(gate: GateResult, profile: StrategyProfile): StrategyFilterResult {
  return {
    allowed:      false,
    blockReason:  gate.blockReason,
    blockSource:  gate.blockSource,

    // Overrides are still populated so consumers can display the strategy
    // context even when blocked (Trade Readiness shows "why it's blocked")
    horizonOverride:        profile.primaryHorizon,
    minConfidenceOverride:  profile.minConfidence,
    reduceSizeOverride:     profile.reduceSizeThreshold,
    mgmtOverrides: {
      maxBarsHeld:          profile.maxBarsHeld,
      breakEvenAtR:         profile.breakEvenAtR,
      tp:                   profile.tp,
      atrStopMultiplier:    profile.atrStopMultiplier,
      atrTargetMultiplier:  profile.atrTargetMultiplier},
    riskPerTradePctOverride: profile.riskPerTradePct,

    strategyContext: {
      id:              profile.id,
      name:            profile.name,
      icon:            profile.icon,
      readinessContext: profile.readinessContext}};
}

// ── Null-strategy pass-through ────────────────────────────────────────────────
/**
 * Returns a pass-through result when no strategy is active.
 * All overrides reflect current app defaults (Intraday profile values).
 * Calling code can check `result.strategyContext === null` to detect this state.
 *
 * This is what keeps existing behavior EXACTLY unchanged when activeStrategyId = null.
 */
export function noStrategyResult(): StrategyFilterResult {
  return {
    allowed:             true,
    blockReason:         undefined,
    blockSource:         undefined,
    horizonOverride:     3,      // PRIMARY_HORIZON in mlSignal.ts
    minConfidenceOverride:  30,  // DEFAULT_PORTFOLIO_RISK_CONFIG.minConfidenceToOpen
    reduceSizeOverride:     55,  // DEFAULT_PORTFOLIO_RISK_CONFIG.reduceSizeThreshold
    mgmtOverrides: {
      maxBarsHeld:          0,   // DEFAULT_MGMT_CONFIG.maxBarsHeld (disabled)
      breakEvenAtR:         2.0, // DEFAULT_MGMT_CONFIG.breakEvenAtR
      tp: [                      // DEFAULT_MGMT_CONFIG.tp
        { atR: 2.0, fraction: 0.25 },
        { atR: 3.0, fraction: 0.35 },
        { atR: 4.0, fraction: 0.40 },
      ],
      atrStopMultiplier:    1.5, // current mlSignal.ts default
      atrTargetMultiplier:  3.0, // current mlSignal.ts default
    },
    riskPerTradePctOverride: 1.0, // DEFAULT_SETTINGS in riskManager.ts
    strategyContext: null,         // signals "no strategy active" to consumers
  };
}
