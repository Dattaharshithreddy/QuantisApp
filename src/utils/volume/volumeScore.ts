// ─────────────────────────────────────────────────────────────────────────────
// VOLUME SCORING  (v5.0.0) — all heuristics isolated here
//
// VWAP_SCORING_V1
// VP_SCORING_V1
// ─────────────────────────────────────────────────────────────────────────────
import { ScoredVWAP, ScoredVP, VolumeScores, VWAPSnapshot, VolumeProfileResult } from './volumeTypes';

// ── VWAP_SCORING_V1 ───────────────────────────────────────────────────────────
// distanceNorm = min(1, |price - sessionVWAP| / (atr × 3))
//   — normalized by 3 ATR; beyond 3 ATR treated as extreme
// aboveVWAP = price > sessionVWAP ? 1 : 0
// slopeNorm = slope / (atr × 0.1)  clamped to [-1, +1]
//   — slope of sessionVWAP over slopeLookback bars / (atr×0.1)
// confidence = 1 - distanceNorm × 0.5
//   — further from VWAP = less reliable as support/resistance
// bias = (price - sessionVWAP) / (atr × 3)  clamped [-1, +1]
//   — positive = price above VWAP (bullish), negative = below (bearish)
//
// Assumptions:
//   Price near VWAP has high institutional relevance
//   VWAP slope direction proxies short-term institutional order flow
//   3 ATR covers ~99% of typical intraday price excursions
export function scoreVWAP(
  price:        number,
  snap:         VWAPSnapshot,
  atr:          number
): ScoredVWAP {
  const diff       = price - snap.sessionVWAP;
  const distNorm   = atr > 0 ? Math.min(1, Math.abs(diff) / (atr * 3)) : 0;
  const slopeNorm  = atr > 0 ? Math.max(-1, Math.min(1, snap.sessionSlope / (atr * 0.1))) : 0;
  const bias       = atr > 0 ? Math.max(-1, Math.min(1, diff / (atr * 3))) : 0;
  const confidence = Math.max(0, 1 - distNorm * 0.5);
  return {
    scoringVersion: 'VWAP_SCORING_V1',
    distanceNorm:   distNorm,
    aboveVWAP:      price > snap.sessionVWAP ? 1 : 0,
    slopeNorm,
    confidence,
    bias};
}

// ── VP_SCORING_V1 ─────────────────────────────────────────────────────────────
// pocDistNorm = min(1, |price - poc| / (atr × 3))
// vahDistNorm = min(1, |price - vah| / (atr × 3))
// valDistNorm = min(1, |price - val| / (atr × 3))
//
// hvnProximity = 1 - min(1, minDist_to_any_HVN / (atr × 2))
//   — closer to an HVN = higher score
// lvnProximity = 1 - min(1, minDist_to_any_LVN / (atr × 2))
//   — closer to an LVN = higher score (LVNs = potential fast-move zones)
//
// profileBias = (price - poc) / (vah - val || 1)  clamped [-1, +1]
//   — positive = price above POC (value area), negative = below
//
// Assumptions:
//   POC is the "fair value" level; price near it has high liquidity
//   HVNs act as support/resistance (volume accumulation zones)
//   LVNs act as acceleration zones (thin volume = fast moves)
export function scoreVP(
  price: number,
  vp:    VolumeProfileResult,
  atr:   number
): ScoredVP {
  const d = (p: number) => atr > 0 ? Math.min(1, Math.abs(price - p) / (atr * 3)) : 0;

  const hvnMin = vp.hvnPrices.length > 0
    ? Math.min(...vp.hvnPrices.map(p => Math.abs(price - p))) : atr * 10;
  const lvnMin = vp.lvnPrices.length > 0
    ? Math.min(...vp.lvnPrices.map(p => Math.abs(price - p))) : atr * 10;

  const vaRange = (vp.vah - vp.val) || 1;
  const profileBias = Math.max(-1, Math.min(1, (price - vp.poc) / vaRange));

  return {
    scoringVersion: 'VP_SCORING_V1',
    pocDistNorm:    d(vp.poc),
    vahDistNorm:    d(vp.vah),
    valDistNorm:    d(vp.val),
    hvnProximity:   atr > 0 ? Math.max(0, 1 - Math.min(1, hvnMin / (atr * 2))) : 0,
    lvnProximity:   atr > 0 ? Math.max(0, 1 - Math.min(1, lvnMin / (atr * 2))) : 0,
    profileBias};
}

// ── Aggregate to VolumeScores for ML ──────────────────────────────────────────
export function toVolumeScores(sv: ScoredVWAP, svp: ScoredVP): VolumeScores {
  return {
    distFromVWAP:   sv.distanceNorm,
    vwapSlope:      sv.slopeNorm,
    aboveVWAP:      sv.aboveVWAP,
    belowVWAP:      1 - sv.aboveVWAP,
    distFromPOC:    svp.pocDistNorm,
    distFromVAH:    svp.vahDistNorm,
    distFromVAL:    svp.valDistNorm,
    hvnProximity:   svp.hvnProximity,
    lvnProximity:   svp.lvnProximity,
    profileBias:    svp.profileBias,
    vwapConfidence: sv.confidence};
}
