// ─────────────────────────────────────────────────────────────────────────────
// MARKET CONTEXT FEATURES  (v1.0.0)
//
// Pure deterministic function: MarketContext → MarketContextFeatures (0–1 values)
//
// INVARIANTS:
//   - Never throws — any missing field returns the neutral default
//   - All outputs strictly in [0, 1] (clamped)
//   - No side effects, no async, no external calls
//   - Deterministic: same input always produces same output
//
// These values are NOT currently fed into the ML feature vector.
// They are available for UI display and future model integration.
// ─────────────────────────────────────────────────────────────────────────────

import {
  MarketContext, MarketContextFeatures, NEUTRAL_CONTEXT_FEATURES,
  VIXData, BreadthData, FIIDIIData, PCRData, SectorData,
} from './marketContextTypes';

const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));

// ── VIX features ──────────────────────────────────────────────────────────────
function vixFeatures(v: VIXData | null | undefined): Pick<MarketContextFeatures,
  'vixNorm' | 'vixSmaRatio' | 'vixTrend' | 'vixMomentum' | 'vixRegime'> {
  if (!v) return {
    vixNorm: NEUTRAL_CONTEXT_FEATURES.vixNorm,
    vixSmaRatio: NEUTRAL_CONTEXT_FEATURES.vixSmaRatio,
    vixTrend: NEUTRAL_CONTEXT_FEATURES.vixTrend,
    vixMomentum: NEUTRAL_CONTEXT_FEATURES.vixMomentum,
    vixRegime: NEUTRAL_CONTEXT_FEATURES.vixRegime};
  return {
    vixNorm:     clamp(v.current / 40),             // 40 = extreme VIX cap
    vixSmaRatio: clamp((v.current / (v.sma20 || 1)) / 2),  // 2x sma = capped
    vixTrend:    v.trend === 'FALLING' ? 0 : v.trend === 'RISING' ? 1 : 0.5,
    vixMomentum: clamp(v.momentum * 0.5 + 0.5),    // shift -1..1 → 0..1
    vixRegime:   v.regime === 'LOW' ? 0 : v.regime === 'NORMAL' ? 0.33
               : v.regime === 'HIGH' ? 0.66 : 1};
}

// ── Breadth features ──────────────────────────────────────────────────────────
function breadthFeatures(b: BreadthData | null | undefined): Pick<MarketContextFeatures,
  'adRatio' | 'adTrend' | 'breadthThrust'> {
  if (!b) return {
    adRatio: NEUTRAL_CONTEXT_FEATURES.adRatio,
    adTrend: NEUTRAL_CONTEXT_FEATURES.adTrend,
    breadthThrust: NEUTRAL_CONTEXT_FEATURES.breadthThrust};
  return {
    adRatio:      clamp(b.adRatio),
    adTrend:      b.adTrend === 'BEARISH' ? 0 : b.adTrend === 'BULLISH' ? 1 : 0.5,
    breadthThrust: b.breadthThrust ? 1 : 0};
}

// ── FII/DII features ──────────────────────────────────────────────────────────
function fiiFeatures(f: FIIDIIData | null | undefined): Pick<MarketContextFeatures,
  'fiiFlowNorm' | 'diiFlowNorm' | 'netFlowNorm' | 'fiiBias'> {
  if (!f) return {
    fiiFlowNorm: NEUTRAL_CONTEXT_FEATURES.fiiFlowNorm,
    diiFlowNorm: NEUTRAL_CONTEXT_FEATURES.diiFlowNorm,
    netFlowNorm: NEUTRAL_CONTEXT_FEATURES.netFlowNorm,
    fiiBias:     NEUTRAL_CONTEXT_FEATURES.fiiBias};
  const CAP = 5000; // crores — normalise to ±5000 crore range
  return {
    fiiFlowNorm: clamp(f.fiiRolling5 / CAP * 0.5 + 0.5),
    diiFlowNorm: clamp(f.diiRolling5 / CAP * 0.5 + 0.5),
    netFlowNorm: clamp(f.netFlow     / CAP * 0.5 + 0.5),
    fiiBias:     f.bias === 'FII_SELL' ? 0 : f.bias === 'FII_BUY' ? 1 : 0.5};
}

// ── PCR features ──────────────────────────────────────────────────────────────
function pcrFeatures(p: PCRData | null | undefined): Pick<MarketContextFeatures,
  'pcrNorm' | 'pcrTrend' | 'pcrSentiment'> {
  if (!p) return {
    pcrNorm:     NEUTRAL_CONTEXT_FEATURES.pcrNorm,
    pcrTrend:    NEUTRAL_CONTEXT_FEATURES.pcrTrend,
    pcrSentiment:NEUTRAL_CONTEXT_FEATURES.pcrSentiment};
  // PCR range 0.5–2.0, inverted (high PCR = bearish sentiment = low value)
  const pcrClamped = clamp(p.current, 0.5, 2.0);
  const pcrNorm = 1 - ((pcrClamped - 0.5) / 1.5);  // high PCR → low norm
  const sentMap: Record<string, number> = {
    'EXTREME_BULLISH': 1, 'BULLISH': 0.75, 'NEUTRAL': 0.5,
    'BEARISH': 0.25,      'EXTREME_BEARISH': 0};
  return {
    pcrNorm:      clamp(pcrNorm),
    pcrTrend:     p.trend === 'FALLING' ? 0 : p.trend === 'RISING' ? 1 : 0.5,
    pcrSentiment: sentMap[p.sentiment] ?? 0.5};
}

// ── Sector features ───────────────────────────────────────────────────────────
function sectorFeatures(s: SectorData | null | undefined): Pick<MarketContextFeatures,
  'sectorMomentum' | 'sectorParticip' | 'leaderStrength' | 'sectorBreadth'> {
  if (!s) return {
    sectorMomentum: NEUTRAL_CONTEXT_FEATURES.sectorMomentum,
    sectorParticip: NEUTRAL_CONTEXT_FEATURES.sectorParticip,
    leaderStrength: NEUTRAL_CONTEXT_FEATURES.leaderStrength,
    sectorBreadth:  NEUTRAL_CONTEXT_FEATURES.sectorBreadth};
  const returns = [s.bank, s.it, s.pharma, s.auto, s.fmcg, s.metal];
  const positive = returns.filter(r => r > 0).length;
  const leaderReturn = s.leader !== 'NONE'
    ? (s[s.leader.toLowerCase() as keyof SectorData] as number ?? 0)
    : 0;
  return {
    sectorMomentum: clamp(s.momentum / 0.02 * 0.5 + 0.5),  // ±2% range
    sectorParticip: clamp(s.participation),
    leaderStrength: clamp(leaderReturn / 0.03 * 0.5 + 0.5), // ±3% range
    sectorBreadth:  clamp(positive / returns.length)};
}

// ── Main export ───────────────────────────────────────────────────────────────
export function toMarketContextFeatures(ctx: MarketContext | null | undefined): MarketContextFeatures {
  if (!ctx) return { ...NEUTRAL_CONTEXT_FEATURES };
  return {
    ...vixFeatures(ctx.vix),
    ...breadthFeatures(ctx.breadth),
    ...fiiFeatures(ctx.fiidii),
    ...pcrFeatures(ctx.pcr),
    ...sectorFeatures(ctx.sectors)};
}

// Convenience: is the context meaningfully populated (at least one source)?
export function hasMarketContext(ctx: MarketContext | null | undefined): boolean {
  return !!ctx && ctx.available.length > 0;
}
