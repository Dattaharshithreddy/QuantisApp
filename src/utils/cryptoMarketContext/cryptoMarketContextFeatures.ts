// ─────────────────────────────────────────────────────────────────────────────
// CRYPTO MARKET CONTEXT FEATURES  (v1.0.0)
//
// Pure deterministic function: CryptoMarketContext → CryptoContextFeatures
// Mirrors marketContextFeatures.ts architecture exactly.
//
// INVARIANTS:
//   - Never throws — missing fields return neutral defaults
//   - All outputs strictly in [0, 1] (clamped)
//   - No side effects, no async, no external calls
//   - Deterministic: same input always produces same output
// ─────────────────────────────────────────────────────────────────────────────

import {
  CryptoMarketContext, CryptoContextFeatures, NEUTRAL_CRYPTO_FEATURES,
  FearGreedData, MarketCapData, FundingRateData, OpenInterestData, StablecoinData,
} from './cryptoMarketContextTypes';

const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));

// ── Fear & Greed features ─────────────────────────────────────────────────────
function fearGreedFeatures(fg: FearGreedData | null | undefined): Pick<CryptoContextFeatures,
  'fearGreedNorm' | 'fearGreedTrend' | 'fearGreedRegime'> {
  if (!fg) return {
    fearGreedNorm:   NEUTRAL_CRYPTO_FEATURES.fearGreedNorm,
    fearGreedTrend:  NEUTRAL_CRYPTO_FEATURES.fearGreedTrend,
    fearGreedRegime: NEUTRAL_CRYPTO_FEATURES.fearGreedRegime,
  };
  const regimeMap: Record<string, number> = {
    EXTREME_FEAR: 0, FEAR: 0.25, NEUTRAL: 0.5, GREED: 0.75, EXTREME_GREED: 1,
  };
  return {
    fearGreedNorm:   clamp(fg.value / 100),
    fearGreedTrend:  fg.trend === 'FALLING' ? 0 : fg.trend === 'RISING' ? 1 : 0.5,
    fearGreedRegime: regimeMap[fg.classification] ?? 0.5,
  };
}

// ── Market cap / dominance features ──────────────────────────────────────────
function marketCapFeatures(mc: MarketCapData | null | undefined): Pick<CryptoContextFeatures,
  'btcDominanceNorm' | 'altDominanceNorm' | 'stableRatioNorm' | 'marketCapChange' | 'marketRegime'> {
  if (!mc) return {
    btcDominanceNorm: NEUTRAL_CRYPTO_FEATURES.btcDominanceNorm,
    altDominanceNorm: NEUTRAL_CRYPTO_FEATURES.altDominanceNorm,
    stableRatioNorm:  NEUTRAL_CRYPTO_FEATURES.stableRatioNorm,
    marketCapChange:  NEUTRAL_CRYPTO_FEATURES.marketCapChange,
    marketRegime:     NEUTRAL_CRYPTO_FEATURES.marketRegime,
  };
  const regimeMap: Record<string, number> = {
    RISK_OFF: 0, NEUTRAL: 0.33, STABLE_DOMINANCE: 0.4,
    BTC_SEASON: 0.5, ALT_SEASON: 0.75, RISK_ON: 1,
  };
  return {
    btcDominanceNorm: clamp(mc.btcDominance / 100),
    altDominanceNorm: clamp(mc.altcoinDominance / 100),
    stableRatioNorm:  clamp(mc.stablecoinRatio),
    // Normalise 24h change: -10%..+10% → 0..1
    marketCapChange:  clamp(mc.totalChange24h / 10 * 0.5 + 0.5),
    marketRegime:     regimeMap[mc.regime] ?? 0.33,
  };
}

// ── Funding rate features ─────────────────────────────────────────────────────
function fundingFeatures(fr: FundingRateData | null | undefined): Pick<CryptoContextFeatures,
  'fundingRateNorm' | 'fundingBias' | 'fundingOverheat'> {
  if (!fr) return {
    fundingRateNorm: NEUTRAL_CRYPTO_FEATURES.fundingRateNorm,
    fundingBias:     NEUTRAL_CRYPTO_FEATURES.fundingBias,
    fundingOverheat: NEUTRAL_CRYPTO_FEATURES.fundingOverheat,
  };
  const sentMap: Record<string, number> = {
    EXTREME_SHORT: 0, SHORT_BIASED: 0.25, NEUTRAL: 0.5, LONG_BIASED: 0.75, EXTREME_LONG: 1,
  };
  // Funding rate: -0.1%..+0.1% per 8h normalised to 0..1
  const CAP = 0.001; // 0.1%
  return {
    fundingRateNorm: clamp(fr.fundingRate / CAP * 0.5 + 0.5),
    fundingBias:     sentMap[fr.sentiment] ?? 0.5,
    fundingOverheat: fr.isOverheated ? 1 : 0,
  };
}

// ── Open interest features ────────────────────────────────────────────────────
function oiFeatures(oi: OpenInterestData | null | undefined): Pick<CryptoContextFeatures,
  'oiTrend' | 'oiChange24h' | 'oiConviction'> {
  if (!oi) return {
    oiTrend:      NEUTRAL_CRYPTO_FEATURES.oiTrend,
    oiChange24h:  NEUTRAL_CRYPTO_FEATURES.oiChange24h,
    oiConviction: NEUTRAL_CRYPTO_FEATURES.oiConviction,
  };
  const convMap: Record<string, number> = {
    BEARISH: 0, WEAK: 0.25, NEUTRAL: 0.5, BULLISH: 1,
  };
  return {
    oiTrend:      oi.trend === 'FALLING' ? 0 : oi.trend === 'RISING' ? 1 : 0.5,
    oiChange24h:  clamp(oi.change24h / 20 * 0.5 + 0.5),  // -20%..+20% → 0..1
    oiConviction: convMap[oi.conviction] ?? 0.5,
  };
}

// ── Stablecoin features ───────────────────────────────────────────────────────
function stablecoinFeatures(sc: StablecoinData | null | undefined): Pick<CryptoContextFeatures,
  'stableDomNorm' | 'stableTrend' | 'stableSignal'> {
  if (!sc) return {
    stableDomNorm: NEUTRAL_CRYPTO_FEATURES.stableDomNorm,
    stableTrend:   NEUTRAL_CRYPTO_FEATURES.stableTrend,
    stableSignal:  NEUTRAL_CRYPTO_FEATURES.stableSignal,
  };
  const signalMap: Record<string, number> = { RISK_OFF: 0, NEUTRAL: 0.5, RISK_ON: 1 };
  return {
    stableDomNorm: clamp(sc.totalStableDom / 20),  // cap at 20% dominance
    stableTrend:   sc.trend === 'FALLING' ? 0 : sc.trend === 'RISING' ? 1 : 0.5,
    stableSignal:  signalMap[sc.signal] ?? 0.5,
  };
}

// ── Aggregate sentiment ───────────────────────────────────────────────────────
function aggregateFeatures(
  fg: FearGreedData | null | undefined,
  fr: FundingRateData | null | undefined,
  sc: StablecoinData | null | undefined,
  mc: MarketCapData | null | undefined,
): Pick<CryptoContextFeatures, 'overallSentiment' | 'marketPhase'> {
  // Combine available signals — missing ones contribute 0.5 (neutral)
  const fgScore  = fg ? fg.value / 100 : 0.5;
  const frScore  = fr ? (fr.fundingRate + 0.001) / 0.002 : 0.5;  // 0=extreme short, 1=extreme long
  const scScore  = sc ? 1 - sc.totalStableDom / 20 : 0.5;        // high stable dom = risk off
  const mcScore  = mc ? (mc.totalChange24h + 10) / 20 : 0.5;     // normalise 24h change

  const scores = [fgScore, frScore, scScore, mcScore];
  const overall = clamp(scores.reduce((s, v) => s + v, 0) / scores.length);

  // Market phase: <0.35=bear, 0.35-0.65=neutral, >0.65=bull
  const phase = clamp(
    (fgScore * 0.4 + frScore * 0.2 + scScore * 0.2 + mcScore * 0.2)
  );

  return { overallSentiment: overall, marketPhase: phase };
}

// ── Main export ───────────────────────────────────────────────────────────────
export function toCryptoContextFeatures(
  ctx: CryptoMarketContext | null | undefined,
): CryptoContextFeatures {
  if (!ctx) return { ...NEUTRAL_CRYPTO_FEATURES };
  return {
    ...fearGreedFeatures(ctx.fearGreed),
    ...marketCapFeatures(ctx.marketCap),
    ...fundingFeatures(ctx.funding),
    ...oiFeatures(ctx.openInterest),
    ...stablecoinFeatures(ctx.stablecoin),
    ...aggregateFeatures(ctx.fearGreed, ctx.funding, ctx.stablecoin, ctx.marketCap),
  };
}

export function hasCryptoContext(ctx: CryptoMarketContext | null | undefined): boolean {
  return !!ctx && ctx.available.length > 0;
}
