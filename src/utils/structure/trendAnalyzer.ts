// ─────────────────────────────────────────────────────────────────────────────
// TREND ANALYZER
// Converts raw structure scores into normalized, ML-ready trend features.
// All outputs are in [-1, +1] or [0, 1] — no unbounded values.
// ─────────────────────────────────────────────────────────────────────────────
import { TrendState, TrendClass } from './structureTypes';

// Map TrendClass to a normalized [-1, +1] scalar for ML features
export function trendClassToScore(c: TrendClass): number {
  switch (c) {
    case 'STRONG_BULL': return  1.0;
    case 'BULL':        return  0.6;
    case 'WEAK_BULL':   return  0.2;
    case 'SIDEWAYS':    return  0.0;
    case 'WEAK_BEAR':   return -0.2;
    case 'BEAR':        return -0.6;
    case 'STRONG_BEAR': return -1.0;
  }
}

// Normalize trend age to [0, 1] using a sigmoid-like saturation
// Age of 0 bars = 0, saturates toward 1 at ~200 bars
export function normalizeTrendAge(ageInBars: number): number {
  return 1 - Math.exp(-ageInBars / 80);
}

// Extract all ML-ready trend features from a TrendState
export function trendToFeatures(trend: TrendState): {
  strength: number;         // -1..+1 (signed by direction)
  confidence: number;       // 0..1
  persistence: number;      // 0..1
  acceleration: number;     // -1..+1
  normalizedAge: number;    // 0..1
} {
  const sign = trendClassToScore(trend.direction) >= 0 ? 1 : -1;
  return {
    strength:      sign * trend.strength,
    confidence:    trend.confidence,
    persistence:   trend.persistence,
    acceleration:  trend.acceleration,
    normalizedAge: normalizeTrendAge(trend.age),
  };
}
