// ─────────────────────────────────────────────────────────────────────────────
// useChartIndicators — all engine precomputation (7 passes in useMemo)
// This is the single most expensive hook. Dependencies: candles only.
// All outputs are memoized; a change to any non-candle state (prediction,
// paper trade, UI toggle) does NOT trigger a recompute.
//
// v8.1 OPTIMISATION: all heavy sub-computations (msStructure, SMC, FVG,
// VWAP, VP, MTF, Regime, ATR) are now sourced from precomputeSeries()
// in mlSignal.ts, which has a module-level cache keyed on candle OHLCV.
// The first call builds the series; any subsequent call within the same
// candle state (Predict tap, indicator refresh) returns the cached result
// at near-zero cost. This eliminates the duplicate computation that
// previously ran independently in both this hook and the ML pipeline.
// ─────────────────────────────────────────────────────────────────────────────
import { useState, useEffect, useRef } from 'react';
import { Candle } from '../../../utils/indicators';
// bollinger import removed — S.bb from precomputeSeries is used instead (FIX H-1)
import { detectChartPatterns } from '../../../utils/chartPatterns';
import { validateAllPatterns } from '../../../utils/patternValidation/validatePattern';
import type { ValidatedPattern } from '../../../utils/patternValidation/patternValidationTypes';
import { detectPatterns } from '../../../utils/candlePatterns';
import { getStructureSnapshotAt } from '../../../utils/structure/marketStructure';
import { getIndicatorSnapshot } from '../../../utils/liveIndicatorSnapshot';
// v8.1: single entry point — precomputeSeries is cached in mlSignal.ts
import { precomputeSeries } from '../../../utils/mlSignal';

export function useChartIndicators(candles: Candle[]) {
  const last           = candles[candles.length - 1];
  const candleCount    = candles.length;
  const lastCandleTime = last?.time    ?? 0;
  const lastHigh       = last?.high    ?? 0;
  const lastLow        = last?.low     ?? 0;
  const lastClose      = last?.close   ?? 0;
  const lastVolume     = last?.volume  ?? 0;

  type IndicatorResult = ReturnType<typeof computeIndicators> extends Promise<infer T> ? T : never;
  const [result, setResult] = useState<IndicatorResult | null>(null);
  const keyRef = useRef('');

  async function computeIndicators() {
    if (candles.length < 25) return null;

    // ── PERF PROBE ───────────────────────────────────────────────────────────
    const _ci0 = Date.now();
    // ────────────────────────────────────────────────────────────────────────

    // ── All expensive sub-computations via the shared cache ───────────────
    // precomputeSeries is async (yields between passes so the JS thread is
    // not blocked). The cache means subsequent calls are O(1).
    const S = await precomputeSeries(candles);

    const atrArr = S.atrArr;
    const atrAt  = (idx: number) => atrArr[idx] ?? candles[idx]?.close * 0.01 ?? 0;
    const i      = candles.length - 1;

    // ── UI-only: chart pattern geometry + validation ───────────────────────
    // geoPatterns drives the SVG overlay on the candlestick chart.
    // cpScores in S are the pre-computed scores used by the ML pipeline.
    // These are the same geometry — reuse S.swings4Highs/Lows to avoid
    // re-running detectSwings.
    const geoPatterns = detectChartPatterns(candles, i, atrAt, S.swings4Highs, S.swings4Lows) ?? null;

    const atrNow = atrArr[i] ?? (candles[i]?.close ?? 1) * 0.01;
    const validatedPatterns: ValidatedPattern[] = geoPatterns?.patterns.length
      ? validateAllPatterns(geoPatterns.patterns, {
          candles, currentBar: i, atr: atrNow, precomputed: {},
        })
      : [];

    // Candle patterns — last 3 bars, O(1)
    const candlePatterns = detectPatterns(candles.slice(-3));

    // ── Market Structure ───────────────────────────────────────────────────
    const msStr      = S.msStructure;
    const msSnapshot = getStructureSnapshotAt(candles, msStr, atrArr, i);

    // ── SMC ───────────────────────────────────────────────────────────────
    const smcSnap = S.smcData.smcScoresArr[i] ?? null;

    // ── FVG ───────────────────────────────────────────────────────────────
    const fvgSnap = S.fvgData.fvgScoresArr[i] ?? null;
    const fvgBull = (S.fvgData.activeBullFVGs[i] ?? []).filter((f: any) => f.status !== 'filled').slice(-3);
    const fvgBear = (S.fvgData.activeBearFVGs[i] ?? []).filter((f: any) => f.status !== 'filled').slice(-3);

    // ── VWAP / Volume Profile ──────────────────────────────────────────────
    const vwapSnap = S.vwapData.snapshots[i] ?? null;
    const vpD      = S.vpData;
    const vpSnap   = {
      poc: vpD.poc, vah: vpD.vah, val: vpD.val,
      hvn: vpD.hvnPrices, lvn: vpD.lvnPrices,
      profileBias:  vpD.hvnPrices.length > 0 ? 0.5 : 0,
      hvnProximity: 0,
    };

    // ── MTF ───────────────────────────────────────────────────────────────
    const mtfSnap    = S.mtfData.latestAlignment;
    const mtfSignals = S.mtfData.latestSignals;

    // ── Regime ────────────────────────────────────────────────────────────
    const regimeSnap = S.regimeData.latestRegime;

    // ── Tech summary (display-only) ────────────────────────────────────────
    // FIX H-1: S.bb is already the bollinger array from precomputeSeries —
    // calling bollinger(candles) again was a duplicate O(n) pass (~50-100ms wasted).
    const bbArr           = S.bb;
    const indicatorSnapshot = candles.length >= 60 ? getIndicatorSnapshot(candles) : null;
    const atrValue        = atrArr[atrArr.length - 1];
    const bbLatest        = bbArr[bbArr.length - 1];
    const techSummary     = indicatorSnapshot
      ? { snapshot: indicatorSnapshot, atrValue, bb: bbLatest }
      : null;

    return {
      geoPatterns, validatedPatterns, candlePatterns, msSnapshot, msStr,
      smcSnap, fvgSnap, fvgBull, fvgBear,
      vwapSnap, vpSnap, mtfSnap, mtfSignals, regimeSnap,
      techSummary,
    };
  }

  useEffect(() => {
    const key = `${candleCount}_${lastCandleTime}_${lastHigh}_${lastLow}_${lastClose}_${lastVolume}`;
    if (keyRef.current === key) return;
    keyRef.current = key;
    computeIndicators().then(r => { if (r !== undefined) setResult(r); }).catch(() => {});
  }, [candleCount, lastCandleTime, lastHigh, lastLow, lastClose, lastVolume]);

  return result;
}
