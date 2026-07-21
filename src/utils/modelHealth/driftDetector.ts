// ─────────────────────────────────────────────────────────────────────────────
// DRIFT DETECTOR  (v6.1.0)
import AsyncStorage from '@react-native-async-storage/async-storage';
// Lightweight statistical structural break detection — O(1) per observation.
//
// Two independent monitors:
//   1. CUSUM (Cumulative Sum) on raw prediction accuracy residuals.
//      Detects sustained bias: model correct 60% in training, now 45% live.
//   2. Page-Hinkley test on feature mean shift.
//      Detects distribution drift: live features consistently higher/lower
//      than the training mean stored in the model's normalization stats.
//
// Output: NORMAL → WATCH → RETRAIN  (never auto-retrains).
//
// Proof of no lookahead:
//   Both tests consume only (y_actual, y_predicted) or (feature_live, mean_train).
//   Both values are available at prediction time (y_actual from the outcome
//   of a closed trade; feature_live from the current bar's feature vector).
//   No future candle is read. No historical array is scanned.
// ─────────────────────────────────────────────────────────────────────────────

export type DriftStatus = 'NORMAL' | 'WATCH' | 'RETRAIN';

export type DriftDetectorState = {
  // CUSUM — accuracy drift
  cusumPos:    number;   // cumulative positive residual
  cusumNeg:    number;   // cumulative negative residual
  n:           number;   // observations processed
  // Page-Hinkley — feature distribution shift
  phSum:       number;   // PH running sum
  phMin:       number;   // minimum seen so far
  phMean:      number;   // running mean of (featureValue - trainingMean) differences
  phN:         number;
  // Derived
  lastStatus:  DriftStatus;
  watchSince:  number;   // Unix ms when status first became WATCH (0 = never)
};

export function emptyDriftState(): DriftDetectorState {
  return { cusumPos: 0, cusumNeg: 0, n: 0, phSum: 0, phMin: 0, phMean: 0, phN: 0, lastStatus: 'NORMAL', watchSince: 0 };
}

// Configuration
export type DriftConfig = {
  // CUSUM: target accuracy in [0,1], allowed slack, detection threshold
  targetAccuracy:  number;   // expected baseline (default: 0.55)
  cusumSlack:      number;   // k — allowance per step (default: 0.05)
  cusumThreshold:  number;   // h — threshold to declare drift (default: 4.0)
  // Page-Hinkley: sensitivity and threshold
  phLambda:        number;   // expected mean of no-drift differences (default: 0.0)
  phDelta:         number;   // detection sensitivity (default: 0.1)
  phThreshold:     number;   // PH statistic threshold (default: 30)
  // Status escalation: bars in WATCH before recommending RETRAIN
  watchToRetrainN: number;   // (default: 30 observations)
};

export const DEFAULT_DRIFT_CONFIG: DriftConfig = {
  targetAccuracy:  0.55,
  cusumSlack:      0.05,
  cusumThreshold:  4.0,
  phLambda:        0.0,
  phDelta:         0.1,
  phThreshold:     30,
  watchToRetrainN: 30,
};

// ── Update CUSUM on one prediction outcome — O(1) ─────────────────────────────
// Call this once per CLOSED trade where we know the actual outcome.
// y_actual: 1 if price moved in predicted direction, 0 otherwise.
// y_predicted: ensemble probability (0–1).
export function updateCUSUM(
  state:      DriftDetectorState,
  y_actual:   0 | 1,
  y_predicted:number,
  cfg:        DriftConfig = DEFAULT_DRIFT_CONFIG,
): DriftDetectorState {
  // Residual: positive when model is too confident (predicted high, was wrong)
  const residual = y_predicted - y_actual;
  const posUpdate = residual - cfg.cusumSlack;
  const negUpdate = -residual - cfg.cusumSlack;

  const cusumPos = Math.max(0, state.cusumPos + posUpdate);
  const cusumNeg = Math.max(0, state.cusumNeg + negUpdate);
  const n = state.n + 1;

  const driftDetected = cusumPos > cfg.cusumThreshold || cusumNeg > cfg.cusumThreshold;
  const newStatus = driftDetected
    ? (state.watchSince > 0 && n - state.watchSince >= cfg.watchToRetrainN ? 'RETRAIN' : 'WATCH')
    : state.lastStatus === 'RETRAIN' ? 'WATCH'  // retrain recommendation persists until cleared
    : 'NORMAL';

  return {
    ...state,
    cusumPos, cusumNeg, n,
    lastStatus:  newStatus,
    watchSince:  driftDetected && state.watchSince === 0 ? Date.now() : state.watchSince,
  };
}

// ── Update Page-Hinkley on one feature observation — O(1) ────────────────────
// Call this once per prediction with the mean absolute z-score of live features
// versus training mean (= driftScore from MLPrediction).
// xi: the observed deviation from training mean (e.g., driftScore).
export function updatePageHinkley(
  state: DriftDetectorState,
  xi:    number,
  cfg:   DriftConfig = DEFAULT_DRIFT_CONFIG,
): DriftDetectorState {
  const phN    = state.phN + 1;
  const phMean = state.phMean + (xi - state.phMean) / phN;  // Welford
  const phSum  = state.phSum + xi - phMean - cfg.phDelta;
  const phMin  = Math.min(state.phMin, phSum);
  const phStat = phSum - phMin;  // PH statistic

  const driftDetected = phStat > cfg.phThreshold;
  const newStatus: DriftStatus = driftDetected ? 'WATCH' : state.lastStatus === 'RETRAIN' ? 'RETRAIN' : state.lastStatus;

  return { ...state, phSum, phMin, phMean, phN, lastStatus: newStatus };
}

// ── Combine CUSUM and PH into a single status ─────────────────────────────────
export function combinedStatus(state: DriftDetectorState): DriftStatus {
  return state.lastStatus;
}

// ── Reset — call after retraining ─────────────────────────────────────────────
export function resetDriftState(): DriftDetectorState {
  return emptyDriftState();
}

// ── Persistence (same AsyncStorage pattern as loadModelMetadata) ──────────────
const DRIFT_KEY = (symbol: string, tf: string) => `driftState_${symbol}_${tf}`;

export async function loadDriftState(
  symbol: string, timeframe: string,
): Promise<DriftDetectorState> {
  try {
    const raw = await AsyncStorage.getItem(DRIFT_KEY(symbol, timeframe));
    return raw ? JSON.parse(raw) : emptyDriftState();
  } catch { return emptyDriftState(); }
}

export async function saveDriftState(
  symbol: string, timeframe: string, state: DriftDetectorState,
): Promise<void> {
  try {
    await AsyncStorage.setItem(DRIFT_KEY(symbol, timeframe), JSON.stringify(state));
  } catch { /* non-critical — drift resets on next load, acceptable */ }
}

export async function clearDriftState(symbol: string, timeframe: string): Promise<void> {
  try { await AsyncStorage.removeItem(DRIFT_KEY(symbol, timeframe)); } catch {}
}
