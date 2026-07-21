import { Asset } from '../api/assets';
import { Candle, calcMA, calcRSI } from './indicators';

export type ScreenResult = {
  symbol: string;
  name: string;
  price: number;
  rsi: number;
  signal: 'OVERSOLD' | 'OVERBOUGHT' | 'ABOVE_MA' | 'BELOW_MA' | 'NEUTRAL';
  detail: string;
};

// Scans a set of already-fetched candle series and flags actionable technical conditions.
// This runs entirely on-device against data you already pulled — no extra API calls.
export function screenAssets(candleMap: Record<string, Candle[]>, assets: Asset[]): ScreenResult[] {
  const results: ScreenResult[] = [];
  assets.forEach(a => {
    const candles = candleMap[a.symbol];
    if (!candles || candles.length < 20) return;
    const rsi = calcRSI(candles);
    const ma20 = calcMA(candles, 20)[candles.length - 1];
    const price = candles[candles.length - 1].close;
    let signal: ScreenResult['signal'] = 'NEUTRAL';
    let detail = `RSI ${rsi}`;
    if (rsi <= 30) { signal = 'OVERSOLD'; detail = `RSI ${rsi} — potential bounce zone`; }
    else if (rsi >= 70) { signal = 'OVERBOUGHT'; detail = `RSI ${rsi} — potential pullback zone`; }
    else if (ma20 && price > ma20 * 1.01) { signal = 'ABOVE_MA'; detail = `${(((price - ma20) / ma20) * 100).toFixed(1)}% above MA20`; }
    else if (ma20 && price < ma20 * 0.99) { signal = 'BELOW_MA'; detail = `${(((ma20 - price) / ma20) * 100).toFixed(1)}% below MA20`; }
    if (signal !== 'NEUTRAL') results.push({ symbol: a.symbol, name: a.name, price, rsi, signal, detail });
  });
  return results;
}

export const SIGNAL_META: Record<ScreenResult['signal'], { label: string; color: string }> = {
  OVERSOLD: { label: '🟢 OVERSOLD', color: '#26a69a' },
  OVERBOUGHT: { label: '🔴 OVERBOUGHT', color: '#ef5350' },
  ABOVE_MA: { label: '▲ TREND UP', color: '#2962ff' },
  BELOW_MA: { label: '▼ TREND DOWN', color: '#9c27b0' },
  NEUTRAL: { label: '— NEUTRAL', color: '#787b86' },
};
