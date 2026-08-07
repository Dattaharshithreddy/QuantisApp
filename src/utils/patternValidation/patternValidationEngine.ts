// ─────────────────────────────────────────────────────────────────────────────
// PATTERN VALIDATION ENGINE  (v6.3.18)
//
// Evaluates every detected geometry through 8 independent validation components.
// Each component returns a 0–1 score + reasons + failed conditions.
// The weighted composite (0–100) is the pattern confidence.
//
// REUSES WITHOUT MODIFICATION:
//   marketStructure.ts → detectSwings, classifyStructure, detectBOSCHoCH, detectTrendDirection
//   technicalIndicators.ts → rsiSeries, macd, adx, atr, obv, cmf, relativeVolume
//   candlePatterns.ts → detectPatterns
//   chartPatterns.ts → PatternResult (geometry input, never recomputed)
//
// CREATES NOTHING DUPLICATED from existing engines.
// ─────────────────────────────────────────────────────────────────────────────

import { Candle } from '../indicators';
import { PatternResult } from '../chartPatterns';
import { detectPatterns } from '../candlePatterns';
import { detectSwings, classifyStructure, detectBOSCHoCH, detectTrendDirection } from '../marketStructure';
import {
  rsiSeries, macd, adx as adxFn, atr as atrFn,
  obv as obvFn, cmf as cmfFn, relativeVolume,
  ema, sma,
} from '../technicalIndicators';
import {
  ValidationComponent, ValidationBreakdown, VALIDATION_WEIGHTS,
  BreakoutState, RetestState, PatternValidationContext,
} from './patternValidationTypes';

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function clamp(v: number, lo = 0, hi = 1): number {
  return Math.max(lo, Math.min(hi, v));
}

function makeComponent(
  name:    string,
  weight:  number,
  raw:     number,
  reasons: string[],
  failed:  string[],
): ValidationComponent {
  const clamped = clamp(raw);
  return {
    name,
    weight,
    rawScore:      clamped,
    weightedScore: Math.round(clamped * weight * 100 * 10) / 10,
    reasons,
    failedConditions: failed};
}

// 20-bar volume average (O(n) rolling, same as swingEngine.ts)
function vol20Avg(candles: Candle[], bar: number): number {
  const start = Math.max(0, bar - 19);
  let sum = 0;
  for (let i = start; i <= bar; i++) sum += candles[i].volume;
  return sum / (bar - start + 1) || 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPONENT 1 — TREND (weight 0.15)
// Evaluates prior trend, market structure, BOS, CHoCH, trend strength
// REUSES: detectSwings, classifyStructure, detectBOSCHoCH, detectTrendDirection
// ─────────────────────────────────────────────────────────────────────────────
function scoreTrend(
  candles:    Candle[],
  bar:        number,
  direction:  'bullish' | 'bearish' | 'neutral',
  ctx:        PatternValidationContext,
): ValidationComponent {
  const reasons: string[]  = [];
  const failed:  string[]  = [];
  const slice    = candles.slice(0, bar + 1);
  const swings   = detectSwings(slice, 4);
  const struct   = classifyStructure(swings);

  // Market structure alignment
  const bullishStruct = struct.highs === 'HH' && struct.lows === 'HL';
  const bearishStruct = struct.highs === 'LH' && struct.lows === 'LL';

  let structScore = 0;
  if (direction === 'bullish') {
    if (bullishStruct) { structScore = 1.0; reasons.push('HH/HL structure confirms uptrend'); }
    else if (struct.lows === 'HL') { structScore = 0.6; reasons.push('Higher lows present'); }
    else { failed.push('No bullish market structure'); }
  } else if (direction === 'bearish') {
    if (bearishStruct) { structScore = 1.0; reasons.push('LH/LL structure confirms downtrend'); }
    else if (struct.highs === 'LH') { structScore = 0.6; reasons.push('Lower highs present'); }
    else { failed.push('No bearish market structure'); }
  } else {
    structScore = 0.5; // neutral patterns score 50% for trend
  }

  // BOS / CHoCH confirmation
  const bosEvents = detectBOSCHoCH(slice, swings);
  const recentBOS = bosEvents.filter(e => bar - e.index <= 20);
  const hasBullBOS = recentBOS.some(e => e.type === 'BOS_BULL');
  const hasBearBOS = recentBOS.some(e => e.type === 'BOS_BEAR');
  const hasCHoCH   = recentBOS.some(e => e.type.startsWith('CHOCH'));

  let bosScore = 0;
  if (direction === 'bullish' && hasBullBOS) { bosScore = 0.3; reasons.push('Recent bullish BOS confirms momentum'); }
  else if (direction === 'bearish' && hasBearBOS) { bosScore = 0.3; reasons.push('Recent bearish BOS confirms momentum'); }
  else if (hasCHoCH) {
    bosScore = 0.15;
    const chochDir = recentBOS.find(e => e.type.startsWith('CHOCH'))?.type;
    reasons.push(`CHoCH detected (${chochDir}) — potential reversal building`);
  } else {
    failed.push('No recent BOS/CHoCH confirming direction');
  }

  // EMA trend alignment using existing ema() from technicalIndicators
  const closes = candles.slice(0, bar + 1).map(c => c.close);
  const ema20  = ema(closes, 20);
  const ema50  = ema(closes, 50);
  const trend  = detectTrendDirection(slice, ema20, ema50);
  let trendScore = 0;
  if (direction === 'bullish' && trend === 'UPTREND') {
    trendScore = 0.3; reasons.push('EMA20 > EMA50: uptrend aligned');
  } else if (direction === 'bearish' && trend === 'DOWNTREND') {
    trendScore = 0.3; reasons.push('EMA20 < EMA50: downtrend aligned');
  } else if (trend === 'RANGING') {
    trendScore = 0.15; // neutral regime — penalize slightly
    failed.push('Ranging market — trend not clearly established');
  } else {
    failed.push('EMA trend opposes pattern direction');
  }

  const raw = clamp(structScore * 0.4 + bosScore + trendScore);
  return makeComponent('Trend', VALIDATION_WEIGHTS.trend, raw, reasons, failed);
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPONENT 2 — VOLUME (weight 0.20)
// Evaluates breakout volume, relative volume, OBV confirmation, CMF
// REUSES: obv, cmf, relativeVolume from technicalIndicators
// ─────────────────────────────────────────────────────────────────────────────
function scoreVolume(
  candles:    Candle[],
  bar:        number,
  direction:  'bullish' | 'bearish' | 'neutral',
  breakout:   BreakoutState,
  ctx:        PatternValidationContext,
): ValidationComponent {
  const reasons: string[] = [];
  const failed:  string[] = [];
  const slice    = candles.slice(0, bar + 1);

  // Relative volume at breakout
  let rvScore = 0;
  if (breakout.hasBreakout && breakout.volumeAtBreakout != null) {
    const rv = breakout.volumeAtBreakout;
    if (rv >= 2.0) { rvScore = 1.0; reasons.push(`Volume spike at breakout: ${rv.toFixed(1)}× average`); }
    else if (rv >= 1.5) { rvScore = 0.8; reasons.push(`Above-average breakout volume: ${rv.toFixed(1)}×`); }
    else if (rv >= 1.0) { rvScore = 0.5; reasons.push(`Average volume at breakout: ${rv.toFixed(1)}×`); }
    else { rvScore = 0.2; failed.push(`Weak breakout volume: ${rv.toFixed(1)}× average`); }
  } else if (!breakout.hasBreakout) {
    rvScore = 0.3; // pre-breakout, neutral
  } else {
    failed.push('Volume data unavailable at breakout');
    rvScore = 0.3;
  }

  // OBV trend confirmation (reuse existing obvFn from technicalIndicators)
  const precomp = ctx.precomputed;
  const obvArr  = precomp?.obv ?? obvFn(slice);
  let obvScore  = 0;
  if (obvArr.length >= 10) {
    const latest   = obvArr[obvArr.length - 1];
    const prev10   = obvArr[Math.max(0, obvArr.length - 11)];
    const obvRising = latest > prev10;
    const obvFalling = latest < prev10;
    if (direction === 'bullish' && obvRising) {
      obvScore = 1.0; reasons.push('OBV rising — institutional accumulation');
    } else if (direction === 'bearish' && obvFalling) {
      obvScore = 1.0; reasons.push('OBV falling — institutional distribution');
    } else if (direction === 'neutral') {
      obvScore = 0.5;
    } else {
      failed.push('OBV diverges from pattern direction');
      obvScore = 0.0;
    }
  }

  // CMF confirmation (reuse existing cmfFn from technicalIndicators)
  const cmfArr  = precomp?.cmf ?? cmfFn(slice);
  let cmfScore  = 0;
  const cmfLast = cmfArr[cmfArr.length - 1];
  if (cmfLast != null) {
    if (direction === 'bullish' && cmfLast > 0.05) {
      cmfScore = 1.0; reasons.push(`CMF positive (${cmfLast.toFixed(2)}) — buying pressure`);
    } else if (direction === 'bearish' && cmfLast < -0.05) {
      cmfScore = 1.0; reasons.push(`CMF negative (${cmfLast.toFixed(2)}) — selling pressure`);
    } else if (Math.abs(cmfLast) <= 0.05) {
      cmfScore = 0.4; failed.push('CMF near zero — neutral money flow');
    } else {
      cmfScore = 0.0; failed.push(`CMF opposes direction (${cmfLast.toFixed(2)})`);
    }
  }

  const raw = clamp(rvScore * 0.50 + obvScore * 0.30 + cmfScore * 0.20);
  return makeComponent('Volume', VALIDATION_WEIGHTS.volume, raw, reasons, failed);
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPONENT 3 — BREAKOUT (weight 0.20)
// Evaluates breakout quality: close-based, ATR strength, no wick-only, no false break
// ─────────────────────────────────────────────────────────────────────────────
function scoreBreakout(
  breakout:  BreakoutState,
  atr:       number,
  direction: 'bullish' | 'bearish' | 'neutral',
): ValidationComponent {
  const reasons: string[] = [];
  const failed:  string[] = [];

  if (!breakout.hasBreakout) {
    failed.push('No breakout detected yet — pattern awaiting confirmation');
    return makeComponent('Breakout', VALIDATION_WEIGHTS.breakout, 0.1, reasons, failed);
  }

  if (breakout.falseBreakout) {
    failed.push('False breakout: close returned inside pattern within 3 bars');
    return makeComponent('Breakout', VALIDATION_WEIGHTS.breakout, 0, reasons, failed);
  }

  if (!breakout.isCloseBreakout) {
    failed.push('Wick-only breakout — close did not confirm the level');
    return makeComponent('Breakout', VALIDATION_WEIGHTS.breakout, 0.1, reasons, failed);
  }

  reasons.push('Close-based breakout confirmed');

  // Strength: how far the close is beyond the level (in ATR units)
  const strength = breakout.breakoutStrength;
  let strengthScore = 0;
  if (strength >= 0.75) { strengthScore = 1.0; reasons.push('Strong breakout: close well beyond level'); }
  else if (strength >= 0.50) { strengthScore = 0.8; reasons.push('Solid breakout strength'); }
  else if (strength >= 0.30) { strengthScore = 0.6; reasons.push('Adequate breakout strength'); }
  else { strengthScore = 0.3; failed.push('Marginal breakout — barely cleared the level'); }

  const raw = clamp(0.40 + strengthScore * 0.60); // base score for having a valid close breakout
  return makeComponent('Breakout', VALIDATION_WEIGHTS.breakout, raw, reasons, failed);
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPONENT 4 — RETEST (weight 0.15)
// Evaluates retest quality — successful bounce raises confidence, failed retest fails pattern
// ─────────────────────────────────────────────────────────────────────────────
function scoreRetest(retest: RetestState): ValidationComponent {
  const reasons: string[] = [];
  const failed:  string[] = [];

  if (!retest.hasRetest) {
    // No retest yet — neutral (pattern may not have had time)
    reasons.push('No retest yet — awaiting pullback to breakout level');
    return makeComponent('Retest', VALIDATION_WEIGHTS.retest, 0.4, reasons, failed);
  }

  if (retest.retestFailed) {
    failed.push('Retest failed: price closed back through breakout level');
    return makeComponent('Retest', VALIDATION_WEIGHTS.retest, 0, reasons, failed);
  }

  if (retest.retestSuccess) {
    reasons.push('Successful retest: price bounced from breakout level — converts to new support/resistance');
    return makeComponent('Retest', VALIDATION_WEIGHTS.retest, 1.0, reasons, failed);
  }

  return makeComponent('Retest', VALIDATION_WEIGHTS.retest, 0.4, reasons, failed);
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPONENT 5 — MOMENTUM (weight 0.10)
// RSI, MACD, ADX, EMA alignment — reuses existing technicalIndicators functions
// ─────────────────────────────────────────────────────────────────────────────
function scoreMomentum(
  candles:    Candle[],
  bar:        number,
  direction:  'bullish' | 'bearish' | 'neutral',
  ctx:        PatternValidationContext,
): ValidationComponent {
  const reasons: string[] = [];
  const failed:  string[] = [];
  const slice    = candles.slice(0, bar + 1);
  const precomp  = ctx.precomputed;

  // RSI (reuse existing rsiSeries from technicalIndicators)
  const rsiArr  = rsiSeries(slice);
  const rsiVal  = precomp?.rsi ?? rsiArr[rsiArr.length - 1];
  let rsiScore  = 0;
  if (rsiVal != null) {
    if (direction === 'bullish') {
      if (rsiVal >= 50 && rsiVal <= 70) { rsiScore = 1.0; reasons.push(`RSI ${rsiVal.toFixed(0)}: bullish momentum zone`); }
      else if (rsiVal >= 40 && rsiVal < 50) { rsiScore = 0.5; reasons.push(`RSI ${rsiVal.toFixed(0)}: recovering from neutral`); }
      else if (rsiVal > 70) { rsiScore = 0.4; failed.push(`RSI ${rsiVal.toFixed(0)}: overbought — potential resistance`); }
      else { rsiScore = 0.2; failed.push(`RSI ${rsiVal.toFixed(0)}: weak bullish momentum`); }
    } else if (direction === 'bearish') {
      if (rsiVal <= 50 && rsiVal >= 30) { rsiScore = 1.0; reasons.push(`RSI ${rsiVal.toFixed(0)}: bearish momentum zone`); }
      else if (rsiVal > 50 && rsiVal <= 60) { rsiScore = 0.5; reasons.push(`RSI ${rsiVal.toFixed(0)}: rolling over from neutral`); }
      else if (rsiVal < 30) { rsiScore = 0.4; failed.push(`RSI ${rsiVal.toFixed(0)}: oversold — potential support`); }
      else { rsiScore = 0.2; failed.push(`RSI ${rsiVal.toFixed(0)}: weak bearish momentum`); }
    } else {
      rsiScore = 0.5;
    }
  }

  // MACD histogram (reuse existing macd() from technicalIndicators)
  const macdResult = macd(slice);
  const macdHist   = precomp?.macdHist ?? macdResult.hist[macdResult.hist.length - 1];
  let macdScore    = 0;
  if (macdHist != null) {
    if (direction === 'bullish' && macdHist > 0) { macdScore = 1.0; reasons.push('MACD histogram bullish'); }
    else if (direction === 'bearish' && macdHist < 0) { macdScore = 1.0; reasons.push('MACD histogram bearish'); }
    else { macdScore = 0.0; failed.push('MACD histogram opposes direction'); }
  }

  // ADX trend strength (reuse existing adx() from technicalIndicators)
  const adxArr  = adxFn(slice);
  const adxVal  = precomp?.adxValue ?? adxArr[adxArr.length - 1];
  let adxScore  = 0;
  if (adxVal != null) {
    if (adxVal >= 40) { adxScore = 1.0; reasons.push(`ADX ${adxVal.toFixed(0)}: very strong trend`); }
    else if (adxVal >= 25) { adxScore = 0.8; reasons.push(`ADX ${adxVal.toFixed(0)}: strong trend`); }
    else if (adxVal >= 18) { adxScore = 0.5; reasons.push(`ADX ${adxVal.toFixed(0)}: developing trend`); }
    else { adxScore = 0.2; failed.push(`ADX ${adxVal.toFixed(0)}: weak trend — pattern may fail in choppy market`); }
  }

  const raw = clamp(rsiScore * 0.40 + macdScore * 0.35 + adxScore * 0.25);
  return makeComponent('Momentum', VALIDATION_WEIGHTS.momentum, raw, reasons, failed);
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPONENT 6 — CANDLESTICK (weight 0.05)
// Rewards strong candles at breakout; penalizes doji, spinning tops, long wicks
// REUSES: detectPatterns from candlePatterns.ts
// ─────────────────────────────────────────────────────────────────────────────
function scoreCandlestick(
  candles:    Candle[],
  bar:        number,
  direction:  'bullish' | 'bearish' | 'neutral',
  breakout:   BreakoutState,
): ValidationComponent {
  const reasons: string[] = [];
  const failed:  string[] = [];

  // Use the last 3 candles at/around the breakout bar
  const refBar   = breakout.breakoutBar ?? bar;
  const end      = Math.min(refBar + 1, candles.length);
  const start    = Math.max(0, end - 3);
  const slice3   = candles.slice(start, end);
  if (slice3.length < 1) return makeComponent('Candlestick', VALIDATION_WEIGHTS.candlestick, 0.5, reasons, failed);

  const patterns = detectPatterns(slice3); // reuses candlePatterns.ts
  const last     = slice3[slice3.length - 1];

  let raw = 0.5; // neutral baseline

  // Check body quality of the breakout candle directly
  const body      = Math.abs(last.close - last.open);
  const range     = (last.high - last.low) || 0.0001;
  const bodyRatio = body / range;

  // Marubozu or strong momentum candle
  if (bodyRatio >= 0.75) {
    raw = 1.0;
    reasons.push(`Strong breakout candle (body ${(bodyRatio * 100).toFixed(0)}% of range)`);
  } else if (bodyRatio >= 0.55) {
    raw = 0.75;
    reasons.push('Solid candle body at breakout');
  } else if (bodyRatio < 0.15) {
    raw = 0.1;
    failed.push('Doji/Spinning Top at breakout — indecision');
  } else {
    raw = 0.45;
  }

  // Pattern bonuses/penalties from existing detector
  for (const p of patterns) {
    if ((direction === 'bullish') && p.bullish === true) {
      raw = Math.min(1, raw + 0.15);
      reasons.push(`${p.name} at breakout — confirms bullish intent`);
    } else if ((direction === 'bearish') && p.bullish === false) {
      raw = Math.min(1, raw + 0.15);
      reasons.push(`${p.name} at breakout — confirms bearish intent`);
    } else if (p.name === 'Doji' || p.name === 'Pin Bar (bearish)') {
      raw = Math.max(0, raw - 0.2);
      failed.push(`${p.name} detected — weakens breakout conviction`);
    }
  }

  return makeComponent('Candlestick', VALIDATION_WEIGHTS.candlestick, clamp(raw), reasons, failed);
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPONENT 7 — SUPPORT / RESISTANCE (weight 0.10)
// Checks OB alignment, FVG, VWAP, S/R levels near breakout
// REUSES: pre-computed SMC/FVG values from PatternValidationContext when available
// ─────────────────────────────────────────────────────────────────────────────
function scoreSupportResistance(
  candles:        Candle[],
  bar:            number,
  direction:      'bullish' | 'bearish' | 'neutral',
  breakoutLevel:  number | null,
  atr:            number,
  ctx:            PatternValidationContext,
): ValidationComponent {
  const reasons: string[] = [];
  const failed:  string[] = [];
  const precomp  = ctx.precomputed;
  const price    = candles[Math.min(bar, candles.length - 1)].close;
  let raw        = 0.3; // baseline when no SMC data available

  // VWAP alignment
  if (precomp?.vwap != null) {
    const vwapGap = Math.abs(price - precomp.vwap);
    if (direction === 'bullish' && price > precomp.vwap) {
      reasons.push('Price above VWAP — institutional bias bullish');
      raw += 0.15;
    } else if (direction === 'bearish' && price < precomp.vwap) {
      reasons.push('Price below VWAP — institutional bias bearish');
      raw += 0.15;
    } else {
      failed.push('Price on wrong side of VWAP for this direction');
    }
  }

  // Order Block proximity (from SMC engine, pre-computed)
  if (precomp?.nearestOBHigh != null && precomp?.nearestOBLow != null) {
    const obHigh = precomp.nearestOBHigh;
    const obLow  = precomp.nearestOBLow;
    const nearOB = price >= obLow - atr && price <= obHigh + atr;
    if (direction === 'bullish' && nearOB && price >= obLow) {
      reasons.push('Price at/above bullish Order Block — institutional support');
      raw += 0.25;
    } else if (direction === 'bearish' && nearOB && price <= obHigh) {
      reasons.push('Price at/below bearish Order Block — institutional resistance');
      raw += 0.25;
    }
  }

  // FVG alignment (from FVG engine, pre-computed)
  if (direction === 'bullish' && precomp?.fvgBullishLevel != null) {
    const fvgDist = Math.abs(price - precomp.fvgBullishLevel);
    if (fvgDist <= atr * 1.5) {
      reasons.push(`Bullish FVG at ${precomp.fvgBullishLevel.toFixed(2)} — magnet for price`);
      raw += 0.20;
    }
  }
  if (direction === 'bearish' && precomp?.fvgBearishLevel != null) {
    const fvgDist = Math.abs(price - precomp.fvgBearishLevel);
    if (fvgDist <= atr * 1.5) {
      reasons.push(`Bearish FVG at ${precomp.fvgBearishLevel.toFixed(2)} — magnet for price`);
      raw += 0.20;
    }
  }

  // Breakout level is near a key level (self-reinforcing)
  if (breakoutLevel != null) {
    const levelDist = Math.abs(price - breakoutLevel);
    if (levelDist <= atr * 0.3) {
      reasons.push('Price testing breakout level — key validation zone');
      raw += 0.10;
    }
  }

  return makeComponent('Support/Resistance', VALIDATION_WEIGHTS.supportResist, clamp(raw), reasons, failed);
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPONENT 8 — PATTERN QUALITY (weight 0.05)
// Evaluates geometry properties: symmetry, touches, duration, neckline quality
// REUSES: PatternResult fields directly from geometry detector
// ─────────────────────────────────────────────────────────────────────────────
function scorePatternQuality(geometry: PatternResult): ValidationComponent {
  const reasons: string[] = [];
  const failed:  string[] = [];

  const keyPts = geometry.keyPoints ?? [];

  // Geometry strength (from existing detector)
  let raw = clamp(geometry.strength);

  // Number of key points (more = more complex and reliable geometry)
  if (keyPts.length >= 5) { reasons.push(`Rich geometry: ${keyPts.length} key points`); raw = Math.min(1, raw + 0.15); }
  else if (keyPts.length >= 3) { reasons.push(`Geometry: ${keyPts.length} key points`); }
  else { failed.push('Simple geometry with few key points'); }

  // Has both a target and a stop level (complete pattern)
  if (geometry.target != null && geometry.stopLevel != null) {
    reasons.push('Pattern has defined target and stop level');
    raw = Math.min(1, raw + 0.10);
  } else if (geometry.target == null) {
    failed.push('No pattern target defined');
    raw = Math.max(0, raw - 0.10);
  }

  // Strong geometry score from the detector
  if (geometry.strength >= 0.75) {
    reasons.push('High geometry strength from detector');
  } else if (geometry.strength < 0.35) {
    failed.push('Weak geometry strength — pattern poorly formed');
    raw = Math.max(0, raw - 0.15);
  }

  return makeComponent('Pattern Quality', VALIDATION_WEIGHTS.patternQuality, clamp(raw), reasons, failed);
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API — compute all 8 components and return the breakdown + total score
// ─────────────────────────────────────────────────────────────────────────────
export function computeValidationBreakdown(
  geometry:       PatternResult,
  breakoutLevel:  number | null,
  breakout:       BreakoutState,
  retest:         RetestState,
  ctx:            PatternValidationContext,
): { breakdown: ValidationBreakdown; totalConfidence: number } {
  const { candles, currentBar, atr } = ctx;

  const trend         = scoreTrend(candles, currentBar, geometry.direction, ctx);
  const volume        = scoreVolume(candles, currentBar, geometry.direction, breakout, ctx);
  const breakoutComp  = scoreBreakout(breakout, atr, geometry.direction);
  const retest_       = scoreRetest(retest);
  const momentum      = scoreMomentum(candles, currentBar, geometry.direction, ctx);
  const candlestick   = scoreCandlestick(candles, currentBar, geometry.direction, breakout);
  const suppRes       = scoreSupportResistance(candles, currentBar, geometry.direction, breakoutLevel, atr, ctx);
  const quality       = scorePatternQuality(geometry);

  const breakdown: ValidationBreakdown = {
    trend,
    volume,
    breakout:       breakoutComp,
    retest:         retest_,
    momentum,
    candlestick,
    supportResist:  suppRes,
    patternQuality: quality};

  // Weighted sum → 0–100
  const totalConfidence = Math.round(
    Object.values(breakdown).reduce((sum, comp) => sum + comp.weightedScore, 0)
  );

  return { breakdown, totalConfidence: Math.min(100, Math.max(0, totalConfidence)) };
}
