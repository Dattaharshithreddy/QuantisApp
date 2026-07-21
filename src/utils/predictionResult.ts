// Direction-forecasting correctness — computed ONLY from entryPrice, exitPrice,
// and direction. Does NOT look at pnl, exitReason, confidence, or anything else.
//
// This answers: "Did the market move in the direction the AI predicted, up to
// the actual exit point?" — independent of how or why the trade was closed.
//
// Examples:
//   LONG, entry=100, manual exit=102  → CORRECT  (price moved up)
//   LONG, entry=100, manual exit=98   → INCORRECT (price moved down — prediction was wrong regardless of why user exited)
//   LONG, entry=100, TP hit at=103    → CORRECT
//   LONG, entry=100, SL hit at=97     → INCORRECT
//
// This is NOT the same as TradeManagementOutcome (see below), which records
// HOW the trade was closed (TP/SL/Manual/Time). Keeping these separate:
//   - PredictionResult  = AI accuracy signal (correct direction call?)
//   - TradeManagementOutcome = execution signal (how was it managed?)
//
// NOTE: also NOT the same as aiPerformanceTracking.ts's predictionAccuracy
// (calibration — how well claimed probabilities matched actual hit rates).
// These are three related but genuinely different measurements.

export type PredictionResult = 'CORRECT' | 'INCORRECT' | 'NEUTRAL';

// How the trade was closed — separate from whether the prediction was correct.
// A manually closed trade can have a CORRECT prediction (price moved right
// direction before user exited) with a MANUAL_CLOSE management outcome.
// 'TIME_EXIT' = position closed due to maxBarsHeld limit from strategy profile.
export type TradeManagementOutcome =
  | 'TAKE_PROFIT'    // SL/TP engine hit take-profit level
  | 'STOP_LOSS'      // SL/TP engine hit stop-loss level
  | 'MANUAL_CLOSE'   // user manually closed position
  | 'TIME_EXIT'      // maxBarsHeld limit reached (strategy profile)
  | 'AI_EXIT'        // AI Copilot exit signal
  | 'UNKNOWN';       // backward-compat: older records without this field

export function classifyPredictionResult(
  direction:  'LONG' | 'SHORT',
  entryPrice: number,
  exitPrice:  number,
): PredictionResult {
  if (exitPrice === entryPrice) return 'NEUTRAL';
  if (direction === 'LONG')  return exitPrice > entryPrice ? 'CORRECT' : 'INCORRECT';
  return exitPrice < entryPrice ? 'CORRECT' : 'INCORRECT'; // SHORT
}

// Map CloseReason string (including legacy values) to TradeManagementOutcome.
// Handles both old 'MANUAL_EXIT' (legacy) and new 'MANUAL_CLOSE'.
export function classifyManagementOutcome(exitReason: string): TradeManagementOutcome {
  switch (exitReason) {
    case 'TAKE_PROFIT':   return 'TAKE_PROFIT';
    case 'STOP_LOSS':     return 'STOP_LOSS';
    case 'MANUAL_CLOSE':  return 'MANUAL_CLOSE';
    case 'MANUAL_EXIT':   return 'MANUAL_CLOSE'; // legacy value → canonical name
    case 'TIME_EXIT':     return 'TIME_EXIT';
    case 'AI_EXIT_SIGNAL':return 'AI_EXIT';
    default:              return 'UNKNOWN';
  }
}

// Human-readable label for TradeManagementOutcome — used in journal UI.
export function managementOutcomeLabel(outcome: TradeManagementOutcome): string {
  switch (outcome) {
    case 'TAKE_PROFIT':  return '✅ Take Profit';
    case 'STOP_LOSS':    return '🛑 Stop Loss';
    case 'MANUAL_CLOSE': return '🤚 Manual Close';
    case 'TIME_EXIT':    return '⏱ Time Exit';
    case 'AI_EXIT':      return '🤖 AI Signal Exit';
    case 'UNKNOWN':      return 'Exit';
  }
}
