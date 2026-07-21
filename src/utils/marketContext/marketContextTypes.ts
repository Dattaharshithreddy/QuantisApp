// ─────────────────────────────────────────────────────────────────────────────
// MARKET CONTEXT TYPES  (v1.0.0)
//
// External market context features for Indian equity markets (NSE).
// All fields are optional — prediction never fails when data is unavailable.
//
// ARCHITECTURE NOTE:
//   These features are NOT part of the 116-element ML feature vector.
//   They live alongside the prediction as contextual metadata.
//   Rationale: embedding them in featuresAt() would invalidate all trained
//   model weights — the neural network maps exact feature indices to weights.
//   Adding them to the vector requires intentional retraining with the full
//   116 + N feature set. This architecture allows the data to be collected
//   and displayed now, and added to the model vector in a future version
//   when retraining is planned.
//
//   Current uses:
//   1. UI display in MarketStructureCard (market context section)
//   2. Available as input to confidence engine overrides (future)
//   3. Logged with paper trades for post-hoc analysis
// ─────────────────────────────────────────────────────────────────────────────

// ── India VIX ─────────────────────────────────────────────────────────────────
export type VIXData = {
  current:        number;        // e.g. 14.2
  sma5:           number;        // 5-day SMA of VIX
  sma20:          number;        // 20-day SMA of VIX
  trend:          'RISING' | 'FALLING' | 'FLAT';
  momentum:       number;        // (current - sma5) / sma5, normalised
  regime:         'LOW' | 'NORMAL' | 'HIGH' | 'EXTREME';
  // Thresholds: LOW<12, NORMAL 12-20, HIGH 20-30, EXTREME>30
  fetchedAt:      number;
};

// ── Market Breadth (NSE advance/decline) ──────────────────────────────────────
export type BreadthData = {
  advances:       number;        // number of advancing stocks
  declines:       number;        // number of declining stocks
  unchanged:      number;
  adRatio:        number;        // advances / (advances + declines), 0–1
  adTrend:        'BULLISH' | 'BEARISH' | 'NEUTRAL';
  // BULLISH: adRatio > 0.6, BEARISH: < 0.4, NEUTRAL: 0.4-0.6
  breadthThrust:  boolean;       // adRatio > 0.7 on above-average volume
  fetchedAt:      number;
};

// ── FII / DII Cash Flow (daily, NSE) ─────────────────────────────────────────
export type FIIDIIData = {
  fiiNetCash:     number;        // today's net FII cash market flow (crores)
  diiNetCash:     number;        // today's net DII cash market flow (crores)
  fiiRolling5:    number;        // 5-day rolling avg FII net
  diiRolling5:    number;        // 5-day rolling avg DII net
  fiiConsecBuys:  number;        // consecutive FII buy days (negative = sell days)
  diiConsecBuys:  number;
  netFlow:        number;        // fiiNetCash + diiNetCash
  bias:           'FII_BUY' | 'FII_SELL' | 'DII_BUY' | 'DII_SELL' | 'MIXED';
  fetchedAt:      number;
};

// ── Put/Call Ratio (NSE options) ──────────────────────────────────────────────
export type PCRData = {
  current:        number;        // current PCR (volume-weighted)
  sma5:           number;        // 5-day avg PCR
  trend:          'RISING' | 'FALLING' | 'FLAT';
  sentiment:      'EXTREME_BULLISH' | 'BULLISH' | 'NEUTRAL' | 'BEARISH' | 'EXTREME_BEARISH';
  // Extreme thresholds: < 0.7 = EXTREME_BULLISH (put buying low),
  //                     > 1.3 = EXTREME_BEARISH (put buying high)
  isContrarianBull: boolean;     // PCR > 1.3 (contrarian: market too fearful = buy signal)
  isContrarianBear: boolean;     // PCR < 0.7 (contrarian: market too complacent = sell signal)
  fetchedAt:      number;
};

// ── Sector Rotation (NSE sector indices) ─────────────────────────────────────
export type SectorData = {
  // Returns relative to NIFTY50 benchmark, 1-day
  bank:    number;   // NIFTY BANK relative return
  it:      number;   // NIFTY IT
  pharma:  number;   // NIFTY PHARMA
  auto:    number;   // NIFTY AUTO
  fmcg:    number;   // NIFTY FMCG
  metal:   number;   // NIFTY METAL
  leader:  'BANK' | 'IT' | 'PHARMA' | 'AUTO' | 'FMCG' | 'METAL' | 'NONE';
  // Sector with highest positive relative return
  participation: number;   // % of sectors outperforming benchmark (0–1)
  momentum:      number;   // mean relative return across sectors
  fetchedAt:     number;
};

// ── Full market context ───────────────────────────────────────────────────────
// All fields optional — any subset can be populated independently.
// null = data source unavailable or fetch failed.
export type MarketContext = {
  vix?:     VIXData    | null;
  breadth?: BreadthData | null;
  fiidii?:  FIIDIIData  | null;
  pcr?:     PCRData     | null;
  sectors?: SectorData  | null;
  // Which fields were successfully fetched in this context
  available: ('VIX' | 'BREADTH' | 'FII_DII' | 'PCR' | 'SECTORS')[];
  fetchedAt: number;
};

// ── Normalised feature snapshot (for ML when retraining is planned) ───────────
// These are the 0–1 normalised values ready to be appended to the feature vector
// in a future model version. Produced by marketContextFeatures.ts.
export type MarketContextFeatures = {
  // VIX features (5)
  vixNorm:        number;   // current VIX / 40, capped 0–1
  vixSmaRatio:    number;   // current / sma20, 0–1
  vixTrend:       number;   // FALLING=0, FLAT=0.5, RISING=1
  vixMomentum:    number;   // normalised momentum, -1 to 1 mapped to 0–1
  vixRegime:      number;   // LOW=0, NORMAL=0.33, HIGH=0.66, EXTREME=1

  // Breadth features (3)
  adRatio:        number;   // already 0–1
  adTrend:        number;   // BEARISH=0, NEUTRAL=0.5, BULLISH=1
  breadthThrust:  number;   // 0 or 1

  // FII/DII features (4)
  fiiFlowNorm:    number;   // rolling5 / 5000 crore cap, clamped 0–1 (0.5 = neutral)
  diiFlowNorm:    number;
  netFlowNorm:    number;
  fiiBias:        number;   // FII_SELL=0, MIXED=0.5, FII_BUY=1

  // PCR features (3)
  pcrNorm:        number;   // capped 0.5–2.0, normalised to 0–1
  pcrTrend:       number;   // FALLING=0, FLAT=0.5, RISING=1
  pcrSentiment:   number;   // EXTREME_BEARISH=0 ... EXTREME_BULLISH=1

  // Sector features (4)
  sectorMomentum: number;   // mean relative return, normalised
  sectorParticip: number;   // % sectors outperforming, 0–1
  leaderStrength: number;   // leader's relative return, normalised
  sectorBreadth:  number;   // sectors > 0 / total sectors, 0–1
};

// Neutral defaults — used when any data source is unavailable.
// All values at 0.5 = maximally uncertain / neither bullish nor bearish.
export const NEUTRAL_CONTEXT_FEATURES: MarketContextFeatures = {
  vixNorm: 0.35, vixSmaRatio: 0.5, vixTrend: 0.5, vixMomentum: 0.5, vixRegime: 0.33,
  adRatio: 0.5, adTrend: 0.5, breadthThrust: 0,
  fiiFlowNorm: 0.5, diiFlowNorm: 0.5, netFlowNorm: 0.5, fiiBias: 0.5,
  pcrNorm: 0.5, pcrTrend: 0.5, pcrSentiment: 0.5,
  sectorMomentum: 0.5, sectorParticip: 0.5, leaderStrength: 0.5, sectorBreadth: 0.5,
};

export const MARKET_CONTEXT_FEATURE_NAMES = [
  'VIX level',       'VIX vs SMA20',    'VIX trend',     'VIX momentum',  'VIX regime',
  'A/D ratio',       'A/D trend',       'Breadth thrust',
  'FII flow',        'DII flow',        'Net flow',      'FII bias',
  'PCR level',       'PCR trend',       'PCR sentiment',
  'Sector momentum', 'Sector breadth',  'Leader strength','Sector participation',
] as const;
