// ─────────────────────────────────────────────────────────────────────────────
// MTF TYPES  (v5.1.0)
// ─────────────────────────────────────────────────────────────────────────────

// Supported timeframes — TF multiples used only for aggregation ratio.
// The engine detects the BASE timeframe from candle spacing.
export type Timeframe = '5m' | '15m' | '30m' | '1h' | '4h' | '1d';

export const TF_SECONDS: Record<Timeframe, number> = {
  '5m':  300,
  '15m': 900,
  '30m': 1800,
  '1h':  3600,
  '4h':  14400,
  '1d':  86400,
};

// Ordered from lowest to highest for alignment comparison
export const TF_ORDER: Timeframe[] = ['5m','15m','30m','1h','4h','1d'];

// ── Per-timeframe lightweight signal snapshot ─────────────────────────────────
// Only the signals needed for alignment — NOT a full engine re-run.
// Every value is OBJECTIVE (deterministic from OHLCV of that TF's candles).
export type TFSignal = {
  tf:           Timeframe;
  barCount:     number;             // how many aggregated bars exist for this TF
  // EMA-based trend direction: determined by ema20 vs ema50 crossover (objective)
  trendDir:     -1 | 0 | 1;        // -1=bear, 0=ranging, 1=bull
  // Structure: last swing comparison (objective — same rule as Market Structure Engine)
  structureDir: -1 | 0 | 1;
  // BOS: close beyond most recent swing high (bull) or low (bear) on this TF
  bosDetected:  boolean;
  bosDir:       -1 | 0 | 1;
  // CHoCH: break against prevailing structure trend
  chochDetected:boolean;
  // SMC: last candle direction as proxy for short-term institutional bias (objective)
  smcBias:      -1 | 0 | 1;
  // FVG: does an unfilled FVG exist above or below price?
  fvgAbove:     boolean;           // unfilled bearish FVG above price
  fvgBelow:     boolean;           // unfilled bullish FVG below price
  // VWAP: is price above or below the session VWAP for this TF?
  aboveVWAP:    boolean;
  // Volume: close vs mid-range as volume proxy (objective, no external data needed)
  volumeBias:   -1 | 0 | 1;       // (close - low) / (high - low) > 0.6 = bull, < 0.4 = bear
};

// ── MTF alignment result ──────────────────────────────────────────────────────
// All scores are heuristic composites — computed in mtfScore.ts.
export type MTFAlignment = {
  // Per-dimension alignment across all higher TFs relative to base TF
  // Range: -1 (all bearish) to +1 (all bullish)
  trendAlignment:     number;
  structureAlignment: number;
  bosAlignment:       number;
  chochAlignment:     number;
  smcAlignment:       number;
  fvgAlignment:       number;
  vwapAlignment:      number;
  volumeAlignment:    number;
  // Composite
  overallScore:       number;   // MTF_SCORING_V1 weighted composite
  htfBias:            number;   // bias from the single highest available TF
};

// ── ML features (10, positions 99–108) ───────────────────────────────────────
export type MTFScores = {
  trendAlignment:     number;   // -1 to +1
  structureAlignment: number;   // -1 to +1
  bosAlignment:       number;   // -1 to +1
  chochAlignment:     number;   // -1 to +1
  smcAlignment:       number;   // -1 to +1
  fvgAlignment:       number;   // -1 to +1
  vwapAlignment:      number;   // -1 to +1
  volumeAlignment:    number;   // -1 to +1
  overallMTFScore:    number;   // -1 to +1
  htfBias:            number;   // -1 to +1
};

export const MTF_FEATURE_NAMES = [
  'MTF trend align',      // 99
  'MTF structure align',  // 100
  'MTF BOS align',        // 101
  'MTF CHoCH align',      // 102
  'MTF SMC align',        // 103
  'MTF FVG align',        // 104
  'MTF VWAP align',       // 105
  'MTF volume align',     // 106
  'MTF overall score',    // 107
  'MTF HTF bias',         // 108
] as const;

export type MTFConfig = {
  // HTF weight: higher timeframes count more in alignment score
  // Formula: weight[i] = (i+1) / totalWeight, where i is TF index (higher=heavier)
  // Documented in MTF_SCORING_V1
  htfWeightPower: number;   // 1.5 — exponential weight increase per TF level
  minBarsForTF:   number;   // 10  — minimum bars needed to trust a TF's signal
};

export const DEFAULT_MTF_CONFIG: MTFConfig = {
  htfWeightPower: 1.5,
  minBarsForTF:   10,
};
