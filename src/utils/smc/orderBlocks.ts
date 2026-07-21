// ─────────────────────────────────────────────────────────────────────────────
// ORDER BLOCK DETECTION  (v4.8.0)
//
// This module answers ONLY: "Does an order block exist, and what is its status?"
// All heuristic scoring (strength, confidence) lives exclusively in smcScore.ts.
//
// DETECTION RULES (ICT mechanical, fully objective):
//   Bullish OB = the last bearish candle (open > close) BEFORE a Bullish BOS.
//   Bearish OB = the last bullish candle (close > open) BEFORE a Bearish BOS.
//
// STATUS TRANSITIONS (deterministic from OHLCV, no heuristics):
//   fresh      → price has not entered the zone (zoneHigh..zoneLow) since OB formed
//   tested     → wick entered the near half of the zone but closed outside
//   mitigated  → price entered the zone (low ≤ zoneHigh for bull, high ≥ zoneLow for bear)
//   invalidated→ price CLOSED beyond the zone's opposing boundary
//                  Bullish OB: c.close < zoneLow
//                  Bearish OB: c.close > zoneHigh
//
// CANDLE DIRECTION (objective):
//   Bullish candle: close > open
//   Bearish candle: open  > close
//   Doji (open == close): not used as an OB candle
// ─────────────────────────────────────────────────────────────────────────────
import { Candle } from '../indicators';
import { DetectedOB, DetectedBreaker, OBStatus, OBDirection, SMCConfig } from './smcTypes';
import { PrecomputedStructure } from '../structure/marketStructure';

// ── Candle classification (deterministic) ─────────────────────────────────────
function isBullish(c: Candle): boolean { return c.close > c.open; }
function isBearish(c: Candle): boolean { return c.open  > c.close; }

// ── OB status update (deterministic, called each bar per active OB) ───────────
// Returns the new status. Invalidated OBs are removed by the caller.
export function updateOBStatus(ob: DetectedOB, c: Candle): OBStatus {
  const { zoneHigh, zoneLow, direction, status } = ob;
  const midZone = (zoneHigh + zoneLow) / 2;

  if (direction === 'bullish') {
    if (c.close < zoneLow)   return 'invalidated';
    if (c.low   <= zoneHigh) return 'mitigated';                // entered zone
    if (status === 'fresh' && c.low <= midZone + (zoneHigh - midZone) * 0.5)
      return 'tested';                                           // near-half wick
  } else {
    if (c.close > zoneHigh)  return 'invalidated';
    if (c.high  >= zoneLow)  return 'mitigated';
    if (status === 'fresh' && c.high >= midZone - (midZone - zoneLow) * 0.5)
      return 'tested';
  }
  return status;  // unchanged
}

// ── Detect the defining OB candle for a BOS event ─────────────────────────────
// Returns the bar index of the OB candle, or -1 if none found in lookback.
// Detection is a backward linear scan — O(bosLookback) per BOS event.
export function detectOBCandle(
  candles: Candle[],
  bosBar:  number,
  direction: OBDirection,
  cfg: SMCConfig
): number {
  // For a Bullish BOS: scan back for the last BEARISH candle before the BOS
  // For a Bearish BOS: scan back for the last BULLISH candle before the BOS
  const wantBull = direction === 'bearish'; // bearish OB needs a bullish candle
  for (let k = bosBar - 1; k >= Math.max(0, bosBar - cfg.bosLookback); k--) {
    if (wantBull ? isBullish(candles[k]) : isBearish(candles[k])) return k;
  }
  return -1;
}

// ── Main: build DetectedOB list incrementally across all bars ─────────────────
// Consumes msStructure.scoresArr for BOS/CHoCH events — no swing re-detection.
// Returns obsAtBar[i]: snapshot of all non-invalidated OBs at bar i.
// Complexity: O(n × k) where k = max active OBs ≤ cfg.maxActiveOBs
export function computeDetectedOBs(
  candles: Candle[],
  msStructure: PrecomputedStructure,
  cfg: SMCConfig
): {
  obsAtBar:     (DetectedOB[] | null)[];
  breakersAtBar:(DetectedBreaker[] | null)[];
} {
  const n = candles.length;
  const obsAtBar:      (DetectedOB[]       | null)[] = new Array(n).fill(null);
  const breakersAtBar: (DetectedBreaker[]   | null)[] = new Array(n).fill(null);

  let activeOBs:      DetectedOB[]      = [];
  let activeBreakers: DetectedBreaker[] = [];

  for (let i = 1; i < n; i++) {
    const c      = candles[i];
    const scores = msStructure.scoresArr[i];

    // ── Update status of all currently active OBs (deterministic) ─────────
    const nextActive: DetectedOB[] = [];
    for (const ob of activeOBs) {
      const newStatus = updateOBStatus(ob, c);
      ob.age = i - ob.index;

      if (newStatus === 'invalidated' || ob.age > cfg.maxOBAge) continue;

      if (newStatus === 'mitigated' && ob.status !== 'mitigated') {
        // Detection fact: this OB is now mitigated → becomes a Breaker candidate
        // Breaker direction is OPPOSITE of the source OB (deterministic rule)
        activeBreakers.push({
          index:        i,
          direction:    ob.direction === 'bullish' ? 'bearish' : 'bullish',
          zoneHigh:     ob.zoneHigh,
          zoneLow:      ob.zoneLow,
          sourceOBIndex:ob.index,
          age:          0,
        });
      }

      // Update touch count (deterministic — price entered the zone this bar)
      if (c.low <= ob.zoneHigh && c.high >= ob.zoneLow) ob.touches++;

      ob.status = newStatus;
      if (ob.status !== 'mitigated') nextActive.push(ob); // mitigated OBs leave active list
    }
    activeOBs = nextActive.slice(-cfg.maxActiveOBs);

    // Age and prune breakers
    activeBreakers = activeBreakers
      .map(b => { b.age++; return b; })
      .filter(b => b.age <= cfg.maxOBAge)
      .slice(-10);

    // ── Create new OBs from BOS/CHoCH detected by Market Structure Engine ──
    // Detection only — no scoring here.
    if (scores && (scores.bosDetected || scores.chochDetected)) {
      // Determine break direction from signed trendStrength
      const isBullBreak = scores.trendStrength > 0 &&
        (scores.bosDetected > 0 || scores.chochDetected > 0);
      const isBearBreak = scores.trendStrength < 0 &&
        (scores.bosDetected > 0 || scores.chochDetected > 0);

      if (isBullBreak) {
        const obIdx = detectOBCandle(candles, i, 'bullish', cfg);
        if (obIdx >= 0) {
          activeOBs.push({
            index:     obIdx,
            direction: 'bullish',
            zoneHigh:  candles[obIdx].high,
            zoneLow:   candles[obIdx].low,
            bosIndex:  i,
            status:    'fresh',
            touches:   0,
            age:       i - obIdx,
          });
        }
      }
      if (isBearBreak) {
        const obIdx = detectOBCandle(candles, i, 'bearish', cfg);
        if (obIdx >= 0) {
          activeOBs.push({
            index:     obIdx,
            direction: 'bearish',
            zoneHigh:  candles[obIdx].high,
            zoneLow:   candles[obIdx].low,
            bosIndex:  i,
            status:    'fresh',
            touches:   0,
            age:       i - obIdx,
          });
        }
      }
    }

    obsAtBar[i]      = activeOBs.length      > 0 ? [...activeOBs]      : null;
    breakersAtBar[i] = activeBreakers.length  > 0 ? [...activeBreakers] : null;
  }

  return { obsAtBar, breakersAtBar };
}
