// ─────────────────────────────────────────────────────────────────────────────
// PATTERN VALIDATION TYPES  (v6.3.18)
//
// These types define the contract between:
//   1. Geometry detectors  (chartPatterns.ts — unchanged)
//   2. Validation engine   (patternValidationEngine.ts — new)
//   3. Lifecycle tracker   (patternLifecycle.ts — new)
//   4. Risk engine         (patternRiskEngine.ts — new)
//
// Adding a new pattern in the future requires ONLY implementing its geometry
// detector that returns PatternResult (chartPatterns.ts). Every type here,
// and all downstream logic, works automatically with no modifications.
// ─────────────────────────────────────────────────────────────────────────────

// ── Pattern lifecycle states ──────────────────────────────────────────────────
// FORMING   : geometry partially present, not yet complete
// DETECTED  : geometry complete, awaiting breakout / volume confirmation
// CONFIRMED : breakout confirmed by close, volume, and momentum
// FAILED    : false breakout, failed retest, or close back inside pattern
export type PatternStatus = 'FORMING' | 'DETECTED' | 'CONFIRMED' | 'FAILED' | 'EXPIRED';
// EXPIRED: pattern was valid but the expected move did not materialise within maxAgeBars

// ── Confidence tiers ─────────────────────────────────────────────────────────
export type ConfidenceTier =
  | 'VERY_STRONG'   // 90–100
  | 'STRONG'        // 80–89
  | 'GOOD'          // 70–79
  | 'WEAK'          // 60–69
  | 'IGNORE';       // < 60

export function confidenceTier(score: number): ConfidenceTier {
  if (score >= 90) return 'VERY_STRONG';
  if (score >= 80) return 'STRONG';
  if (score >= 70) return 'GOOD';
  if (score >= 60) return 'WEAK';
  return 'IGNORE';
}

// ── Individual validation component scores ────────────────────────────────────
// Each component returns a 0–1 raw score, a weight, and human-readable reasons.
export type ValidationComponent = {
  name: string;
  weight: number;        // must match VALIDATION_WEIGHTS below
  rawScore: number;      // 0–1 before weighting
  weightedScore: number; // rawScore × weight × 100 (contribution to 0–100 total)
  reasons: string[];     // what drove the score up
  failedConditions: string[]; // what dragged it down
};

// ── Framework version ───────────────────────────────────────────────────────
// Bump PATTERN_VALIDATION_VERSION when scoring logic changes.
// Old saved patterns carry their version so future readers know which
// scoring rules produced each result — never silently reinterpret old data.
export const PATTERN_VALIDATION_VERSION = 1 as const;

// ── Pattern expiry windows (in bars) per pattern family ──────────────────────
// Derived from the lookback constants in chartPatterns.ts:
//   Flag / Pennant  : FLAG_MAX=18 → expire after 25 bars (pole + flag + buffer)
//   Triangle        : barsToApex<=50 → expire after 60 bars
//   Double Top/Bot  : LOOKBACK=80 → expire after 50 bars (awaiting confirmation)
//   H&S / IH&S      : LOOKBACK=120 → expire after 80 bars
//   Wedge / Channel : 60-bar lookback → expire after 40 bars
//   Cup & Handle    : CUP_LENS=[30,50,70] → expire after 90 bars
//   Default         : 30 bars when pattern not matched
export const PATTERN_EXPIRY_BARS: Record<string, number> = {
  'Bull Flag':               25,
  'Bear Flag':               25,
  'Bull Pennant':            25,
  'Bear Pennant':            25,
  'Ascending Triangle':      60,
  'Descending Triangle':     60,
  'Symmetrical Triangle':    60,
  'Double Top':              50,
  'Double Bottom':           50,
  'Head & Shoulders':        80,
  'Inverse Head & Shoulders':80,
  'Rising Wedge':            40,
  'Falling Wedge':           40,
  'Uptrend Channel':         40,
  'Downtrend Channel':       40,
  'Cup & Handle':            90,
};

export const DEFAULT_PATTERN_EXPIRY_BARS = 30;

// ── Confidence score history entry ────────────────────────────────────────────
// Stored to show whether a pattern is building conviction or decaying.
// trend: 'up' | 'down' | 'flat' is derived by comparing to the previous entry.
export type ConfidenceSnapshot = {
  bar:        number;         // candle bar index at which this was measured
  confidence: number;         // 0–100
  status:     PatternStatus;
  timestamp:  number;         // Date.now() at measurement time
};

// ── Component scores for AI explainability ────────────────────────────────────
// These are the per-component WEIGHTED contributions (sum → total confidence).
// Stored separately from reasons[] so AI can say:
//   'Volume score dropped from 16 to 9 — breakout volume weakened'
// without recalculating anything.
export type ComponentScores = {
  trend:          number;  // 0–15
  volume:         number;  // 0–20
  breakout:       number;  // 0–20
  retest:         number;  // 0–15
  momentum:       number;  // 0–10
  candlestick:    number;  // 0–5
  supportResist:  number;  // 0–10
  patternQuality: number;  // 0–5
};

// ── Validation weights — must sum to 1.0
// These reflect quant practitioner consensus on relative importance.
export const VALIDATION_WEIGHTS = {
  trend:          0.15,  // Prior trend and market structure alignment
  volume:         0.20,  // Volume confirmation at breakout
  breakout:       0.20,  // Quality and validity of the breakout
  retest:         0.15,  // Successful retest / pullback confirmation
  momentum:       0.10,  // RSI, MACD, ADX, EMA alignment
  candlestick:    0.05,  // Candle quality at breakout / key levels
  supportResist:  0.10,  // S/R, OB, FVG, liquidity zone alignment
  patternQuality: 0.05,  // Symmetry, touches, duration, neckline fit
} as const;

// Validate at compile time that weights sum to 1.0
const _weightSum = Object.values(VALIDATION_WEIGHTS).reduce((s, v) => s + v, 0);
// TypeScript cannot do this at compile time, but the unit test in validatePattern.ts
// will catch any drift. Expected: 1.00.

// ── Validation breakdown ──────────────────────────────────────────────────────
export type ValidationBreakdown = {
  trend:          ValidationComponent;
  volume:         ValidationComponent;
  breakout:       ValidationComponent;
  retest:         ValidationComponent;
  momentum:       ValidationComponent;
  candlestick:    ValidationComponent;
  supportResist:  ValidationComponent;
  patternQuality: ValidationComponent;
};

// ── Risk levels per target ────────────────────────────────────────────────────
export type PatternRisk = {
  entry:       number;   // suggested entry price
  stopLoss:    number;   // hard stop loss
  target1:     number;   // conservative target (0.5R or pattern midpoint)
  target2:     number;   // primary target (full pattern projection)
  target3:     number;   // extended target (1.5× pattern projection)
  riskReward1: number;   // R:R to target1
  riskReward2: number;   // R:R to target2
  riskReward3: number;   // R:R to target3
  stopDistance:number;   // |entry - stopLoss| in price units
  atrMultiple: number;   // stopDistance / ATR (context for stop sizing)
};

// ── Breakout state ─────────────────────────────────────────────────────────────
export type BreakoutState = {
  hasBreakout:      boolean;
  breakoutBar:      number | null;  // bar index where close crossed level
  breakoutPrice:    number | null;
  breakoutStrength: number;         // 0–1: how far close is beyond level (ATR units)
  isCloseBreakout:  boolean;        // true = close-based (not wick-only)
  volumeAtBreakout: number | null;  // relative to 20-bar average
  falseBreakout:    boolean;        // close returned inside pattern within 3 bars
};

// ── Retest state ──────────────────────────────────────────────────────────────
export type RetestState = {
  hasRetest:       boolean;
  retestBar:       number | null;
  retestPrice:     number | null;
  retestSuccess:   boolean;         // bounced from breakout level = successful
  retestFailed:    boolean;         // closed back through level = failed
};

// ── Full validated pattern result ─────────────────────────────────────────────
// This is what validatePattern() returns for every detected geometry.
export type ValidatedPattern = {
  // Identity
  patternName:    string;
  direction:      'bullish' | 'bearish' | 'neutral';

  // Lifecycle
  status:         PatternStatus;

  // Confidence
  confidence:     number;           // 0–100, weighted composite
  tier:           ConfidenceTier;
  bullishProbability: number;       // 0–1 (confidence × direction bias)
  bearishProbability: number;       // 0–1

  // Breakout & retest state
  breakout:       BreakoutState;
  retest:         RetestState;

  // Risk management (null when RR < 1.5 or pattern rejected)
  risk:           PatternRisk | null;

  // Geometry passthrough from the detector (never recomputed here)
  breakoutLevel:  number | null;    // neckline / resistance / breakout price
  stopLoss:       number | null;    // from geometry detector

  // Human-readable output
  reasons:        string[];         // conditions that PASSED (increase confidence)
  failedConditions: string[];       // conditions that FAILED (reduce confidence)

  // Detailed breakdown per component
  validationBreakdown: ValidationBreakdown;

  // ── Stable pattern identity ───────────────────────────────────────────────
  // Format: SYMBOL-TIMEFRAME-PatternName-anchorBarTimestamp
  // Example: BTCUSDT-15m-DoubleBottom-1720602000
  // Stable across re-runs because the anchor bar (oldest keyPoint) is fixed.
  // Used to: deduplicate alerts, update lifecycle on same pattern, avoid re-notifying.
  patternId:   string;

  // ── Framework version ─────────────────────────────────────────────────────
  // The version of PATTERN_VALIDATION_VERSION that produced this result.
  // When the framework upgrades to v2, old stored patterns remain interpretable.
  patternValidationVersion: number;

  // ── Expiry ───────────────────────────────────────────────────────────────
  maxAgeBars:  number;  // from PATTERN_EXPIRY_BARS — how long the pattern is valid
  expiresAtBar:number;  // detectedAtBar + maxAgeBars

  // ── Confidence history ────────────────────────────────────────────────────
  // Append a new snapshot each time validatePattern() is called on the same
  // patternId. The caller is responsible for accumulating this array.
  // validatePattern() always sets scoreHistory to [currentSnapshot];
  // the caller merges it with any previously stored history.
  scoreHistory: ConfidenceSnapshot[];

  // ── Per-component weighted scores for AI explainability ───────────────────
  // These are the individual contributions to the total confidence.
  // AI can explain: 'Volume score dropped 16→9 — breakout volume weakened'.
  componentScores: ComponentScores;

  // ── Raw geometry metadata from the detector
  metadata: {
    geometryStrength:     number;   // from PatternResult.strength
    geometryScore:        number;   // from PatternResult.score
    detectedAtBar:        number;
    patternAgeInBars:     number;
    keyPointCount:        number;
    // How many bars elapsed from FORMING to CONFIRMED.
    // null until the pattern reaches CONFIRMED status.
    // Fast confirmations (few bars) often behave differently from slow ones.
    validationDuration:   number | null;
  };
};

// ── Input to the validation engine ────────────────────────────────────────────
// Consumers call validatePattern(geometry, candles, context).
// The framework computes everything from these inputs using existing indicators.
export type PatternValidationContext = {
  candles:       import('../indicators').Candle[];
  currentBar:    number;                  // the bar at which validation runs
  atr:           number;                  // current ATR (from atr() in technicalIndicators)
  // Optional: the bar at which this pattern was first seen in FORMING state.
  // When provided, validationDuration = confirmedBar - formingBar (accurate).
  // When absent, estimated from the oldest keyPoint bar (approximate).
  formingBar?:   number;
  // Optional: pre-computed values from existing engines to avoid re-computation.
  // When absent, the validator computes them from candles.
  precomputed?: {
    rsi?:        number | null;
    macdHist?:   number | null;
    adxValue?:   number | null;
    obv?:        number[];
    cmf?:        (number | null)[];
    relVol?:     (number | null)[];
    nearestOBHigh?: number | null;       // from SMC engine if available
    nearestOBLow?:  number | null;
    fvgBullishLevel?: number | null;     // from FVG engine if available
    fvgBearishLevel?: number | null;
    vwap?:       number | null;
  };
};


// ═════════════════════════════════════════════════════════════════════════════
// OUTCOME TRACKING TYPES
//
// These types belong to the POST-CONFIRMATION layer.
// validatePattern() is stateless and ends at CONFIRMED/FAILED/EXPIRED.
// Outcome tracking is stateful: it watches price AFTER confirmation
// to record whether the expected move materialised.
//
// Architecture:
//   validatePattern()    → PatternStatus (FORMING/DETECTED/CONFIRMED/FAILED/EXPIRED)
//   PatternOutcome       → OutcomeStatus (ACTIVE/TP1_HIT/TP2_HIT/TP3_HIT/STOPPED/CLOSED)
//
// These are separate concerns. The validation engine never reads outcome data.
// The outcome tracker only acts on CONFIRMED patterns.
// ═════════════════════════════════════════════════════════════════════════════

// ── Outcome lifecycle states ──────────────────────────────────────────────────
// ACTIVE    : pattern confirmed, position/monitoring open
// TP1_HIT   : price reached Target 1 (conservative: 0.5× pattern height)
// TP2_HIT   : price reached Target 2 (full measured move)
// TP3_HIT   : price reached Target 3 (1.618× extension)
// STOPPED   : stop-loss hit before any target
// CLOSED    : manually closed, or pattern monitoring ended without a clear hit
// ── Completion reason — WHY an outcome ended ─────────────────────────────────
// Provides richer analytics than outcomeStatus alone.
// STOP_LOSS     : stop-loss hit (maps to outcomeStatus STOPPED)
// TP1_REACHED   : first target hit (outcomeStatus TP1_HIT)
// TP2_REACHED   : second target hit (outcomeStatus TP2_HIT)
// TP3_REACHED   : third target hit — full extension (outcomeStatus TP3_HIT)
// TIME_EXPIRY   : maxAgeBars elapsed without a breakout (outcomeStatus CLOSED)
// MANUAL_CLOSE  : caller explicitly closed (outcomeStatus CLOSED)
// INVALIDATED   : a new opposing pattern or BOS invalidated this one (outcomeStatus CLOSED)
// null          : outcome still ACTIVE — not yet closed
export type CompletionReason =
  | 'STOP_LOSS'
  | 'TP1_REACHED'
  | 'TP2_REACHED'
  | 'TP3_REACHED'
  | 'TIME_EXPIRY'
  | 'MANUAL_CLOSE'
  | 'INVALIDATED';

export type OutcomeStatus =
  | 'ACTIVE'
  | 'TP1_HIT'
  | 'TP2_HIT'
  | 'TP3_HIT'
  | 'STOPPED'
  | 'CLOSED';

// ── Full outcome record for one confirmed pattern ─────────────────────────────
export type PatternOutcome = {
  // Links back to the validated pattern
  patternId:               string;
  patternName:             string;
  symbol:                  string;
  timeframe:               string;
  direction:               'bullish' | 'bearish' | 'neutral';
  patternValidationVersion:number;

  // Scoring version that produced confirmationConfidence.
  // undefined on outcomes created before v6.3.29 (treat as version 0 = pre-versioning).
  // Allows Phase 3 to filter outcomes by scoring version before comparing results.
  confidenceScoringVersion?: number;

  // Optional experiment label — set manually when deliberately testing a parameter
  // variant. Two outcomes can share confidenceScoringVersion = 2 but differ on
  // experimentTag ('patcorr75' vs 'patcorr60') without needing separate version numbers.
  // Leave undefined during normal operation (baseline data collection).
  // Only set this when running a controlled experiment — never change it mid-experiment.
  experimentTag?: string;

  // Confirmation context (snapshot at the moment of CONFIRMED status)
  confirmedAtBar:          number;
  confirmedAtTimestamp:    number;
  confirmationConfidence:  number;    // 0–100 at the moment of confirmation
  componentScoresAtConfirm:ComponentScores;
  entry:                   number;
  stopLoss:                number;
  target1:                 number;
  target2:                 number;
  target3:                 number;
  riskReward2:             number;    // R:R to primary target

  // Live outcome tracking
  outcomeStatus:           OutcomeStatus;
  // WHY the outcome ended. Null while still ACTIVE.
  // Separates TIME_EXPIRY from MANUAL_CLOSE from INVALIDATED
  // — all of which share outcomeStatus='CLOSED' — enabling
  // analytics: '10% expired without triggering vs 18% stopped.'
  completionReason:        CompletionReason | null;
  tp1Hit:                  boolean;
  tp2Hit:                  boolean;
  tp3Hit:                  boolean;
  stopHit:                 boolean;
  tp1Bar:                  number | null;  // bar index when TP1 was first touched
  tp2Bar:                  number | null;
  tp3Bar:                  number | null;
  stopBar:                 number | null;
  closedBar:               number | null;
  closeBar:                number | null;  // alias: bar at which monitoring ended
  closedPrice:             number | null;  // price at final close
  realizedPnLPct:          number | null;  // (closedPrice - entry) / entry × direction
  barsToFirstTarget:       number | null;  // bars from confirmAtBar to TP1 hit
  barsToClose:             number | null;  // bars from confirmAtBar to close

  // Validation duration from this pattern (for regression analysis)
  validationDuration:      number | null;  // bars from FORMING to CONFIRMED
};

// ── Aggregate stats per pattern family ───────────────────────────────────────
// Answers: "Which pattern has the highest TP1 hit rate?"
export type PatternFamilyStats = {
  patternName:       string;
  totalConfirmed:    number;
  tp1HitCount:       number;
  tp2HitCount:       number;
  tp3HitCount:       number;
  stoppedCount:      number;
  tp1HitRate:        number;   // 0–1
  tp2HitRate:        number;   // 0–1
  tp3HitRate:        number;   // 0–1
  stopRate:          number;   // 0–1
  avgRealizedPnLPct: number;   // mean P&L across all closed outcomes
  avgBarsToTP1:      number | null;
  avgValidationDuration: number | null;
  // Used to decide whether to adjust confidence weighting for this pattern
  // e.g. "Double Bottom TP1 hit rate = 72%, raise confidence weight?"
  sampleSufficient:  boolean;  // true when totalConfirmed >= MIN_OUTCOME_SAMPLE
  // Completion reason breakdown — distinguishes CLOSED subtypes
  expiredCount:      number;   // TIME_EXPIRY
  manualCloseCount:  number;   // MANUAL_CLOSE
  invalidatedCount:  number;   // INVALIDATED
  expiredRate:       number;   // 0–1
};

// Minimum samples before stats are considered statistically meaningful
export const MIN_OUTCOME_SAMPLE = 20;

// ── Experiment ID utility ─────────────────────────────────────────────────────
// Generates a human-readable composite ID from individual version fields.
// Used for logging, display, and grouping — NOT stored in PatternOutcome.
// Individual numeric fields (confidenceScoringVersion, patternValidationVersion)
// are the source of truth for filtering.
//
// Format: "cs{n}-pv{n}" where cs=confidenceScoring, pv=patternValidation
// Example: "cs1-pv1" = confidence scoring v1 + pattern validation v1
//
// When consensusEngine.ts TIMEFRAME_WEIGHTS change for the first time:
//   1. Add CONSENSUS_VERSION constant to consensusEngine.ts
//   2. Add consensusVersion?: number to PatternOutcome
//   3. Extend this function: `cv${cv ?? 0}` segment
// Until then, consensusVersion is omitted (it has not changed from baseline).
//
// Usage:
//   const id = buildExperimentId(outcome);
//   logger.info('analysis', `Outcome ${id}: TP1 hit rate ${rate}`);
export function buildExperimentId(outcome: {
  confidenceScoringVersion?: number;
  patternValidationVersion:  number;
  experimentTag?:            string;
}): string {
  const cs  = outcome.confidenceScoringVersion ?? 0;
  const pv  = outcome.patternValidationVersion;
  const tag = outcome.experimentTag ? `-${outcome.experimentTag}` : '';
  return `cs${cs}-pv${pv}${tag}`;
  // Examples:
  //   normal operation:  'cs1-pv1'
  //   controlled test:   'cs2-pv1-patcorr60'
}

// Convenience: generate the current experiment ID without a stored outcome.
// Use this in logs and analytics queries to label the current running version.
export function currentExperimentId(): string {
  return `cs${CONFIDENCE_SCORING_VERSION_REF}-pv${PATTERN_VALIDATION_VERSION}`;
}

// Re-imported here so currentExperimentId() has access without circular deps.
// CONFIDENCE_SCORING_VERSION lives in confidenceTypes.ts — we reference its
// value as a literal to avoid importing from a non-patternValidation module.
// UPDATE THIS when CONFIDENCE_SCORING_VERSION increments.
const CONFIDENCE_SCORING_VERSION_REF = 1;

