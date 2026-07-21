// ─────────────────────────────────────────────────────────────────────────────
// ANCHORED VWAP  (v6.0.1 — Fix B: causal swing-anchored VWAP)
//
// Session, Weekly, Monthly anchors: unchanged — fully causal by construction
// (anchor is determined from timestamp, not from future price action).
//
// Swing-High / Swing-Low anchors: FIX B.
//   Previous bug: anchor = majorHighs[last].index — the final confirmed swing
//   of the ENTIRE series. At training bar i=100, the VWAP was anchored to a
//   swing at bar 2850, making all swing-anchored VWAP values look-ahead.
//
//   Fix: at bar i, anchor = most recently confirmed swing ≤ i.
//   Implemented with the prefix-sum pattern:
//     prefixPV[i]  = Σ tp[j]×vol[j]  for j in [0..i]
//     prefixVol[i] = Σ vol[j]          for j in [0..i]
//     VWAP(anchor a, bar i) = (prefixPV[i] - prefixPV[a-1])
//                           / (prefixVol[i] - prefixVol[a-1])
//   Prefix arrays: O(n) one pass.
//   Per-bar VWAP: O(1) per bar after prefix is built.
//   Anchor advance: monotonic pointer → O(n) total across all bars.
//   Total complexity: O(n) — same as before.
//
// No repainting: VWAP at bar i never references candles[i+1..n-1].
// ─────────────────────────────────────────────────────────────────────────────
import { Candle } from '../indicators';
import {
  AnchoredVWAPResult, VWAPAnchorType, VWAPSnapshot,
  DEFAULT_VOLUME_CONFIG, VolumeConfig,
} from './volumeTypes';
import { PrecomputedStructure } from '../structure/marketStructure';

// ── Single fixed-anchor VWAP (session/weekly/monthly — unchanged) ─────────────
// O(n - anchorBar): single forward pass, no lookahead.
function computeFromAnchor(
  candles: Candle[],
  anchorBar: number,
  anchorType: VWAPAnchorType
): AnchoredVWAPResult {
  const n = candles.length;
  const vwapArr = new Float64Array(n);
  const upper1  = new Float64Array(n);
  const lower1  = new Float64Array(n);
  const upper2  = new Float64Array(n);
  const lower2  = new Float64Array(n);
  let cumPV = 0, cumVol = 0, cumPV2 = 0;

  for (let i = anchorBar; i < n; i++) {
    const c  = candles[i];
    const tp = (c.high + c.low + c.close) / 3;
    cumPV  += tp * c.volume;
    cumVol += c.volume;
    cumPV2 += tp * tp * c.volume;
    const vwap     = cumVol > 0 ? cumPV / cumVol : tp;
    const variance = cumVol > 0 ? Math.max(0, cumPV2 / cumVol - vwap * vwap) : 0;
    const sigma    = Math.sqrt(variance);
    vwapArr[i] = vwap;
    upper1[i]  = vwap + sigma;   lower1[i] = vwap - sigma;
    upper2[i]  = vwap + 2*sigma; lower2[i] = vwap - 2*sigma;
  }

  return {
    anchorType, anchorBar,
    vwap:      Array.from(vwapArr),
    upperDev1: Array.from(upper1), lowerDev1: Array.from(lower1),
    upperDev2: Array.from(upper2), lowerDev2: Array.from(lower2),
  };
}

// ── Fix B: prefix-sum based per-bar causal swing-anchored VWAP ────────────────
// Returns two Float64Arrays: per-bar swingHighVWAP and swingLowVWAP.
// At bar i, each value is anchored to the most recently confirmed major swing
// of the corresponding type with index ≤ i - SWING_CONFIRM_LOOKBACK (5 bars).
// When the anchor advances (new swing confirmed), the VWAP resets from the
// new anchor bar using the prefix sum difference — no inner loop, O(1) per bar.
//
// Proof of causality:
//   prefixPV[i]  = Σ_{j=0}^{i} tp_j × vol_j  — uses only candles[0..i]
//   anchor[i]    = majorHighs[ptr].index where majorHighs[ptr].index ≤ i - 5
//                — uses only swings confirmed 5+ bars ago
//   VWAP[i]      = (prefixPV[i] - prefixPV[anchor[i]-1])
//                / (prefixVol[i] - prefixVol[anchor[i]-1])
//                — both components use only information available at bar i
function computeSwingAnchoredVWAP(
  candles: Candle[],
  msStructure: PrecomputedStructure,
): { swingHighVWAP: Float64Array; swingLowVWAP: Float64Array } {
  const n = candles.length;
  const SWING_CONFIRM_LOOKBACK = 5; // bars after swing index before it's "confirmed"

  // ── Step 1: build prefix sums in one pass  O(n) ───────────────────────────
  const prefixPV  = new Float64Array(n); // Σ tp×vol for [0..i]
  const prefixVol = new Float64Array(n); // Σ vol    for [0..i]
  for (let i = 0; i < n; i++) {
    const c  = candles[i];
    const tp = (c.high + c.low + c.close) / 3;
    prefixPV[i]  = (i > 0 ? prefixPV[i-1]  : 0) + tp * c.volume;
    prefixVol[i] = (i > 0 ? prefixVol[i-1] : 0) + c.volume;
  }

  // ── VWAP from anchor a to bar i using prefix difference  O(1) ────────────
  function vwapFromAnchor(a: number, i: number): number {
    const pvFrom  = prefixPV[i]  - (a > 0 ? prefixPV[a-1]  : 0);
    const volFrom = prefixVol[i] - (a > 0 ? prefixVol[a-1] : 0);
    return volFrom > 0 ? pvFrom / volFrom : candles[i].close;
  }

  // ── Step 2: per-bar causal VWAP with monotonic anchor pointer  O(n) ───────
  const swingHighVWAP = new Float64Array(n);
  const swingLowVWAP  = new Float64Array(n);

  // majorHighs and majorLows are sorted by index (guaranteed by detectSwings)
  const mh = msStructure.majorHighs;
  const ml = msStructure.majorLows;
  let ptrH = -1; // index into mh: most recently admitted swing high
  let ptrL = -1;

  for (let i = 0; i < n; i++) {
    // Advance high pointer: admit swings confirmed at or before bar i
    while (ptrH + 1 < mh.length && mh[ptrH + 1].index <= i - SWING_CONFIRM_LOOKBACK) {
      ptrH++;
    }
    while (ptrL + 1 < ml.length && ml[ptrL + 1].index <= i - SWING_CONFIRM_LOOKBACK) {
      ptrL++;
    }

    const highAnchor = ptrH >= 0 ? mh[ptrH].index : 0;
    const lowAnchor  = ptrL >= 0 ? ml[ptrL].index : 0;

    swingHighVWAP[i] = vwapFromAnchor(highAnchor, i);
    swingLowVWAP[i]  = vwapFromAnchor(lowAnchor,  i);
  }

  return { swingHighVWAP, swingLowVWAP };
}

// ── Timestamp-based anchor finders (unchanged) ────────────────────────────────
function findWeeklyAnchor(candles: Candle[]): number {
  if (candles.length === 0) return 0;
  const last = new Date(candles[candles.length - 1].time * 1000);
  const dow  = last.getUTCDay();
  const weekStart = new Date(last);
  weekStart.setUTCDate(last.getUTCDate() - (dow === 0 ? 6 : dow - 1));
  weekStart.setUTCHours(0, 0, 0, 0);
  const ws = weekStart.getTime() / 1000;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].time < ws) return Math.min(i + 1, candles.length - 1);
  }
  return 0;
}

function findMonthlyAnchor(candles: Candle[]): number {
  if (candles.length === 0) return 0;
  const last = new Date(candles[candles.length - 1].time * 1000);
  const monthStart = Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), 1) / 1000;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].time < monthStart) return Math.min(i + 1, candles.length - 1);
  }
  return 0;
}

// ── Main entry point ──────────────────────────────────────────────────────────
// Public API preserved. Complexity: O(n) total.
// Session, weekly, monthly: O(n) each via computeFromAnchor (unchanged).
// Swing-anchored: O(n) via prefix sums + monotonic pointer (Fix B).
export function computeAllVWAPs(
  candles: Candle[],
  msStructure: PrecomputedStructure,
  cfg: VolumeConfig = DEFAULT_VOLUME_CONFIG
): {
  session:   AnchoredVWAPResult;
  swingHigh: AnchoredVWAPResult;  // kept for UI compatibility — last bar only
  swingLow:  AnchoredVWAPResult;
  weekly:    AnchoredVWAPResult;
  monthly:   AnchoredVWAPResult;
  snapshots: (VWAPSnapshot | null)[];
} {
  const n = candles.length;

  // Fixed-anchor VWAPs (all causal — timestamp-determined or series-start)
  const sessionAnchor  = 0;
  const weeklyAnchor   = findWeeklyAnchor(candles);
  const monthlyAnchor  = findMonthlyAnchor(candles);
  const session   = computeFromAnchor(candles, sessionAnchor,  'session_open');
  const weekly    = computeFromAnchor(candles, weeklyAnchor,   'weekly');
  const monthly   = computeFromAnchor(candles, monthlyAnchor,  'monthly');

  // Fix B: causal per-bar swing-anchored VWAP
  const { swingHighVWAP, swingLowVWAP } = computeSwingAnchoredVWAP(candles, msStructure);

  // For the AnchoredVWAPResult return shape (used by UI), construct using the
  // last-confirmed swing anchor — this is cosmetic/display only and does not
  // affect the ML pipeline (snapshots use per-bar causal values below).
  const lastHighAnchor = msStructure.majorHighs.length > 0
    ? msStructure.majorHighs[msStructure.majorHighs.length - 1].index : 0;
  const lastLowAnchor  = msStructure.majorLows.length > 0
    ? msStructure.majorLows[msStructure.majorLows.length - 1].index : 0;
  const swingHigh = computeFromAnchor(candles, lastHighAnchor, 'swing_high'); // UI only
  const swingLow  = computeFromAnchor(candles, lastLowAnchor,  'swing_low');  // UI only

  // Build per-bar snapshots — swing values come from causal per-bar arrays
  const snapshots: (VWAPSnapshot | null)[] = new Array(n).fill(null);
  for (let i = cfg.slopeLookback; i < n; i++) {
    const prevI = i - cfg.slopeLookback;
    snapshots[i] = {
      sessionVWAP:   session.vwap[i],
      swingHighVWAP: swingHighVWAP[i],  // Fix B: per-bar causal value
      swingLowVWAP:  swingLowVWAP[i],   // Fix B: per-bar causal value
      weeklyVWAP:    weekly.vwap[i]    ?? session.vwap[i],
      monthlyVWAP:   monthly.vwap[i]   ?? session.vwap[i],
      upperDev1:     session.upperDev1[i],
      lowerDev1:     session.lowerDev1[i],
      sessionSlope:  session.vwap[i] - session.vwap[prevI],
    };
  }

  return { session, swingHigh, swingLow, weekly, monthly, snapshots };
}
