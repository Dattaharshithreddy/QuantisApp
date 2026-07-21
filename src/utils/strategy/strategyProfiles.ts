// ─────────────────────────────────────────────────────────────────────────────
// STRATEGY PROFILES  (v1.0.0)
//
// Four concrete StrategyProfile objects. These are pure data — no logic.
// Every value maps to an existing engine parameter (see strategyTypes.ts).
//
// ADDING A NEW PROFILE: create a new object here and add it to STRATEGY_PROFILES.
// No engine code changes required.
//
// INTRADAY is the current app default:
//   primaryHorizon = 3  (matches PRIMARY_HORIZON in mlSignal.ts)
//   atrStopMultiplier = 1.5, atrTargetMultiplier = 3.0  (current mlSignal defaults)
//   minConfidence = 30  (current PortfolioRiskConfig.minConfidenceToOpen)
//   maxBarsHeld = 0  (disabled, matches DEFAULT_MGMT_CONFIG)
//
// Implementing INTRADAY first produces IDENTICAL behavior to the current app
// with no strategy active — it is the regression baseline.
// ─────────────────────────────────────────────────────────────────────────────

import type { StrategyProfile } from './strategyTypes';

// ── Strategy 1: Scalping ─────────────────────────────────────────────────────
// h=1 momentum trades on sub-5-minute charts.
// Higher confidence bar (75) because fast trades have no time to recover.
// Tighter SL (0.8×ATR) and target (1.5×ATR) — exits before moves fade.
// requireMTFAlignment = false: HTF direction is irrelevant for a 2-minute trade.
// requireBOS = true: must see a fresh break before entering.
export const SCALPING_PROFILE: StrategyProfile = {
  id:          'SCALPING',
  name:        'Scalping',
  icon:        '⚡',
  description: 'Seconds to minutes. Momentum and fast BOS on 1m–5m charts.',

  preferredTimeframes: ['1m', '3m', '5m'],
  warnOnTimeframes:    ['1h', '4h', '1d'],

  primaryHorizon: 1,

  minConfidence:       75,
  reduceSizeThreshold: 85,

  minRiskReward:       1.5,
  atrStopMultiplier:   0.8,
  atrTargetMultiplier: 1.5,

  maxBarsHeld:  20,    // 20 bars on 1m = 20 minutes maximum hold
  breakEvenAtR: 1.0,
  tp: [
    { atR: 1.0, fraction: 0.50 },
    { atR: 1.5, fraction: 0.50 },
  ],

  riskPerTradePct: 0.5,  // smaller per-trade risk; frequency compensates

  requireSignalTypes: ['BREAKOUT', 'TREND'],
  blockSignalTypes:   ['MEAN_REVERSION', 'COUNTER_TREND'],

  requireBOS:            true,   // fresh break required for momentum entry
  requireMTFAlignment:   false,  // HTF context irrelevant at 1m scale
  requirePatternConfirm: false,  // chart patterns are multi-bar; too slow
  requireSMC:            false,  // OB zones are positional, not tick-by-tick

  allowedRegimes: [
    'STRONG_BULL_TREND', 'BULL_TREND',
    'STRONG_BEAR_TREND', 'BEAR_TREND',
    'BREAKOUT',
  ],
  blockRegimes: ['SIDEWAYS', 'MEAN_REVERSION', 'LOW_VOLATILITY'],

  readinessContext: {
    focusLabel:   'Momentum & Speed',
    holdingLabel: 'Seconds to minutes',
    watchFor:     'BOS on current bar, volume spike, tight spread',
  },
};

// ── Strategy 2: Intraday ──────────────────────────────────────────────────────
// This is the current app default. All values match existing engine defaults.
// Implementing this first = zero behavior change = regression baseline.
export const INTRADAY_PROFILE: StrategyProfile = {
  id:          'INTRADAY',
  name:        'Intraday',
  icon:        '📊',
  description: 'Minutes to hours. Trend continuation with MTF and SMC confirmation.',

  preferredTimeframes: ['5m', '15m', '1h'],
  warnOnTimeframes:    ['1m', '1d'],

  primaryHorizon: 3,   // matches PRIMARY_HORIZON in mlSignal.ts

  minConfidence:       30,   // matches DEFAULT_PORTFOLIO_RISK_CONFIG.minConfidenceToOpen
  reduceSizeThreshold: 55,   // matches DEFAULT_PORTFOLIO_RISK_CONFIG.reduceSizeThreshold

  minRiskReward:       2.0,
  atrStopMultiplier:   1.5,  // matches current mlSignal.ts default
  atrTargetMultiplier: 3.0,  // matches current mlSignal.ts default

  maxBarsHeld:  0,     // disabled — matches DEFAULT_MGMT_CONFIG.maxBarsHeld
  breakEvenAtR: 2.0,  // matches DEFAULT_MGMT_CONFIG.breakEvenAtR
  tp: [
    { atR: 2.0, fraction: 0.25 },   // matches DEFAULT_MGMT_CONFIG.tp
    { atR: 3.0, fraction: 0.35 },
    { atR: 4.0, fraction: 0.40 },
  ],

  riskPerTradePct: 1.0,   // matches DEFAULT_SETTINGS in riskManager.ts

  requireSignalTypes: ['TREND', 'BREAKOUT'],
  blockSignalTypes:   ['COUNTER_TREND'],

  requireBOS:            false,
  requireMTFAlignment:   true,   // 1H should agree with 15m entry
  requirePatternConfirm: false,
  requireSMC:            true,   // OB zones are meaningful intraday

  allowedRegimes: [
    'STRONG_BULL_TREND', 'BULL_TREND', 'WEAK_BULL_TREND',
    'STRONG_BEAR_TREND', 'BEAR_TREND', 'WEAK_BEAR_TREND',
    'BREAKOUT',
  ],
  blockRegimes: ['LOW_VOLATILITY'],

  readinessContext: {
    focusLabel:   'Trend + Volume Confirmation',
    holdingLabel: 'Minutes to hours (same session)',
    watchFor:     'MTF alignment, SMC Order Block, volume above average',
  },
};

// ── Strategy 3: Swing Trading ─────────────────────────────────────────────────
// h=10 structural trades on 4H/1D. Higher confidence bar (70).
// Wider SL (2×ATR) absorbs multi-day noise. Larger target (5×ATR).
// requirePatternConfirm = true: chart patterns are reliable at this scale.
// blockRegimes excludes WEAK_BULL/BEAR: swing needs clear structural conviction.
export const SWING_PROFILE: StrategyProfile = {
  id:          'SWING',
  name:        'Swing',
  icon:        '🌊',
  description: '2–5 trading days. Structure, regime, and HTF pattern alignment.',

  preferredTimeframes: ['4h', '1d'],
  warnOnTimeframes:    ['1m', '3m', '5m', '15m'],

  primaryHorizon: 10,

  minConfidence:       70,
  reduceSizeThreshold: 80,

  minRiskReward:       3.0,
  atrStopMultiplier:   2.0,   // wider stop for multi-day noise
  atrTargetMultiplier: 5.0,

  maxBarsHeld:  30,    // ~5 trading days on 4H
  breakEvenAtR: 2.0,
  tp: [
    { atR: 3.0, fraction: 0.30 },
    { atR: 5.0, fraction: 0.40 },
    { atR: 7.0, fraction: 0.30 },
  ],

  riskPerTradePct: 1.5,   // larger per trade; fewer trades

  requireSignalTypes: ['TREND'],
  blockSignalTypes:   ['COUNTER_TREND', 'MEAN_REVERSION'],

  requireBOS:            true,   // major BOS required for swing entry
  requireMTFAlignment:   true,   // 1D and 4H must agree
  requirePatternConfirm: true,   // chart patterns are meaningful at 4H/1D
  requireSMC:            true,

  allowedRegimes: [
    'STRONG_BULL_TREND', 'BULL_TREND',
    'STRONG_BEAR_TREND', 'BEAR_TREND',
    'BREAKOUT',
  ],
  blockRegimes: [
    'SIDEWAYS', 'MEAN_REVERSION',
    'LOW_VOLATILITY', 'HIGH_VOLATILITY',
    'WEAK_BULL_TREND', 'WEAK_BEAR_TREND',
  ],

  readinessContext: {
    focusLabel:   'Regime + Structure + Pattern',
    holdingLabel: '2–5 trading days',
    watchFor:     'HTF BOS confirmed, regime aligned, major pattern validated',
  },
};

// ── Strategy 4: Position Trading ──────────────────────────────────────────────
// h=20 macro trades on 1D+. Highest confidence bar (80).
// Very wide SL (3×ATR) and large target (8×ATR).
// Only STRONG_BULL/BEAR allowed — needs full structural conviction.
// blockSignalTypes includes BREAKOUT: position trades need sustained trend,
// not impulse moves that fade at longer horizons.
// maxBarsHeld = 0: no time exit — structure decides when the trade is done.
export const POSITION_PROFILE: StrategyProfile = {
  id:          'POSITION',
  name:        'Position',
  icon:        '🏔️',
  description: 'Weeks to months. Macro trend with strong regime and full SMC alignment.',

  preferredTimeframes: ['1d'],
  warnOnTimeframes:    ['1m', '3m', '5m', '15m', '30m', '1h'],

  primaryHorizon: 20,

  minConfidence:       80,
  reduceSizeThreshold: 90,

  minRiskReward:       4.0,
  atrStopMultiplier:   3.0,
  atrTargetMultiplier: 8.0,

  maxBarsHeld:  0,     // no time exit — structure decides
  breakEvenAtR: 3.0,
  tp: [
    { atR:  5.0, fraction: 0.25 },
    { atR:  8.0, fraction: 0.35 },
    { atR: 12.0, fraction: 0.40 },
  ],

  riskPerTradePct: 2.0,

  requireSignalTypes: ['TREND'],
  blockSignalTypes:   ['COUNTER_TREND', 'MEAN_REVERSION', 'BREAKOUT'],

  requireBOS:            true,
  requireMTFAlignment:   true,
  requirePatternConfirm: true,
  requireSMC:            true,

  allowedRegimes: [
    'STRONG_BULL_TREND',
    'STRONG_BEAR_TREND',
  ],
  blockRegimes: [
    'SIDEWAYS', 'MEAN_REVERSION',
    'LOW_VOLATILITY', 'HIGH_VOLATILITY',
    'BULL_TREND', 'BEAR_TREND',
    'WEAK_BULL_TREND', 'WEAK_BEAR_TREND',
    'BREAKOUT',
  ],

  readinessContext: {
    focusLabel:   'Macro Trend + Strong Regime',
    holdingLabel: 'Weeks to months',
    watchFor:     'STRONG_BULL/BEAR regime, all timeframes aligned, major SMC zone',
  },
};

// ── Registry ──────────────────────────────────────────────────────────────────
// Single source of truth for all strategy profiles.
// UI and filter code iterate this — never hardcode StrategyId strings in logic.

export const STRATEGY_PROFILES: Record<string, StrategyProfile> = {
  SCALPING:  SCALPING_PROFILE,
  INTRADAY:  INTRADAY_PROFILE,
  SWING:     SWING_PROFILE,
  POSITION:  POSITION_PROFILE,
};

// Ordered list for display (picker shows them in this sequence)
export const STRATEGY_ORDER: StrategyProfile[] = [
  SCALPING_PROFILE,
  INTRADAY_PROFILE,
  SWING_PROFILE,
  POSITION_PROFILE,
];

// Convenience lookup — returns null if id is invalid (never throws)
export function getProfile(id: string | null | undefined): StrategyProfile | null {
  if (!id) return null;
  return STRATEGY_PROFILES[id] ?? null;
}
