// ─────────────────────────────────────────────────────────────────────────────
// STRUCTURE ANALYZER
// Computes HH/HL/LH/LL labels with quantified scores, BOS/CHoCH detection,
// swing failure, internal vs external structure, and structure continuation/
// reversal scores.
//
// MATHEMATICAL DEFINITIONS (for correctness audit):
//   HH  — latest swing high > previous swing high
//   HL  — latest swing low  > previous swing low
//   LH  — latest swing high < previous swing high
//   LL  — latest swing low  < previous swing low
//   HEH — latest swing high within EQUAL_TOL of previous (not clearly HH or LH)
//   LEL — latest swing low  within EQUAL_TOL of previous (not clearly HL or LL)
//   BOS — close price breaks BEYOND the most recent swing level IN THE DIRECTION
//         of the prevailing trend (continuation)
//   CHoCH — close price breaks BEYOND the most recent swing level AGAINST the
//            prevailing trend (counter-trend — first sign of reversal)
//   SwingFailure — a swing high that gets taken out within FAIL_BARS bars (bull trap)
//                  a swing low  that gets taken out within FAIL_BARS bars (bear trap)
//
// All detection uses CLOSE prices (not wicks) for BOS/CHoCH confirmation.
// All detection is causal: at bar i, only candles[0..i] are used.
// ─────────────────────────────────────────────────────────────────────────────
import { Candle } from '../indicators';
import { Swing, StructureLabel, StructureBreak, StructureSnapshot } from './structureTypes';

const EQUAL_TOL  = 0.001; // 0.1% — swing is "equal" if within this fraction
const FAIL_BARS  = 5;     // a swing fails if invalidated within 5 bars of confirmation
const BOS_LOOKBACK = 60;  // only consider BOS/CHoCH within last 60 bars

// ── Label two consecutive swing highs ─────────────────────────────────────────
function labelHighs(prev: Swing, last: Swing): StructureLabel {
  const ratio = (last.price - prev.price) / prev.price;
  if (Math.abs(ratio) < EQUAL_TOL) return 'HEH';
  return ratio > 0 ? 'HH' : 'LH';
}
function labelLows(prev: Swing, last: Swing): StructureLabel {
  const ratio = (last.price - prev.price) / prev.price;
  if (Math.abs(ratio) < EQUAL_TOL) return 'LEL';
  return ratio > 0 ? 'HL' : 'LL';
}

// ── Structure strength: normalised distance between consecutive swings ─────────
function swingDeltaStrength(prev: Swing, last: Swing, atr: number): number {
  const delta = Math.abs(last.price - prev.price);
  return atr > 0 ? Math.min(1, delta / (atr * 3)) : 0;
}

// ── Trend direction from swing sequence ───────────────────────────────────────
// External trend: from the last 3 swing highs and last 3 swing lows.
// Requires at least 2 highs AND 2 lows to classify. Returns -1..+1.
function structureTrendScore(
  highs: Swing[], lows: Swing[], atr: number
): { score: number; quality: number } {
  if (highs.length < 2 || lows.length < 2) return { score: 0, quality: 0 };

  const n = Math.min(highs.length, 3);
  const m = Math.min(lows.length, 3);
  const recentHighs = highs.slice(-n);
  const recentLows  = lows.slice(-m);

  // Count HH vs LH among the last n-1 high transitions
  let hhCount = 0, lhCount = 0;
  for (let k = 1; k < recentHighs.length; k++) {
    if (recentHighs[k].price > recentHighs[k-1].price) hhCount++;
    else lhCount++;
  }

  // Count HL vs LL among the last m-1 low transitions
  let hlCount = 0, llCount = 0;
  for (let k = 1; k < recentLows.length; k++) {
    if (recentLows[k].price > recentLows[k-1].price) hlCount++;
    else llCount++;
  }

  const totalH = hhCount + lhCount, totalL = hlCount + llCount;
  const bullRatio = (totalH > 0 ? hhCount / totalH : 0.5) * 0.5 +
                    (totalL > 0 ? hlCount / totalL : 0.5) * 0.5;

  const score   = (bullRatio * 2) - 1; // -1..+1
  const quality = Math.min(1, (Math.abs(hhCount - lhCount) + Math.abs(hlCount - llCount)) /
                              Math.max(1, totalH + totalL));
  return { score, quality };
}

// ── Detect BOS/CHoCH at bar i (causal — only uses candles[0..i]) ──────────────
function detectStructureBreak(
  candles: Candle[],
  highs: Swing[],
  lows: Swing[],
  trendScore: number,
  i: number,
  atrArr: (number | null)[]
): { bos: StructureBreak | null; choch: StructureBreak | null } {
  if (highs.length < 1 || lows.length < 1) return { bos: null, choch: null };

  const atr    = atrArr[i] ?? (candles[i].high - candles[i].low);
  const close  = candles[i].close;
  const recentHighs = highs.filter(s => i - s.index <= BOS_LOOKBACK);
  const recentLows  = lows.filter(s => i - s.index <= BOS_LOOKBACK);
  if (!recentHighs.length || !recentLows.length) return { bos: null, choch: null };

  const lastHigh = recentHighs[recentHighs.length - 1];
  const lastLow  = recentLows[recentLows.length - 1];

  // Volume confirmation at bar i
  let volSum = 0;
  for (let k = Math.max(0, i - 19); k <= i; k++) volSum += candles[k].volume;
  const volAvg = volSum / Math.min(20, i + 1);
  const volConf = Math.min(1, candles[i].volume / (volAvg * 1.5));

  // Momentum confirmation: rate of change at break bar
  const prevClose  = candles[i - 1]?.close ?? close;
  const momConf    = Math.min(1, Math.abs(close - prevClose) / Math.max(atr, 1e-9));

  function makeBreak(
    type: StructureBreak['type'], breakPrice: number
  ): StructureBreak {
    const dist   = Math.abs(close - breakPrice);
    const brkStr = Math.min(1, dist / Math.max(atr, 1e-9));
    // False break probability: higher if volume is low and momentum is weak
    const falseBrk = Math.max(0, 1 - (volConf * 0.5 + momConf * 0.5));
    const confidence = Math.max(0, brkStr * 0.4 + volConf * 0.3 + momConf * 0.3 - falseBrk * 0.2);
    return { index: i, type, breakPrice, closePrice: close, breakStrength: brkStr,
      volumeConfirmation: volConf, momentumConfirmation: momConf,
      falseBreakProbability: falseBrk, confidence: Math.min(1, confidence) };
  }

  let bos: StructureBreak | null = null;
  let choch: StructureBreak | null = null;

  // BULLISH break: close > last swing HIGH
  if (close > lastHigh.price) {
    const isBull = trendScore > 0;
    const ev = makeBreak(isBull ? 'BOS_BULL' : 'CHOCH_BULL', lastHigh.price);
    if (isBull) bos  = ev; else choch = ev;
  }
  // BEARISH break: close < last swing LOW
  if (close < lastLow.price) {
    const isBear = trendScore < 0;
    const ev = makeBreak(isBear ? 'BOS_BEAR' : 'CHOCH_BEAR', lastLow.price);
    if (isBear) bos  = ev; else choch = ev;
  }

  return { bos, choch };
}

// ── Swing failure: a swing high taken out within FAIL_BARS ────────────────────
// At bar i, we look at swings confirmed at [i-FAIL_BARS..i-lookback].
// A high-swing fails if its price was exceeded by close within FAIL_BARS bars.
// A low-swing fails if its price was undercut by close within FAIL_BARS bars.
function detectSwingFailure(
  candles: Candle[], highs: Swing[], lows: Swing[], i: number
): { failure: boolean; direction: 'bull' | 'bear' | null } {
  const close = candles[i].close;
  // Look at the most recent high — did close exceed it within FAIL_BARS?
  const recentH = highs.filter(s => i - s.index <= FAIL_BARS && i - s.index >= 2).slice(-1)[0];
  const recentL = lows.filter(s => i - s.index <= FAIL_BARS && i - s.index >= 2).slice(-1)[0];
  if (recentH && close > recentH.price) return { failure: true, direction: 'bear' }; // bear trap: high broken quickly
  if (recentL && close < recentL.price) return { failure: true, direction: 'bull' }; // bull trap: low broken quickly
  return { failure: false, direction: null };
}

// ── Main: compute full structure snapshot at bar i ────────────────────────────
export function computeStructureAt(
  candles: Candle[],
  majorSwings: { highs: Swing[]; lows: Swing[] }, // lookback=5 (external)
  minorSwings: { highs: Swing[]; lows: Swing[] }, // lookback=3 (internal)
  atrArr: (number | null)[],
  i: number
): StructureSnapshot {
  const null_snap: StructureSnapshot = {
    highLabel: 'NONE', lowLabel: 'NONE',
    hhScore: 0, hlScore: 0, lhScore: 0, llScore: 0,
    trend: { direction: 'SIDEWAYS', strength: 0, persistence: 0, acceleration: 0,
             confidence: 0, age: 0, quality: 0 },
    latestBOS: null, latestCHoCH: null,
    externalHighLabel: 'NONE', externalLowLabel: 'NONE',
    internalHighLabel: 'NONE', internalLowLabel: 'NONE',
    swingFailure: false, swingFailureDirection: null,
    continuationScore: 0.5, reversalScore: 0.5,
    structureQuality: 0, structureConfidence: 0, structureAge: 0};
  if (i < 20) return null_snap;

  const atr = atrArr[i] ?? (candles[i].high - candles[i].low);

  // ── External (major) structure ─────────────────────────────────────────────
  const extH = majorSwings.highs.filter(s => s.index <= i - 5);
  const extL = majorSwings.lows.filter(s => s.index <= i - 5);

  // ── Internal (minor) structure ────────────────────────────────────────────
  const intH = minorSwings.highs.filter(s => s.index <= i - 3);
  const intL = minorSwings.lows.filter(s => s.index <= i - 3);

  // Labels and scores for the external (primary) structure
  const lastExtH  = extH[extH.length - 1];
  const prevExtH  = extH[extH.length - 2];
  const lastExtL  = extL[extL.length - 1];
  const prevExtL  = extL[extL.length - 2];

  let highLabel: StructureLabel = 'NONE';
  let lowLabel:  StructureLabel = 'NONE';
  let hhScore = 0, hlScore = 0, lhScore = 0, llScore = 0;

  if (lastExtH && prevExtH) {
    highLabel = labelHighs(prevExtH, lastExtH);
    const s = swingDeltaStrength(prevExtH, lastExtH, atr) * lastExtH.strength;
    if (highLabel === 'HH') hhScore = s;
    if (highLabel === 'LH') lhScore = s;
  }
  if (lastExtL && prevExtL) {
    lowLabel = labelLows(prevExtL, lastExtL);
    const s = swingDeltaStrength(prevExtL, lastExtL, atr) * lastExtL.strength;
    if (lowLabel === 'HL') hlScore = s;
    if (lowLabel === 'LL') llScore = s;
  }

  // Internal structure labels
  const lastIntH  = intH[intH.length - 1];
  const prevIntH  = intH[intH.length - 2];
  const lastIntL  = intL[intL.length - 1];
  const prevIntL  = intL[intL.length - 2];
  const intHighLabel: StructureLabel = (lastIntH && prevIntH) ? labelHighs(prevIntH, lastIntH) : 'NONE';
  const intLowLabel:  StructureLabel = (lastIntL && prevIntL) ? labelLows(prevIntL, lastIntL) : 'NONE';

  // ── Trend from structure ───────────────────────────────────────────────────
  const extTrend = structureTrendScore(extH, extL, atr);
  const intTrend = structureTrendScore(intH, intL, atr);

  // Trend classification
  const score = extTrend.score;
  let trendDirection: StructureSnapshot['trend']['direction'] = 'SIDEWAYS';
  if (score >  0.7) trendDirection = 'STRONG_BULL';
  else if (score >  0.35) trendDirection = 'BULL';
  else if (score >  0.08) trendDirection = 'WEAK_BULL';
  else if (score < -0.7) trendDirection = 'STRONG_BEAR';
  else if (score < -0.35) trendDirection = 'BEAR';
  else if (score < -0.08) trendDirection = 'WEAK_BEAR';

  // Persistence: how many consecutive bars has the structure maintained direction
  // Proxy: proportion of last 20 bars where ema is above/below
  // We don't have EMA here, so use the swing sequence: count consecutive matching labels
  // For each external high/low transition, check if it matches the trend direction
  let persist = 0, persistTotal = 0;
  if (extH.length >= 2) {
    for (let k = 1; k < extH.length; k++) {
      const isHH = extH[k].price > extH[k-1].price;
      if (score > 0 && isHH) persist++;
      if (score < 0 && !isHH) persist++;
      persistTotal++;
    }
  }
  if (extL.length >= 2) {
    for (let k = 1; k < extL.length; k++) {
      const isHL = extL[k].price > extL[k-1].price;
      if (score > 0 && isHL) persist++;
      if (score < 0 && !isHL) persist++;
      persistTotal++;
    }
  }
  const persistence = persistTotal > 0 ? persist / persistTotal : 0.5;

  // Acceleration: is internal trend stronger or weaker than external?
  const acceleration = Math.max(-1, Math.min(1, intTrend.score - extTrend.score));

  // Trend age: bars since the most recent swing that confirmed current trend
  let trendAge = 0;
  if (score > 0 && lastExtH) trendAge = i - lastExtH.index;
  if (score < 0 && lastExtL) trendAge = i - lastExtL.index;

  const trend = {
    direction: trendDirection,
    strength:    Math.abs(score),
    persistence: persistence,
    acceleration: acceleration,
    confidence:  Math.min(1, extTrend.quality * 0.6 + persistence * 0.4),
    age:         trendAge,
    quality:     extTrend.quality};

  // ── BOS / CHoCH at bar i ──────────────────────────────────────────────────
  const { bos, choch } = detectStructureBreak(candles, extH, extL, extTrend.score, i, atrArr);

  // ── Swing failure ─────────────────────────────────────────────────────────
  const { failure: swingFailure, direction: swingFailureDirection } =
    detectSwingFailure(candles, intH, intL, i);

  // ── Structure Age ─────────────────────────────────────────────────────────
  const structureAge = trendAge;

  // ── Continuation vs Reversal ──────────────────────────────────────────────
  const chochBoost    = choch ? choch.confidence * 0.4 : 0;
  const bosBoost      = bos   ? bos.confidence   * 0.3 : 0;
  const failureBoost  = swingFailure ? 0.2 : 0;
  const reversalScore = Math.min(1, chochBoost + failureBoost);
  const continuationScore = Math.min(1, bosBoost + persistence * 0.3);

  // ── Quality ───────────────────────────────────────────────────────────────
  const structureQuality    = extTrend.quality;
  const structureConfidence = Math.min(1,
    structureQuality * 0.4 + persistence * 0.3 + Math.abs(score) * 0.3);

  return {
    highLabel, lowLabel,
    hhScore, hlScore, lhScore, llScore,
    trend,
    latestBOS:  bos,
    latestCHoCH: choch,
    externalHighLabel: highLabel,
    externalLowLabel:  lowLabel,
    internalHighLabel: intHighLabel,
    internalLowLabel:  intLowLabel,
    swingFailure, swingFailureDirection,
    continuationScore, reversalScore,
    structureQuality, structureConfidence, structureAge};
}
