// Direction-forecasting correctness, computed ONLY from the two real
// executed prices already stored on a completed trade (entryPrice,
// exitPrice) and its direction. Deliberately does NOT look at pnl,
// exitReason, confidence, or anything else - per the explicit
// requirement, this measures whether the AI called the market's
// direction correctly, which is a different question from whether the
// trade was profitable after fees/slippage (that's Win Rate, unchanged
// and untouched by this file).
//
// NOTE: this is NOT the same thing as aiPerformanceTracking.ts's
// `predictionAccuracy` field, despite the similar name. That one measures
// calibration - how well the model's CLAIMED probability buckets matched
// REAL hit rates, sourced from predictionHistory.ts's resolved-prediction
// tracking, scoped per symbol/timeframe. This one is a simple per-trade
// "did price move the direction implied by LONG/SHORT" check, sourced
// from the paper trade journal, shown portfolio-wide. They measure
// related but genuinely different things and are not interchangeable.

export type PredictionResult = 'CORRECT' | 'INCORRECT' | 'NEUTRAL';

export function classifyPredictionResult(direction: 'LONG' | 'SHORT', entryPrice: number, exitPrice: number): PredictionResult {
  if (exitPrice === entryPrice) return 'NEUTRAL'; // no meaningful price movement either way
  if (direction === 'LONG') return exitPrice > entryPrice ? 'CORRECT' : 'INCORRECT';
  return exitPrice < entryPrice ? 'CORRECT' : 'INCORRECT'; // SHORT
}
