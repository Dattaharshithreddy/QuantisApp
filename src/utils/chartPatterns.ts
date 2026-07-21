import { Candle } from './indicators';
import { detectSwings, SwingPoint } from './marketStructure';

export type PatternKeyPoint = { barIndex: number; price: number; role: string };

export type PatternResult = {
  name: string;
  direction: 'bullish' | 'bearish' | 'neutral';
  strength: number;
  score: number;
  target?: number;
  stopLevel?: number;
  keyPoints?: PatternKeyPoint[];   // geometry for SVG overlay; never used by ML
};

export type ChartPatternSummary = {
  patterns: PatternResult[];
  compositeScore: number;
  triangleScore: number;
  flagScore: number;
  doubleTopBottomScore: number;
  headShouldersScore: number;
  wedgeScore: number;
  channelScore: number;
  supportScore: number;
  resistanceScore: number;
};

function clamp(v: number, lo = 0, hi = 1): number {
  return Math.max(lo, Math.min(hi, v));
}

function linReg(pts: { x: number; y: number }[]): { slope: number; intercept: number; r2: number } {
  const n = pts.length;
  if (n < 2) return { slope: 0, intercept: pts[0]?.y ?? 0, r2: 0 };
  const sx  = pts.reduce((s, p) => s + p.x, 0);
  const sy  = pts.reduce((s, p) => s + p.y, 0);
  const sxy = pts.reduce((s, p) => s + p.x * p.y, 0);
  const sxx = pts.reduce((s, p) => s + p.x * p.x, 0);
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-12) return { slope: 0, intercept: sy / n, r2: 0 };
  const slope     = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  const yMean = sy / n;
  const ssTot = pts.reduce((s, p) => s + (p.y - yMean) ** 2, 0);
  const ssRes = pts.reduce((s, p) => s + (p.y - (slope * p.x + intercept)) ** 2, 0);
  const r2 = ssTot > 1e-12 ? 1 - ssRes / ssTot : 1;
  return { slope, intercept, r2 };
}

function detectTriangle(
  highs: SwingPoint[], lows: SwingPoint[], currentBar: number, currentPrice: number, atr: number
): PatternResult | null {
  const recentHighs = highs.filter(s => currentBar - s.index <= 80 && currentBar - s.index >= 5).slice(-4);
  const recentLows  = lows.filter(s => currentBar - s.index <= 80 && currentBar - s.index >= 5).slice(-4);
  if (recentHighs.length < 3 || recentLows.length < 3) return null;

  const upper = linReg(recentHighs.map(s => ({ x: s.index, y: s.price })));
  const lower = linReg(recentLows.map(s => ({ x: s.index, y: s.price })));
  if (upper.r2 < 0.5 || lower.r2 < 0.5) return null;

  const upperNow = upper.slope * currentBar + upper.intercept;
  const lowerNow = lower.slope * currentBar + lower.intercept;
  if (upperNow <= lowerNow) return null;

  const width = upperNow - lowerNow;
  if (width > 0.12 * currentPrice) return null;

  // Apex: intersection of upper and lower regression lines.
  // Formula: (lower.intercept - upper.intercept) / (upper.slope - lower.slope)
  // is algebraically identical to audit's proposed "fix" — no change needed.
  const apexBar = upper.slope !== lower.slope
    ? (lower.intercept - upper.intercept) / (upper.slope - lower.slope)
    : currentBar + 999;
  const barsToApex = apexBar - currentBar;
  if (barsToApex <= 0 || barsToApex > 50) return null;

  const compressionScore = clamp(1 - width / (4 * atr));

  // Slope as %/bar — correct and asset-agnostic (audit claim of bug was wrong)
  const upperSlope = upper.slope / (currentPrice / 100);
  const lowerSlope = lower.slope / (currentPrice / 100);

  const oldest = Math.min(...recentHighs.map(s => s.index), ...recentLows.map(s => s.index));
  const heightAtStart =
    (upper.slope * oldest + upper.intercept) - (lower.slope * oldest + lower.intercept);
  // FIX: guard negative height (pathological case where regression lines are disordered at oldest bar)
  if (heightAtStart <= 0) return null;

  const midNow = (upperNow + lowerNow) / 2;
  const target = currentPrice > midNow ? upperNow + heightAtStart : lowerNow - heightAtStart;

  if (Math.abs(upperSlope) < 0.015 && lowerSlope > 0.01) {
    return { name: 'Ascending Triangle', direction: 'bullish', strength: compressionScore, score: compressionScore, target, stopLevel: lowerNow,
      keyPoints: [
        { barIndex: oldest, price: upper.slope * oldest + upper.intercept, role: 'upperStart' },
        { barIndex: currentBar, price: upperNow, role: 'upperEnd' },
        { barIndex: oldest, price: lower.slope * oldest + lower.intercept, role: 'lowerStart' },
        { barIndex: currentBar, price: lowerNow, role: 'lowerEnd' },
      ] };

  }
  if (upperSlope < -0.01 && Math.abs(lowerSlope) < 0.015) {
    return { name: 'Descending Triangle', direction: 'bearish', strength: compressionScore, score: -compressionScore, target, stopLevel: upperNow,
      keyPoints: [
        { barIndex: oldest, price: upper.slope * oldest + upper.intercept, role: 'upperStart' },
        { barIndex: currentBar, price: upperNow, role: 'upperEnd' },
        { barIndex: oldest, price: lower.slope * oldest + lower.intercept, role: 'lowerStart' },
        { barIndex: currentBar, price: lowerNow, role: 'lowerEnd' },
      ] };

  }
  if (upperSlope < -0.005 && lowerSlope > 0.005) {
    const breakDir = currentPrice > midNow ? 1 : -1;
    return { name: 'Symmetrical Triangle', direction: 'neutral', strength: compressionScore, score: clamp(compressionScore * 0.5 * breakDir, -1, 1), target, stopLevel: breakDir > 0 ? lowerNow : upperNow,
      keyPoints: [
        { barIndex: oldest, price: upper.slope * oldest + upper.intercept, role: 'upperStart' },
        { barIndex: currentBar, price: upperNow, role: 'upperEnd' },
        { barIndex: oldest, price: lower.slope * oldest + lower.intercept, role: 'lowerStart' },
        { barIndex: currentBar, price: lowerNow, role: 'lowerEnd' },
      ] };
  }
  return null;
}

function detectFlagPennant(candles: Candle[], i: number, atr: number): PatternResult | null {
  if (i < 25) return null;
  const POLE_BARS = [5, 7, 10, 12];
  const FLAG_MIN  = 5;
  const FLAG_MAX  = 18;

  let best: PatternResult | null = null;
  let bestStrength = 0;

  for (const poleLen of POLE_BARS) {
    for (let flagStart = i - FLAG_MAX; flagStart <= i - FLAG_MIN; flagStart++) {
      const poleEnd   = flagStart;
      const poleBegin = poleEnd - poleLen;
      if (poleBegin < 0) continue;

      const poleSlice = candles.slice(poleBegin, poleEnd + 1);
      const poleHigh  = poleSlice.reduce((m, c) => Math.max(m, c.high), -Infinity);
      const poleLow   = poleSlice.reduce((m, c) => Math.min(m, c.low),   Infinity);
      const poleMove  = (poleHigh - poleLow) / poleLow;
      if (poleMove < 0.03) continue;

      const isBullPole   = candles[poleEnd].close > candles[poleBegin].close;
      const flagCandles  = candles.slice(flagStart, i + 1);
      if (flagCandles.length < FLAG_MIN) continue;

      const flagHigh = flagCandles.reduce((m, c) => Math.max(m, c.high), -Infinity);
      const flagLow  = flagCandles.reduce((m, c) => Math.min(m, c.low),   Infinity);
      const flagRetracement = (flagHigh - flagLow) / (poleHigh - poleLow);
      if (flagRetracement < 0.1 || flagRetracement > 0.65) continue;

      const flagSlope    = (flagCandles[flagCandles.length - 1].close - flagCandles[0].close) / flagCandles.length;
      const counterTrend = isBullPole ? flagSlope < 0 : flagSlope > 0;
      if (!counterTrend) continue;

      const sampledH = flagCandles.filter((_, k) => k % 3 === 0).map((c, k) => ({ x: k, y: c.high }));
      const sampledL = flagCandles.filter((_, k) => k % 3 === 0).map((c, k) => ({ x: k, y: c.low }));
      const uReg = linReg(sampledH);
      const lReg = linReg(sampledL);

      // FIX (CRITICAL): bear pennant was checking uReg.slope>0 && lReg.slope<0
      // (diverging shape). A pennant always converges: upper slopes DOWN, lower slopes UP.
      const isPennant  = uReg.slope < 0 && lReg.slope > 0;
      const name       = isPennant ? (isBullPole ? 'Bull Pennant' : 'Bear Pennant') : (isBullPole ? 'Bull Flag' : 'Bear Flag');
      const target     = isBullPole ? candles[i].close + (poleHigh - poleLow) : candles[i].close - (poleHigh - poleLow);
      const stopLevel  = isBullPole ? flagLow : flagHigh;
      const strength   = clamp(Math.min(1, poleMove * 5) * (1 - flagRetracement));

      if (strength <= bestStrength) continue;
      bestStrength = strength;
      best = { name, direction: isBullPole ? 'bullish' : 'bearish', strength, score: clamp(isBullPole ? strength : -strength, -1, 1), target, stopLevel,
        keyPoints: [
          { barIndex: poleBegin, price: isBullPole ? poleLow : poleHigh, role: 'poleBase' },
          { barIndex: poleEnd,   price: isBullPole ? poleHigh : poleLow, role: 'poleTip' },
          { barIndex: flagStart, price: flagCandles[0].high, role: 'flagStart' },
          { barIndex: i,         price: flagCandles[flagCandles.length - 1].close, role: 'flagEnd' },
        ] };
    }
  }
  return best;
}

function detectDoubleTopBottom(
  highs: SwingPoint[], lows: SwingPoint[], candles: Candle[], i: number
): PatternResult | null {
  const LOOKBACK  = 80;
  const TOLERANCE = 0.025;
  const MIN_GAP   = 5;
  const price     = candles[i].close;
  const recentHighs = highs.filter(s => i - s.index <= LOOKBACK && i - s.index >= 3);
  const recentLows  = lows.filter(s => i - s.index <= LOOKBACK && i - s.index >= 3);

  let best: PatternResult | null = null;
  let bestStrength = 0;

  // FIX: scan ALL pairs of swing highs instead of only the last two
  for (let a = 0; a < recentHighs.length - 1; a++) {
    for (let b = a + 1; b < recentHighs.length; b++) {
      const h1 = recentHighs[a], h2 = recentHighs[b];
      if (h2.index - h1.index < MIN_GAP) continue;
      if (Math.abs(h1.price - h2.price) / h1.price >= TOLERANCE) continue;
      const between  = lows.filter(s => s.index > h1.index && s.index < h2.index);
      if (between.length === 0) continue;
      const neckline = between.reduce((m, s) => Math.min(m, s.price), Infinity);
      const height   = (h1.price + h2.price) / 2 - neckline;
      if (height <= 0) continue;
      const raw     = clamp(height / (price * 0.03));
      if (raw <= 0.3) continue;
      const confirmed = price < neckline;
      const strength  = clamp(confirmed ? raw * 1.3 : raw * 0.7);
      if (strength <= bestStrength) continue;
      bestStrength = strength;
      best = { name: 'Double Top', direction: 'bearish', strength, score: -strength, target: neckline - height, stopLevel: (h1.price + h2.price) / 2,
        keyPoints: [
          { barIndex: h1.index, price: h1.price, role: 'top1' },
          { barIndex: h2.index, price: h2.price, role: 'top2' },
          { barIndex: h1.index, price: neckline,  role: 'necklineLeft' },
          { barIndex: h2.index, price: neckline,  role: 'necklineRight' },
        ] };
    }
  }

  for (let a = 0; a < recentLows.length - 1; a++) {
    for (let b = a + 1; b < recentLows.length; b++) {
      const l1 = recentLows[a], l2 = recentLows[b];
      if (l2.index - l1.index < MIN_GAP) continue;
      if (Math.abs(l1.price - l2.price) / l1.price >= TOLERANCE) continue;
      const between  = highs.filter(s => s.index > l1.index && s.index < l2.index);
      if (between.length === 0) continue;
      const neckline = between.reduce((m, s) => Math.max(m, s.price), -Infinity);
      const height   = neckline - (l1.price + l2.price) / 2;
      if (height <= 0) continue;
      const raw     = clamp(height / (price * 0.03));
      if (raw <= 0.3) continue;
      const confirmed = price > neckline;
      const strength  = clamp(confirmed ? raw * 1.3 : raw * 0.7);
      if (strength <= bestStrength) continue;
      bestStrength = strength;
      best = { name: 'Double Bottom', direction: 'bullish', strength, score: strength, target: neckline + height, stopLevel: (l1.price + l2.price) / 2,
        keyPoints: [
          { barIndex: l1.index, price: l1.price, role: 'bottom1' },
          { barIndex: l2.index, price: l2.price, role: 'bottom2' },
          { barIndex: l1.index, price: neckline,  role: 'necklineLeft' },
          { barIndex: l2.index, price: neckline,  role: 'necklineRight' },
        ] };
    }
  }
  return best;
}

function detectHeadAndShoulders(
  highs: SwingPoint[], lows: SwingPoint[], candles: Candle[], i: number
): PatternResult | null {
  const LOOKBACK     = 120;
  const SHOULDER_TOL = 0.04;
  const HEAD_MARGIN  = 0.015;
  const price        = candles[i].close;
  const recentHighs  = highs.filter(s => i - s.index <= LOOKBACK && i - s.index >= 3);
  const recentLows   = lows.filter(s => i - s.index <= LOOKBACK && i - s.index >= 3);

  if (recentHighs.length >= 3) {
    const n  = recentHighs.length;
    const ls = recentHighs[n - 3], head = recentHighs[n - 2], rs = recentHighs[n - 1];
    const shoulderDiff = Math.abs(ls.price - rs.price) / ls.price;
    const headAbove    = (head.price - Math.max(ls.price, rs.price)) / Math.max(ls.price, rs.price);
    if (shoulderDiff < SHOULDER_TOL && headAbove > HEAD_MARGIN) {
      const leftTroughs  = lows.filter(s => s.index > ls.index   && s.index < head.index);
      const rightTroughs = lows.filter(s => s.index > head.index  && s.index < rs.index);
      if (leftTroughs.length > 0 && rightTroughs.length > 0) {
        const nl1 = leftTroughs.reduce((a, b)  => a.price < b.price ? a : b);
        const nl2 = rightTroughs.reduce((a, b) => a.price < b.price ? a : b);
        // FIX: sloped neckline evaluated at head bar (for height) and current bar (for confirmation/target)
        const span   = nl2.index - nl1.index;
        const neckAt = (bar: number) => span !== 0
          ? nl1.price + (nl2.price - nl1.price) * (bar - nl1.index) / span
          : (nl1.price + nl2.price) / 2;
        const neckAtHead    = neckAt(head.index);
        const neckAtCurrent = neckAt(i);
        const patternHeight = head.price - neckAtHead;
        if (patternHeight <= 0) return null;
        const strength  = clamp(clamp(headAbove * 10) * clamp(1 - shoulderDiff * 10));
        const confirmed = price < neckAtCurrent;
        return {
          name: 'Head & Shoulders', direction: 'bearish',
          strength: clamp(confirmed ? strength * 1.4 : strength * 0.7),
          score:   -clamp(confirmed ? strength * 1.4 : strength * 0.7),
          target: neckAtCurrent - patternHeight, stopLevel: head.price,
          keyPoints: [
            { barIndex: ls.index,   price: ls.price,   role: 'leftShoulder' },
            { barIndex: nl1.index,  price: nl1.price,  role: 'necklineLeft' },
            { barIndex: head.index, price: head.price,  role: 'head' },
            { barIndex: nl2.index,  price: nl2.price,  role: 'necklineRight' },
            { barIndex: rs.index,   price: rs.price,   role: 'rightShoulder' },
          ],
        };
      }
    }
  }

  if (recentLows.length >= 3) {
    const n  = recentLows.length;
    const ls = recentLows[n - 3], head = recentLows[n - 2], rs = recentLows[n - 1];
    const shoulderDiff = Math.abs(ls.price - rs.price) / ls.price;
    const headBelow    = (Math.min(ls.price, rs.price) - head.price) / Math.min(ls.price, rs.price);
    if (shoulderDiff < SHOULDER_TOL && headBelow > HEAD_MARGIN) {
      const leftPeaks  = highs.filter(s => s.index > ls.index   && s.index < head.index);
      const rightPeaks = highs.filter(s => s.index > head.index  && s.index < rs.index);
      if (leftPeaks.length > 0 && rightPeaks.length > 0) {
        const nl1 = leftPeaks.reduce((a, b)  => a.price > b.price ? a : b);
        const nl2 = rightPeaks.reduce((a, b) => a.price > b.price ? a : b);
        const span   = nl2.index - nl1.index;
        const neckAt = (bar: number) => span !== 0
          ? nl1.price + (nl2.price - nl1.price) * (bar - nl1.index) / span
          : (nl1.price + nl2.price) / 2;
        const neckAtHead    = neckAt(head.index);
        const neckAtCurrent = neckAt(i);
        const patternHeight = neckAtHead - head.price;
        if (patternHeight <= 0) return null;
        const strength  = clamp(clamp(headBelow * 10) * clamp(1 - shoulderDiff * 10));
        const confirmed = price > neckAtCurrent;
        return {
          name: 'Inverse Head & Shoulders', direction: 'bullish',
          strength: clamp(confirmed ? strength * 1.4 : strength * 0.7),
          score:     clamp(confirmed ? strength * 1.4 : strength * 0.7),
          target: neckAtCurrent + patternHeight, stopLevel: head.price,
          keyPoints: [
            { barIndex: ls.index,   price: ls.price,   role: 'leftShoulder' },
            { barIndex: nl1.index,  price: nl1.price,  role: 'necklineLeft' },
            { barIndex: head.index, price: head.price,  role: 'head' },
            { barIndex: nl2.index,  price: nl2.price,  role: 'necklineRight' },
            { barIndex: rs.index,   price: rs.price,   role: 'rightShoulder' },
          ],
        };
      }
    }
  }
  return null;
}

function detectWedge(
  highs: SwingPoint[], lows: SwingPoint[], candles: Candle[], i: number
): PatternResult | null {
  const recentHighs = highs.filter(s => i - s.index <= 60 && i - s.index >= 5).slice(-4);
  const recentLows  = lows.filter(s => i - s.index <= 60 && i - s.index >= 5).slice(-4);
  if (recentHighs.length < 3 || recentLows.length < 3) return null;

  const upper = linReg(recentHighs.map(s => ({ x: s.index, y: s.price })));
  const lower = linReg(recentLows.map(s => ({ x: s.index, y: s.price })));
  if (upper.r2 < 0.5 || lower.r2 < 0.5) return null;

  const price  = candles[i].close;
  const normU  = upper.slope / price * 1000;
  const normL  = lower.slope / price * 1000;
  // FIX: removed `converging` variable (dead code — computed but never used)
  const bothUp   = normU > 0.2 && normL > 0.2;
  const bothDown = normU < -0.2 && normL < -0.2;
  if (!bothUp && !bothDown) return null;

  const upperNow = upper.slope * i + upper.intercept;
  const lowerNow = lower.slope * i + lower.intercept;
  const width    = Math.abs(upperNow - lowerNow);
  const compressionScore = clamp(1 - width / (price * 0.06));
  if (compressionScore < 0.2) return null;

  if (bothUp && upper.slope < lower.slope) {
    return { name: 'Rising Wedge', direction: 'bearish', strength: compressionScore, score: -compressionScore, target: lowerNow - width, stopLevel: upperNow,
      keyPoints: [
        { barIndex: recentHighs[0].index, price: upper.slope * recentHighs[0].index + upper.intercept, role: 'upperStart' },
        { barIndex: i, price: upper.slope * i + upper.intercept, role: 'upperEnd' },
        { barIndex: recentLows[0].index,  price: lower.slope * recentLows[0].index + lower.intercept,  role: 'lowerStart' },
        { barIndex: i, price: lower.slope * i + lower.intercept, role: 'lowerEnd' },
      ] };
  }
  if (bothDown && lower.slope < upper.slope) {
    return { name: 'Falling Wedge', direction: 'bullish', strength: compressionScore, score: compressionScore, target: upperNow + width, stopLevel: lowerNow,
      keyPoints: [
        { barIndex: recentHighs[0].index, price: upper.slope * recentHighs[0].index + upper.intercept, role: 'upperStart' },
        { barIndex: i, price: upper.slope * i + upper.intercept, role: 'upperEnd' },
        { barIndex: recentLows[0].index,  price: lower.slope * recentLows[0].index + lower.intercept,  role: 'lowerStart' },
        { barIndex: i, price: lower.slope * i + lower.intercept, role: 'lowerEnd' },
      ] };
  }
  return null;
}

function detectChannel(
  highs: SwingPoint[], lows: SwingPoint[], candles: Candle[], i: number
): PatternResult | null {
  const recentHighs = highs.filter(s => i - s.index <= 60 && i - s.index >= 5).slice(-4);
  const recentLows  = lows.filter(s => i - s.index <= 60 && i - s.index >= 5).slice(-4);
  if (recentHighs.length < 3 || recentLows.length < 3) return null;

  const upper = linReg(recentHighs.map(s => ({ x: s.index, y: s.price })));
  const lower = linReg(recentLows.map(s => ({ x: s.index, y: s.price })));
  if (upper.r2 < 0.55 || lower.r2 < 0.55) return null;

  const price = candles[i].close;
  // FIX: use average absolute slope as denominator (symmetric, handles mixed-sign slopes correctly)
  const avgAbsSlope = (Math.abs(upper.slope) + Math.abs(lower.slope)) / 2 || 1;
  const slopeDiff   = Math.abs(upper.slope - lower.slope) / avgAbsSlope;
  if (slopeDiff > 0.4) return null;

  const upperNow = upper.slope * i + upper.intercept;
  const lowerNow = lower.slope * i + lower.intercept;
  const channelWidth = upperNow - lowerNow;
  if (channelWidth <= 0) return null;

  const posInChannel = clamp((price - lowerNow) / channelWidth, -0.5, 1.5);
  const strength     = clamp((upper.r2 + lower.r2) / 2);
  // FIX: use average of both slopes for direction, not upper slope alone
  const avgSlope     = (upper.slope + lower.slope) / 2;
  const normAvg      = avgSlope / price * 1000;

  if (normAvg > 0.3) {
    const score = posInChannel < 0.3 ? strength : posInChannel > 0.7 ? -strength * 0.5 : strength * 0.3;
    return { name: 'Uptrend Channel', direction: 'bullish', strength, score: clamp(score, -1, 1), target: upperNow, stopLevel: lowerNow,
      keyPoints: [
        { barIndex: recentHighs[0].index, price: upper.slope * recentHighs[0].index + upper.intercept, role: 'upperStart' },
        { barIndex: i, price: upperNow, role: 'upperEnd' },
        { barIndex: recentLows[0].index,  price: lower.slope * recentLows[0].index + lower.intercept,  role: 'lowerStart' },
        { barIndex: i, price: lowerNow, role: 'lowerEnd' },
      ] };
  }
  if (normAvg < -0.3) {
    const score = posInChannel > 0.7 ? -strength : posInChannel < 0.3 ? strength * 0.5 : -strength * 0.3;
    return { name: 'Downtrend Channel', direction: 'bearish', strength, score: clamp(score, -1, 1), target: lowerNow, stopLevel: upperNow,
      keyPoints: [
        { barIndex: recentHighs[0].index, price: upper.slope * recentHighs[0].index + upper.intercept, role: 'upperStart' },
        { barIndex: i, price: upperNow, role: 'upperEnd' },
        { barIndex: recentLows[0].index,  price: lower.slope * recentLows[0].index + lower.intercept,  role: 'lowerStart' },
        { barIndex: i, price: lowerNow, role: 'lowerEnd' },
      ] };
  }
  return null;
}

function detectSupportResistance(
  highs: SwingPoint[], lows: SwingPoint[], candles: Candle[], i: number, atr: number
): { supportScore: number; resistanceScore: number; nearestSupport?: number; nearestResistance?: number } {
  const price    = candles[i].close;
  const ZONE     = atr * 1.5;
  const LOOKBACK = 150;
  const TOL      = 0.015;
  const MIN_TOUCHES = 2;
  const recentHighs = highs.filter(s => i - s.index <= LOOKBACK && s.index < i - 2);
  const recentLows  = lows.filter(s => i - s.index <= LOOKBACK && s.index < i - 2);

  // FIX: sort by price first for order-independent deterministic clustering
  function clusterLevels(points: SwingPoint[]): number[] {
    if (points.length === 0) return [];
    const sorted = [...points].sort((a, b) => a.price - b.price);
    const levels: number[] = [];
    let cluster = [sorted[0].price];
    for (let k = 1; k < sorted.length; k++) {
      const mean = cluster.reduce((s, v) => s + v, 0) / cluster.length;
      if (Math.abs(sorted[k].price - mean) / mean < TOL) {
        cluster.push(sorted[k].price);
      } else {
        if (cluster.length >= MIN_TOUCHES) levels.push(cluster.reduce((s, v) => s + v, 0) / cluster.length);
        cluster = [sorted[k].price];
      }
    }
    if (cluster.length >= MIN_TOUCHES) levels.push(cluster.reduce((s, v) => s + v, 0) / cluster.length);
    return levels;
  }

  const supportLevels    = clusterLevels(recentLows);
  const resistanceLevels = clusterLevels(recentHighs);
  const belowSupports    = supportLevels.filter(l => l < price);
  const nearestSupport   = belowSupports.length > 0 ? Math.max(...belowSupports) : undefined;
  const supportScore     = nearestSupport != null ? clamp(1 - (price - nearestSupport) / ZONE) : 0;
  const aboveRes         = resistanceLevels.filter(l => l > price);
  const nearestResistance = aboveRes.length > 0 ? Math.min(...aboveRes) : undefined;
  const resistanceScore  = nearestResistance != null ? clamp(1 - (nearestResistance - price) / ZONE) : 0;
  return { supportScore, resistanceScore, nearestSupport, nearestResistance };
}

function detectCupAndHandle(candles: Candle[], i: number): PatternResult | null {
  if (i < 45) return null;
  const HANDLE_BARS = 8;
  const CUP_LENS    = [30, 50, 70];

  for (const cupLen of CUP_LENS) {
    // FIX: cup and handle are now strictly contiguous — no overlap.
    // Handle = last HANDLE_BARS bars. Cup = cupLen bars immediately before handle.
    const handleStart = i - HANDLE_BARS + 1;
    const cupStart    = handleStart - cupLen;
    if (cupStart < 0) continue;

    const cupCandles    = candles.slice(cupStart, handleStart);
    const handleCandles = candles.slice(handleStart, i + 1);
    if (cupCandles.length < 20 || handleCandles.length < 4) continue;

    // FIX: cup rim = max of first and last 5 bars (not just first and last candle)
    const RIM = 5;
    const leftRim  = cupCandles.slice(0, RIM).reduce((m, c) => Math.max(m, c.high), -Infinity);
    const rightRim = cupCandles.slice(-RIM).reduce((m, c) => Math.max(m, c.high),   -Infinity);
    const cupHigh  = Math.max(leftRim, rightRim);
    const cupLow   = cupCandles.reduce((m, c) => Math.min(m, c.low), Infinity);
    const cupDepth = (cupHigh - cupLow) / cupHigh;
    if (cupDepth < 0.1 || cupDepth > 0.5) continue;

    const midIdx   = Math.floor(cupCandles.length / 2);
    const midSlice = cupCandles.slice(Math.max(0, midIdx - 3), midIdx + 3);
    if (midSlice.length === 0) continue;
    const midPrice = midSlice.reduce((s, c) => s + c.close, 0) / midSlice.length;
    if (midPrice > (cupHigh + cupLow) / 2) continue;

    const handleHigh = handleCandles.reduce((m, c) => Math.max(m, c.high), -Infinity);
    const handleLow  = handleCandles.reduce((m, c) => Math.min(m, c.low),   Infinity);
    const handleRetracement = (handleHigh - handleLow) / (cupHigh - cupLow);
    if (handleRetracement > 0.35) continue;
    if (handleLow < midPrice) continue;

    return {
      name: 'Cup & Handle', direction: 'bullish',
      strength: clamp((1 - handleRetracement) * (1 - cupDepth * 0.5)),
      score:    clamp((1 - handleRetracement) * (1 - cupDepth * 0.5)),
      target: cupHigh + (cupHigh - cupLow), stopLevel: handleLow,
      keyPoints: [
        { barIndex: cupStart,    price: cupHigh,  role: 'cupRimLeft' },
        { barIndex: cupStart + Math.floor(cupCandles.length / 2), price: cupLow, role: 'cupBottom' },
        { barIndex: handleStart - 1, price: cupHigh, role: 'cupRimRight' },
        { barIndex: handleStart, price: handleHigh, role: 'handleStart' },
        { barIndex: i,           price: handleCandles[handleCandles.length - 1].close, role: 'handleEnd' },
      ],
    };
  }
  return null;
}

// P0 #2: accepts optional pre-computed swing points (lookback=4) from
// precomputeSeries. When provided, detectSwings is NOT re-run — the
// causal window is enforced by the caller filtering s.index <= i-4.
// Falls back to internal detectSwings when called outside of training
// (e.g. from ChartScreen useMemo).
export function detectChartPatterns(
  candles: Candle[], i: number, atrAt: (idx: number) => number,
  precomputedHighs?: SwingPoint[], precomputedLows?: SwingPoint[]
): ChartPatternSummary {
  const slice = candles.slice(0, i + 1);
  const empty: ChartPatternSummary = {
    patterns: [], compositeScore: 0,
    triangleScore: 0, flagScore: 0, doubleTopBottomScore: 0,
    headShouldersScore: 0, wedgeScore: 0, channelScore: 0,
    supportScore: 0, resistanceScore: 0,
  };
  if (slice.length < 25) return empty;

  // P0 #2: use pre-computed swings when available (avoids O(n^2) re-detection
  // during training). The causal filter s.index <= i-4 is equivalent to what
  // detectSwings(slice, 4) produces — a swing at j needs bars j+1..j+4, so
  // j <= i-4 guarantees those bars exist at bar i. Proof: detectSwings on
  // candles.slice(0,i+1) excludes the last 4 bars; our filter excludes j>i-4.
  let highs: SwingPoint[], lows: SwingPoint[];
  if (precomputedHighs && precomputedLows) {
    // Causal filter: swing at j classified using bars j-4..j+4;
    // j+4 <= i iff j <= i-4. All pattern detectors filter >=5 bars old
    // (a strict subset), so this is always sufficient.
    highs = precomputedHighs.filter(s => s.index <= i - 4);
    lows  = precomputedLows.filter(s => s.index <= i - 4);
  } else {
    const swings = detectSwings(slice, 4);
    highs = swings.filter(s => s.type === 'high');
    lows  = swings.filter(s => s.type === 'low');
  }
  const atr     = atrAt(i) || slice[i].close * 0.01;

  const triangle     = detectTriangle(highs, lows, i, slice[i].close, atr);
  const flag         = detectFlagPennant(slice, i, atr);
  const doubleTopBot = detectDoubleTopBottom(highs, lows, slice, i);
  const hs           = detectHeadAndShoulders(highs, lows, slice, i);
  const wedge        = detectWedge(highs, lows, slice, i);
  const channel      = detectChannel(highs, lows, slice, i);
  const cup          = detectCupAndHandle(slice, i);
  const srLevels     = detectSupportResistance(highs, lows, slice, i, atr);

  const currentPrice = slice[i].close;
  const allPatterns: PatternResult[] = [triangle, flag, doubleTopBot, hs, wedge, channel, cup]
    .filter((p): p is PatternResult => p !== null)
    .filter(p => {
      // Remove stale patterns whose price target has already been exceeded.
      // e.g. a bullish Double Bottom with target 1671 when price is 1800
      // was valid historically but is misleading now.
      if (!p.target) return true;
      if (p.direction === 'bullish' && p.target <= currentPrice) return false;
      if (p.direction === 'bearish' && p.target >= currentPrice) return false;
      return true;
    });

  const scores = allPatterns.map(p => p.score).filter(s => s !== 0);
  const compositeScore = scores.length > 0
    ? clamp(scores.reduce((a, b) => a + b, 0) / scores.length, -1, 1)
    : 0;

  if (srLevels.nearestSupport && srLevels.supportScore > 0.3) {
    allPatterns.push({ name: `Support @ ${srLevels.nearestSupport.toFixed(2)}`, direction: 'bullish', strength: srLevels.supportScore, score: srLevels.supportScore });
  }
  if (srLevels.nearestResistance && srLevels.resistanceScore > 0.3) {
    allPatterns.push({ name: `Resistance @ ${srLevels.nearestResistance.toFixed(2)}`, direction: 'bearish', strength: srLevels.resistanceScore, score: -srLevels.resistanceScore });
  }

  return {
    patterns: allPatterns.sort((a, b) => Math.abs(b.score) - Math.abs(a.score)),
    compositeScore,
    triangleScore:        triangle     ? triangle.score     : 0,
    flagScore:            flag         ? flag.score         : 0,
    doubleTopBottomScore: doubleTopBot ? doubleTopBot.score : 0,
    headShouldersScore:   hs           ? hs.score           : 0,
    wedgeScore:           wedge        ? wedge.score        : 0,
    channelScore:         channel      ? channel.score      : 0,
    supportScore:         srLevels.supportScore,
    resistanceScore:      -srLevels.resistanceScore,
  };
}
