import { Candle, calcRSI } from './indicators';
import { ema, macd, adx, relativeVolume } from './technicalIndicators';

// A single shared "what do the real indicators say right now" snapshot,
// reused by BOTH the Consensus Engine (trend strength) and the AI
// Explanation generator (Phase 4) — built once here rather than each
// computing its own copy. Every function called below already exists and
// was already tested elsewhere in this app; this module only reads their
// latest values, it computes nothing new.

export type IndicatorSnapshot = {
  price: number;
  ema200: number | null;
  aboveEma200: boolean | null;
  rsi: number;
  rsiRecovering: boolean; // RSI rising from oversold territory
  rsiOverbought: boolean;
  macdHistogram: number | null;
  macdBullish: boolean;
  adxValue: number | null;
  adxStrengthening: boolean; // ADX rising over the last few bars — trend gaining strength, not just present
  relativeVolume: number | null;
  volumeExpansion: boolean; // current volume meaningfully above its recent average
};

export function getIndicatorSnapshot(candles: Candle[]): IndicatorSnapshot | null {
  if (candles.length < 60) return null;
  const i = candles.length - 1;
  const closesArr = candles.map(c => c.close);

  const ema200Series = ema(closesArr, 200);
  const ema200 = ema200Series[i];
  const price = candles[i].close;

  const rsi = calcRSI(candles.slice(Math.max(0, i - 14), i + 1));
  const rsiAt = (idx: number) => calcRSI(candles.slice(Math.max(0, idx - 14), idx + 1));
  const rsiPrev = i >= 3 ? rsiAt(i - 3) : rsi;
  const rsiRecovering = rsi > rsiPrev && rsi < 60 && rsiPrev < 45; // was oversold-ish, now climbing

  const macdResult = macd(candles);
  const macdHist = macdResult.hist[i];

  const adxSeries = adx(candles);
  const adxValue = adxSeries[i];
  const adxPrev = i >= 3 ? adxSeries[i - 3] : adxValue;
  const adxStrengthening = adxValue != null && adxPrev != null && adxValue > adxPrev;

  const relVol = relativeVolume(candles);
  const relVolValue = relVol[i];

  return {
    price, ema200, aboveEma200: ema200 != null ? price > ema200 : null,
    rsi, rsiRecovering, rsiOverbought: rsi > 70,
    macdHistogram: macdHist, macdBullish: macdHist != null && macdHist > 0,
    adxValue, adxStrengthening,
    relativeVolume: relVolValue, volumeExpansion: relVolValue != null && relVolValue > 1.3,
  };
}
