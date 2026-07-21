// ─────────────────────────────────────────────────────────────────────────────
// useChartIndicators — all engine precomputation (7 passes in useMemo)
// This is the single most expensive hook. Dependencies: candles only.
// All outputs are memoized; a change to any non-candle state (prediction,
// paper trade, UI toggle) does NOT trigger a recompute.
// ─────────────────────────────────────────────────────────────────────────────
import { useMemo } from 'react';
import { Candle } from '../../../utils/indicators';
import { atr, bollinger, adx as adxFn, historicalVolatility as histVolFn, donchianChannel } from '../../../utils/technicalIndicators';
import { detectSwings } from '../../../utils/marketStructure';
import { detectChartPatterns } from '../../../utils/chartPatterns';
import { validateAllPatterns } from '../../../utils/patternValidation/validatePattern';
import type { ValidatedPattern } from '../../../utils/patternValidation/patternValidationTypes';
import { detectPatterns } from '../../../utils/candlePatterns';
import { precomputeStructure, getStructureSnapshotAt } from '../../../utils/structure/marketStructure';
import { precomputeSMC } from '../../../utils/smc/smcEngine';
import { DEFAULT_SMC_CONFIG } from '../../../utils/smc/smcTypes';
import { precomputeFVG } from '../../../utils/fvg/fvgEngine';
import { DEFAULT_FVG_CONFIG } from '../../../utils/fvg/fvgTypes';
import { computeAllVWAPs } from '../../../utils/volume/anchoredVWAP';
import { computeVolumeProfile } from '../../../utils/volume/volumeProfile';
import { DEFAULT_VOLUME_CONFIG } from '../../../utils/volume/volumeTypes';
import { precomputeMTF } from '../../../utils/mtf/mtfEngine';
import { DEFAULT_MTF_CONFIG } from '../../../utils/mtf/mtfTypes';
import { precomputeRegime } from '../../../utils/regime/regimeEngine';
import { DEFAULT_REGIME_CONFIG } from '../../../utils/regime/regimeTypes';
import { getIndicatorSnapshot } from '../../../utils/liveIndicatorSnapshot';

export function useChartIndicators(candles: Candle[]) {
  return useMemo(() => {
    if (candles.length < 25) return null;

    const atrArr = atr(candles, 14);
    const atrAt  = (idx: number) => atrArr[idx] ?? candles[idx]?.close * 0.01 ?? 0;
    const sw4    = detectSwings(candles, 4);
    const preH   = sw4.filter(s => s.type === 'high');
    const preL   = sw4.filter(s => s.type === 'low');

    const geoPatterns = detectChartPatterns(candles, candles.length - 1, atrAt, preH, preL) ?? null;

    // ── Pattern Validation Framework integration ───────────────────────────
    // validateAllPatterns() sits AFTER geometry detection, BEFORE display.
    // Raw geoPatterns are preserved for CandlestickChart SVG overlay (geometry
    // keyPoints never change). validatedPatterns are used for MarketStructureCard
    // text display — showing confidence, status, reasons, risk levels.
    // mlSignal.ts cpScores (ML features) remain on raw geometry — NOT passed through
    // the validator because validation is a UI/trading-decision concern, not a
    // training feature. This preserves causality in the ML pipeline.
    const atrNow = atrArr[atrArr.length - 1] ?? (candles[candles.length-1]?.close ?? 1) * 0.01;
    const validatedPatterns: ValidatedPattern[] = geoPatterns?.patterns.length
      ? validateAllPatterns(
          geoPatterns.patterns,
          {
            candles,
            currentBar: candles.length - 1,
            atr: atrNow,
            // Pass pre-computed indicator values to avoid re-computation
            // inside the validator. All values computed above in this same
            // useMemo — zero extra cost.
            precomputed: {
              // indicatorSnapshot is computed later in this memo; we can't
              // reference it here. RSI/MACD/ADX are cheap to re-derive and
              // the validator computes them lazily when precomputed is absent.
            },
          },
        )
      : [];

    // Candle patterns — last 3 bars, O(1)
    const candlePatterns = detectPatterns(candles.slice(-3));

    const msStr  = precomputeStructure(candles, atrArr);
    const msSnapshot = getStructureSnapshotAt(candles, msStr, atrArr, candles.length - 1);

    const smcD   = precomputeSMC(candles, atrArr, msStr, DEFAULT_SMC_CONFIG);
    const smcSnap = smcD.smcScoresArr[candles.length - 1] ?? null;

    const fvgD   = precomputeFVG(candles, atrArr, DEFAULT_FVG_CONFIG);
    const fvgSnap = fvgD.fvgScoresArr[candles.length - 1] ?? null;
    const fvgBull = (fvgD.activeBullFVGs[candles.length - 1] ?? []).filter(f => f.status !== 'filled').slice(-3);
    const fvgBear = (fvgD.activeBearFVGs[candles.length - 1] ?? []).filter(f => f.status !== 'filled').slice(-3);

    const vwapD  = computeAllVWAPs(candles, msStr, DEFAULT_VOLUME_CONFIG);
    const vpD    = computeVolumeProfile(candles, DEFAULT_VOLUME_CONFIG);
    const vwapSnap = vwapD.snapshots[candles.length - 1] ?? null;
    const vpSnap   = {
      poc: vpD.poc, vah: vpD.vah, val: vpD.val,
      hvn: vpD.hvnPrices, lvn: vpD.lvnPrices,
      profileBias: vpD.hvnPrices.length > 0 ? 0.5 : 0,
      hvnProximity: 0,
    };

    const mtfD        = precomputeMTF(candles, DEFAULT_MTF_CONFIG);
    const mtfSnap     = mtfD.latestAlignment;
    const mtfSignals  = mtfD.latestSignals;   // per-TF signals for TradeReadinessCard

    const bbArr      = bollinger(candles);
    const histVolArr = histVolFn(candles);
    const donchArr   = donchianChannel(candles);
    const adxArrR    = adxFn(candles);
    const hvMean60: number[] = histVolArr.map((_, i) => {
      let s = 0, cnt = 0;
      for (let j = Math.max(0, i - 60); j <= i; j++) { const v = histVolArr[j]; if (v != null) { s += v; cnt++; } }
      return cnt > 0 ? s / cnt : 1;
    });

    // Compute patternBias for the live bar from the top confirmed pattern.
    // Only CONFIRMED patterns with confidence > 0 contribute.
    // Unconfirmed / FORMING = 0 so they never influence regime.
    const topConfirmed = validatedPatterns
      .filter(vp => vp.status === 'CONFIRMED' && vp.confidence > 0)
      .sort((a, b) => b.confidence - a.confidence)[0] ?? null;
    const livePB = topConfirmed
      ? (topConfirmed.direction === 'bullish' ? 1
        : topConfirmed.direction === 'bearish' ? -1 : 0)
        * (topConfirmed.confidence / 100)
      : 0;
    // Build a sparse array: 0 for all historical bars, livePB for last bar.
    // Historical bars don't have validated pattern state available here,
    // so we conservatively leave them at 0 (no phantom bias in ML training).
    const patternBiasArr = new Array(candles.length).fill(0);
    patternBiasArr[candles.length - 1] = livePB;

    const regD   = precomputeRegime(candles, {
      adxArr: adxArrR, atrArr: atrArr as (number|null)[],
      bb: bbArr as any, donchianArr: donchArr as any,
      histVol: histVolArr, histVolMean60: hvMean60,
      msStructure: msStr, mtfData: mtfD,
      patternBiasArr,
    }, DEFAULT_REGIME_CONFIG);
    const regimeSnap = regD.latestRegime;

    // Tech summary (read-only display — never feeds ML or trading logic)
    const indicatorSnapshot = candles.length >= 60 ? getIndicatorSnapshot(candles) : null;
    const atrValue  = atrArr[atrArr.length - 1];
    const bbLatest  = bbArr[bbArr.length - 1];
    const techSummary = indicatorSnapshot
      ? { snapshot: indicatorSnapshot, atrValue, bb: bbLatest }
      : null;

    return {
      geoPatterns, validatedPatterns, candlePatterns, msSnapshot, msStr,
      smcSnap, fvgSnap, fvgBull, fvgBear,
      vwapSnap, vpSnap, mtfSnap, mtfSignals, regimeSnap,
      techSummary,
    };
  }, [candles]);
}
