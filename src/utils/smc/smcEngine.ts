// ─────────────────────────────────────────────────────────────────────────────
// SMC ENGINE — main entry point  (v4.8.0)
//
// Orchestrates all SMC modules. Called ONCE from precomputeSeries().
// Returns a per-bar score array for O(1) lookup in featuresAt().
//
// Reuse policy:
//   - atrArr, volAvg, msStructure: consumed from precomputeSeries — not recomputed
//   - Swing detection: reuses msStructure.majorHighs/majorLows — not re-run
//   - BOS/CHoCH events: reuses msStructure.scoresArr — not re-detected
// ─────────────────────────────────────────────────────────────────────────────
import { Candle } from '../indicators';
import {
  SMCScores, SMC_FEATURE_NAMES, ScoredOB, ScoredBreaker, ScoredLiquidity,
  ScoredSweep, ScoredPD, DEFAULT_SMC_CONFIG, SMCConfig,
} from './smcTypes';
import { PrecomputedStructure } from '../structure/marketStructure';
import { computeDetectedOBs } from './orderBlocks';
import { computeDetectedLiquidity } from './liquidity';
import { computeDetectedPD }        from './premiumDiscount';
import { scoreOB, scoreBreaker, scoreLiquidityLevel, scoreSweep, scorePD, toSMCScores } from './smcScore';

export { SMC_FEATURE_NAMES };
export type { SMCScores };

export type PrecomputedSMC = {
  smcScoresArr: (SMCScores | null)[];
};

// ── Rolling 20-bar volume average (shared with swingEngine, recomputed here
//    because we can't reuse S.histVolMean60 — that's histVol, not raw volume) ──
function buildVolAvg(candles: Candle[]): Float64Array {
  const n = candles.length;
  const va = new Float64Array(n);
  let run = 0;
  for (let i = 0; i < n; i++) {
    run += candles[i].volume;
    if (i >= 20) run -= candles[i - 20].volume;
    va[i] = run / Math.min(20, i + 1);
  }
  return va;
}

// ── Precompute all SMC scores for the full candle array ───────────────────────
// Total complexity:
//   detectOBs:        O(n × k)   k = max active OBs (≤ 30) → O(30n)
//   detectLiquidity:  O(s log s) + O(n × L)  L = levels ≤ s
//   detectPD:         O(n × s)   dominated by majorHighs.filter per bar
//                                (P2: could use pointer like marketStructure.ts)
//   scoring:          O(n)
//   Total:            O(n × max(k, L)) ≈ O(n) in practice
export function precomputeSMC(
  candles: Candle[],
  atrArr:  (number | null)[],
  msStructure: PrecomputedStructure,
  cfg: SMCConfig = DEFAULT_SMC_CONFIG
): PrecomputedSMC {
  const n = candles.length;
  if (n < 10) return { smcScoresArr: new Array(n).fill(null) };

  const volAvg = buildVolAvg(candles);

  // ── Phase 1: Detection (pure, no heuristics) ─────────────────────────────
  const { obsAtBar, breakersAtBar } = computeDetectedOBs(candles, msStructure, cfg);
  const { levelsAtBar, sweepsAtBar } = computeDetectedLiquidity(candles, msStructure, cfg);
  const pdArr = computeDetectedPD(candles, msStructure);

  // ── Phase 2: Scoring + aggregation per bar ────────────────────────────────
  const smcScoresArr: (SMCScores | null)[] = new Array(n).fill(null);
  let lastMitigationBar = 0;

  for (let i = 5; i < n; i++) {
    const atr = atrArr[i] ?? (candles[i].high - candles[i].low);

    // Find nearest fresh/tested bullish OB (furthest price support below current)
    const obs = obsAtBar[i] ?? [];
    const price = candles[i].close;

    const bullOBsRaw = obs.filter(o =>
      o.direction === 'bullish' && o.status !== 'invalidated'
    );
    const bearOBsRaw = obs.filter(o =>
      o.direction === 'bearish' && o.status !== 'invalidated'
    );

    // Score the nearest relevant OB in each direction
    // "Nearest" = closest zone edge to current price
    const nearestBullRaw = bullOBsRaw.sort((a, b) =>
      Math.abs(price - b.zoneHigh) - Math.abs(price - a.zoneHigh)
    ).pop() ?? null;

    const nearestBearRaw = bearOBsRaw.sort((a, b) =>
      Math.abs(price - a.zoneLow) - Math.abs(price - b.zoneLow)
    ).shift() ?? null;

    // Track last mitigation bar
    for (const ob of obs) {
      if (ob.status === 'mitigated') {
        if (i > lastMitigationBar) lastMitigationBar = i;
      }
    }

    const msScores = msStructure.scoresArr[i];
    const bStrength = msScores?.bosStrength ?? msScores?.chochStrength ?? 0;

    const bullOB: ScoredOB | null = nearestBullRaw
      ? scoreOB(nearestBullRaw, bStrength,
          Math.min(1, candles[nearestBullRaw.index].volume / ((volAvg[nearestBullRaw.index] || 1) * 1.5)),
          cfg)
      : null;

    const bearOB: ScoredOB | null = nearestBearRaw
      ? scoreOB(nearestBearRaw, bStrength,
          Math.min(1, candles[nearestBearRaw.index].volume / ((volAvg[nearestBearRaw.index] || 1) * 1.5)),
          cfg)
      : null;

    // Score breakers
    const breakerList = breakersAtBar[i] ?? [];
    const bullBreakerRaw = breakerList.filter(b => b.direction === 'bullish').slice(-1)[0] ?? null;
    const bearBreakerRaw = breakerList.filter(b => b.direction === 'bearish').slice(-1)[0] ?? null;
    const bullBreaker: ScoredBreaker | null = bullBreakerRaw
      ? scoreBreaker(bullBreakerRaw, bullOB?.strength ?? 0.5) : null;
    const bearBreaker: ScoredBreaker | null = bearBreakerRaw
      ? scoreBreaker(bearBreakerRaw, bearOB?.strength ?? 0.5) : null;

    // Score liquidity
    const levels = levelsAtBar[i] ?? [];
    const strongestLevel = levels
      .filter(l => !l.swept)
      .sort((a, b) => b.touches - a.touches)[0] ?? null;
    const topLiquidity: ScoredLiquidity | null = strongestLevel
      ? scoreLiquidityLevel(strongestLevel, cfg) : null;

    const rawSweep = sweepsAtBar[i];
    const sweep: ScoredSweep | null = rawSweep ? scoreSweep(rawSweep, atr, cfg) : null;

    // Score premium/discount
    const rawPD = pdArr[i];
    const pd: ScoredPD | null = rawPD ? scorePD(rawPD) : null;

    smcScoresArr[i] = toSMCScores({
      bullOB, bearOB, bullBreaker, bearBreaker,
      topLiquidity, sweep, pd,
      price, atr,
      mitigationBar: lastMitigationBar,
      currentBar:    i});
  }

  return { smcScoresArr };
}

// ── O(1) feature lookup ────────────────────────────────────────────────────────
export function getSMCFeaturesAt(smc: PrecomputedSMC, i: number): number[] {
  const s = smc.smcScoresArr[i];
  if (!s) return new Array(14).fill(0);
  return [
    s.bullOBStrength, s.bearOBStrength, s.nearestOBDistance,
    s.liquidityScore, s.liquiditySweep, s.stopHuntProb,
    s.premiumPosition, s.discountPosition, s.breakerBlockScore,
    s.mitigationScore, s.obAge, s.obFreshness,
    s.obConfidence, s.pdBias,
  ];
}
