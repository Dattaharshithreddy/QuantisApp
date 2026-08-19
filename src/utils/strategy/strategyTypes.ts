// ─────────────────────────────────────────────────────────────────────────────
// STRATEGY TYPES  (v1.0.0)
//
// DESIGN CONTRACT:
//   StrategyProfile is a named configuration preset.
//   It configures how existing engine outputs are interpreted and filtered.
//   It does NOT introduce new computation, new ML models, or new engines.
//
//   Every field in StrategyProfile maps to an already-existing parameter in:
//     primaryHorizon        → horizonOverride in trainAndPredict()
//     minConfidence         → PortfolioRiskConfig.minConfidenceToOpen
//     reduceSizeThreshold   → PortfolioRiskConfig.reduceSizeThreshold
//     atrStopMultiplier     → OptimalExecParams.atrStopMultiplier
//     atrTargetMultiplier   → OptimalExecParams.atrTargetMultiplier
//     maxBarsHeld           → TradeManagementConfig.maxBarsHeld
//     breakEvenAtR          → TradeManagementConfig.breakEvenAtR
//     tp[]                  → TradeManagementConfig.tp
//     riskPerTradePct       → RiskSettings.riskPerTradePct
//     requireSignalTypes    → filters classifySignalType() output (regimeFilter.ts)
//     blockSignalTypes      → same
//     requireBOS            → reads mtfSignals[baseTF].bosDetected
//     requireMTFAlignment   → reads mtfSnap.overallMTFScore
//     requirePatternConfirm → reads validatedPatterns[].status === 'CONFIRMED'
//     requireSMC            → reads smcSnap.bullOBStrength / bearOBStrength
//     allowedRegimes        → filters regimeSnap.label
//     blockRegimes          → same
//
//   When no strategy is active (activeStrategyId === null), all existing
//   app behavior is unchanged. The strategy layer is purely additive.
// ─────────────────────────────────────────────────────────────────────────────

import type { RegimeLabel } from '../regime/regimeTypes';
import type { SignalType }  from '../regimeFilter';

// ── Identity ──────────────────────────────────────────────────────────────────

export type StrategyId = 'SCALPING' | 'INTRADAY' | 'SWING' | 'POSITION';

// The five prediction horizons the ML model trains and evaluates separately.
// primaryHorizon selects which horizon's probability is the primary signal.
// This maps directly to horizonOverride in trainAndPredict().
export type PrimaryHorizon = 1 | 3 | 5 | 10 | 20;

// ── Partial TP level ──────────────────────────────────────────────────────────
// Mirrors TradeManagementConfig.tp — defined here so StrategyProfile is
// self-contained without importing TradeManagementConfig.
export type TakeProfitLevel = {
  atR:      number;   // R-multiple at which to take partial profit
  fraction: number;   // fraction of remaining position to close (0..1, sum must equal 1.0)
};

// ── Trade Readiness display context ──────────────────────────────────────────
// Plain-English additions shown in TradeReadinessCard when a strategy is active.
// These are display-only strings — they carry no logic.
export type StrategyReadinessContext = {
  focusLabel:   string;   // e.g. "Regime + Structure + Pattern"
  holdingLabel: string;   // e.g. "2–5 trading days"
  watchFor:     string;   // e.g. "HTF BOS confirmed, STRONG_BULL regime"
};

// ── Full profile ──────────────────────────────────────────────────────────────

export type StrategyProfile = {
  // ── Identity ────────────────────────────────────────────────────────────────
  id:   StrategyId;
  name: string;          // display name, e.g. "Swing"
  icon: string;          // emoji shown in UI, e.g. "🌊"
  description: string;   // one-sentence summary for the picker

  // ── Timeframe guidance ───────────────────────────────────────────────────────
  // These are UI hints only — the app warns but does not block trading on
  // an unpreferred timeframe. The user may always override.
  preferredTimeframes: string[];   // e.g. ['4h', '1d']
  warnOnTimeframes:    string[];   // e.g. ['1m', '3m', '5m']

  // ── Horizon ──────────────────────────────────────────────────────────────────
  // Which of the five trained horizon models to use as the primary signal.
  // Maps to horizonOverride in trainAndPredict().
  // Current DEFAULT_HORIZON = 3 (Intraday profile).
  primaryHorizon: PrimaryHorizon;

  // ── Confidence gates ─────────────────────────────────────────────────────────
  // Applied as an ADDITIVE gate on top of the universal portfolio risk floor.
  // If strategy.minConfidence > PortfolioRiskConfig.minConfidenceToOpen,
  // the strategy threshold is the effective minimum.
  // If lower, the portfolio risk floor still applies — no weakening.
  minConfidence:        number;   // 0–100; e.g. 70 for Swing
  reduceSizeThreshold:  number;   // 0–100; confidence below this → REDUCE_SIZE

  // ── Risk / reward parameters ─────────────────────────────────────────────────
  // These override the corresponding values in OptimalExecParams when a strategy
  // is active. If OptimalConfig exists for the symbol, the strategy values take
  // precedence (strategy is the user's explicit intent; optimization is a hint).
  minRiskReward:        number;   // minimum R:R required to allow entry
  atrStopMultiplier:    number;   // SL = entry ± ATR × this
  atrTargetMultiplier:  number;   // TP = entry ± ATR × this

  // ── Trade management ─────────────────────────────────────────────────────────
  // Passed to TradeManagementConfig at position open.
  maxBarsHeld:   number;                // 0 = disabled (let structure decide)
  breakEvenAtR:  number;                // move stop to entry after this many R
  tp:            TakeProfitLevel[];     // partial exit schedule

  // ── Position sizing ───────────────────────────────────────────────────────────
  // Overrides RiskSettings.riskPerTradePct while strategy is active.
  riskPerTradePct: number;   // e.g. 0.5 for Scalping, 1.5 for Swing

  // ── Signal type filter ────────────────────────────────────────────────────────
  // Applied after classifySignalType() (regimeFilter.ts).
  // The signal must appear in requireSignalTypes (at least one match)
  // and must NOT appear in blockSignalTypes.
  // Empty requireSignalTypes = allow any signal type.
  requireSignalTypes: SignalType[];
  blockSignalTypes:   SignalType[];

  // ── Confirmation requirements ─────────────────────────────────────────────────
  // Each is a boolean gate read from existing engine outputs.
  // false = requirement not enforced (don't block on absence).
  requireBOS:            boolean;   // bosDetected on the current TF's latest signal
  requireMTFAlignment:   boolean;   // |mtfSnap.overallMTFScore| > MTF_ALIGN_MIN
  requirePatternConfirm: boolean;   // validatedPatterns has a CONFIRMED entry
  requireSMC:            boolean;   // bullOBStrength or bearOBStrength > SMC_OB_MIN

  // ── Regime filter ─────────────────────────────────────────────────────────────
  // Applied as an outer filter around evaluateRegimeGate().
  // allowedRegimes: empty array = allow all regimes (no additional filter).
  // blockRegimes:   always applied regardless of allowedRegimes.
  // Uses RegimeLabel exactly as returned by precomputeRegime().latestRegime.label
  allowedRegimes: RegimeLabel[];
  blockRegimes:   RegimeLabel[];

  // ── Trade Readiness display ───────────────────────────────────────────────────
  // Plain-English strings added to TradeReadinessCard when this strategy is active.
  // No logic — display only.
  readinessContext: StrategyReadinessContext;
};

// ── Confirmation thresholds (module-level constants, not per-profile) ─────────
// These are the numeric floors for the boolean confirmation requirements above.
// Defined here once so strategyFilter.ts and any future caller use the same values.

// |mtfSnap.overallMTFScore| must exceed this for requireMTFAlignment to pass.
export const MTF_ALIGN_MIN = 0.15;

// smcSnap.bullOBStrength or bearOBStrength must exceed this for requireSMC to pass.
export const SMC_OB_MIN = 0.30;

// ── Strategy filter result (returned by strategyFilter.ts) ───────────────────
// Defined here alongside the profile type so consumers import from one place.

export type StrategyFilterResult = {
  // Whether the trade is allowed to proceed
  allowed:       boolean;
  // Human-readable reason if blocked (undefined when allowed)
  blockReason?:  string;
  // Which requirement was the primary blocker
  blockSource?:  'REGIME' | 'SIGNAL_TYPE' | 'CONFIDENCE' | 'BOS' | 'MTF' | 'PATTERN' | 'SMC' | 'RR';

  // Configuration overrides for downstream consumers.
  // These are partial — consumers merge with their own defaults.
  // Only populated when allowed === true.
  horizonOverride:      number;
  minConfidenceOverride:number;
  reduceSizeOverride:   number;
  mgmtOverrides: {
    maxBarsHeld:  number;
    breakEvenAtR: number;
    tp:           TakeProfitLevel[];
    atrStopMultiplier:   number;
    atrTargetMultiplier: number;
  };
  riskPerTradePctOverride: number;

  // Context passed through to computeTradeReadiness() and TradeReadinessCard.
  // null when no strategy is active.
  strategyContext: {
    id:              StrategyId;
    name:            string;
    icon:            string;
    readinessContext: StrategyReadinessContext;
  } | null;
};
