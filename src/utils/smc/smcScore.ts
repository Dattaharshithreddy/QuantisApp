// ─────────────────────────────────────────────────────────────────────────────
// SMC SCORING  (v4.8.0)
//
// ALL heuristics live here. This module is completely isolated from detection.
// Every scoring function is versioned. Bumping a version changes the score
// formula without touching detection modules or invalidating backtests
// (backtest comparison tables reference the version string).
//
// VERSION REGISTER:
//   OB_SCORING_V1  — order block strength and confidence
//   BB_SCORING_V1  — breaker block strength
//   LIQ_SCORING_V1 — liquidity level strength and stop-hunt probability
//   PD_SCORING_V1  — premium/discount bias encoding
//
// ─────────────────────────────────────────────────────────────────────────────
import {
  DetectedOB, DetectedBreaker, DetectedLiquidity, DetectedSweep, DetectedPD,
  ScoredOB, ScoredBreaker, ScoredLiquidity, ScoredSweep, ScoredPD,
  SMCConfig, SMCScores,
} from './smcTypes';
import { Candle } from '../indicators';

// ── OB_SCORING_V1 ─────────────────────────────────────────────────────────────
// Version: OB_SCORING_V1
// Formula:
//   bosStrength  = the BOS's break distance / ATR at the BOS bar (from msStructure)
//   volumeScore  = candles[ob.index].volume / (volAvg[ob.index] × 1.5), capped at 1
//   recency      = 1 / (1 + age / cfg.obAgHalfLife)
//   strength     = bosStrength × cfg.obScoreWeights.bos
//                + volumeScore × cfg.obScoreWeights.volume
//                + recency     × cfg.obScoreWeights.recency
//   confidence   = strength × (status === 'fresh' ? 1.0 : 0.7)
// Assumptions:
//   - BOS magnitude proxies for institutional commitment strength
//   - OB candle volume proxies for institutional participation
//   - Recency assumes older OBs are less relevant (half-life = cfg.obAgHalfLife bars)
//   - Fresh OBs are treated as more reliable (20% confidence haircut after first touch)
// Configurable: cfg.obScoreWeights, cfg.obAgHalfLife
export function scoreOB(
  ob: DetectedOB,
  bosStrength: number,      // raw from msStructure.scoresArr[ob.bosIndex]
  volumeScore: number,      // pre-computed: candles[ob.index].volume / (volAvg[ob.index]*1.5)
  cfg: SMCConfig
): ScoredOB {
  const { bos, volume, recency: recencyW } = cfg.obScoreWeights;
  const recency  = 1 / (1 + ob.age / cfg.obAgHalfLife);
  const strength = Math.min(1,
    bosStrength * bos + volumeScore * volume + recency * recencyW
  );
  const confidence = strength * (ob.status === 'fresh' ? 1.0 : 0.7);

  return {
    ...ob,
    scoringVersion: 'OB_SCORING_V1',
    bosStrength,
    volumeScore,
    strength,
    confidence,
  };
}

// ── BB_SCORING_V1 ─────────────────────────────────────────────────────────────
// Version: BB_SCORING_V1
// Formula: strength = sourceOBStrength × 0.80
// Assumption:
//   A breaker is inherently weaker than its source OB because it has already
//   been violated once, indicating the original institutional order was absorbed.
//   The 0.80 multiplier is a conservative discount. No configurable parameter
//   introduced in V1 — a V2 could add age-decay or confluence adjustments.
export function scoreBreaker(
  b: DetectedBreaker,
  sourceOBStrength: number
): ScoredBreaker {
  return {
    ...b,
    scoringVersion:  'BB_SCORING_V1',
    sourceStrength:  sourceOBStrength,
    strength:        Math.min(1, sourceOBStrength * 0.80),
  };
}

// ── LIQ_SCORING_V1 ────────────────────────────────────────────────────────────
// Version: LIQ_SCORING_V1
//
// Level strength formula:
//   strength = min(1, touches / cfg.liqTouchSaturation)
// Assumption:
//   More touches = more stop orders accumulated = larger liquidity pool.
//   Saturation at cfg.liqTouchSaturation (default 4) means 4+ touches = max strength.
//   Beyond 4, we treat the level as equally "fully formed" — diminishing returns.
//
// Stop hunt classification (heuristic):
//   stopHunt = wickRatio > cfg.stopHuntWickRatio (default 0.60)
// Formula:
//   wickRatio = (high - close) / (high - low) for buy-side sweep
//               (close - low)  / (high - low) for sell-side sweep
// Assumption:
//   A wick consuming > 60% of the candle's range, combined with the close-back,
//   suggests price was driven beyond the level deliberately to trigger stops
//   before reversing. This is observable from OHLCV but its INTERPRETATION
//   as "intentional" is inherently heuristic.
// Configurable: cfg.stopHuntWickRatio, cfg.liqTouchSaturation
//
// Sweep confidence formula:
//   confidence = closeBack × (wickRatio × 0.5 + min(1, wickSize/atr) × 0.5)
//   Since closeBack is always true for a detected sweep, it simplifies to:
//   confidence = wickRatio × 0.5 + min(1, wickSize/atr) × 0.5
export function scoreLiquidityLevel(
  level: DetectedLiquidity,
  cfg: SMCConfig
): ScoredLiquidity {
  return {
    ...level,
    scoringVersion: 'LIQ_SCORING_V1',
    strength: Math.min(1, level.touches / cfg.liqTouchSaturation),
  };
}

export function scoreSweep(
  sweep: DetectedSweep,
  atr: number,
  cfg: SMCConfig
): ScoredSweep {
  const stopHunt   = sweep.wickRatio > cfg.stopHuntWickRatio;
  const wickInATR  = atr > 0 ? Math.min(1, sweep.wickSize / atr) : 0;
  const confidence = sweep.wickRatio * 0.5 + wickInATR * 0.5;
  return {
    ...sweep,
    scoringVersion: 'LIQ_SCORING_V1',
    stopHunt,
    confidence: Math.min(1, confidence),
  };
}

// ── PD_SCORING_V1 ─────────────────────────────────────────────────────────────
// Version: PD_SCORING_V1
// Formula: pdBias = 1 - 2 × position
//   position = 0   → price at swing low  → pdBias = +1 (deep discount, bullish bias)
//   position = 0.5 → equilibrium         → pdBias =  0 (neutral)
//   position = 1   → price at swing high → pdBias = -1 (deep premium, bearish bias)
// This transformation maps [0,1] position to [-1,+1] ML-friendly range.
// No subjective input — position is fully objective; the linear mapping is PD_SCORING_V1.
export function scorePD(pd: DetectedPD): ScoredPD {
  return {
    ...pd,
    scoringVersion: 'PD_SCORING_V1',
    pdBias: 1 - 2 * pd.position,   // +1=discount, -1=premium
  };
}

// ── Aggregate to SMCScores for ML ─────────────────────────────────────────────
// Converts all scored SMC structures at bar i into the 14-element normalized
// feature vector. Called from smcEngine.ts during precomputation.
export function toSMCScores(params: {
  bullOB:        ScoredOB | null;
  bearOB:        ScoredOB | null;
  bullBreaker:   ScoredBreaker | null;
  bearBreaker:   ScoredBreaker | null;
  topLiquidity:  ScoredLiquidity | null;
  sweep:         ScoredSweep | null;
  pd:            ScoredPD | null;
  price:         number;
  atr:           number;
  mitigationBar: number;      // bar of last OB mitigation (0 = never)
  currentBar:    number;
}): SMCScores {
  const { bullOB, bearOB, bullBreaker, bearBreaker, topLiquidity, sweep, pd,
          price, atr, mitigationBar, currentBar } = params;

  // OB distance: normalized inverse proximity to nearest OB zone edge
  const nearestOB = bullOB || bearOB;
  let obDist = 0;
  if (nearestOB && atr > 0) {
    const edge = nearestOB.direction === 'bullish'
      ? nearestOB.zoneHigh
      : nearestOB.zoneLow;
    obDist = Math.min(1, Math.abs(price - edge) / (atr * 5));
  }
  const obDistScore = nearestOB ? Math.max(0, 1 - obDist) : 0;

  // Mitigation score: how recently an OB was mitigated (0 = never, 1 = just now)
  const mitigAge   = mitigationBar > 0 ? currentBar - mitigationBar : 9999;
  const mitigScore = Math.min(1, 1 / (1 + mitigAge / 20));

  // Breaker block: signed score (+bullish, -bearish)
  const bkrScore = bullBreaker ? bullBreaker.strength : bearBreaker ? -bearBreaker.strength : 0;

  // OB age normalized
  const obAgeNorm = nearestOB ? Math.min(1, nearestOB.age / 100) : 1;

  return {
    bullOBStrength:    bullOB   ? bullOB.strength   : 0,
    bearOBStrength:    bearOB   ? bearOB.strength   : 0,
    nearestOBDistance: obDistScore,
    liquidityScore:    topLiquidity ? topLiquidity.strength : 0,
    liquiditySweep:    sweep  ? 1 : 0,
    stopHuntProb:      sweep  ? (sweep.stopHunt ? sweep.confidence : 0) : 0,
    premiumPosition:   pd     ? (pd.isPremium  ? pd.position - 0.5 : 0) * 2 : 0,
    discountPosition:  pd     ? (pd.isDiscount ? 0.5 - pd.position : 0) * 2 : 0,
    breakerBlockScore: Math.max(-1, Math.min(1, bkrScore)),
    mitigationScore:   mitigScore,
    obAge:             obAgeNorm,
    obFreshness:       nearestOB ? (nearestOB.status === 'fresh' ? 1 : 0) : 0,
    obConfidence:      nearestOB ? (nearestOB as ScoredOB).confidence ?? 0 : 0,
    pdBias:            pd ? pd.pdBias : 0,
  };
}
