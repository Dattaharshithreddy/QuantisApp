import AsyncStorage from '@react-native-async-storage/async-storage';
import { Candle } from './indicators';
import { logger } from './logger';

// Tracks real predictions and their actual outcomes over time, per symbol —
// this is what makes "historical calibration" a genuine measurement rather
// than a fabricated input. A prediction is "resolved" once enough bars have
// passed to check whether price actually went up as predicted; until then
// it sits unresolved. Calibration only ever uses RESOLVED predictions.

export type PredictionRecord = {
  time: number;        // when the prediction was made (bar time)
  ensembleProbUp: number;
  horizon: number;
  resolved: boolean;
  wasCorrect?: boolean; // filled in once resolved
};

// FIX (same gap found and fixed for model storage in Phase 1): this was
// symbol-only, with no timeframe — predictions made on 5m and 1D candles
// for the same symbol would land in the SAME calibration history, blending
// timeframes together and making any per-timeframe calibration score
// meaningless. Fixed by keying on symbol+timeframe, matching the model
// storage fix exactly.
const HISTORY_KEY = (symbol: string, timeframe: string) => `predictionHistory_${symbol}_${timeframe}`;
const MAX_RECORDS = 200; // cap storage growth — keeps the most recent 200 predictions per symbol

export async function recordPrediction(symbol: string, timeframe: string, time: number, ensembleProbUp: number, horizon: number): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(HISTORY_KEY(symbol, timeframe));
    const history: PredictionRecord[] = raw ? JSON.parse(raw) : [];
    // Avoid duplicate records for the same bar (e.g. re-pressing Train & Predict on the same live bar)
    if (history.some(r => r.time === time)) return;
    history.push({ time, ensembleProbUp, horizon, resolved: false });
    const trimmed = history.slice(-MAX_RECORDS);
    await AsyncStorage.setItem(HISTORY_KEY(symbol, timeframe), JSON.stringify(trimmed));
  } catch (e: any) {
    logger.warn('predictionHistory', `${symbol}: failed to record: ${e.message}`);
  }
}

// Call this with the latest candles whenever convenient (e.g. each time a
// chart loads) — resolves any past predictions where enough bars have now
// passed to check the actual outcome against real price data.
export async function resolveOutcomes(symbol: string, timeframe: string, candles: Candle[]): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(HISTORY_KEY(symbol, timeframe));
    if (!raw) return;
    const history: PredictionRecord[] = JSON.parse(raw);
    let changed = false;

    history.forEach(record => {
      if (record.resolved) return;
      const atIdx = candles.findIndex(c => c.time === record.time);
      if (atIdx < 0 || atIdx + record.horizon >= candles.length) return; // not enough bars yet, or this bar isn't in the current window
      const actualUp = candles[atIdx + record.horizon].close > candles[atIdx].close;
      const predictedUp = record.ensembleProbUp > 0.5;
      record.wasCorrect = actualUp === predictedUp;
      record.resolved = true;
      changed = true;
    });

    if (changed) await AsyncStorage.setItem(HISTORY_KEY(symbol, timeframe), JSON.stringify(history));
  } catch (e: any) {
    logger.warn('predictionHistory', `${symbol}: failed to resolve outcomes: ${e.message}`);
  }
}

export type CalibrationBucket = { range: string; nominalProb: number; actualHitRate: number; sampleCount: number };

// Buckets resolved predictions by confidence range and compares the NOMINAL
// probability (what the model claimed) against the ACTUAL hit rate (what
// really happened). A well-calibrated model's actual hit rate should track
// its nominal probability closely; a meaningful gap means confidence numbers
// shouldn't be taken at face value.
export async function getCalibration(symbol: string, timeframe: string): Promise<{ buckets: CalibrationBucket[]; totalResolved: number; available: boolean }> {
  try {
    const raw = await AsyncStorage.getItem(HISTORY_KEY(symbol, timeframe));
    const history: PredictionRecord[] = raw ? JSON.parse(raw) : [];
    const resolved = history.filter(r => r.resolved);

    if (resolved.length < 20) {
      return { buckets: [], totalResolved: resolved.length, available: false };
    }

    const ranges = [
      { label: '50-60%', min: 0.5, max: 0.6 }, { label: '60-70%', min: 0.6, max: 0.7 },
      { label: '70-80%', min: 0.7, max: 0.8 }, { label: '80-100%', min: 0.8, max: 1.01 },
    ];
    const buckets: CalibrationBucket[] = ranges.map(r => {
      const inBucket = resolved.filter(rec => {
        const distFromHalf = Math.abs(rec.ensembleProbUp - 0.5) + 0.5; // fold below-50% predictions symmetrically
        return distFromHalf >= r.min && distFromHalf < r.max;
      });
      const hits = inBucket.filter(rec => rec.wasCorrect).length;
      return {
        range: r.label, nominalProb: (r.min + Math.min(r.max, 1)) / 2 * 100,
        actualHitRate: inBucket.length ? (hits / inBucket.length) * 100 : 0,
        sampleCount: inBucket.length,
      };
    }).filter(b => b.sampleCount > 0);

    return { buckets, totalResolved: resolved.length, available: true };
  } catch (e: any) {
    logger.warn('predictionHistory', `${symbol}: failed to compute calibration: ${e.message}`);
    return { buckets: [], totalResolved: 0, available: false };
  }
}
