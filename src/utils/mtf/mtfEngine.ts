// ─────────────────────────────────────────────────────────────────────────────
// MTF ENGINE  (v5.1.0)
//
// Design: lightweight signal extraction only.
// The full engine stack (structure, SMC, FVG, volume) is NOT re-run on every
// aggregated TF — that would be O(n × TF_count × engine_cost).
// Instead, each TF gets a single lightweight O(n/k) pass producing
// 7 objective directional signals from aggregated OHLCV.
//
// Objective signals extracted per TF (no heuristics here):
//   trendDir:     EMA20 > EMA50 → +1, < → -1, crossing → 0
//   structureDir: last two swing highs/lows comparison (HH/HL or LH/LL)
//   bosDetected:  close > last swing high (bull) or < last swing low (bear)
//   smcBias:      last candle close > open → +1 (bullish candle), else -1
//   fvgAbove/fvgBelow: three-bar gap check (prev2.high < c.low for bearish FVG above)
//   aboveVWAP:    cumulative VWAP from first bar of this aggregated series
//   volumeBias:   (close - low) / (high - low) > 0.6 → +1, < 0.4 → -1, else 0
//
// No lookahead: all signals at aggregated-bar k use only bars 0..k of that TF.
// ─────────────────────────────────────────────────────────────────────────────
import { Candle } from '../indicators';
import {
  Timeframe, TFSignal, MTFScores, MTF_FEATURE_NAMES,
  DEFAULT_MTF_CONFIG, MTFConfig, TF_SECONDS, TF_ORDER,
} from './mtfTypes';
import { computeAlignment, toMTFScores } from './mtfScore';

export { MTF_FEATURE_NAMES };
export type { MTFScores };

export type PrecomputedMTF = {
  baseTF:       Timeframe;
  // Per base-TF-bar MTF scores (O(1) lookup in featuresAt)
  mtfScoresArr: (MTFScores | null)[];
  // Latest alignment for UI display
  latestAlignment: MTFScores | null;
  // All per-TF signals at the last bar (for chart display)
  latestSignals:   TFSignal[];
};

// ── Detect base timeframe from candle spacing ──────────────────────────────────
function detectBaseTF(candles: Candle[]): Timeframe {
  if (candles.length < 2) return '1h';
  const diff = candles[1].time - candles[0].time;
  for (const tf of TF_ORDER) {
    if (Math.abs(diff - TF_SECONDS[tf]) < TF_SECONDS[tf] * 0.1) return tf;
  }
  return '1h';
}

// ── Aggregate candles into a higher timeframe ──────────────────────────────────
// O(n): single forward pass.
// Returns [aggregatedCandles, mapping] where mapping[i] = base-TF bar index
// of the LAST base-TF bar contributing to aggregated bar i.
function aggregateTo(
  candles: Candle[],
  targetTF: Timeframe
): { bars: Candle[]; lastBaseBarOf: number[] } {
  const targetSec = TF_SECONDS[targetTF];
  const bars: Candle[] = [];
  const lastBaseBarOf: number[] = [];
  let cur: Candle | null = null;
  let curBucketStart = 0;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const bucket = Math.floor(c.time / targetSec) * targetSec;

    if (cur === null || bucket !== curBucketStart) {
      if (cur) { bars.push(cur); lastBaseBarOf.push(i - 1); }
      cur = { open: c.open, high: c.high, low: c.low, close: c.close,
              volume: c.volume, time: bucket };
      curBucketStart = bucket;
    } else {
      cur.high    = Math.max(cur.high, c.high);
      cur.low     = Math.min(cur.low,  c.low);
      cur.close   = c.close;
      cur.volume += c.volume;
    }
  }
  if (cur) { bars.push(cur); lastBaseBarOf.push(candles.length - 1); }
  return { bars, lastBaseBarOf };
}

// ── Lightweight EMA ────────────────────────────────────────────────────────────
function lightEMA(vals: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = vals[0] ?? 0;
  for (const v of vals) { prev = v * k + prev * (1 - k); out.push(prev); }
  return out;
}

// ── Extract TFSignal from an aggregated candle series ─────────────────────────
// O(n_tf): single pass over the aggregated bars.
function extractSignal(bars: Candle[], tf: Timeframe): TFSignal {
  const n = bars.length;
  if (n < 2) {
    return { tf, barCount: n, trendDir: 0, structureDir: 0,
      bosDetected: false, bosDir: 0, chochDetected: false,
      smcBias: 0, fvgAbove: false, fvgBelow: false,
      aboveVWAP: false, volumeBias: 0 };
  }

  const closes = bars.map(c => c.close);
  const ema20  = lightEMA(closes, 20);
  const ema50  = lightEMA(closes, 50);

  const last = bars[n - 1];
  const e20  = ema20[n - 1], e50 = ema50[n - 1];
  const eDiff = (e20 - e50) / (e50 || 1);
  const trendDir: -1|0|1 = eDiff > 0.003 ? 1 : eDiff < -0.003 ? -1 : 0;

  // Structure: compare last two swing highs and lows (simplified, no full detectSwings)
  // Proxy: compare last 4 local extremes using rolling max/min over 3-bar windows
  const highs: number[] = [], lows: number[] = [];
  for (let i = 1; i < n - 1; i++) {
    if (bars[i].high > bars[i-1].high && bars[i].high > bars[i+1].high) highs.push(bars[i].high);
    if (bars[i].low  < bars[i-1].low  && bars[i].low  < bars[i+1].low)  lows.push(bars[i].low);
  }
  let structureDir: -1|0|1 = 0;
  if (highs.length >= 2 && lows.length >= 2) {
    const hhhl = highs[highs.length-1] > highs[highs.length-2]
              && lows[lows.length-1]   > lows[lows.length-2];
    const llhl = highs[highs.length-1] < highs[highs.length-2]
              && lows[lows.length-1]   < lows[lows.length-2];
    structureDir = hhhl ? 1 : llhl ? -1 : 0;
  }

  // BOS: close vs last extreme
  const lastHigh = highs[highs.length - 1] ?? last.high;
  const lastLow  = lows[lows.length - 1]   ?? last.low;
  const bosDetected = last.close > lastHigh || last.close < lastLow;
  const bosDir: -1|0|1 = last.close > lastHigh ? 1 : last.close < lastLow ? -1 : 0;

  // CHoCH: bosDir is against prevailing structure
  const chochDetected = bosDetected && ((bosDir === 1 && structureDir === -1) ||
                                        (bosDir === -1 && structureDir === 1));

  // SMC bias: last candle body direction (objective)
  const smcBias: -1|0|1 = last.close > last.open ? 1 : last.close < last.open ? -1 : 0;

  // FVG: check last 3 bars
  let fvgAbove = false, fvgBelow = false;
  if (n >= 3) {
    const p2 = bars[n - 3], p1 = bars[n - 2];
    if (p2.high < last.low)  fvgAbove = false, fvgBelow = false; // bearish FVG = above price? no: price is below it
    if (p2.low  > last.high) fvgBelow = true;  // bullish FVG zone below current price
    if (p2.high < last.low)  fvgAbove = true;  // bearish FVG zone above current price
  }

  // VWAP: cumulative from bar 0 of this TF series
  let cumPV = 0, cumVol = 0;
  for (const b of bars) {
    const tp = (b.high + b.low + b.close) / 3;
    cumPV += tp * b.volume; cumVol += b.volume;
  }
  const vwap = cumVol > 0 ? cumPV / cumVol : last.close;
  const aboveVWAP = last.close > vwap;

  // Volume bias: candle close position within range
  const range = last.high - last.low || 1;
  const closePos = (last.close - last.low) / range;
  const volumeBias: -1|0|1 = closePos > 0.6 ? 1 : closePos < 0.4 ? -1 : 0;

  return { tf, barCount: n, trendDir, structureDir, bosDetected, bosDir,
    chochDetected, smcBias, fvgAbove, fvgBelow, aboveVWAP, volumeBias };
}

// ── Main precompute ────────────────────────────────────────────────────────────
// Strategy:
//   1. Detect base TF.
//   2. Aggregate to each higher TF once — O(n) each.
//   3. Build a mapping: for each base-TF bar i, which aggregated bar covers it.
//   4. Extract per-aggregated-bar TFSignal incrementally.
//   5. At each base-TF bar i, read signals from the covering aggregated bars
//      and compute alignment via mtfScore — O(TF_count) per bar = O(n) total.
//
// The alignment at bar i uses only the signals from aggregated bars whose
// lastBaseBarOf <= i — causal, no lookahead.
export function precomputeMTF(
  candles: Candle[],
  cfg: MTFConfig = DEFAULT_MTF_CONFIG
): PrecomputedMTF {
  const n = candles.length;
  const baseTF = detectBaseTF(candles);
  const baseTFIdx = TF_ORDER.indexOf(baseTF);

  if (n < 10) {
    return { baseTF, mtfScoresArr: new Array(n).fill(null),
             latestAlignment: null, latestSignals: [] };
  }

  // For each higher TF: aggregate and build a per-base-bar index of the
  // most recent completed aggregated bar.
  const higherTFs = TF_ORDER.slice(baseTFIdx + 1);

  type TFData = {
    tf: Timeframe;
    bars: Candle[];
    lastBaseBarOf: number[];  // lastBaseBarOf[k] = last base bar in agg bar k
  };

  const tfDataArr: TFData[] = higherTFs.map(tf => {
    const { bars, lastBaseBarOf } = aggregateTo(candles, tf);
    return { tf, bars, lastBaseBarOf };
  });

  // Pre-extract signals incrementally: O(n_tf) per TF (v5.5.1 M3 fix).
  // Previously each bar k called extractSignal(bars.slice(0,k+1)) which
  // recomputed EMA from scratch — O(n_tf²) total per TF.
  // Now a single forward pass maintains incremental EMA and VWAP state.
  const tfSignalsArr: TFSignal[][] = tfDataArr.map(({ tf, bars }) => {
    const signals: TFSignal[] = [];
    // Incremental EMA state
    const k20 = 2 / (20 + 1), k50 = 2 / (50 + 1);
    let ema20 = bars[0]?.close ?? 0;
    let ema50 = bars[0]?.close ?? 0;
    // Incremental VWAP state
    let cumPV = 0, cumVol = 0;
    // Running local extremes (last 2 highs and lows)
    const highs: number[] = [], lows: number[] = [];

    for (let k = 0; k < bars.length; k++) {
      const bar = bars[k];
      // Update EMA
      ema20 = bar.close * k20 + ema20 * (1 - k20);
      ema50 = bar.close * k50 + ema50 * (1 - k50);
      // Update VWAP
      const tp = (bar.high + bar.low + bar.close) / 3;
      cumPV += tp * bar.volume; cumVol += bar.volume;
      // Update local extremes (3-bar pivot)
      if (k >= 1 && k < bars.length - 1) {
        if (bars[k].high > bars[k-1].high && bars[k].high > bars[k+1].high) {
          highs.push(bars[k].high); if (highs.length > 4) highs.shift();
        }
        if (bars[k].low < bars[k-1].low && bars[k].low < bars[k+1].low) {
          lows.push(bars[k].low); if (lows.length > 4) lows.shift();
        }
      }

      if (k < 1) { signals.push({ tf, barCount: k+1, trendDir: 0, structureDir: 0,
        bosDetected: false, bosDir: 0, chochDetected: false, smcBias: 0,
        fvgAbove: false, fvgBelow: false, aboveVWAP: false, volumeBias: 0 }); continue; }

      const eDiff    = (ema20 - ema50) / (ema50 || 1);
      const trendDir: -1|0|1 = eDiff > 0.003 ? 1 : eDiff < -0.003 ? -1 : 0;

      let structureDir: -1|0|1 = 0;
      if (highs.length >= 2 && lows.length >= 2) {
        const hhhl = highs[highs.length-1] > highs[highs.length-2]
                  && lows[lows.length-1]   > lows[lows.length-2];
        const llhl = highs[highs.length-1] < highs[highs.length-2]
                  && lows[lows.length-1]   < lows[lows.length-2];
        structureDir = hhhl ? 1 : llhl ? -1 : 0;
      }

      const lastHigh   = highs[highs.length-1] ?? bar.high;
      const lastLow    = lows[lows.length-1]   ?? bar.low;
      const bosDetected = bar.close > lastHigh || bar.close < lastLow;
      const bosDir: -1|0|1 = bar.close > lastHigh ? 1 : bar.close < lastLow ? -1 : 0;
      const chochDetected = bosDetected && ((bosDir===1&&structureDir===-1)||(bosDir===-1&&structureDir===1));
      const smcBias: -1|0|1 = bar.close > bar.open ? 1 : bar.close < bar.open ? -1 : 0;

      let fvgAbove = false, fvgBelow = false;
      if (k >= 2) {
        const p2 = bars[k - 2];
        if (p2.low  > bar.high) fvgBelow = true;
        if (p2.high < bar.low)  fvgAbove = true;
      }

      const vwap        = cumVol > 0 ? cumPV / cumVol : bar.close;
      const aboveVWAP   = bar.close > vwap;
      const crange      = bar.high - bar.low || 1;
      const closePos    = (bar.close - bar.low) / crange;
      const volumeBias: -1|0|1 = closePos > 0.6 ? 1 : closePos < 0.4 ? -1 : 0;

      signals.push({ tf, barCount: k+1, trendDir, structureDir,
        bosDetected, bosDir, chochDetected, smcBias,
        fvgAbove, fvgBelow, aboveVWAP, volumeBias });
    }
    return signals;
  });

  // For each base-TF bar i, find the last completed aggregated bar index
  // for each higher TF (causal: only bars whose lastBaseBarOf <= i).
  const mtfScoresArr: (MTFScores | null)[] = new Array(n).fill(null);

  for (let i = 5; i < n; i++) {
    const currentSignals: TFSignal[] = [];
    for (let t = 0; t < tfDataArr.length; t++) {
      const { lastBaseBarOf } = tfDataArr[t];
      // Find the latest aggregated bar k where lastBaseBarOf[k] <= i
      // Since lastBaseBarOf is monotonically increasing, binary search or
      // linear scan from the end.
      let k = lastBaseBarOf.length - 1;
      while (k >= 0 && lastBaseBarOf[k] > i) k--;
      if (k >= 0 && tfSignalsArr[t][k]) {
        currentSignals.push(tfSignalsArr[t][k]);
      }
    }

    if (currentSignals.length === 0) continue;
    const alignment = computeAlignment(baseTF, currentSignals, cfg);
    mtfScoresArr[i] = toMTFScores(alignment);
  }

  // Latest signals for UI
  const latestSignals: TFSignal[] = tfDataArr.map(({ tf, bars }) =>
    bars.length > 0 ? extractSignal(bars, tf) : { tf, barCount: 0, trendDir: 0,
      structureDir: 0, bosDetected: false, bosDir: 0, chochDetected: false,
      smcBias: 0, fvgAbove: false, fvgBelow: false, aboveVWAP: false, volumeBias: 0 }
  );
  const latestAlignment = mtfScoresArr[n - 1];

  return { baseTF, mtfScoresArr, latestAlignment, latestSignals };
}

// ── O(1) feature lookup ────────────────────────────────────────────────────────
export function getMTFFeaturesAt(mtf: PrecomputedMTF, i: number): number[] {
  const s = mtf.mtfScoresArr[i];
  if (!s) return new Array(10).fill(0);
  return [
    s.trendAlignment, s.structureAlignment, s.bosAlignment, s.chochAlignment,
    s.smcAlignment, s.fvgAlignment, s.vwapAlignment, s.volumeAlignment,
    s.overallMTFScore, s.htfBias,
  ];
}
