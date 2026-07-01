import { Candle } from './indicators';

// Pearson correlation coefficient between two return series
function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const aMean = a.slice(0, n).reduce((s, v) => s + v, 0) / n;
  const bMean = b.slice(0, n).reduce((s, v) => s + v, 0) / n;
  let num = 0, denA = 0, denB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - aMean, db = b[i] - bMean;
    num += da * db; denA += da * da; denB += db * db;
  }
  const den = Math.sqrt(denA * denB);
  return den === 0 ? 0 : num / den;
}

function toReturns(candles: Candle[]): number[] {
  const rets: number[] = [];
  for (let i = 1; i < candles.length; i++) rets.push((candles[i].close - candles[i - 1].close) / candles[i - 1].close);
  return rets;
}

// Build an NxN correlation matrix from a map of symbol -> candle array
export function buildCorrelationMatrix(candleMap: Record<string, Candle[]>): { symbols: string[]; matrix: number[][] } {
  const symbols = Object.keys(candleMap);
  const returns = symbols.map(s => toReturns(candleMap[s]));
  const matrix = symbols.map((_, i) => symbols.map((_, j) => (i === j ? 1 : pearson(returns[i], returns[j]))));
  return { symbols, matrix };
}

export function correlationColor(v: number): string {
  // -1 (red) .. 0 (neutral) .. +1 (green)
  if (v > 0.5) return '#089981';
  if (v > 0.15) return '#26a69a88';
  if (v > -0.15) return '#78788840';
  if (v > -0.5) return '#ef535088';
  return '#f23645';
}
