// ─────────────────────────────────────────────────────────────────────────────
// FVG SCORING  (v4.9.0)  — FVG_SCORING_V1
//
// All heuristics are here. Detection logic is in fvgEngine.ts only.
// ─────────────────────────────────────────────────────────────────────────────
import { DetectedFVG, ScoredFVG, FVGCluster, FVGScores, FVGConfig } from './fvgTypes';

// ── FVG_SCORING_V1 ────────────────────────────────────────────────────────────
// Formula:
//   sizeScore      = min(1, gapSize / (atr × cfg.sizeAtrMult))
//   freshnessScore = 1 / (1 + age / cfg.halfLife)
//   fillScore      = 1 - fillPct
//   strength       = sizeScore×0.45 + freshnessScore×0.35 + fillScore×0.20
//   confidence     = strength × (unfilled ? 1.0 : 0.6)
export function scoreFVG(fvg: DetectedFVG, atr: number, cfg: FVGConfig): ScoredFVG {
  const sizeScore      = atr > 0 ? Math.min(1, fvg.gapSize / (atr * cfg.sizeAtrMult)) : 0;
  const freshnessScore = 1 / (1 + fvg.age / cfg.halfLife);
  const fillScore      = 1 - fvg.fillPct;
  const strength       = sizeScore * 0.45 + freshnessScore * 0.35 + fillScore * 0.20;
  const confidence     = strength * (fvg.status === 'unfilled' ? 1.0 : 0.6);
  return {
    ...fvg,
    scoringVersion: 'FVG_SCORING_V1',
    sizeScore,
    freshnessScore,
    strength:   Math.min(1, strength),
    confidence: Math.min(1, confidence),
  };
}

// ── Cluster scoring ───────────────────────────────────────────────────────────
// FVG_SCORING_V1 cluster formula:
//   strength = min(1, count / 3)
//   — 3+ FVGs in a cluster = maximum strength
//   Assumption: more overlapping FVGs = more institutional price imbalance.
export function scoreCluster(count: number, fvgStrengths: number[]): number {
  const avgStrength = fvgStrengths.length > 0
    ? fvgStrengths.reduce((a, b) => a + b, 0) / fvgStrengths.length : 0;
  return Math.min(1, (count / 3) * 0.6 + avgStrength * 0.4);
}

// ── Aggregate to FVGScores for ML ─────────────────────────────────────────────
export function toFVGScores(
  bullFVG: ScoredFVG | null,
  bearFVG: ScoredFVG | null,
  cluster: FVGCluster | null,
  price:   number,
  atr:     number
): FVGScores {
  // Nearest FVG: whichever is closer to current price
  const nearestFVG = (() => {
    if (!bullFVG && !bearFVG) return null;
    if (!bullFVG) return bearFVG!;
    if (!bearFVG) return bullFVG!;
    const dBull = Math.abs(price - bullFVG.gapHigh);
    const dBear = Math.abs(price - bearFVG.gapLow);
    return dBull < dBear ? bullFVG : bearFVG;
  })();

  const distScore = nearestFVG && atr > 0
    ? Math.max(0, 1 - Math.abs(price - (nearestFVG.direction === 'bullish'
        ? nearestFVG.gapHigh : nearestFVG.gapLow)) / (atr * 5))
    : 0;

  // Bias: bull FVG below price = bullish context (+1), bear FVG above = bearish (−1)
  let bias = 0;
  if (bullFVG && bullFVG.gapHigh < price) bias += bullFVG.strength;
  if (bearFVG && bearFVG.gapLow  > price) bias -= bearFVG.strength;
  bias = Math.max(-1, Math.min(1, bias));

  return {
    bullFVGStrength:    bullFVG ? bullFVG.strength   : 0,
    bearFVGStrength:    bearFVG ? bearFVG.strength   : 0,
    nearestFVGDistance: distScore,
    gapFillPct:         nearestFVG ? nearestFVG.fillPct : 0,
    fvgAge:             nearestFVG ? Math.min(1, nearestFVG.age / 100) : 1,
    clusterScore:       cluster ? cluster.strength : 0,
    fvgConfidence:      nearestFVG ? nearestFVG.confidence : 0,
    fvgBias:            bias,
  };
}
