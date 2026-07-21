// ─────────────────────────────────────────────────────────────────────────────
// CRYPTO MARKET CONTEXT TYPES  (v1.0.0)
//
// External market context for cryptocurrency assets.
// Mirrors the Indian Market Context architecture exactly:
//   - All fields optional — prediction never fails when data unavailable
//   - Not embedded in the 116-feature ML vector
//   - Available for UI display, paper-trade logging, future model versions
//
// DATA SOURCES (all free, no auth required):
//   Fear & Greed  — alternative.me/crypto/fear-and-greed-index/
//   Market Cap    — api.coingecko.com/api/v3/global
//   BTC Dominance — same CoinGecko global endpoint
//   Funding Rate  — api.binance.com/fapi/v1/fundingRate (Binance futures)
//   Open Interest — api.binance.com/fapi/v1/openInterest
//   Stablecoin    — CoinGecko global (USDT market cap / total)
// ─────────────────────────────────────────────────────────────────────────────

// ── Fear & Greed Index ────────────────────────────────────────────────────────
export type FearGreedData = {
  value:        number;   // 0–100 (0=extreme fear, 100=extreme greed)
  classification: 'EXTREME_FEAR' | 'FEAR' | 'NEUTRAL' | 'GREED' | 'EXTREME_GREED';
  // Thresholds: 0-25=EXTREME_FEAR, 25-45=FEAR, 45-55=NEUTRAL, 55-75=GREED, 75-100=EXTREME_GREED
  previousDay:  number;   // yesterday's value for trend
  trend:        'RISING' | 'FALLING' | 'FLAT';
  fetchedAt:    number;
};

// ── Bitcoin Dominance & Market Cap ───────────────────────────────────────────
export type MarketCapData = {
  totalMarketCapUsd:      number;   // TOTAL in USD
  totalExBtcMarketCapUsd: number;   // TOTAL2 in USD (excl BTC)
  btcDominance:           number;   // BTC.D as percentage 0–100
  ethDominance:           number;   // ETH dominance
  altcoinDominance:       number;   // 100 - btcDominance - ethDominance
  stablecoinRatio:        number;   // stablecoin mcap / total mcap, 0–1
  // Market cap change 24h
  totalChange24h:         number;   // percentage
  btcDominanceChange24h:  number;   // dominance change in percentage points
  regime: 'RISK_ON' | 'RISK_OFF' | 'BTC_SEASON' | 'ALT_SEASON' | 'STABLE_DOMINANCE' | 'NEUTRAL';
  // RISK_ON: total up + alts up, RISK_OFF: total down, BTC_SEASON: BTC.D rising
  // ALT_SEASON: TOTAL2 outperforming BTC, STABLE_DOMINANCE: stablecoin ratio high
  fetchedAt: number;
};

// ── Funding Rate ──────────────────────────────────────────────────────────────
export type FundingRateData = {
  symbol:       string;   // e.g. 'BTCUSDT'
  fundingRate:  number;   // current 8h funding rate, e.g. 0.0001 = 0.01%
  annualized:   number;   // fundingRate * 3 * 365 (three 8h periods/day)
  sentiment:    'EXTREME_LONG' | 'LONG_BIASED' | 'NEUTRAL' | 'SHORT_BIASED' | 'EXTREME_SHORT';
  // > 0.05% = EXTREME_LONG (longs paying heavily, overheated)
  // < -0.05% = EXTREME_SHORT
  isOverheated: boolean;  // |fundingRate| > 0.05%
  fetchedAt:    number;
};

// ── Open Interest ─────────────────────────────────────────────────────────────
export type OpenInterestData = {
  symbol:         string;
  openInterestUsd: number;    // total OI in USD
  change24h:       number;    // % change in OI over 24h
  // Rising OI + rising price = bullish conviction
  // Rising OI + falling price = bearish conviction (shorts adding)
  // Falling OI + price move = weak conviction (unwinding)
  trend: 'RISING' | 'FALLING' | 'FLAT';
  conviction: 'BULLISH' | 'BEARISH' | 'WEAK' | 'NEUTRAL';
  fetchedAt:  number;
};

// ── Stablecoin Dominance ──────────────────────────────────────────────────────
export type StablecoinData = {
  usdtDominance:  number;   // USDT % of total crypto market cap
  usdcDominance:  number;   // USDC % of total crypto market cap
  totalStableDom: number;   // combined stablecoin dominance
  trend:          'RISING' | 'FALLING' | 'FLAT';
  // Rising stablecoin dominance = risk-off (money moving to safety)
  signal:         'RISK_OFF' | 'NEUTRAL' | 'RISK_ON';
  fetchedAt:      number;
};

// ── Full crypto market context ─────────────────────────────────────────────────
export type CryptoMarketContext = {
  fearGreed?:    FearGreedData    | null;
  marketCap?:    MarketCapData    | null;
  funding?:      FundingRateData  | null;
  openInterest?: OpenInterestData | null;
  stablecoin?:   StablecoinData   | null;
  available: ('FEAR_GREED' | 'MARKET_CAP' | 'FUNDING' | 'OPEN_INTEREST' | 'STABLECOIN')[];
  symbol:    string;   // which symbol this context was fetched for
  fetchedAt: number;
};

// ── Normalised features (19 values, all 0–1) ──────────────────────────────────
export type CryptoContextFeatures = {
  // Fear & Greed (3)
  fearGreedNorm:    number;   // value / 100
  fearGreedTrend:   number;   // FALLING=0, FLAT=0.5, RISING=1
  fearGreedRegime:  number;   // EXTREME_FEAR=0, FEAR=0.25, NEUTRAL=0.5, GREED=0.75, EXTREME_GREED=1

  // Market Cap / Dominance (5)
  btcDominanceNorm: number;   // btcDominance / 100
  altDominanceNorm: number;   // altcoinDominance / 100
  stableRatioNorm:  number;   // stablecoinRatio (already 0–1)
  marketCapChange:  number;   // totalChange24h normalised, -10%..+10% → 0..1
  marketRegime:     number;   // RISK_OFF=0, NEUTRAL=0.33, STABLE_DOM=0.4, BTC_SEASON=0.5, ALT_SEASON=0.75, RISK_ON=1

  // Funding Rate (3)
  fundingRateNorm:  number;   // clamped -0.1%..+0.1% → 0..1 (0.5=neutral)
  fundingBias:      number;   // EXTREME_SHORT=0 .. EXTREME_LONG=1
  fundingOverheat:  number;   // 0 or 1

  // Open Interest (3)
  oiTrend:          number;   // FALLING=0, FLAT=0.5, RISING=1
  oiChange24h:      number;   // change normalised -20%..+20% → 0..1
  oiConviction:     number;   // BEARISH=0, WEAK=0.25, NEUTRAL=0.5, BULLISH=1

  // Stablecoin (3)
  stableDomNorm:    number;   // totalStableDom / 20 (cap at 20%), 0–1
  stableTrend:      number;   // FALLING=0, FLAT=0.5, RISING=1
  stableSignal:     number;   // RISK_OFF=0, NEUTRAL=0.5, RISK_ON=1

  // Aggregate sentiment (2)
  overallSentiment: number;   // composite fear+funding+stable, 0–1
  marketPhase:      number;   // 0=bear/fear, 0.5=neutral, 1=bull/greed
};

// Neutral defaults — used when any source is unavailable
export const NEUTRAL_CRYPTO_FEATURES: CryptoContextFeatures = {
  fearGreedNorm: 0.5,  fearGreedTrend: 0.5,  fearGreedRegime: 0.5,
  btcDominanceNorm: 0.5, altDominanceNorm: 0.25, stableRatioNorm: 0.1,
  marketCapChange: 0.5,  marketRegime: 0.33,
  fundingRateNorm: 0.5,  fundingBias: 0.5,     fundingOverheat: 0,
  oiTrend: 0.5,          oiChange24h: 0.5,     oiConviction: 0.5,
  stableDomNorm: 0.5,    stableTrend: 0.5,     stableSignal: 0.5,
  overallSentiment: 0.5, marketPhase: 0.5,
};

export const CRYPTO_CONTEXT_FEATURE_NAMES = [
  'Fear/Greed level',    'Fear/Greed trend',  'Fear/Greed regime',
  'BTC dominance',       'Alt dominance',      'Stablecoin ratio',
  'Market cap change',   'Market regime',
  'Funding rate',        'Funding bias',       'Funding overheat',
  'OI trend',            'OI change 24h',      'OI conviction',
  'Stable dominance',    'Stable trend',       'Stable signal',
  'Overall sentiment',   'Market phase',
] as const;
