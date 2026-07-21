import AsyncStorage from '@react-native-async-storage/async-storage';
import { Candle } from './indicators';
import { precomputeSeries } from './mlSignal';
import { detectTrendDirection, detectVolatilityRegime } from './marketStructure';

// A REAL execution-time regime filter — previously, market regime was only
// ever analyzed AFTER trades closed (regimeAnalysis.ts, for backtest
// reporting). This is the first time regime classification actually gates
// whether a trade is allowed to open at all, reusing the same causal
// detectTrendDirection/detectVolatilityRegime classifiers already built and
// tested, not a new classification method.

export type RegimeFilterMode = 'DISABLED' | 'BULL_ONLY' | 'TRENDING_ONLY' | 'AVOID_LOW_VOL' | 'AVOID_RANGING';

const KEY = 'regimeFilterMode';

export async function getRegimeFilterMode(): Promise<RegimeFilterMode> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return (raw as RegimeFilterMode) || 'DISABLED';
  } catch { return 'DISABLED'; }
}
export async function setRegimeFilterMode(mode: RegimeFilterMode): Promise<void> {
  try { await AsyncStorage.setItem(KEY, mode); } catch { /* non-fatal */ }
}

export type RegimeCheckResult = { allowed: boolean; currentRegime: string; skipMessage?: string };

export function checkRegimeFilter(candles: Candle[], mode: RegimeFilterMode): RegimeCheckResult {
  // FIX (found while building Phase 1 — multi-timeframe regime display):
  // this used to short-circuit to currentRegime:'UNKNOWN' whenever mode was
  // DISABLED, which seemed reasonable for the execution-gating use case
  // (no point computing a regime you're not going to act on) but silently
  // broke any OTHER caller that just wants to know the current regime label
  // without applying a filter — exactly the multi-timeframe evaluator's
  // need. The regime label is cheap to compute regardless; only the GATING
  // decision should depend on whether a filter mode is actually active.
  if (candles.length < 60) return { allowed: true, currentRegime: 'UNKNOWN' };

  const S = precomputeSeries(candles);
  const i = candles.length - 1;
  const trend = detectTrendDirection(candles, S.ema20, S.ema50);
  const volSamples = S.histVol.filter((v): v is number => v != null);
  const avgVol = volSamples.length ? volSamples.reduce((s, v) => s + v, 0) / volSamples.length : 1;
  const volRegime = detectVolatilityRegime(S.histVol[i] ?? avgVol, avgVol);

  // A single, human-readable label for the message format requested ("Current regime = Range")
  const currentRegime = volRegime === 'LOW' ? 'Low Volatility' : volRegime === 'EXTREME' || volRegime === 'HIGH' ? `${volRegime} Volatility`
    : trend === 'UPTREND' ? 'Bull' : trend === 'DOWNTREND' ? 'Bear' : 'Range';

  if (mode === 'DISABLED') return { allowed: true, currentRegime };

  const filterLabel: Record<RegimeFilterMode, string> = {
    DISABLED: '', BULL_ONLY: 'Bull filter enabled', TRENDING_ONLY: 'Trending-only filter enabled',
    AVOID_LOW_VOL: 'Avoid-low-volatility filter enabled', AVOID_RANGING: 'Avoid-ranging filter enabled',
  };

  let allowed = true;
  if (mode === 'BULL_ONLY' && trend !== 'UPTREND') allowed = false;
  else if (mode === 'TRENDING_ONLY' && trend === 'RANGING') allowed = false;
  else if (mode === 'AVOID_LOW_VOL' && volRegime === 'LOW') allowed = false;
  else if (mode === 'AVOID_RANGING' && trend === 'RANGING') allowed = false;

  return {
    allowed, currentRegime,
    skipMessage: allowed ? undefined : `Skipped because:\n${filterLabel[mode]}\nCurrent regime = ${currentRegime}`,
  };
}


// ── Regime-aware entry gate (v6.1.0) ─────────────────────────────────────────
// Reads the already-computed regime label (from portfolioRiskEngine or
// attemptOpenPosition's regimeCheck) and the signal direction, then decides
// ALLOW / REDUCE_SIZE / BLOCK without re-running any engine.
// O(1): pure label matching — no candle scanning, no indicator calls.

export type RegimeGateDecision = 'ALLOW' | 'REDUCE_SIZE' | 'BLOCK';

export type RegimeGateResult = {
  decision:   RegimeGateDecision;
  reason:     string;
  // Minimum confidence to ALLOW in this regime (caller can enforce)
  minConfidenceRequired: number;
  // Size multiplier already applied by portfolioRiskEngine; surfaced here
  // for transparency in the UI / logs.
  sizeMultiplier: number;
};

export type SignalType = 'TREND' | 'BREAKOUT' | 'MEAN_REVERSION' | 'COUNTER_TREND';

// Derive signal type from the ensemble direction + MTF overall score.
// Reuses scalars already computed by the caller — no new computation.
// Classify the trade signal type from fields ALWAYS present on MLPrediction.
// Uses the multi-horizon probability spread as the primary discriminator
// instead of topFeatures string lookups (which silently return 0 when the
// named feature is not in the top-N influential features).
//
// Three reliable inputs — all always populated:
//   direction      from prediction.action (deterministic)
//   horizons       from prediction.horizons (5 entries: h=1,3,5,10,20)
//   regimeLabel    from regimeCheck.currentRegime (always computed before this call)
//
// Classification logic:
//   REGIME override (always takes priority):
//     MEAN_REVERSION / SIDEWAYS  → MEAN_REVERSION
//     BREAKOUT                   → BREAKOUT
//
//   HORIZON SPREAD (for all other regimes):
//     Long-horizon opposes direction (longAligned < 0.40)   → COUNTER_TREND
//     Short >> long (spread > 0.12, shortAligned > 0.60)   → BREAKOUT (impulse)
//     Both horizons aligned and above threshold             → TREND
//     Default                                               → TREND
//
// The spread distinguishes:
//   TREND:      h1≈h20 both strong — sustained, multi-timeframe directional
//   BREAKOUT:   h1 strong, h20 weak — immediate impulse, may not persist
//   COUNTER_TREND: h20 opposes direction — model doubts the long-run move
export function classifySignalType(
  direction:      'LONG' | 'SHORT',
  ensembleProbUp: number,          // 0–1, always present
  regimeLabel:    string,          // from regimeCheck.currentRegime
  horizons:       { horizon: number; probUp: number }[], // prediction.horizons
): SignalType {
  // Regime overrides: these regime states define the signal type structurally
  if (regimeLabel === 'MEAN_REVERSION' || regimeLabel === 'SIDEWAYS') return 'MEAN_REVERSION';
  if (regimeLabel === 'BREAKOUT') return 'BREAKOUT';

  // Short-horizon probabilities (h=1,3): immediate momentum
  const short = horizons.filter(h => h.horizon <= 3);
  // Long-horizon probabilities (h=10,20): sustained trend signal
  const long  = horizons.filter(h => h.horizon >= 10);

  // Fall back to ensembleProbUp if horizons array is unexpectedly empty
  const shortProb = short.length > 0
    ? short.reduce((s, h) => s + h.probUp, 0) / short.length
    : ensembleProbUp;
  const longProb  = long.length > 0
    ? long.reduce((s, h) => s + h.probUp, 0) / long.length
    : ensembleProbUp;

  // Align probabilities to the trade direction:
  //   LONG: P(up) directly measures alignment
  //   SHORT: P(down) = 1 - P(up) measures alignment
  const shortAligned = direction === 'LONG' ? shortProb : (1 - shortProb);
  const longAligned  = direction === 'LONG' ? longProb  : (1 - longProb);
  const spread       = shortAligned - longAligned; // positive = short decays toward long

  // Counter-trend: long-horizon model output opposes the trade direction.
  // Happens when a short-term reversal signal fires against the longer trend.
  if (longAligned < 0.40) return 'COUNTER_TREND';

  // Breakout: short horizon is strong but long horizon is materially weaker.
  // Indicates an impulse/momentum signal that may not persist across timeframes.
  if (spread > 0.12 && shortAligned > 0.60) return 'BREAKOUT';

  // Trend: both horizons above threshold and broadly agree.
  return 'TREND';
}

// Per-regime rules — the authoritative mapping:
//   TREND regimes:        allow trend signals, block mean-reversion
//   BREAKOUT:             require higher confidence, allow breakout
//   MEAN_REVERSION:       reject trend-following, allow mean-reversion only
//   HIGH_VOLATILITY:      reduce size, block low-confidence
//   LOW_VOLATILITY:       reject breakouts
type RegimeRule = {
  allowedSignals:  SignalType[];
  blockedSignals:  SignalType[];
  minConfidence:   number;   // below this: BLOCK
  reduceThreshold: number;   // below this: REDUCE_SIZE
  sizeMultiplier:  number;
};

const REGIME_RULES: Record<string, RegimeRule> = {
  STRONG_BULL_TREND:  { allowedSignals:['TREND','BREAKOUT'],     blockedSignals:['MEAN_REVERSION','COUNTER_TREND'], minConfidence:40, reduceThreshold:55, sizeMultiplier:1.1 },
  BULL_TREND:         { allowedSignals:['TREND','BREAKOUT'],     blockedSignals:['MEAN_REVERSION','COUNTER_TREND'], minConfidence:40, reduceThreshold:55, sizeMultiplier:1.0 },
  WEAK_BULL_TREND:    { allowedSignals:['TREND'],                blockedSignals:['COUNTER_TREND'],                  minConfidence:50, reduceThreshold:60, sizeMultiplier:0.9 },
  SIDEWAYS:           { allowedSignals:['MEAN_REVERSION'],       blockedSignals:['TREND','BREAKOUT'],               minConfidence:55, reduceThreshold:65, sizeMultiplier:0.8 },
  MEAN_REVERSION:     { allowedSignals:['MEAN_REVERSION'],       blockedSignals:['TREND','COUNTER_TREND'],          minConfidence:55, reduceThreshold:65, sizeMultiplier:0.8 },
  WEAK_BEAR_TREND:    { allowedSignals:['TREND'],                blockedSignals:['COUNTER_TREND'],                  minConfidence:50, reduceThreshold:60, sizeMultiplier:0.85 },
  BEAR_TREND:         { allowedSignals:['TREND','BREAKOUT'],     blockedSignals:['MEAN_REVERSION','COUNTER_TREND'], minConfidence:40, reduceThreshold:55, sizeMultiplier:1.0 },
  STRONG_BEAR_TREND:  { allowedSignals:['TREND','BREAKOUT'],     blockedSignals:['MEAN_REVERSION','COUNTER_TREND'], minConfidence:40, reduceThreshold:55, sizeMultiplier:1.0 },
  BREAKOUT:           { allowedSignals:['BREAKOUT','TREND'],     blockedSignals:['MEAN_REVERSION'],                 minConfidence:60, reduceThreshold:70, sizeMultiplier:0.9 },
  HIGH_VOLATILITY:    { allowedSignals:['TREND','MEAN_REVERSION'],blockedSignals:['BREAKOUT'],                      minConfidence:65, reduceThreshold:75, sizeMultiplier:0.7 },
  LOW_VOLATILITY:     { allowedSignals:['TREND','MEAN_REVERSION'],blockedSignals:['BREAKOUT'],                      minConfidence:45, reduceThreshold:55, sizeMultiplier:0.9 },
  UNKNOWN:            { allowedSignals:['TREND','BREAKOUT','MEAN_REVERSION'], blockedSignals:[], minConfidence:40, reduceThreshold:55, sizeMultiplier:0.9 },
};

export function evaluateRegimeGate(
  regimeLabel: string,
  signalType:  SignalType,
  confidence:  number,   // 0-100
): RegimeGateResult {
  // Normalise the human-readable label from checkRegimeFilter to the
  // REGIME_RULES key space. Without this, 'Bull'/'Bear'/'Range' etc. all
  // fall through to REGIME_RULES['UNKNOWN'] and every regime-specific rule
  // (counter-trend blocking, breakout gating, volatility sizing) is silently skipped.
  const LABEL_MAP: Record<string, string> = {
    'Bull':               'BULL_TREND',
    'Bear':               'BEAR_TREND',
    'Range':              'SIDEWAYS',
    'Low Volatility':     'LOW_VOLATILITY',
    'HIGH Volatility':    'HIGH_VOLATILITY',
    'EXTREME Volatility': 'HIGH_VOLATILITY',
    'BREAKOUT':           'BREAKOUT',
    'MEAN_REVERSION':     'MEAN_REVERSION',
    'SIDEWAYS':           'SIDEWAYS',
  };
  const normalisedLabel = LABEL_MAP[regimeLabel] ?? regimeLabel;
  const rule = REGIME_RULES[normalisedLabel] ?? REGIME_RULES['UNKNOWN'];
  const { allowedSignals, blockedSignals, minConfidence, reduceThreshold, sizeMultiplier } = rule;

  if (blockedSignals.includes(signalType)) {
    return {
      decision: 'BLOCK', sizeMultiplier: 0,
      minConfidenceRequired: minConfidence,
      reason: `${signalType} signal blocked in ${regimeLabel} regime. ` +
              `Allowed signals: ${allowedSignals.join(', ')}.`,
    };
  }

  if (confidence < minConfidence) {
    return {
      decision: 'BLOCK', sizeMultiplier: 0,
      minConfidenceRequired: minConfidence,
      reason: `Confidence ${confidence.toFixed(0)}/100 below minimum ${minConfidence} for ${regimeLabel} regime.`,
    };
  }

  if (confidence < reduceThreshold) {
    return {
      decision: 'REDUCE_SIZE', sizeMultiplier,
      minConfidenceRequired: minConfidence,
      reason: `Confidence ${confidence.toFixed(0)}/100 below ${reduceThreshold} for ${regimeLabel} — size reduced ×${sizeMultiplier.toFixed(2)}.`,
    };
  }

  return {
    decision: 'ALLOW', sizeMultiplier,
    minConfidenceRequired: minConfidence,
    reason: `${regimeLabel}: ${signalType} signal allowed with confidence ${confidence.toFixed(0)}/100.`,
  };
}
