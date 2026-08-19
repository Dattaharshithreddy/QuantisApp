import { Candle } from './indicators';

// A genuine, much larger technical indicator library — all computed from
// real OHLCV, all standard textbook formulas, no fabricated data.

export function ema(values: number[], period: number): (number | null)[] {
  const k = 2 / (period + 1);
  const out: (number | null)[] = [];
  let prev: number | null = null;
  values.forEach((v, i) => {
    if (i < period - 1) { out.push(null); return; }
    if (prev == null) {
      const seed = values.slice(i - period + 1, i + 1).reduce((s, x) => s + x, 0) / period;
      prev = seed; out.push(seed); return;
    }
    prev = v * k + prev * (1 - k);
    out.push(prev);
  });
  return out;
}

export function sma(values: number[], period: number): (number | null)[] {
  return values.map((_, i) => i < period - 1 ? null : values.slice(i - period + 1, i + 1).reduce((s, v) => s + v, 0) / period);
}

export function closes(c: Candle[]) { return c.map(x => x.close); }

export function macd(c: Candle[], fast = 12, slow = 26, signalP = 9, cl?: number[]) {
  if (!cl) cl = closes(c); // P1 #1: accept precomputed close array
  const emaFast = ema(cl, fast), emaSlow = ema(cl, slow);
  const macdLine = cl.map((_, i) => (emaFast[i] != null && emaSlow[i] != null) ? emaFast[i]! - emaSlow[i]! : null);
  const validMacd = macdLine.filter((v): v is number => v != null);
  const signalRaw = ema(validMacd, signalP);
  // Re-align signal (which was computed on a filtered array) back to full length
  let vi = 0;
  const signal: (number | null)[] = macdLine.map(v => {
    if (v == null) return null;
    const s = signalRaw[vi]; vi++; return s ?? null;
  });
  const hist = macdLine.map((v, i) => (v != null && signal[i] != null) ? v - signal[i]! : null);
  return { macdLine, signal, hist };
}

export function rsiSeries(c: Candle[], period = 14, cl?: number[]): (number | null)[] {
  if (!cl) cl = closes(c); // P1 #1: accept precomputed close array
  const out: (number | null)[] = [null];
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i < cl.length; i++) {
    const diff = cl[i] - cl[i - 1];
    const gain = Math.max(diff, 0), loss = Math.max(-diff, 0);
    if (i <= period) {
      avgGain += gain / period; avgLoss += loss / period;
      out.push(i === period ? 100 - 100 / (1 + (avgLoss === 0 ? Infinity : avgGain / avgLoss)) : null);
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      out.push(100 - 100 / (1 + (avgLoss === 0 ? Infinity : avgGain / avgLoss)));
    }
  }
  return out;
}

// Stochastic RSI: stochastic oscillator applied to the RSI series itself
export function stochasticRSI(c: Candle[], rsiPeriod = 14, stochPeriod = 14): (number | null)[] {
  const rsi = rsiSeries(c, rsiPeriod);
  return rsi.map((_, i) => {
    if (i < rsiPeriod + stochPeriod - 1) return null;
    const window = rsi.slice(i - stochPeriod + 1, i + 1).filter((v): v is number => v != null);
    if (!window.length || rsi[i] == null) return null;
    const hi = Math.max(...window), lo = Math.min(...window);
    return hi === lo ? 50 : ((rsi[i]! - lo) / (hi - lo)) * 100;
  });
}

export function roc(c: Candle[], period = 10, cl?: number[]): (number | null)[] {
  if (!cl) cl = closes(c); // P1 #1: accept precomputed close array
  return cl.map((v, i) => i < period ? null : ((v - cl[i - period]) / cl[i - period]) * 100);
}

export function momentum(c: Candle[], period = 10, cl?: number[]): (number | null)[] {
  if (!cl) cl = closes(c); // P1 #1: accept precomputed close array
  return cl.map((v, i) => i < period ? null : v - cl[i - period]);
}

export function cci(c: Candle[], period = 20): (number | null)[] {
  const tp = c.map(x => (x.high + x.low + x.close) / 3);
  return tp.map((v, i) => {
    if (i < period - 1) return null;
    const window = tp.slice(i - period + 1, i + 1);
    const mean = window.reduce((s, x) => s + x, 0) / period;
    const meanDev = window.reduce((s, x) => s + Math.abs(x - mean), 0) / period;
    return meanDev === 0 ? 0 : (v - mean) / (0.015 * meanDev);
  });
}

export function williamsR(c: Candle[], period = 14): (number | null)[] {
  return c.map((_, i) => {
    if (i < period - 1) return null;
    const window = c.slice(i - period + 1, i + 1);
    const hi = Math.max(...window.map(x => x.high)), lo = Math.min(...window.map(x => x.low));
    return hi === lo ? 0 : ((hi - c[i].close) / (hi - lo)) * -100;
  });
}

// True Strength Index
export function tsi(c: Candle[], longP = 25, shortP = 13, cl?: number[]): (number | null)[] {
  if (!cl) cl = closes(c); // P1 #1: accept precomputed close array
  const mom = cl.map((v, i) => i === 0 ? 0 : v - cl[i - 1]);
  const absMom = mom.map(Math.abs);
  const emaMomLong = ema(mom, longP), emaMomShort = ema(emaMomLong.map(v => v ?? 0), shortP);
  const emaAbsLong = ema(absMom, longP), emaAbsShort = ema(emaAbsLong.map(v => v ?? 0), shortP);
  return cl.map((_, i) => (emaMomShort[i] != null && emaAbsShort[i] != null && emaAbsShort[i] !== 0) ? (emaMomShort[i]! / emaAbsShort[i]!) * 100 : null);
}

export function atr(c: Candle[], period = 14): (number | null)[] {
  const tr = c.map((x, i) => {
    if (i === 0) return x.high - x.low;
    return Math.max(x.high - x.low, Math.abs(x.high - c[i - 1].close), Math.abs(x.low - c[i - 1].close));
  });
  return ema(tr, period);
}

export function bollinger(c: Candle[], period = 20, mult = 2, cl?: number[], midArr?: (number | null)[]) {
  if (!cl) cl = closes(c);           // P1 #1: accept precomputed close array
  const mid = midArr ?? sma(cl, period); // P1 #3: accept precomputed SMA (dedup SMA-20)
  return cl.map((v, i) => {
    if (mid[i] == null) return { upper: null, mid: null, lower: null, widthPct: null };
    const window = cl.slice(i - period + 1, i + 1);
    const std = Math.sqrt(window.reduce((s, x) => s + (x - mid[i]!) ** 2, 0) / period);
    const upper = mid[i]! + mult * std, lower = mid[i]! - mult * std;
    return { upper, mid: mid[i], lower, widthPct: ((upper - lower) / mid[i]!) * 100 };
  });
}

export function keltnerChannel(c: Candle[], emaPeriod = 20, atrPeriod = 10, mult = 2) {
  const cl = closes(c);
  const mid = ema(cl, emaPeriod);
  const a = atr(c, atrPeriod);
  return c.map((_, i) => {
    if (mid[i] == null || a[i] == null) return { upper: null, mid: null, lower: null };
    return { upper: mid[i]! + mult * a[i]!, mid: mid[i], lower: mid[i]! - mult * a[i]! };
  });
}

export function donchianChannel(c: Candle[], period = 20) {
  return c.map((_, i) => {
    if (i < period - 1) return { upper: null, lower: null, mid: null };
    const window = c.slice(i - period + 1, i + 1);
    const upper = Math.max(...window.map(x => x.high)), lower = Math.min(...window.map(x => x.low));
    return { upper, lower, mid: (upper + lower) / 2 };
  });
}

export function historicalVolatility(c: Candle[], period = 20, cl?: number[]): (number | null)[] {
  if (!cl) cl = closes(c); // P1 #1: accept precomputed close array
  const rets = cl.map((v, i) => i === 0 ? 0 : Math.log(v / cl[i - 1]));
  return rets.map((_, i) => {
    if (i < period - 1) return null;
    const window = rets.slice(i - period + 1, i + 1);
    const mean = window.reduce((s, x) => s + x, 0) / period;
    const variance = window.reduce((s, x) => s + (x - mean) ** 2, 0) / period;
    return Math.sqrt(variance) * Math.sqrt(252) * 100; // annualized %
  });
}

export function obv(c: Candle[]): number[] {
  const out: number[] = [0];
  for (let i = 1; i < c.length; i++) {
    const prev = out[i - 1];
    if (c[i].close > c[i - 1].close) out.push(prev + c[i].volume);
    else if (c[i].close < c[i - 1].close) out.push(prev - c[i].volume);
    else out.push(prev);
  }
  return out;
}

export function mfi(c: Candle[], period = 14): (number | null)[] {
  const tp = c.map(x => (x.high + x.low + x.close) / 3);
  const rawFlow = tp.map((v, i) => v * c[i].volume);
  return c.map((_, i) => {
    if (i < period) return null;
    let posFlow = 0, negFlow = 0;
    for (let j = i - period + 1; j <= i; j++) {
      if (tp[j] > tp[j - 1]) posFlow += rawFlow[j];
      else if (tp[j] < tp[j - 1]) negFlow += rawFlow[j];
    }
    if (negFlow === 0) return 100;
    const ratio = posFlow / negFlow;
    return 100 - 100 / (1 + ratio);
  });
}

// Chaikin Money Flow
export function cmf(c: Candle[], period = 20): (number | null)[] {
  const mfv = c.map(x => {
    const range = x.high - x.low;
    const mult = range === 0 ? 0 : ((x.close - x.low) - (x.high - x.close)) / range;
    return mult * x.volume;
  });
  return c.map((_, i) => {
    if (i < period - 1) return null;
    const volSum = c.slice(i - period + 1, i + 1).reduce((s, x) => s + x.volume, 0);
    const mfvSum = mfv.slice(i - period + 1, i + 1).reduce((s, x) => s + x, 0);
    return volSum === 0 ? 0 : mfvSum / volSum;
  });
}

export function volumeOscillator(c: Candle[], fast = 5, slow = 20): (number | null)[] {
  const vol = c.map(x => x.volume);
  const f = sma(vol, fast), s = sma(vol, slow);
  return c.map((_, i) => (f[i] != null && s[i] != null && s[i] !== 0) ? ((f[i]! - s[i]!) / s[i]!) * 100 : null);
}

export function accDist(c: Candle[]): number[] {
  const out: number[] = [];
  let cum = 0;
  c.forEach(x => {
    const range = x.high - x.low;
    const mult = range === 0 ? 0 : ((x.close - x.low) - (x.high - x.close)) / range;
    cum += mult * x.volume;
    out.push(cum);
  });
  return out;
}

export function relativeVolume(c: Candle[], period = 20): (number | null)[] {
  const vol = c.map(x => x.volume);
  const avg = sma(vol, period);
  return vol.map((v, i) => avg[i] != null && avg[i] !== 0 ? v / avg[i]! : null);
}

// VWAP — cumulative from the start of the loaded series (resets are caller's responsibility per-session if needed)
export function vwap(c: Candle[]): number[] {
  let cumPV = 0, cumVol = 0;
  return c.map(x => {
    const tp = (x.high + x.low + x.close) / 3;
    cumPV += tp * x.volume; cumVol += x.volume;
    return cumVol === 0 ? x.close : cumPV / cumVol;
  });
}

export function adx(c: Candle[], period = 14): (number | null)[] {
  const plusDM: number[] = [0], minusDM: number[] = [0], tr: number[] = [c[0] ? c[0].high - c[0].low : 0];
  for (let i = 1; i < c.length; i++) {
    const upMove = c[i].high - c[i - 1].high, downMove = c[i - 1].low - c[i].low;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    tr.push(Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close)));
  }
  const smPlusDM = ema(plusDM, period), smMinusDM = ema(minusDM, period), smTR = ema(tr, period);
  const diPlus = smPlusDM.map((v, i) => (v != null && smTR[i] != null && smTR[i] !== 0) ? (v / smTR[i]!) * 100 : null);
  const diMinus = smMinusDM.map((v, i) => (v != null && smTR[i] != null && smTR[i] !== 0) ? (v / smTR[i]!) * 100 : null);
  const dx = diPlus.map((p, i) => (p != null && diMinus[i] != null && (p + diMinus[i]!) !== 0) ? (Math.abs(p - diMinus[i]!) / (p + diMinus[i]!)) * 100 : null);
  return ema(dx.map(v => v ?? 0), period);
}

// Parabolic SAR — simplified standard implementation
export function parabolicSAR(c: Candle[], step = 0.02, maxStep = 0.2): number[] {
  const out: number[] = [];
  let isUptrend = c[1] ? c[1].close > c[0].close : true;
  let sar = isUptrend ? c[0].low : c[0].high;
  let af = step;
  let ep = isUptrend ? c[0].high : c[0].low;
  out.push(sar);
  for (let i = 1; i < c.length; i++) {
    sar = sar + af * (ep - sar);
    if (isUptrend) {
      sar = Math.min(sar, c[i - 1].low, c[i - 2]?.low ?? c[i - 1].low);
      if (c[i].low < sar) { isUptrend = false; sar = ep; af = step; ep = c[i].low; }
      else { if (c[i].high > ep) { ep = c[i].high; af = Math.min(af + step, maxStep); } }
    } else {
      sar = Math.max(sar, c[i - 1].high, c[i - 2]?.high ?? c[i - 1].high);
      if (c[i].high > sar) { isUptrend = true; sar = ep; af = step; ep = c[i].high; }
      else { if (c[i].low < ep) { ep = c[i].low; af = Math.min(af + step, maxStep); } }
    }
    out.push(sar);
  }
  return out;
}

export function returnsOverHorizons(c: Candle[], horizons = [1, 3, 5, 10, 20]): Record<number, (number | null)[]> {
  const cl = closes(c);
  const result: Record<number, (number | null)[]> = {};
  horizons.forEach(h => {
    result[h] = cl.map((v, i) => i < h ? null : ((v - cl[i - h]) / cl[i - h]) * 100);
  });
  return result;
}
