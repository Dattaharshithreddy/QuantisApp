// ─────────────────────────────────────────────────────────────────────────────
// SMC TYPES  (v4.8.0)
//
// ARCHITECTURAL RULE (enforced throughout the SMC engine):
//   Detection types  — pure facts derivable from OHLCV + Market Structure.
//                      "Does this structure exist?" Boolean / count / price.
//                      No heuristics. No scoring. No probabilities.
//   Scored types     — add heuristic reliability on top of detection facts.
//                      "How reliable is it?" Must carry a version identifier
//                      (e.g. OB_SCORING_V1) so future scoring improvements
//                      never change detection behavior or invalidate backtests.
//
// Detection is frozen once a version ships.
// Scoring versions can be bumped without affecting detection results.
// ─────────────────────────────────────────────────────────────────────────────

// ── Shared primitives ─────────────────────────────────────────────────────────
export type OBDirection = 'bullish' | 'bearish';

// OB status transitions are DETERMINISTIC (objective rules from OHLCV):
//   fresh      → price has not entered the zone since formation
//   tested     → price entered the near-side half but closed outside the zone
//   mitigated  → price entered the zone (touched or closed inside)
//   invalidated→ price CLOSED through the zone's opposing boundary
export type OBStatus = 'fresh' | 'tested' | 'mitigated' | 'invalidated';

// ═══════════════════════════════════════════════════════════════════════════════
// DETECTION TYPES — objective facts only
// ═══════════════════════════════════════════════════════════════════════════════

// Order Block detection result — no heuristics
export type DetectedOB = {
  readonly index:    number;       // bar index of the OB-defining candle
  readonly direction:OBDirection;
  readonly zoneHigh: number;       // candle.high of the OB candle
  readonly zoneLow:  number;       // candle.low  of the OB candle
  readonly bosIndex: number;       // bar index of the BOS that created this OB
  // mutable facts updated as candles advance:
  status: OBStatus;
  touches: number;                 // how many times price entered the zone
  age: number;                     // i - index (bars since formation)
};

// Breaker Block detection — formed when an OB is fully mitigated
export type DetectedBreaker = {
  readonly index:     number;      // bar where mitigation completed
  readonly direction: OBDirection; // direction of the BREAKER (opposite of source OB)
  readonly zoneHigh:  number;      // inherited from the source OB
  readonly zoneLow:   number;
  readonly sourceOBIndex: number;  // the OB that was mitigated
  age: number;
};

// Liquidity Level detection — objectively identifiable clusters
// OBJECTIVE: swing highs within EQUAL_TOL (0.1%) of each other = buy-side liq.
//            swing lows  within EQUAL_TOL of each other = sell-side liq.
// ASSUMPTION (documented): EQUAL_TOL = 0.001 (0.1%). Configurable via SMC_CONFIG.
export type DetectedLiquidity = {
  readonly price:    number;
  readonly type:     'buy_side' | 'sell_side';
  readonly touches:  number;       // how many swing highs/lows at this level
  swept: boolean;                  // price has taken this liquidity
  sweepBar: number | null;
};

// Liquidity Sweep detection — objective: wick-through + close-back
// OBJECTIVE: for buy-side, candle.high > level AND candle.close < level.
//            for sell-side, candle.low  < level AND candle.close > level.
// HEURISTIC (stop hunt): wickRatio is a proxy — see smcScore.ts for formula.
export type DetectedSweep = {
  readonly index:      number;
  readonly type:       'buy_side_sweep' | 'sell_side_sweep';
  readonly levelPrice: number;
  readonly wickSize:   number;     // absolute distance wick extended beyond level
  readonly wickRatio:  number;     // (high-close)/(high-low) for buyside, objective measurement
  readonly closeBack:  boolean;    // close came back through level — always true for a sweep
};

// Premium / Discount detection — fully objective given two swing points
// Position = (price - swingLow) / (swingHigh - swingLow): 0=at low, 1=at high
export type DetectedPD = {
  readonly swingHigh:   number;
  readonly swingLow:    number;
  readonly equilibrium: number;   // (H+L)/2
  readonly position:    number;   // 0–1
  readonly isPremium:   boolean;  // position > 0.5
  readonly isDiscount:  boolean;  // position < 0.5
  // Fibonacci levels — objectively placed, not heuristic
  readonly fib236: number;
  readonly fib382: number;
  readonly fib618: number;
  readonly fib786: number;
};

// ═══════════════════════════════════════════════════════════════════════════════
// SCORED TYPES — heuristic layer on top of detection
// Each scored type carries its scoring version identifier.
// ═══════════════════════════════════════════════════════════════════════════════

// OB_SCORING_V1
// Formula: strength = bosStrength×0.50 + volumeScore×0.30 + recency×0.20
//   recency = 1/(1 + age/50)  [exponential decay, half-life ≈ 50 bars]
// Assumptions:
//   - Larger BOS = more institutional commitment
//   - Higher OB candle volume = more institutional participation
//   - Newer OBs are more relevant (market may have changed since old ones)
// Configurable: see SMC_CONFIG.obScoringWeights
export type ScoredOB = DetectedOB & {
  readonly scoringVersion: 'OB_SCORING_V1';
  readonly bosStrength:    number;  // raw BOS break distance / ATR (0–1)
  readonly volumeScore:    number;  // OB candle volume / 20-bar avg (0–1, capped)
  strength:   number;               // composite 0–1 (updated each bar as age grows)
  confidence: number;               // strength × freshness_factor (0–1)
};

// BB_SCORING_V1
// Formula: strength = sourceOBStrength × 0.80
// Assumption: a breaker is inherently slightly weaker than its source OB
//   because it has already been violated once.
export type ScoredBreaker = DetectedBreaker & {
  readonly scoringVersion: 'BB_SCORING_V1';
  readonly sourceStrength: number;
  strength: number;
};

// LIQ_SCORING_V1
// Formula: strength = min(1, touches / LIQ_TOUCH_SATURATION)
//   LIQ_TOUCH_SATURATION = 4 (configurable)
// Assumption: more touches = more stop orders accumulated = stronger pool.
// HEURISTIC (stop hunt probability): wickRatio threshold = 0.60 (configurable)
//   stopHuntProb = wickRatio > STOP_HUNT_WICK_RATIO ? wickRatio : 0
export type ScoredLiquidity = DetectedLiquidity & {
  readonly scoringVersion: 'LIQ_SCORING_V1';
  strength: number;
};

export type ScoredSweep = DetectedSweep & {
  readonly scoringVersion: 'LIQ_SCORING_V1';
  readonly stopHunt:    boolean;  // wickRatio > STOP_HUNT_WICK_RATIO
  readonly confidence:  number;   // closeBack × (wickRatio×0.5 + wickSize/atr×0.5)
};

// PD_SCORING_V1 — no true heuristic needed; the position is objective.
// pdBias is a signed transformation for ML: -1 = deep premium, +1 = deep discount
// Formula: pdBias = 1 - 2×position  (position=0 → bias=+1, position=1 → bias=-1)
export type ScoredPD = DetectedPD & {
  readonly scoringVersion: 'PD_SCORING_V1';
  readonly pdBias: number;  // -1 to +1
};

// ── Configuration (all thresholds in one place for auditability) ──────────────
export type SMCConfig = {
  equalTol:          number;  // 0.001 — equal highs/lows tolerance (fraction of price)
  stopHuntWickRatio: number;  // 0.60  — wickRatio threshold for stop hunt classification
  liqTouchSaturation:number;  // 4     — touches at which liquidity strength reaches 1.0
  obAgHalfLife:      number;  // 50    — bars at which OB recency = 0.5
  obScoreWeights: { bos: number; volume: number; recency: number }; // must sum to 1
  maxOBAge:          number;  // 200   — bars after which OBs are pruned
  maxActiveOBs:      number;  // 30    — max simultaneous tracked OBs
  bosLookback:       number;  // 30    — bars to scan back for the OB candle
};

export const DEFAULT_SMC_CONFIG: SMCConfig = {
  equalTol:          0.001,
  stopHuntWickRatio: 0.60,
  liqTouchSaturation:4,
  obAgHalfLife:      50,
  obScoreWeights:    { bos: 0.50, volume: 0.30, recency: 0.20 },
  maxOBAge:          200,
  maxActiveOBs:      30,
  bosLookback:       30,
};

// ── ML output ─────────────────────────────────────────────────────────────────
export type SMCScores = {
  bullOBStrength:    number;  // 0–1
  bearOBStrength:    number;  // 0–1
  nearestOBDistance: number;  // 0–1 (inverted proximity)
  liquidityScore:    number;  // 0–1
  liquiditySweep:    number;  // 0 or 1
  stopHuntProb:      number;  // 0–1
  premiumPosition:   number;  // 0–1
  discountPosition:  number;  // 0–1
  breakerBlockScore: number;  // -1 to +1
  mitigationScore:   number;  // 0–1
  obAge:             number;  // 0–1
  obFreshness:       number;  // 0 or 1
  obConfidence:      number;  // 0–1
  pdBias:            number;  // -1 to +1
};

export const SMC_FEATURE_NAMES = [
  'SMC bull OB strength',
  'SMC bear OB strength',
  'SMC OB distance',
  'SMC liquidity score',
  'SMC liquidity sweep',
  'SMC stop hunt prob',
  'SMC premium position',
  'SMC discount position',
  'SMC breaker score',
  'SMC mitigation score',
  'SMC OB age',
  'SMC OB freshness',
  'SMC OB confidence',
  'SMC PD bias',
] as const; // features 66–79 (14 new features)
