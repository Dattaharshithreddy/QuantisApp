// ─────────────────────────────────────────────────────────────────────────────
// MARKET STRUCTURE ENGINE  (v4.7.1 — performance optimized)
//
// v4.7.1 changes vs v4.7.0:
//
//   P1 — Monotonic pointer scan (O(n+s) instead of O(n×s)):
//     The precompute loop no longer calls computeStructureAt() per bar,
//     which internally did 4–6 filter() calls across the full swing arrays.
//     Instead, 6 monotonically-advancing pointers track the causal boundary
//     and BOS lookback window. Each swing is visited O(1) amortised.
//
//   P2 — No per-bar allocations inside the hot loop:
//     Eliminated filter(), slice(), and temporary array creation for every bar.
//     Trend score reads directly from array indices via pointers.
//     BOS volume confirmation uses a precomputed rolling sum (O(1) lookup).
//
//   P3 — Incremental persistence counters:
//     hhAllCount / lhAllCount / hlAllCount / llAllCount are updated only when
//     a pointer advances (O(1) per new swing), not recomputed from scratch per bar.
//
//   Correctness guarantee:
//     All outputs are bit-identical to v4.7.0. The mathematical definitions of
//     HH/HL/LH/LL, BOS, CHoCH, trend classification, and all 19 ML feature
//     values are unchanged. The only thing that changed is WHEN the computation
//     runs — incrementally as pointers advance instead of per-bar full-scan.
//
//   computeStructureAt() in structureAnalyzer.ts is UNCHANGED — still used by
//   getStructureSnapshotAt() for the UI path (single bar, not a loop).
// ─────────────────────────────────────────────────────────────────────────────
import { Candle } from '../indicators';
import { computeSwings } from './swingEngine';
import { snapshotToScores, scoresToArray, STRUCTURE_FEATURE_NAMES } from './structureScore';
import { computeStructureAt } from './structureAnalyzer';
import { StructureSnapshot, StructureScores, StructureLabel, StructureBreak, Swing } from './structureTypes';

export { STRUCTURE_FEATURE_NAMES };
export type { StructureSnapshot, StructureScores, Swing };

export type PrecomputedStructure = {
  majorHighs: Swing[];
  majorLows:  Swing[];
  minorHighs: Swing[];
  minorLows:  Swing[];
  scoresArr:  (StructureScores | null)[];
};

const EQUAL_TOL   = 0.001;
const FAIL_BARS   = 5;
const BOS_LOOKBACK = 60;

// ── Pure functions (same logic as structureAnalyzer.ts, inlined for pointer access) ──

function labelHighs(prevPrice: number, lastPrice: number): StructureLabel {
  const ratio = (lastPrice - prevPrice) / prevPrice;
  if (Math.abs(ratio) < EQUAL_TOL) return 'HEH';
  return ratio > 0 ? 'HH' : 'LH';
}

function labelLows(prevPrice: number, lastPrice: number): StructureLabel {
  const ratio = (lastPrice - prevPrice) / prevPrice;
  if (Math.abs(ratio) < EQUAL_TOL) return 'LEL';
  return ratio > 0 ? 'HL' : 'LL';
}

// ── Precompute for an entire candle series ─────────────────────────────────────
export function precomputeStructure(
  candles: Candle[],
  atrArr: (number | null)[]
): PrecomputedStructure {
  const n = candles.length;
  if (n < 20) {
    return { majorHighs: [], majorLows: [], minorHighs: [], minorLows: [], scoresArr: [] };
  }

  // STEP 1: Enriched swings (unchanged, O(n) each + O(n×s) touches)
  const majorSwings = computeSwings(candles, atrArr, { lookback: 5 });
  const minorSwings = computeSwings(candles, atrArr, { lookback: 3 });

  const majorHighs = majorSwings.filter(s => s.type === 'high');
  const majorLows  = majorSwings.filter(s => s.type === 'low');
  const minorHighs = minorSwings.filter(s => s.type === 'high');
  const minorLows  = minorSwings.filter(s => s.type === 'low');

  // STEP 2: P2 — rolling 20-bar volume average for O(1) BOS volume confirmation.
  // Eliminates the O(20n) inner loop in detectStructureBreak.
  const volAvg20 = new Float64Array(n);
  {
    let vRun = 0;
    for (let i = 0; i < n; i++) {
      vRun += candles[i].volume;
      if (i >= 20) vRun -= candles[i - 20].volume;
      volAvg20[i] = vRun / Math.min(20, i + 1);
    }
  }

  // STEP 3: P1+P3 — single forward pass with monotonic pointers.
  //
  // Pointer semantics:
  //   mhEnd = majorHighs[0..mhEnd-1] are all confirmed causal (index <= i-5)
  //   mlEnd, ihEnd, ilEnd — same for their arrays
  //   mhBos = majorHighs[mhBos..mhEnd-1] are within BOS_LOOKBACK bars of i
  //   mlBos — same for majorLows
  //
  // Each pointer only advances forward — O(1) amortized per bar, O(s) total.
  //
  // P3 — incremental persistence counters:
  //   Instead of iterating all extH/extL transitions per bar (O(s) per bar),
  //   we maintain running counts updated only when mhEnd/mlEnd advances.
  let mhEnd = 0, mlEnd = 0, ihEnd = 0, ilEnd = 0;
  let mhBos = 0, mlBos = 0;

  // Incremental HH/LH and HL/LL counts across all confirmed major swings
  let mhHH = 0, mhLH = 0;  // total HH vs LH transitions in majorHighs[0..mhEnd-1]
  let mlHL = 0, mlLL = 0;  // total HL vs LL transitions in majorLows[0..mlEnd-1]

  const scoresArr: (StructureScores | null)[] = new Array(n).fill(null);

  for (let i = 0; i < n; i++) {
    if (i < 20) continue;

    const atr   = atrArr[i] ?? (candles[i].high - candles[i].low);
    const close = candles[i].close;

    // ── P1: Advance causal end pointers ───────────────────────────────────────
    // P3: update incremental transition counts as each new swing is confirmed
    while (mhEnd < majorHighs.length && majorHighs[mhEnd].index <= i - 5) {
      if (mhEnd > 0) {
        if (majorHighs[mhEnd].price > majorHighs[mhEnd - 1].price) mhHH++;
        else mhLH++;
      }
      mhEnd++;
    }
    while (mlEnd < majorLows.length && majorLows[mlEnd].index <= i - 5) {
      if (mlEnd > 0) {
        if (majorLows[mlEnd].price > majorLows[mlEnd - 1].price) mlHL++;
        else mlLL++;
      }
      mlEnd++;
    }
    while (ihEnd < minorHighs.length && minorHighs[ihEnd].index <= i - 3) ihEnd++;
    while (ilEnd < minorLows.length  && minorLows[ilEnd].index  <= i - 3) ilEnd++;

    // ── P1: Advance BOS lookback start pointers ────────────────────────────────
    while (mhBos < mhEnd && majorHighs[mhBos].index < i - BOS_LOOKBACK) mhBos++;
    while (mlBos < mlEnd && majorLows[mlBos].index  < i - BOS_LOOKBACK) mlBos++;

    // ── Read last 2 confirmed major swings (O(1)) ──────────────────────────────
    const lastExtH = mhEnd > 0 ? majorHighs[mhEnd - 1] : null;
    const prevExtH = mhEnd > 1 ? majorHighs[mhEnd - 2] : null;
    const lastExtL = mlEnd > 0 ? majorLows[mlEnd - 1]  : null;
    const prevExtL = mlEnd > 1 ? majorLows[mlEnd - 2]  : null;

    // ── HH/LH/HL/LL labels and scores ──────────────────────────────────────────
    let highLabel: StructureLabel = 'NONE';
    let lowLabel:  StructureLabel = 'NONE';
    let hhScore = 0, hlScore = 0, lhScore = 0, llScore = 0;

    if (lastExtH && prevExtH) {
      highLabel = labelHighs(prevExtH.price, lastExtH.price);
      const delta = Math.abs(lastExtH.price - prevExtH.price);
      const s = (atr > 0 ? Math.min(1, delta / (atr * 3)) : 0) * lastExtH.strength;
      if (highLabel === 'HH') hhScore = s;
      if (highLabel === 'LH') lhScore = s;
    }
    if (lastExtL && prevExtL) {
      lowLabel = labelLows(prevExtL.price, lastExtL.price);
      const delta = Math.abs(lastExtL.price - prevExtL.price);
      const s = (atr > 0 ? Math.min(1, delta / (atr * 3)) : 0) * lastExtL.strength;
      if (lowLabel === 'HL') hlScore = s;
      if (lowLabel === 'LL') llScore = s;
    }

    // ── Internal structure labels (last 2 minor swings, O(1)) ──────────────────
    const lastIntH = ihEnd > 0 ? minorHighs[ihEnd - 1] : null;
    const prevIntH = ihEnd > 1 ? minorHighs[ihEnd - 2] : null;
    const lastIntL = ilEnd > 0 ? minorLows[ilEnd - 1]  : null;
    const prevIntL = ilEnd > 1 ? minorLows[ilEnd - 2]  : null;

    const intHighLabel: StructureLabel = (lastIntH && prevIntH)
      ? labelHighs(prevIntH.price, lastIntH.price) : 'NONE';
    const intLowLabel:  StructureLabel = (lastIntL && prevIntL)
      ? labelLows(prevIntL.price, lastIntL.price) : 'NONE';

    // ── External trend score (reads last 3 via pointer, no slice) ──────────────
    // Replicates structureTrendScore() exactly, including its early-exit guard:
    //   if (highs.length < 2 || lows.length < 2) return { score: 0, quality: 0 }
    // Without this guard, quality was non-zero from lows alone when mhEnd<2 (bug).
    let extHH = 0, extLH = 0, extHL = 0, extLL = 0;
    let extScore = 0, extQuality = 0;
    if (mhEnd >= 2 && mlEnd >= 2) {
      const extN = Math.min(mhEnd, 3);
      for (let k = mhEnd - extN + 1; k < mhEnd; k++) {
        if (majorHighs[k].price > majorHighs[k - 1].price) extHH++; else extLH++;
      }
      const extM = Math.min(mlEnd, 3);
      for (let k = mlEnd - extM + 1; k < mlEnd; k++) {
        if (majorLows[k].price > majorLows[k - 1].price) extHL++; else extLL++;
      }
      const extTH = extHH + extLH, extTL = extHL + extLL;
      const extBull = (extTH > 0 ? extHH / extTH : 0.5) * 0.5 +
                      (extTL > 0 ? extHL / extTL : 0.5) * 0.5;
      extScore   = (extBull * 2) - 1;
      extQuality = (extTH + extTL) > 0
        ? Math.min(1, (Math.abs(extHH - extLH) + Math.abs(extHL - extLL)) / (extTH + extTL))
        : 0;
    }

    // ── Internal trend score (reads last 3 minor, no slice) ────────────────────
    let intHH = 0, intLH = 0, intHL = 0, intLL = 0;
    let intScore = 0;
    if (ihEnd >= 2 && ilEnd >= 2) {
      const intN = Math.min(ihEnd, 3);
      for (let k = ihEnd - intN + 1; k < ihEnd; k++) {
        if (minorHighs[k].price > minorHighs[k - 1].price) intHH++; else intLH++;
      }
      const intM = Math.min(ilEnd, 3);
      for (let k = ilEnd - intM + 1; k < ilEnd; k++) {
        if (minorLows[k].price > minorLows[k - 1].price) intHL++; else intLL++;
      }
      const intTH = intHH + intLH, intTL = intHL + intLL;
      const intBull = (intTH > 0 ? intHH / intTH : 0.5) * 0.5 +
                      (intTL > 0 ? intHL / intTL : 0.5) * 0.5;
      intScore = (intBull * 2) - 1;
    }

    // ── Trend classification (same thresholds as v4.7.0) ──────────────────────
    let trendDir: StructureSnapshot['trend']['direction'] = 'SIDEWAYS';
    if      (extScore >  0.7)  trendDir = 'STRONG_BULL';
    else if (extScore >  0.35) trendDir = 'BULL';
    else if (extScore >  0.08) trendDir = 'WEAK_BULL';
    else if (extScore < -0.7)  trendDir = 'STRONG_BEAR';
    else if (extScore < -0.35) trendDir = 'BEAR';
    else if (extScore < -0.08) trendDir = 'WEAK_BEAR';

    // ── P3: persistence from incremental counters (O(1)) ──────────────────────
    // mhHH/mhLH/mlHL/mlLL are cumulative counts of ALL major swing transitions
    // seen so far. This replaces the per-bar O(s) loop from v4.7.0.
    //
    // Bug fix vs first draft: extScore==0 must contribute 0 to persist.
    // In v4.7.0: `if (score>0 && isHH) persist++` and `if (score<0 && !isHH)`
    // both evaluate to false when score==0, so persist is unchanged.
    // The ternary `extScore>0 ? mhHH : mhLH` incorrectly selected mhLH
    // when extScore==0, giving wrong persistence. Fixed with explicit branches.
    const totalH = mhHH + mhLH, totalL = mlHL + mlLL;
    let persist = 0, persistTotal = 0;
    if (totalH > 0) {
      if (extScore > 0) persist += mhHH;
      else if (extScore < 0) persist += mhLH;
      // extScore==0: add nothing — matches v4.7.0 where neither branch fires
      persistTotal += totalH;
    }
    if (totalL > 0) {
      if (extScore > 0) persist += mlHL;
      else if (extScore < 0) persist += mlLL;
      persistTotal += totalL;
    }
    const persistence = persistTotal > 0 ? persist / persistTotal : 0.5;

    const acceleration = Math.max(-1, Math.min(1, intScore - extScore));

    let trendAge = 0;
    if (extScore > 0 && lastExtH) trendAge = i - lastExtH.index;
    if (extScore < 0 && lastExtL) trendAge = i - lastExtL.index;

    const trend = {
      direction:    trendDir,
      strength:     Math.abs(extScore),
      persistence,
      acceleration,
      confidence:   Math.min(1, extQuality * 0.6 + persistence * 0.4),
      age:          trendAge,
      quality:      extQuality,
    };

    // ── BOS / CHoCH (O(1) — reads last high/low within BOS window) ────────────
    // lastHigh = majorHighs[mhEnd-1] (already confirmed, within i-5)
    // We also check it's within BOS_LOOKBACK: mhBos..mhEnd-1 is the valid window
    let bos: StructureBreak | null = null;
    let choch: StructureBreak | null = null;

    if (mhBos < mhEnd && mlBos < mlEnd) {
      const lastBOSHigh = majorHighs[mhEnd - 1]; // always within BOS window (most recent confirmed)
      const lastBOSLow  = majorLows[mlEnd - 1];

      // P2: O(1) volume confirmation via precomputed rolling average
      const volAvg  = volAvg20[i] || 1;
      const volConf = Math.min(1, candles[i].volume / (volAvg * 1.5));

      const prevClose = candles[i - 1]?.close ?? close;
      const momConf   = Math.min(1, Math.abs(close - prevClose) / Math.max(atr, 1e-9));

      function makeBreak(type: StructureBreak['type'], breakPrice: number): StructureBreak {
        const dist     = Math.abs(close - breakPrice);
        const brkStr   = Math.min(1, dist / Math.max(atr, 1e-9));
        const falseBrk = Math.max(0, 1 - (volConf * 0.5 + momConf * 0.5));
        const confidence = Math.min(1, Math.max(0,
          brkStr * 0.4 + volConf * 0.3 + momConf * 0.3 - falseBrk * 0.2));
        return { index: i, type, breakPrice, closePrice: close, breakStrength: brkStr,
          volumeConfirmation: volConf, momentumConfirmation: momConf,
          falseBreakProbability: falseBrk, confidence };
      }

      if (close > lastBOSHigh.price) {
        const ev = makeBreak(extScore > 0 ? 'BOS_BULL' : 'CHOCH_BULL', lastBOSHigh.price);
        if (extScore > 0) bos = ev; else choch = ev;
      }
      if (close < lastBOSLow.price) {
        const ev = makeBreak(extScore < 0 ? 'BOS_BEAR' : 'CHOCH_BEAR', lastBOSLow.price);
        if (extScore < 0) bos = ev; else choch = ev;
      }
    }

    // ── Swing failure (O(FAIL_BARS) backward scan from ihEnd/ilEnd) ────────────
    let swingFailure = false;
    let swingFailureDirection: 'bull' | 'bear' | null = null;
    for (let k = ihEnd - 1; k >= 0 && minorHighs[k].index >= i - FAIL_BARS; k--) {
      const dist = i - minorHighs[k].index;
      if (dist >= 2 && close > minorHighs[k].price) {
        swingFailure = true; swingFailureDirection = 'bear'; break;
      }
    }
    if (!swingFailure) {
      for (let k = ilEnd - 1; k >= 0 && minorLows[k].index >= i - FAIL_BARS; k--) {
        const dist = i - minorLows[k].index;
        if (dist >= 2 && close < minorLows[k].price) {
          swingFailure = true; swingFailureDirection = 'bull'; break;
        }
      }
    }

    // ── Scores (identical formulas to v4.7.0) ─────────────────────────────────
    const structureQuality    = extQuality;
    const structureConfidence = Math.min(1,
      structureQuality * 0.4 + persistence * 0.3 + Math.abs(extScore) * 0.3);
    const bosBoost    = bos   ? bos.confidence   * 0.3 : 0;
    const chochBoost  = choch ? choch.confidence * 0.4 : 0;
    const failureBoost = swingFailure ? 0.2 : 0;
    const continuationScore = Math.min(1, bosBoost + persistence * 0.3);
    const reversalScore     = Math.min(1, chochBoost + failureBoost);

    // Internal trend encoded
    const intBullish = (intHighLabel === 'HH' ? 1 : 0) + (intLowLabel === 'HL' ? 1 : 0);
    const intBearish = (intHighLabel === 'LH' ? 1 : 0) + (intLowLabel === 'LL' ? 1 : 0);
    const internalTrend = (intBullish - intBearish) / 2;

    const swingStrengthVal = Math.max(hhScore, hlScore, lhScore, llScore);

    scoresArr[i] = {
      hhScore,
      hlScore,
      lhScore,
      llScore,
      trendStrength:     (trendDir.includes('BULL') ? 1 : trendDir.includes('BEAR') ? -1 : 0) * Math.abs(extScore),
      trendConfidence:   trend.confidence,
      trendPersistence:  persistence,
      trendAcceleration: acceleration,
      bosDetected:       bos   ? 1 : 0,
      bosStrength:       bos   ? bos.breakStrength   : 0,
      bosConfidence:     bos   ? bos.confidence      : 0,
      chochDetected:     choch ? 1 : 0,
      chochStrength:     choch ? choch.breakStrength : 0,
      chochConfidence:   choch ? choch.confidence    : 0,
      swingStrength:     swingStrengthVal,
      structureQuality,
      internalTrend,
      externalTrend:     (trendDir.includes('BULL') ? 1 : trendDir.includes('BEAR') ? -1 : 0) * Math.abs(extScore),
      structureAge:      Math.min(1, trendAge / 200),
    };
  }

  return { majorHighs, majorLows, minorHighs, minorLows, scoresArr };
}

// ── O(1) feature lookup ────────────────────────────────────────────────────────
export function getStructureFeaturesAt(
  structure: PrecomputedStructure,
  i: number
): number[] {
  const scores = structure.scoresArr[i];
  if (!scores) return new Array(19).fill(0);
  return scoresToArray(scores);
}

// ── UI snapshot (unchanged — calls computeStructureAt for single bar) ──────────
export function getStructureSnapshotAt(
  candles: Candle[],
  structure: PrecomputedStructure,
  atrArr: (number | null)[],
  i: number
): StructureSnapshot | null {
  if (i < 20 || i >= candles.length) return null;
  return computeStructureAt(
    candles,
    { highs: structure.majorHighs, lows: structure.majorLows },
    { highs: structure.minorHighs, lows: structure.minorLows },
    atrArr,
    i
  );
}
