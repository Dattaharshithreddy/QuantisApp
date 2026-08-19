// ─────────────────────────────────────────────────────────────────────────────
// REGIME ENGINE  (v5.2.0)
//
// Reads ONLY from precomputed arrays already in S (precomputeSeries return).
// Zero indicator re-computation. O(n): one forward pass reading O(1) per bar.
//
// Data consumed (all from precomputeSeries):
//   S.adxArr[i]                      — ADX
//   S.atrArr[i]                      — ATR
//   S.bb[i].widthPct                 — Bollinger Band width %
//   S.donchianArr[i]                 — Donchian channel (for width)
//   S.histVol[i]                     — historical volatility
//   S.histVolMean60[i]               — rolling 60-bar histVol mean
//   S.msStructure.scoresArr[i].trendStrength — structure-based trend
//   S.mtfData.mtfScoresArr[i].overallMTFScore — MTF alignment
// ─────────────────────────────────────────────────────────────────────────────
import { Candle } from '../indicators';
import {
  RegimeInputs, RegimeResult, RegimeScores, RegimeLabel,
  REGIME_FEATURE_NAMES, DEFAULT_REGIME_CONFIG, RegimeConfig,
} from './regimeTypes';
import { scoreRegime, toRegimeScores } from './regimeScore';

export { REGIME_FEATURE_NAMES };
export type { RegimeScores, RegimeResult, RegimeLabel };

export type PrecomputedRegime = {
  regimeArr:    (RegimeResult | null)[];
  scoresArr:    (RegimeScores | null)[];
  latestRegime: RegimeResult | null;
};

// Precomputed series fields needed — typed to allow reuse without importing full mlSignal types
type RegimeSource = {
  adxArr:      (number | null)[];
  atrArr:      (number | null)[];
  bb:          ({ upper:number|null; mid:number|null; lower:number|null; widthPct:number|null } | null)[];
  donchianArr: ({ upper:number|null; lower:number|null } | null)[];
  histVol:     (number | null)[];
  histVolMean60:(number)[];
  msStructure: { scoresArr: ({ trendStrength:number } | null)[] };
  mtfData:     { mtfScoresArr: ({ overallMTFScore:number } | null)[] };
  patternBiasArr?: (number | null)[];  // optional — 0 when absent or unconfirmed
};

export function precomputeRegime(
  candles: Candle[],
  S: RegimeSource,
  cfg: RegimeConfig = DEFAULT_REGIME_CONFIG
): PrecomputedRegime {
  const n = candles.length;
  const regimeArr: (RegimeResult | null)[] = new Array(n).fill(null);
  const scoresArr: (RegimeScores | null)[] = new Array(n).fill(null);

  for (let i = 20; i < n; i++) {
    const adx       = S.adxArr[i] ?? 0;
    const atr       = S.atrArr[i] ?? (candles[i].high - candles[i].low);
    const bbEntry   = S.bb[i];
    const donchEntry= S.donchianArr[i];
    const histVol   = S.histVol[i] ?? 0;
    const histVolMean = S.histVolMean60[i] || 1;
    const trendStr    = S.msStructure.scoresArr[i]?.trendStrength ?? 0;
    const mtfScore    = S.mtfData.mtfScoresArr[i]?.overallMTFScore ?? 0;
    const patternBias = S.patternBiasArr?.[i] ?? 0;

    // Bollinger width: (upper - lower) / mid — objective measurement
    const bbWidth = (bbEntry?.upper != null && bbEntry?.lower != null && bbEntry?.mid != null && bbEntry.mid > 0)
      ? (bbEntry.upper - bbEntry.lower) / bbEntry.mid : 0;

    const inp: RegimeInputs = {
      adx,
      atr,
      atrNorm:      candles[i].close > 0 ? atr / candles[i].close : 0,
      bbWidth,
      donchWidth:   0,  // unused in V1 — kept for future REGIME_SCORING_V2
      histVol,
      histVolMean,
      trendStrength: trendStr,
      mtfOverall:   mtfScore,
      patternBias:  patternBias};

    const result = scoreRegime(inp, cfg);
    regimeArr[i] = result;
    scoresArr[i] = toRegimeScores(result);
  }

  return {
    regimeArr,
    scoresArr,
    latestRegime: regimeArr[n - 1]};
}

export function getRegimeFeaturesAt(regime: PrecomputedRegime, i: number): number[] {
  const s = regime.scoresArr[i];
  if (!s) return new Array(8).fill(0);
  return [
    s.bullScore, s.bearScore, s.trendRegime, s.sidewaysScore,
    s.breakoutScore, s.meanRevScore, s.volatilityScore, s.regimeConfidence,
  ];
}
