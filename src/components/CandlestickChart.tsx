import React, { useMemo, useState, useRef, useCallback, useEffect } from 'react';
import { View, TouchableOpacity, Pressable, Text, Modal, useWindowDimensions, ActivityIndicator, Animated } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';

// ── CRASH ISOLATION FLAGS (temporary — all false in production) ──────────────
// Flip ONE at a time, rebuild bundle, touch the chart, observe:
//   E2_CHART_INERT   in ChartScreen.tsx — chart ignores all touches.
//     crash stops → fault inside chart · still crashes → fault outside chart
//   E3_DISABLE_GESTURES — inert gesture, full render kept.
//     crash stops → RNGH machinery guilty → upgrade RNGH (E6)
//     still crashes → render path guilty (SVG/selection), RNGH innocent
//   E4_STUB_TAP_SELECT — gestures run but tap-select does nothing.
//     crash stops → the setState→re-render is the killer, gestures fine
export const CHART_DIAG = {
  E3_DISABLE_GESTURES: false,
  E4_STUB_TAP_SELECT:  false,
};
import Svg, { Line, Rect, Path, Text as SvgText, G, Circle } from 'react-native-svg';
import { Candle, calcMA, pFmt, calcVolumeProfile } from '../utils/indicators';
import { ChartPatternSummary } from '../utils/chartPatterns';
import { formatPriceWithPrecision } from '../utils/pricePrecision';
import { atr, ema, historicalVolatility, bollinger, keltnerChannel, donchianChannel } from '../utils/technicalIndicators';
import { detectTrendDirection, detectVolatilityRegime } from '../utils/marketStructure';
import { getMarketStructureSnapshot } from '../utils/marketStructureSnapshot';
import { Theme } from '../theme/colors';

// confQuality carries the AI Confidence score and grade from the prediction card.
// This is the ONLY grade shown on the chart marker — Trade Quality is shown
// separately in the PredictionCard below the chart, labelled clearly.
type ChartMarker = { time: number; type: 'BUY' | 'SELL' | 'HOLD' | 'ENTRY' | 'EXIT' | 'SL_HIT' | 'TP_HIT' | 'TRAIL'; price: number; label?: string; confQuality?: { overall: number; grade: string } };
type TradeLevel = { label: string; price: number; color: string };
export type OverlayToggles = { bollinger?: boolean; donchian?: boolean; keltner?: boolean; fib?: boolean; pivots?: boolean };

type Props = {
  data: Candle[];
  theme: Theme;
  showMA?: boolean;
  showVP?: boolean;
  height?: number;
  expandable?: boolean;
  onRequestOlderData?: () => Promise<boolean>;
  loadingOlder?: boolean;
  noDataMessage?: string;
  timeframe?: string;          // needed for axis label formatting and the live-candle countdown
  tradeLevels?: TradeLevel[];  // entry/SL/TP/trailing-stop lines, e.g. from an open paper position
  markers?: ChartMarker[];     // AI signal + trade-event markers
  livePrediction?: { action: string; confidence: number; horizon: number } | null; // only ever shown for the current/last candle — never fabricated for historical ones
  overlays?: OverlayToggles;   // Phase 3 — individually enable/disable each technical overlay
  pricePrecision?: number;     // TASK 5: real exchange-defined decimal places for this asset; omitted falls back to pFmt's magnitude-based heuristic exactly as before
  livePrice?: number;          // ROOT-CAUSE FIX: the true latest tick price (same cp.price the header reads). When provided and the user is viewing the live edge (not scrolled into history), the chart's rendered last candle, price label, and OHLC readout are visually adjusted to this value - display-only, never written into the real candles array passed in via `data`, so ML/indicator/trade-quality calculations elsewhere are completely unaffected.
};

const MIN_VIEW = 15;
const MAX_VIEW = 200;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const INTRADAY_TFS = ['5m', '15m', '30m', '1h', '4h'];

// Verified directly against the spec's own examples before writing this
// (5m -> "09:15"/"09:30", 1D -> "12 Jun"/"13 Jun", month/year transitions
// elevate to "Jul"/"2027") — each format matched exactly.
function formatAxisLabel(ts: number, tf: string, prevTs: number | null): string {
  const d = new Date(ts);
  const prev = prevTs != null ? new Date(prevTs) : null;
  const pad2 = (n: number) => String(n).padStart(2, '0');

  if (INTRADAY_TFS.includes(tf)) {
    const dayChanged = prev && d.getUTCDate() !== prev.getUTCDate();
    if (dayChanged || !prev) return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
    return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
  }
  const yearChanged = prev && d.getUTCFullYear() !== prev.getUTCFullYear();
  if (yearChanged) return String(d.getUTCFullYear());
  const monthChanged = prev && d.getUTCMonth() !== prev.getUTCMonth();
  if (monthChanged || !prev) return MONTHS[d.getUTCMonth()];
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

// N evenly-spaced indices across the visible window — labels can never
// overlap by construction (fixed count, fixed minimum spacing), rather than
// trying to dynamically measure text widths in SVG.
function selectTickIndices(dataLength: number, n: number): number[] {
  if (dataLength <= n) return Array.from({ length: dataLength }, (_, i) => i);
  const indices: number[] = [];
  for (let i = 0; i < n; i++) indices.push(Math.round((i / (n - 1)) * (dataLength - 1)));
  return Array.from(new Set(indices));
}

// P1 #6: React.memo prevents ChartSvg from re-rendering when parent re-renders
// but props are shallowly unchanged. At 60 candles this saves rendering 624+ SVG
// nodes on every live price tick and every EvalTaskContext update.
// Safe because ChartSvg is a pure function of its props — no side effects.
const ChartSvg = React.memo(function ChartSvg({
  data, theme: T, showMA, showVP, width, height, timeframe, selectedIndex, onSelectCandle,
  tradeLevels, markers, overlays, pricePrecision, yScale = 1,
  crosshairActive = false, crosshairX = null, crosshairY = null,
  geoPatterns = null, patternBarOffset = 0, yOffset = 0,
}: {
  data: Candle[]; theme: Theme; showMA: boolean; showVP: boolean; width: number; height: number; timeframe?: string;
  selectedIndex: number | null; onSelectCandle: (i: number) => void;
  tradeLevels?: TradeLevel[]; markers?: ChartMarker[]; overlays?: OverlayToggles; pricePrecision?: number; yScale?: number;
  crosshairActive?: boolean; crosshairX?: number | null; crosshairY?: number | null;
  geoPatterns?: ChartPatternSummary | null;
  patternBarOffset?: number;
  yOffset?: number;
}) {
  const fmtPrice = (v: number | null | undefined) => pricePrecision != null ? formatPriceWithPrecision(v, pricePrecision) : pFmt(v);
  // Early return: empty data causes NaN cascade through all SVG coordinates → Hermes crash
  if (!data.length) return (
    <Svg width={width} height={height}>
      <SvgText x={width/2} y={height/2} fill={T.textDim} fontSize={11} textAnchor='middle'>Waiting for data…</SvgText>
    </Svg>
  );
  const PAD = { top: 16, right: 56, bottom: 28, left: 4 };
  const volH = Math.max(36, height * 0.12);
  const mainH = height - PAD.top - PAD.bottom - volH - 6;

  if (!data.length) return <View style={{ height, backgroundColor: T.bg0, borderRadius: 8 }} />;

  // Phase 3 overlays — computed here (before the price range) so Phase 5's
  // auto-scaling can include them; reused calculations, not duplicated.
  const bollingerSeries = overlays?.bollinger ? bollinger(data) : null;
  const keltnerSeries = overlays?.keltner ? keltnerChannel(data) : null;
  const donchianSeries = overlays?.donchian ? donchianChannel(data) : null;
  const snapshot = (overlays?.fib || overlays?.pivots) ? getMarketStructureSnapshot(data) : null;

  // Phase 5 — auto price scaling: candles alone used to set the visible
  // range, silently clipping Bollinger/Keltner/Donchian bands and
  // entry/SL/TP/trailing-stop lines whenever they extended beyond the
  // candle range. Now every enabled overlay value and every trade level
  // price is folded into the same min/max computation, verified directly
  // before wiring this in (a take-profit level beyond the candle range
  // correctly pulled the chart's hi/lo to include it, never clipped).
  const overlayValues: number[] = [];
  [bollingerSeries, keltnerSeries, donchianSeries].forEach(series => {
    series?.forEach(pt => { if (pt.upper != null) overlayValues.push(pt.upper); if (pt.lower != null) overlayValues.push(pt.lower); });
  });
  if (snapshot?.fib) Object.values(snapshot.fib).forEach(v => overlayValues.push(v));
  if (snapshot?.pivots) Object.values(snapshot.pivots).forEach(v => overlayValues.push(v));
  const tradeLevelPrices = tradeLevels?.map(l => l.price) ?? [];

  // Guard: Math.max/min with empty arrays returns ±Infinity → rawMid=NaN → crash.
  // Filter to finite prices only before spreading.
  const allHighs = [...data.map(c => c.high), ...overlayValues, ...tradeLevelPrices].filter(Number.isFinite);
  const allLows  = [...data.map(c => c.low),  ...overlayValues, ...tradeLevelPrices].filter(Number.isFinite);
  const hi = allHighs.length ? Math.max(...allHighs) : 100;
  const lo = allLows.length  ? Math.min(...allLows)  : 0;
  const pad = (hi - lo) * 0.06 || hi * 0.01 || 1;

  const rawMidBase = (hi + lo) / 2;
  // yOffset (pixels from gesture) → price units via pRng/height ratio, clamped to ±45% range
  const pRngRaw = (hi - lo) / Math.max(0.5, yScale);
  const safeYOffset = Number.isFinite(yOffset) && pRngRaw > 0 && height > 0
    ? Math.max(-pRngRaw * 0.45, Math.min(pRngRaw * 0.45, yOffset * pRngRaw / height))
    : 0;
  const rawMid = rawMidBase + safeYOffset;
  const rawHalf = (hi - lo) / 2 + pad;
  const zoomedHalf = rawHalf / Math.max(0.5, yScale);
  const maxP = rawMid + zoomedHalf;
  const minP = rawMid - zoomedHalf;
  const pRng = maxP - minP || 1;
  const cW = width - PAD.left - PAD.right;
  const gap = cW / Math.max(1, data.length); // Math.max(1,...) correctly blocks Infinity; || 1 does NOT (Infinity is truthy)
  const bW = Math.max(1, gap * 0.62);
  const toX = (i: number) => PAD.left + i * gap + gap / 2;
  const toY = (p: number) => PAD.top + ((maxP - p) / pRng) * mainH;

  const isFinitePositive = (n: number) => Number.isFinite(n) && n > 0;
  if (!isFinitePositive(hi) || !isFinitePositive(lo) || !isFinitePositive(width) || !isFinitePositive(height)) {
    return <View style={{ height, backgroundColor: T.bg0, borderRadius: 8 }} />;
  }

  const maLines = showMA ? [20, 50].map((p, idx) => {
    const ma = calcMA(data, p);
    let d = '';
    ma.forEach((v, i) => { if (v == null) return; d += (d === '' ? 'M' : 'L') + `${toX(i)},${toY(v)} `; });
    return { d, color: T.ma[idx] };
  }) : [];

  // Build band paths: upper/lower outlines + closed fill polygon.
  // Each band type gets a distinct visual style (see render section below).
  function buildBandPaths(series: { upper: number | null; lower: number | null }[] | null, color: string) {
    if (!series) return null;
    let upperD = '', lowerD = '';
    const upperPts: string[] = [], lowerPts: string[] = [];
    series.forEach((pt, i) => {
      if (pt.upper != null) { const s = `${toX(i).toFixed(1)},${toY(pt.upper).toFixed(1)}`; upperD += (upperD === '' ? 'M' : 'L') + s + ' '; upperPts.push(s); }
      if (pt.lower != null) { const s = `${toX(i).toFixed(1)},${toY(pt.lower).toFixed(1)}`; lowerD += (lowerD === '' ? 'M' : 'L') + s + ' '; lowerPts.push(s); }
    });
    // Closed fill polygon: trace upper forward, lower backward
    const fillD = upperPts.length && lowerPts.length
      ? 'M' + upperPts[0] + ' L' + upperPts.join(' L') + ' L' + [...lowerPts].reverse().join(' L') + ' Z'
      : '';
    return { upperD, lowerD, fillD, color };
  }
  const bollingerPaths = buildBandPaths(bollingerSeries, '#2563EB');  // blue
  const keltnerPaths   = buildBandPaths(keltnerSeries,   '#7C3AED');  // violet — distinct from blue
  const donchianPaths  = buildBandPaths(donchianSeries,  '#D97706');  // amber — clearly different

  const vp = showVP ? calcVolumeProfile(data, 20) : null;
  const maxVol = Math.max(...data.map(c => c.volume), 1);
  const last = data[data.length - 1];
  const bull = last.close >= last.open;
  const grid = Array.from({ length: 5 }, (_, g) => ({ y: PAD.top + (mainH / 5) * g, price: maxP - (pRng / 5) * g }));
  const tickIndices = selectTickIndices(data.length, 5);

  return (
    <Svg width={width} height={height}>
      {grid.map((g, i) => (
        <G key={i}>
          <Line x1={PAD.left} y1={g.y} x2={width - PAD.right} y2={g.y} stroke={T.grid} strokeWidth={0.4} opacity={0.6} />
          <SvgText x={width - PAD.right + 4} y={g.y + 3} fontSize={9} fill={T.textDim}>{fmtPrice(g.price)}</SvgText>
        </G>
      ))}
      {vp?.levels.map((lv, i) => {
        if (lv.price < minP || lv.price > maxP) return null;
        const y = toY(lv.price);
        const w = (lv.vol / Math.max(...vp.levels.map(l => l.vol), 1)) * 50;
        const isPoc = vp.poc && Math.abs(lv.price - vp.poc.price) < 1e-9;
        return <Rect key={i} x={width - PAD.right - w} y={y - 1.5} width={w} height={2.4} rx={1} fill={isPoc ? '#F59E0B55' : '#3B82F622'} opacity={0.85} />;
      })}
      {maLines.map((l, i) => l.d && <Path key={i} d={l.d} stroke={l.color} strokeWidth={1.8} fill="none" opacity={0.9} />)}
      {/* Band fills first (lowest z) then outlines on top */}
      {bollingerPaths?.fillD ? <Path d={bollingerPaths.fillD} fill={bollingerPaths.color} fillOpacity={0.06} stroke="none" /> : null}
      {keltnerPaths?.fillD   ? <Path d={keltnerPaths.fillD}   fill={keltnerPaths.color}   fillOpacity={0.05} stroke="none" /> : null}
      {donchianPaths?.fillD  ? <Path d={donchianPaths.fillD}  fill={donchianPaths.color}  fillOpacity={0.04} stroke="none" /> : null}
      {/* Bollinger: solid thin lines, distinctive blue */}
      {bollingerPaths && <>
        {bollingerPaths.upperD && <Path d={bollingerPaths.upperD} stroke={bollingerPaths.color} strokeWidth={1.1} fill="none" opacity={0.75} />}
        {bollingerPaths.lowerD && <Path d={bollingerPaths.lowerD} stroke={bollingerPaths.color} strokeWidth={1.1} fill="none" opacity={0.75} />}
      </>}
      {/* Keltner: dashed, violet — clearly different from Bollinger */}
      {keltnerPaths && <>
        {keltnerPaths.upperD && <Path d={keltnerPaths.upperD} stroke={keltnerPaths.color} strokeWidth={1} strokeDasharray="4,3" fill="none" opacity={0.65} />}
        {keltnerPaths.lowerD && <Path d={keltnerPaths.lowerD} stroke={keltnerPaths.color} strokeWidth={1} strokeDasharray="4,3" fill="none" opacity={0.65} />}
      </>}
      {/* Donchian: wider dash, amber — step-like channel boundaries */}
      {donchianPaths && <>
        {donchianPaths.upperD && <Path d={donchianPaths.upperD} stroke={donchianPaths.color} strokeWidth={1} strokeDasharray="6,4" fill="none" opacity={0.6} />}
        {donchianPaths.lowerD && <Path d={donchianPaths.lowerD} stroke={donchianPaths.color} strokeWidth={1} strokeDasharray="6,4" fill="none" opacity={0.6} />}
      </>}
      {overlays?.fib && snapshot?.fib && (() => {
        // De-collide fib labels on right axis (same technique as price labels)
        const FIB_COL = '#F59E0B';
        const entries = Object.entries(snapshot.fib)
          .map(([k, price]) => ({ key: k, price, y: toY(price as number), label: k.replace('level', '') }))
          .filter(e => e.y >= PAD.top && e.y <= PAD.top + mainH)
          .sort((a, b) => a.y - b.y);
        // Nudge overlapping labels apart
        for (let i = 1; i < entries.length; i++) {
          if (entries[i].y - entries[i-1].y < 11) entries[i].y = entries[i-1].y + 11;
        }
        return entries.map(e => (
          <G key={'fib' + e.key}>
            <Line x1={PAD.left} y1={toY(e.price as number)} x2={width - PAD.right} y2={toY(e.price as number)}
              stroke={FIB_COL} strokeWidth={0.6} strokeDasharray="3,5" opacity={0.55} />
            <SvgText x={width - PAD.right - 3} y={e.y - 1} fontSize={7.5} fill={FIB_COL} textAnchor="end" opacity={0.85}>{e.label}</SvgText>
          </G>
        ));
      })()}
      {overlays?.pivots && snapshot?.pivots && (() => {
        const pivotColor = (k: string) => k === 'P' ? '#94A3B8' : k.startsWith('R') ? '#EF4444' : '#22C55E';
        const entries = Object.entries(snapshot.pivots)
          .map(([k, price]) => ({ key: k, price, y: toY(price as number), col: pivotColor(k) }))
          .filter(e => e.y >= PAD.top - 4 && e.y <= PAD.top + mainH + 4)
          .sort((a, b) => a.y - b.y);
        for (let i = 1; i < entries.length; i++) {
          if (entries[i].y - entries[i-1].y < 10) entries[i].y = entries[i-1].y + 10;
        }
        return entries.map(e => (
          <G key={'piv' + e.key}>
            <Line x1={PAD.left} y1={toY(e.price as number)} x2={width - PAD.right} y2={toY(e.price as number)}
              stroke={e.col} strokeWidth={e.key === 'P' ? 0.8 : 0.6} strokeDasharray="4,5" opacity={0.55} />
            <SvgText x={width - PAD.right - 3} y={e.y - 1} fontSize={7} fill={e.col} textAnchor="end" opacity={0.8}>{e.key}</SvgText>
          </G>
        ));
      })()}
      {/* Candlesticks — drawn AFTER MA lines so they sit on top, not hidden behind them */}
      {data.map((c, i) => {
        const x = toX(i);
        const color = c.close >= c.open ? T.upBody : T.dnBody;
        const top = Math.min(toY(c.open), toY(c.close));
        const bodyH = Math.max(1.5, Math.abs(toY(c.open) - toY(c.close)));
        return (
          <G key={i}>
            <Line x1={x} y1={toY(c.high)} x2={x} y2={toY(c.low)} stroke={color} strokeWidth={1} />
            <Rect x={x - bW / 2} y={top} width={bW} height={bodyH} fill={color} />
          </G>
        );
      })}
      {data.map((c, i) => {
        const x = toX(i);
        const h = (c.volume / maxVol) * volH;
        const vTop = PAD.top + mainH + 6;
        return <Rect key={'v' + i} x={x - bW / 2} y={vTop + volH - h} width={bW} height={h} fill={c.close >= c.open ? T.volUp : T.volDn} />;
      })}
      {/* Price-axis labels (live price + trade levels) — de-collided so
          a tight stop-loss or a fresh entry near the current price never
          renders its label directly on top of another. The price LINE
          stays at its true position; only the LABEL BOX is nudged apart
          from its neighbor, the same way professional charting platforms
          keep dense price-axis labels readable. Verified with a dedicated
          test before wiring this in: a label 5px from its neighbor gets
          pushed to a minimum 20px gap, while a label already far away is
          left untouched. */}
      {(() => {
        const liveLabel = { key: 'live', trueY: toY(last.close), color: bull ? T.green : T.red, text: fmtPrice(last.close), height: 18 };
        const levelLabels = (tradeLevels ?? []).map((lvl, i) => ({ key: 'lvl' + i, trueY: toY(lvl.price), color: lvl.color, text: lvl.label, height: 16 }));
        const allLabels = [liveLabel, ...levelLabels].map(l => ({ ...l, labelY: l.trueY }));
        const sorted = [...allLabels].sort((a, b) => a.trueY - b.trueY);
        for (let i = 1; i < sorted.length; i++) {
          const minGap = (sorted[i - 1].height + sorted[i].height) / 2 + 4;
          if (sorted[i].labelY - sorted[i - 1].labelY < minGap) sorted[i].labelY = sorted[i - 1].labelY + minGap;
        }
        return sorted.map(l => (
          <G key={l.key}>
            <Line x1={PAD.left} y1={l.trueY} x2={width - PAD.right} y2={l.trueY} stroke={l.key === 'live' ? T.textSub : l.color} strokeWidth={l.key === 'live' ? 0.8 : 1} strokeDasharray={l.key === 'live' ? '4,5' : '3,3'} />
            <Rect x={width - PAD.right + 2} y={l.labelY - l.height / 2} width={50} height={l.height} rx={3} fill={l.color} />
            <SvgText x={width - PAD.right + 27} y={l.labelY + l.height / 2 - 5} fontSize={l.key === 'live' ? 9 : 8} fontWeight="bold" fill="#fff" textAnchor="middle">{l.text}</SvgText>
          </G>
        ));
      })()}

      {/* Time axis (X-axis) — N evenly-spaced ticks, format adapts to
          timeframe and elevates to date/month/year at boundaries (verified
          against the spec's own examples before writing this). */}
      {timeframe && tickIndices.map((idx, k) => (
        <SvgText key={'t' + idx} x={toX(idx)} y={height - 10} fontSize={9} fill={T.textDim} textAnchor="middle">
          {formatAxisLabel(data[idx].time, timeframe, k > 0 ? data[tickIndices[k - 1]].time : null)}
        </SvgText>
      ))}

      {/* AI signal + trade-event markers, aligned to the candle they belong to.
          FIX: real trade/signal timestamps are arbitrary Date.now() values
          that almost never exactly equal a candle's open time — strict
          equality here would have silently matched nothing, ever. Instead
          finds the latest candle whose open time is <= the marker's time
          (the candle that was actually forming when the event happened),
          verified directly before applying this fix. */}
      {markers?.map((m, i) => {
        let idx = -1;
        for (let j = 0; j < data.length; j++) { if (data[j].time <= m.time) idx = j; else break; }
        if (idx === -1) idx = 0;
        const x = toX(idx), y = toY(m.price);
        const isBuyLike = m.type === 'BUY' || m.type === 'ENTRY' || m.type === 'TP_HIT';
        const isSellLike = m.type === 'SELL' || m.type === 'EXIT' || m.type === 'SL_HIT';
        const color = isBuyLike ? T.green : isSellLike ? T.red : T.amber;
        const yOff = isBuyLike ? 14 : -14; // buy-like markers sit below price action, sell-like above — avoids overlapping the candle itself
        return (
          <G key={'m' + i}>
            <Circle cx={x} cy={y + yOff} r={4} fill={color} />
            <SvgText x={x} y={y + yOff + (isBuyLike ? 14 : -8)} fontSize={7} fill={color} textAnchor="middle" fontWeight="bold">{m.label || m.type}</SvgText>
            {/* Confidence Grade — the only grade on the chart marker.
                Shows: "31% D" — how confident Quantis is in this signal.
                Trade Quality is shown separately in the PredictionCard,
                clearly labelled. Mixing both here caused confusion because
                a D confidence grade (low confidence) could coexist with a
                B trade quality grade (decent setup), appearing contradictory. */}
            {m.confQuality && (
              <SvgText x={x} y={y + yOff + (isBuyLike ? 24 : -18)} fontSize={6} fill={T.textDim} textAnchor="middle">
                {m.confQuality.overall.toFixed(0)}% {m.confQuality.grade}
              </SvgText>
            )}
          </G>
        );
      })}

      {/* Selected-candle highlight */}
      {selectedIndex != null && selectedIndex >= 0 && selectedIndex < data.length && (
        <Line x1={toX(selectedIndex)} y1={PAD.top} x2={toX(selectedIndex)} y2={PAD.top + mainH} stroke={T.accent} strokeWidth={1} strokeDasharray="2,3" />
      )}
      {/* Chart Pattern Overlay — TradingView style.
           Converts barIndex coordinates from keyPoints into pixel coords via
           toX (same function as candles) and priceToY (derived from price range).
           Renders only the highest-confidence pattern (two if within 5%).
           Runs inside ChartSvg React.memo — only redraws when data changes. */}
      {geoPatterns && geoPatterns.patterns.length > 0 && (() => {
        const best = geoPatterns.patterns[0];
        const second = geoPatterns.patterns.length > 1 &&
          Math.abs(best.strength - geoPatterns.patterns[1].strength) <= 0.05
          ? geoPatterns.patterns[1] : null;
        const toRender = second ? [best, second] : [best];

        // Reuse existing toX() — no drift between candle positions and pattern lines.
        // toX(relIdx) = PAD.left + relIdx*gap + gap/2; equivalent to the old formula.
        const barToX = (barIdx: number) => toX(barIdx - patternBarOffset);
        const priceToY = (price: number) =>
          pRng > 0 ? PAD.top + ((maxP - price) / pRng) * mainH : PAD.top;
        const inView = (x: number) => x >= PAD.left - 20 && x <= width - PAD.right + 20;
        const inViewY = (y: number) => y >= PAD.top - 10 && y <= PAD.top + mainH + 10;

        return toRender.map((p, pidx) => {
          const col = p.direction === 'bullish' ? '#22C55E' : p.direction === 'bearish' ? '#EF4444' : '#F59E0B';
          const kp = p.keyPoints ?? [];
          const by = (role: string) => { const pt = kp.find(k => k.role === role); return pt ? { x: barToX(pt.barIndex), y: priceToY(pt.price) } : null; };
          const elements: React.ReactNode[] = [];

          // ── Trendline-based patterns (Triangle / Wedge / Channel / Pennant)
          const uS = by('upperStart'), uE = by('upperEnd'), lS = by('lowerStart'), lE = by('lowerEnd');
          if (uS && uE && lS && lE) {
            if (inView(uS.x) || inView(uE.x)) elements.push(
              <Line key='ul' x1={uS.x} y1={uS.y} x2={uE.x} y2={uE.y} stroke={col} strokeWidth={1.5} opacity={0.85} />
            );
            if (inView(lS.x) || inView(lE.x)) elements.push(
              <Line key='ll' x1={lS.x} y1={lS.y} x2={lE.x} y2={lE.y} stroke={col} strokeWidth={1.5} opacity={0.85} />
            );
          }

          // ── Flag/Pennant: pole line + flag channel
          const pb = by('poleBase'), pt = by('poleTip'), fS = by('flagStart'), fE = by('flagEnd');
          if (pb && pt && fS && fE) {
            elements.push(<Line key='pole' x1={pb.x} y1={pb.y} x2={pt.x} y2={pt.y} stroke={col} strokeWidth={2.5} opacity={0.8} />);
            elements.push(<Line key='flag' x1={fS.x} y1={fS.y} x2={fE.x} y2={fE.y} stroke={col} strokeWidth={1.5} strokeDasharray='4,3' opacity={0.7} />);
          }

          // ── Double Top/Bottom: markers + neckline
          const t1 = by('top1') ?? by('bottom1'), t2 = by('top2') ?? by('bottom2');
          const nlL = by('necklineLeft'), nlR = by('necklineRight');
          if (t1 && t2) {
            [t1, t2].forEach((pt, ti) => {
              if (!pt || !inView(pt.x)) return;
              elements.push(<Circle key={`mk${ti}`} cx={pt.x} cy={pt.y} r={4} fill='none' stroke={col} strokeWidth={1.5} opacity={0.9} />);
            });
          }
          if (nlL && nlR && (inView(nlL.x) || inView(nlR.x))) {
            elements.push(<Line key='nl' x1={nlL.x} y1={nlL.y} x2={nlR.x} y2={nlR.y} stroke={col} strokeWidth={1.5} strokeDasharray='5,4' opacity={0.8} />);
            // Extend neckline to current bar
            elements.push(<Line key='nlext' x1={nlR.x} y1={nlR.y} x2={width - PAD.right} y2={nlR.y} stroke={col} strokeWidth={1} strokeDasharray='3,3' opacity={0.5} />);
          }

          // ── Head & Shoulders: all 5 points + neckline
          const lsh = by('leftShoulder'), hd = by('head'), rsh = by('rightShoulder');
          const nlLeft = by('necklineLeft'), nlRight = by('necklineRight');
          if (lsh && hd && rsh) {
            [lsh, hd, rsh].forEach((pt, si) => {
              if (!pt || !inView(pt.x)) return;
              elements.push(<Circle key={`hs${si}`} cx={pt.x} cy={pt.y} r={si === 1 ? 5 : 4} fill='none' stroke={col} strokeWidth={1.5} opacity={0.9} />);
            });
            if (lsh && rsh && inView(lsh.x) && inView(rsh.x))
              elements.push(<Line key='neck' x1={lsh.x} y1={lsh.y} x2={rsh.x} y2={rsh.y} stroke={col} strokeWidth={1.5} strokeDasharray='5,3' opacity={0.8} />);
          }
          if (nlLeft && nlRight && (inView(nlLeft.x) || inView(nlRight.x))) {
            elements.push(<Line key='nkl' x1={nlLeft.x} y1={nlLeft.y} x2={nlRight.x} y2={nlRight.y} stroke={col} strokeWidth={1.5} strokeDasharray='5,3' opacity={0.85} />);
          }

          // ── Cup & Handle
          const cRL = by('cupRimLeft'), cB = by('cupBottom'), cRR = by('cupRimRight');
          const hStart = by('handleStart'), hEnd = by('handleEnd');
          if (cRL && cB && cRR) {
            // Draw U-curve approximation with three line segments
            if (inView(cRL.x) || inView(cB.x) || inView(cRR.x)) {
              elements.push(<Line key='cl1' x1={cRL.x} y1={cRL.y} x2={cB.x}  y2={cB.y}  stroke={col} strokeWidth={1.5} opacity={0.8} />);
              elements.push(<Line key='cl2' x1={cB.x}  y1={cB.y}  x2={cRR.x} y2={cRR.y} stroke={col} strokeWidth={1.5} opacity={0.8} />);
            }
          }
          if (hStart && hEnd && (inView(hStart.x) || inView(hEnd.x))) {
            elements.push(<Line key='hdl' x1={hStart.x} y1={hStart.y} x2={hEnd.x} y2={hEnd.y} stroke={col} strokeWidth={1.5} strokeDasharray='4,3' opacity={0.75} />);
          }

          // ── Support/Resistance: full-width horizontal dashed line
          if (p.target != null && p.name.startsWith('Support')) {
            const sy = priceToY(p.target); if (inViewY(sy))
              elements.push(<Line key='sr' x1={PAD.left} y1={sy} x2={width - PAD.right} y2={sy} stroke={col} strokeWidth={1.2} strokeDasharray='6,4' opacity={0.65} />);
          }
          if (p.stopLevel != null && p.name.startsWith('Resistance')) {
            const ry = priceToY(p.stopLevel); if (inViewY(ry))
              elements.push(<Line key='rr' x1={PAD.left} y1={ry} x2={width - PAD.right} y2={ry} stroke={col} strokeWidth={1.2} strokeDasharray='6,4' opacity={0.65} />);
          }

          // ── Target / Stop dashed lines
          if (p.target != null) {
            const ty = priceToY(p.target); if (inViewY(ty)) {
              elements.push(<Line key='tp' x1={PAD.left} y1={ty} x2={width - PAD.right} y2={ty} stroke={col} strokeWidth={1} strokeDasharray='4,4' opacity={0.45} />);
              elements.push(<Rect key='tpr' x={width - PAD.right + 2} y={ty - 7} width={36} height={13} rx={3} fill={col} opacity={0.85} />);
              elements.push(<SvgText key='tpt' x={width - PAD.right + 20} y={ty + 4} fontSize={7.5} fontWeight='bold' fill='#fff' textAnchor='middle'>TP</SvgText>);
            }
          }

          // ── Pattern name label (top-left of chart)
          const lY = PAD.top + 14 + pidx * 18;
          const lW = Math.min(155, p.name.length * 6.5 + 18);
          elements.push(
            <G key='lbl'>
              <Rect x={PAD.left + 4} y={lY - 11} width={lW} height={15} rx={4} fill={col} opacity={0.88} />
              <SvgText x={PAD.left + 12} y={lY} fontSize={8.5} fontWeight='bold' fill='#fff'>{p.direction === 'bullish' ? '▲' : p.direction === 'bearish' ? '▼' : '◆'} {p.name}</SvgText>
            </G>
          );

          return <G key={pidx}>{elements}</G>;
        });
      })()}

      {/* CoinDCX-style crosshair: vertical + horizontal + price label + time label */}
      {crosshairActive && crosshairX != null && (() => {
        // Compute price at crosshairY (clamp to chart area)
        const cyRaw = crosshairY ?? ((PAD.top + PAD.top + mainH) / 2);
        const cy = Math.max(PAD.top, Math.min(PAD.top + mainH, cyRaw));
        const crossPrice = maxP - ((cy - PAD.top) / mainH) * pRng;
        // Find nearest candle for time label
        const rawIdx = Math.round((crosshairX - PAD.left) / gap);
        const candleIdx = Math.max(0, Math.min(data.length - 1, rawIdx));
        const candleTime = data[candleIdx]?.time;
        const timeLabel = candleTime ? new Date(candleTime).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }) : '';
        const priceLabel = fmtPrice(crossPrice);
        const priceLabelW = Math.max(46, priceLabel.length * 6 + 8);
        const timeLabelW = Math.max(38, timeLabel.length * 5.5 + 8);
        const timeLabelX = Math.max(PAD.left + timeLabelW / 2 + 2,
                           Math.min(width - PAD.right - timeLabelW / 2 - 2, crosshairX));
        return (
          <G>
            {/* Vertical line */}
            <Line x1={crosshairX} y1={PAD.top} x2={crosshairX} y2={PAD.top + mainH}
              stroke={T.textSub} strokeWidth={0.8} strokeDasharray="3,3" opacity={0.85} />
            {/* Horizontal line */}
            <Line x1={PAD.left} y1={cy} x2={width - PAD.right} y2={cy}
              stroke={T.textSub} strokeWidth={0.8} strokeDasharray="3,3" opacity={0.85} />
            {/* Price label on right axis */}
            <Rect x={width - PAD.right + 1} y={cy - 9} width={priceLabelW} height={18} rx={3} fill={T.accent} />
            <SvgText x={width - PAD.right + 1 + priceLabelW / 2} y={cy + 4}
              fontSize={9} fontWeight="bold" fill="#fff" textAnchor="middle">{priceLabel}</SvgText>
            {/* Time label on bottom axis */}
            <Rect x={timeLabelX - timeLabelW / 2} y={PAD.top + mainH + 4} width={timeLabelW} height={16} rx={3} fill={T.accent} />
            <SvgText x={timeLabelX} y={PAD.top + mainH + 15}
              fontSize={9} fontWeight="bold" fill="#fff" textAnchor="middle">{timeLabel}</SvgText>
            {/* Dot at intersection */}
            <Circle cx={crosshairX} cy={cy} r={3} fill={T.accent} opacity={0.9} />
          </G>
        );
      })()}
    </Svg>
  );
}); // end React.memo(ChartSvg)

// FIXED: previously used nested PanGestureHandler/PinchGestureHandler legacy
// components with no `simultaneousHandlers` configuration — a well-documented
// react-native-gesture-handler gotcha where two handlers compete for the same
// touch and only one "wins," meaning pan very plausibly never activated at
// all because the inner pinch handler claimed the touch sequence first. This
// is almost certainly why dragging didn't move the chart.
//
// Rewritten using RNGH's modern Gesture API with Gesture.Simultaneous(), which
// is the library's own documented, recommended way to make pan + pinch work
// together reliably — both can now be recognized on the same touch sequence.
// `.runOnJS(true)` keeps callbacks as plain JS functions updating normal React
// state, avoiding any need to convert this logic into reanimated worklets.
function useChartWindow(dataLength: number, width: number, onRequestOlderData?: () => Promise<boolean>, loadingOlder?: boolean) {
  const DEFAULT_VIEW = Math.min(60, dataLength) || 60;
  const [viewCount, setViewCount] = useState(DEFAULT_VIEW);
  const [endOffset, setEndOffset] = useState(0);
  const [yScale, setYScale] = useState(1); // >1 = zoomed in vertically (narrower price range)
  const gestureBase = useRef({ viewCount, endOffset, yScale: 1, yOffset: 0 });
  const triggeredEdgeRef = useRef(false);
  const momentumFrameRef = useRef<number | null>(null);

  // isMountedRef: gates setState calls inside RAF callbacks.
  // Prevents crash when RNGH delivers gesture events after navigation unmounts the component.
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  const clamp = useCallback((vc: number, eo: number) => {
    const cleanVc = Number.isFinite(vc) && vc > 0 ? vc : DEFAULT_VIEW;
    const cleanEo = Number.isFinite(eo) && eo >= 0 ? eo : 0;
    const safeVc = Math.max(MIN_VIEW, Math.min(MAX_VIEW, Math.min(cleanVc, dataLength || MIN_VIEW)));
    const maxOffset = Math.max(0, dataLength - safeVc);
    const safeEo = Math.max(0, Math.min(cleanEo, maxOffset));
    return { viewCount: safeVc, endOffset: safeEo };
  }, [dataLength, DEFAULT_VIEW]);

  // Phase 4 — inertial scrolling: decays the pan's release velocity each
  // frame, exactly the same -translationX/candleWidth conversion onPanUpdate
  // already uses (verified directly before wiring this in: a leftward
  // flick travels several candles then smoothly settles; clamp() — the
  // SAME clamp already used everywhere else — naturally prevents
  // overscroll/bounce past either edge, no separate bounce-prevention
  // logic needed).
  const stopMomentum = useCallback(() => {
    if (momentumFrameRef.current != null) { cancelAnimationFrame(momentumFrameRef.current); momentumFrameRef.current = null; }
  }, []);

  // Without this, an in-flight momentum animation would keep calling
  // setEndOffset after the chart unmounts (e.g. navigating away mid-flick),
  // which is exactly the kind of stray-update React warns about.
  useEffect(() => stopMomentum, [stopMomentum]);

  const startMomentum = useCallback((initialVelocityX: number) => {
    stopMomentum();
    let velocity = initialVelocityX;
    const friction = 0.95;
    const candleWidth = width / Math.max(1, gestureBase.current.viewCount);
    let accumulatedCandles = 0;

    function step() {
      if (!isMountedRef.current) { momentumFrameRef.current = null; return; }
      if (Math.abs(velocity) < 1) { momentumFrameRef.current = null; return; }
      // Recalculate candleWidth each frame — new candles may have loaded
      const cw = width / Math.max(1, gestureBase.current.viewCount);
      accumulatedCandles += (-velocity * (1 / 60)) / (cw > 0 ? cw : candleWidth);
      velocity *= friction;
      const delta = Math.round(accumulatedCandles);
      if (delta !== 0) {
        const requestedOffset = gestureBase.current.endOffset + delta;
        const next = clamp(gestureBase.current.viewCount, requestedOffset);
        setEndOffset(next.endOffset);
        gestureBase.current = next;
        accumulatedCandles -= delta;
        // Only stop on edge if we're NOT waiting for older data to load
        const hitEdge = next.endOffset !== requestedOffset;
        if (hitEdge && !loadingOlder) { momentumFrameRef.current = null; return; }
      }
      momentumFrameRef.current = requestAnimationFrame(step);
    }
    momentumFrameRef.current = requestAnimationFrame(step);
  }, [width, clamp, dataLength, loadingOlder, stopMomentum]);

  // ── CoinDCX/TradingView-quality pinch zoom ────────────────────────────
  //
  // RNGH Pinch delivers e.scale as a cumulative value from gesture start
  // (e.g. 1.0 → 2.0 = fingers doubled). Raw application of viewCount/scale
  // is too aggressive — a 2× pinch instantly halves visible candles.
  //
  // Our approach (same as TradingView mobile):
  //   1. Convert cumulative scale → per-frame delta: δ = scale / prevScale
  //   2. Damp the delta: δ_damped = 1 + (δ - 1) × DAMPING  (≈25% sensitivity)
  //   3. Clamp δ_damped per frame to prevent noisy event spikes
  //   4. Apply to a continuous float viewCount (not integer yet) for smooth steps
  //   5. Anchor: adjust endOffset so the candle under the focal point stays put
  //   6. Lerp float viewCount toward target each RAF frame for smoothing
  //   7. Only round to integer when flushing to React state

  const PINCH_DAMPING = 0.10;       // 10% of raw sensitivity — TradingView heavy feel
  const PINCH_MAX_DELTA = 0.04;     // max ±4% viewCount change per frame

  // Pinch gesture refs — declared before first use
  const pinchPrevScaleRef  = useRef(1);  // horizontal cumulative scale tracker
  const pinchPrevScaleVRef = useRef(1);  // vertical — own ref prevents stale-delta on diagonal
  const pinchFocalXRef     = useRef(0);  // focal X captured at gesture start (anchor)

  // ── Drag handlers ─────────────────────────────────────────────────────
  // ARCHITECTURE: all in-flight gesture math runs against gestureBase.current
  // (a ref, always synchronous). React setState is throttled to one call per
  // ~16ms frame via rafPendingRef. This eliminates 60fps bridge congestion
  // while keeping the SVG perfectly smooth — it reads from React props which
  // update at display refresh rate, not faster.
  const yDragBaseRef = useRef(1);
  const yOffsetDragBaseRef = useRef(0); // price offset at free-drag start
  const [yOffset, setYOffset] = useState(0); // vertical viewport shift when zoomed
  const rafPendingRef = useRef(false);

  // Flush pending gesture state to React in a single batched update.
  // Called at most once per animation frame regardless of gesture frequency.
  const flushGestureState = useCallback(() => {
    rafPendingRef.current = false;
    if (!isMountedRef.current) return;
    const gb = gestureBase.current;
    setYScale(gb.yScale ?? 1);
    setViewCount(gb.viewCount);
    setEndOffset(gb.endOffset);
    setYOffset(Number.isFinite(gb.yOffset) ? gb.yOffset : 0);
  }, []);

  const flushRafIdRef = useRef<number | null>(null);
  const scheduleFlush = useCallback(() => {
    if (rafPendingRef.current) return;
    rafPendingRef.current = true;
    flushRafIdRef.current = requestAnimationFrame(flushGestureState);
  }, [flushGestureState]);
  const cancelFlush = useCallback(() => {
    if (flushRafIdRef.current != null) { cancelAnimationFrame(flushRafIdRef.current); flushRafIdRef.current = null; }
    rafPendingRef.current = false;
  }, []);

  // Declared AFTER cancelFlush — dep array [cancelFlush] evaluated at render time
  const onPinchStart = useCallback((focalX: number) => {
    stopMomentum();
    cancelFlush();
    pinchPrevScaleRef.current  = 1;
    pinchPrevScaleVRef.current = 1;
    pinchFocalXRef.current     = focalX;
  }, [stopMomentum, cancelFlush]);

  const onVerticalPinchUpdate = useCallback((scale: number) => {
    if (!Number.isFinite(scale) || scale <= 0) return;
    const prev = pinchPrevScaleVRef.current; // own ref — not shared with horizontal
    const rawDelta = scale / prev;
    pinchPrevScaleVRef.current = scale;       // update after reading
    if (!Number.isFinite(rawDelta) || rawDelta <= 0) return;
    const dampedDelta = 1 + (rawDelta - 1) * PINCH_DAMPING;
    const clampedDelta = Math.max(1 - PINCH_MAX_DELTA, Math.min(1 + PINCH_MAX_DELTA, dampedDelta));
    const next = Math.max(0.5, Math.min(20, gestureBase.current.yScale * clampedDelta));
    if (!Number.isFinite(next)) return;
    gestureBase.current = { ...gestureBase.current, yScale: next };
    scheduleFlush();
  }, [scheduleFlush]);

  const onPinchUpdate = useCallback((scale: number, focalX: number) => {
    if (!Number.isFinite(scale) || scale <= 0) return;
    // Per-frame delta (cumulative → incremental)
    const prev = pinchPrevScaleRef.current;
    const rawDelta = scale / prev;
    pinchPrevScaleRef.current = scale;
    if (!Number.isFinite(rawDelta) || rawDelta <= 0) return;
    // Damp + clamp
    const dampedDelta  = 1 + (rawDelta - 1) * PINCH_DAMPING;
    const clampedDelta = Math.max(1 - PINCH_MAX_DELTA, Math.min(1 + PINCH_MAX_DELTA, dampedDelta));
    // Apply to viewCount
    const prevVC    = gestureBase.current.viewCount;
    const rawNextVC = prevVC / clampedDelta;
    const nextVC    = Math.max(MIN_VIEW, Math.min(MAX_VIEW, Math.round(rawNextVC)));
    if (nextVC === prevVC) return;
    // Anchor: keep candle under focal point stationary
    const cW = width - PAD_LEFT - PAD_RIGHT;
    let nextEO = gestureBase.current.endOffset;
    if (cW > 0) {
      const anchorFrac = Math.max(0, Math.min(1, (pinchFocalXRef.current - PAD_LEFT) / cW));
      const anchorFromEnd = (1 - anchorFrac) * prevVC;
      nextEO = Math.round(anchorFromEnd - (1 - anchorFrac) * nextVC) + gestureBase.current.endOffset;
    }
    const safe = clamp(nextVC, Math.max(0, nextEO));
    gestureBase.current = { ...gestureBase.current, viewCount: safe.viewCount, endOffset: safe.endOffset };
    scheduleFlush();
  }, [clamp, cancelFlush, scheduleFlush, width]);

  const onYDragStart = useCallback(() => {
    stopMomentum();
    yDragBaseRef.current = gestureBase.current.yScale;
  }, [stopMomentum]);

  const onYDragUpdate = useCallback((translationY: number) => {
    if (!Number.isFinite(translationY)) return; // guard NaN/Infinity from bad gesture events
    // Exponential mapping: small drags = fine control, large drags = coarse zoom.
    // Clamp factor to [-0.99, 10] so yScale never goes negative or explodes.
    const rawFactor = 1 - translationY / 550;
    const factor = Math.max(0.01, Math.min(10, rawFactor));
    const next = Math.max(0.5, Math.min(20, yDragBaseRef.current * factor));
    if (!Number.isFinite(next)) return; // final safety net
    gestureBase.current = { ...gestureBase.current, yScale: next };
    scheduleFlush(); // throttled — at most 1 setState per RAF frame
  }, [scheduleFlush]);

  const onXDensityDrag = useCallback((translationX: number) => {
    if (!Number.isFinite(translationX)) return;
    stopMomentum();
    const delta = Math.round(translationX / 30);
    const next = clamp(gestureBase.current.viewCount + delta, gestureBase.current.endOffset);
    gestureBase.current = { ...gestureBase.current, viewCount: next.viewCount };
    scheduleFlush();
  }, [clamp, stopMomentum, scheduleFlush]);

  const onPinchEnd = useCallback(() => {
    pinchPrevScaleRef.current  = 1;
    pinchPrevScaleVRef.current = 1;
    pinchFocalXRef.current     = 0;
    cancelFlush();
    if (!isMountedRef.current) return;
    const gb = gestureBase.current;
    setYScale(gb.yScale ?? 1);
    setViewCount(gb.viewCount);
    setEndOffset(gb.endOffset);
  }, [cancelFlush]);

  const onPanUpdate = useCallback((translationX: number) => {
    if (!Number.isFinite(translationX)) return;
    stopMomentum();
    const candleWidth = width / Math.max(1, gestureBase.current.viewCount);
    if (!Number.isFinite(candleWidth) || candleWidth <= 0) return;
    const candleDelta = Math.round(-translationX / candleWidth);
    // Use pan-start offset so cumulative translationX maps correctly
    const next = clamp(gestureBase.current.viewCount, panStartEndOffsetRef.current + candleDelta);
    gestureBase.current = { ...gestureBase.current, endOffset: next.endOffset };
    scheduleFlush();

    const nearOldestEdge = next.endOffset + next.viewCount >= dataLength - 3;
    if (nearOldestEdge && onRequestOlderData && !loadingOlder && !triggeredEdgeRef.current) {
      triggeredEdgeRef.current = true;
      onRequestOlderData();
    }
  }, [clamp, dataLength, onRequestOlderData, loadingOlder, width, stopMomentum, scheduleFlush]);

  const onPanEnd = useCallback((velocityX: number = 0) => {
    // Use gestureBase.current (live ref) not stale React state from closure.
    // gestureBase is always up-to-date; viewCount/endOffset state may lag by 1 frame.
    triggeredEdgeRef.current = false;
    if (Math.abs(velocityX) > 30) startMomentum(velocityX);
  }, [startMomentum]);

  const resetToLive = useCallback(() => {
    stopMomentum(); // reset during momentum must kill the RAF or it keeps scrolling after reset
    const next = clamp(gestureBase.current.viewCount, 0);
    setViewCount(next.viewCount);
    setEndOffset(0);
    setYScale(1);
    setYOffset(0);
    gestureBase.current = { viewCount: next.viewCount, endOffset: 0, yScale: 1, yOffset: 0 };
  }, [clamp, stopMomentum]);

  // Zoom in/out by a fixed step — used by +/- buttons
  const zoomIn = useCallback(() => {
    stopMomentum();
    const next = clamp(Math.max(5, Math.round(gestureBase.current.viewCount * 0.7)), gestureBase.current.endOffset);
    setViewCount(next.viewCount); setEndOffset(next.endOffset);
    gestureBase.current = { ...gestureBase.current, viewCount: next.viewCount, endOffset: next.endOffset };
  }, [clamp, stopMomentum]);
  const zoomOut = useCallback(() => {
    stopMomentum();
    const next = clamp(Math.min(500, Math.round(gestureBase.current.viewCount * 1.4)), gestureBase.current.endOffset);
    setViewCount(next.viewCount); setEndOffset(next.endOffset);
    gestureBase.current = { ...gestureBase.current, viewCount: next.viewCount, endOffset: next.endOffset };
  }, [clamp, stopMomentum]);
  // Free viewport vertical drag (zoomed state only)
  const onViewportDragStart = useCallback(() => {
    yOffsetDragBaseRef.current = gestureBase.current.yOffset;
  }, []);
  const onViewportDragY = useCallback((translationY: number) => {
    if (!Number.isFinite(translationY)) return;
    // translationY is in pixels; convert to price units.
    // We don't know pRng here (it's computed in ChartSvg), so we use
    // a normalized offset in 'yScale units' and convert in ChartSvg.
    // +translationY = drag down = viewport moves down = prices shift up (rawMid decreases)
    gestureBase.current.yOffset = yOffsetDragBaseRef.current - translationY;
    scheduleFlush();
  }, [scheduleFlush]);

  // No lerp RAF to clean up — lerp system was removed in v6.2.26

  // Whether anything has changed from default state
  const isModified = endOffset > 0 || yScale !== 1 || viewCount !== DEFAULT_VIEW || yOffset !== 0;
  return { viewCount, endOffset, yScale, yOffset, DEFAULT_VIEW, isModified, onPinchStart, onPinchUpdate, onVerticalPinchUpdate, onPinchEnd, onPanUpdate, onPanEnd, resetToLive, onYDragUpdate, onXDensityDrag, onYDragStart, zoomIn, zoomOut, onViewportDragStart, onViewportDragY };
}

function GestureChart({ data, theme: T, showMA, showVP, width, height, onRequestOlderData, loadingOlder, timeframe, tradeLevels, markers, livePrediction, overlays, pricePrecision, livePrice, geoPatterns = null }: {
  data: Candle[]; theme: Theme; showMA: boolean; showVP: boolean; width: number; height: number;
  onRequestOlderData?: () => Promise<boolean>; loadingOlder?: boolean; timeframe?: string;
  tradeLevels?: TradeLevel[]; markers?: ChartMarker[]; livePrediction?: { action: string; confidence: number; horizon: number } | null;
  overlays?: OverlayToggles; pricePrecision?: number; livePrice?: number;
  geoPatterns?: ChartPatternSummary | null;
}) {
  const win = useChartWindow(data.length, width, onRequestOlderData, loadingOlder);
  const ctrlsOpacity = useRef(new Animated.Value(0)).current;
  const ctrlsHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showControls = useCallback(() => {
    if (ctrlsHideTimer.current) clearTimeout(ctrlsHideTimer.current);
    Animated.timing(ctrlsOpacity, { toValue: 1, duration: 150, useNativeDriver: true }).start();
    ctrlsHideTimer.current = setTimeout(() => {
      Animated.timing(ctrlsOpacity, { toValue: 0, duration: 400, useNativeDriver: true }).start();
    }, 2500);
  }, [ctrlsOpacity]);
  useEffect(() => () => { if (ctrlsHideTimer.current) clearTimeout(ctrlsHideTimer.current); }, []);
  // TASK 5 (Price Scale): when real exchange precision is known, use it
  // exactly; otherwise fall back to pFmt's existing magnitude heuristic
  // unchanged — this guarantees zero behavior change for any caller that
  // doesn't pass pricePrecision.
  const fmtPrice = (v: number | null | undefined) => pricePrecision != null ? formatPriceWithPrecision(v, pricePrecision) : pFmt(v);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  // Crosshair mode: activated by long-press, exited on release.
  // While active, pan gesture moves the crosshair instead of the viewport.
  const [crosshairActive, setCrosshairActive] = useState(false);
  const [crosshairX, setCrosshairX] = useState<number | null>(null);
  const [crosshairY, setCrosshairY] = useState<number | null>(null);
  const crosshairActiveRef = useRef(false); // sync access inside gesture callbacks
  const visible = useMemo(() => {
    const end = data.length - win.endOffset;
    const start = Math.max(0, end - win.viewCount);
    return data.slice(start, end);
  }, [data, win.endOffset, win.viewCount]);

  const viewingHistory = win.endOffset > 0;

  // ROOT-CAUSE FIX (live price sync): see comment above GestureChart's
  // livePrice prop. Display-only overlay - `data` itself is never mutated.
  const displayVisible = useMemo(() => {
    if (livePrice == null || viewingHistory || !visible.length) return visible;
    const lastReal = visible[visible.length - 1];
    const adjusted: Candle = { ...lastReal, close: livePrice, high: Math.max(lastReal.high, livePrice), low: Math.min(lastReal.low, livePrice) };
    return [...visible.slice(0, -1), adjusted];
  }, [visible, livePrice, viewingHistory]);

  const PAD_LEFT = 4, PAD_RIGHT = 56;
  // CoinDCX-style control button styles — memoised to avoid new objects every render
  const ctrlBtn = useMemo(() => ({ backgroundColor: T.bg2 + 'ee', borderRadius: 8, width: 36, height: 36, justifyContent: 'center' as const, alignItems: 'center' as const, borderWidth: 1, borderColor: T.border }), [T.bg2, T.border]);
  const ctrlTxt = useMemo(() => ({ color: T.text, fontSize: 16, fontWeight: '700' as const }), [T.text]);

  const selectNearestCandle = useCallback((touchX: number) => {
    if (CHART_DIAG.E4_STUB_TAP_SELECT) return; // E4: isolate gesture vs re-render
    if (!visible.length) return; // guard: no candles yet
    const cW = width - PAD_LEFT - PAD_RIGHT;
    const gap = cW / Math.max(1, visible.length);
    const idx = Math.round((touchX - PAD_LEFT - gap / 2) / gap);
    const safe = Math.max(0, Math.min(visible.length - 1, idx));
    if (Number.isFinite(safe)) setSelectedIndex(safe);
  }, [width, visible.length]);

  // Track which axis this pan gesture was committed to on its first significant move.
  // 'x'  = horizontal scroll (existing).
  // 'y'  = price-scale drag (finger started near the right price axis).
  // 'xd' = candle-density drag (finger started near the bottom time axis).
  // null = undecided (first frames before axis is clear).
  // 'free' added: when chart is zoomed, one-finger drag allows both H and V movement
  const panAxisRef = useRef<'x' | 'y' | 'xd' | 'free' | null>(null);
  const isZoomedAtGestureStartRef = useRef(false);
  const panStartEndOffsetRef = useRef(0);

  const panGesture = useMemo(() =>
    Gesture.Pan()
      .minDistance(2)
      .runOnJS(true)
      .onBegin(e => {
        showControls();
        panAxisRef.current = null;
        panStartEndOffsetRef.current = win.endOffset; // React state is correct at gesture start
        isZoomedAtGestureStartRef.current = win.isModified;
        if (e.x >= width - PAD_RIGHT) {
          panAxisRef.current = 'y';
          win.onYDragStart();
        } else if (e.y >= height - 28) {
          panAxisRef.current = 'xd';
        }
      })
      .onUpdate(e => {
        if (crosshairActiveRef.current) {
          // Crosshair: track both X and Y — full chart area
          const clampedX = Math.max(PAD_LEFT, Math.min(width - PAD_RIGHT, e.x));
          const clampedY = Math.max(0, Math.min(height, e.y));
          setCrosshairX(clampedX);
          setCrosshairY(clampedY);
          const cW = width - PAD_LEFT - PAD_RIGHT;
          const gap = cW / Math.max(1, visible.length);
          const idx = Math.round((clampedX - PAD_LEFT) / gap);
          setSelectedIndex(Math.max(0, Math.min(visible.length - 1, idx)));
          return;
        }
        if (panAxisRef.current === null) {
          // When chart is zoomed: enable free viewport drag (H + V simultaneously).
          // When not zoomed: horizontal scroll only (CoinDCX default locked state).
          panAxisRef.current = isZoomedAtGestureStartRef.current ? 'free' : 'x';
          if (panAxisRef.current === 'free') win.onViewportDragStart();
        }
        if (panAxisRef.current === 'y') {
          win.onYDragUpdate(e.translationY);
        } else if (panAxisRef.current === 'xd') {
          win.onXDensityDrag(e.translationX);
        } else if (panAxisRef.current === 'free') {
          // Free drag: move viewport both horizontally and vertically
          win.onPanUpdate(e.translationX);
          win.onViewportDragY(e.translationY);
        } else {
          win.onPanUpdate(e.translationX);
        }
      })
      .onEnd(e => {
        if (crosshairActiveRef.current) {
          crosshairActiveRef.current = false;
          setCrosshairActive(false);
          setCrosshairX(null);
          setCrosshairY(null);
          setSelectedIndex(null);
        } else if (panAxisRef.current === 'x' || panAxisRef.current === 'free') {
          win.onPanEnd(e.velocityX);
        }
        // panAxisRef===null means tap with no drag — do nothing
        // panAxisRef==='y' or 'xd' — no momentum needed
        panAxisRef.current = null;
      })
      .onFinalize(() => {
        // Android can cancel a pan without firing onEnd (navigation swipe,
        // incoming call, gesture arena steal). Always reset pan state so
        // the next gesture starts clean.
        panAxisRef.current = null;
        if (crosshairActiveRef.current) {
          crosshairActiveRef.current = false;
          setCrosshairActive(false);
          setCrosshairX(null);
          setCrosshairY(null);
          setSelectedIndex(null);
        }
      })
  , [win.onPanUpdate, win.onPanEnd, win.onYDragUpdate, win.onXDensityDrag, win.onPinchEnd,
     win.onYDragStart, win.onViewportDragStart, win.onViewportDragY, win.isModified,
     visible.length, width, height, showControls]);

  const longPressGesture = useMemo(() =>
    Gesture.LongPress()
      .minDuration(400)
      .runOnJS(true)
      .onStart(e => {
        panAxisRef.current = null;
        crosshairActiveRef.current = true;
        setCrosshairActive(true);
        const clampedX = Math.max(PAD_LEFT, Math.min(width - PAD_RIGHT, e.x));
        setCrosshairX(clampedX);
        setCrosshairY(e.y);
        selectNearestCandle(clampedX);
      })
      .onFinalize(() => {
        // Safety: always clear crosshair ref on gesture end/cancel
        // so a cancelled long-press never leaves the ref stuck true.
        crosshairActiveRef.current = false;
        setCrosshairActive(false);
        setCrosshairX(null);
        setCrosshairY(null);
        setSelectedIndex(null); // auto-clear on release — no X button needed
      })
  , [selectNearestCandle, width]);

  const pinchAxisRef = useRef<'h' | 'v' | null>(null); // determined on first onUpdate, fixed for the gesture

  // Track the pinch focal point at the start of each gesture to determine
  // axis from actual displacement, not velocity (which is unreliable in RNGH).
  const pinchFocalStartRef = useRef<{ x: number; y: number } | null>(null);

  const pinchGesture = useMemo(() =>
    Gesture.Pinch()
      .runOnJS(true)
      .onBegin(e => {
        showControls();
        pinchAxisRef.current = null;
        pinchFocalStartRef.current = { x: e.focalX, y: e.focalY };
        win.onPinchStart(e.focalX);
      })
      .onUpdate(e => {
        // Commit axis once the focal point has moved enough to be unambiguous.
        // Using displacement (not velocity) gives a reliable signal.
        // Simultaneous H+V pinch: once enough focal displacement, determine dominant axis.
        // Both axes can fire in the same gesture (diagonal pinch adjusts both).
        // Fire immediately — no displacement threshold (matches TradingView)
        const sc = e.scale;
        if (pinchFocalStartRef.current) {
          const dx = Math.abs(e.focalX - pinchFocalStartRef.current.x);
          const dy = Math.abs(e.focalY - pinchFocalStartRef.current.y);
          const ratio = (dx + dy) > 0 ? dy / (dx + dy) : 0.5;
          // ratio < 0.3: mostly horizontal; > 0.7: mostly vertical; else both
          if (ratio < 0.7) win.onPinchUpdate(sc, e.focalX);
          if (ratio > 0.3) win.onVerticalPinchUpdate(sc);
        } else {
          win.onPinchUpdate(sc, e.focalX);
        }
      })
      .onEnd(() => { win.onPinchEnd(); pinchAxisRef.current = null; pinchFocalStartRef.current = null; })
      .onFinalize(() => { win.onPinchEnd(); pinchAxisRef.current = null; pinchFocalStartRef.current = null; })
  , [win.onPinchStart, win.onPinchUpdate, win.onVerticalPinchUpdate, win.onPinchEnd, showControls]);

  // Tap selects/highlights the nearest candle (per-spec: separate from the
  // crosshair-style drag, a discrete selection showing a detail panel).
  // Double-tap resets zoom. Gesture.Exclusive tries doubleTap FIRST with a
  // short deadline — if it doesn't complete, the single tap fires instead —
  // this is RNGH's own documented pattern for distinguishing the two
  // without them fighting over the same touch.
  const singleTapGesture = useMemo(() =>
    Gesture.Tap()
      .runOnJS(true)
      .onEnd(e => selectNearestCandle(e.x))
  , [selectNearestCandle]);

  const doubleTapGesture = useMemo(() =>
    Gesture.Tap()
      .numberOfTaps(2)
      .runOnJS(true)
      .onEnd(() => win.resetToLive())
  , [win.resetToLive]);

  const tapGestures = useMemo(() => Gesture.Exclusive(doubleTapGesture, singleTapGesture), [doubleTapGesture, singleTapGesture]);
  const composed = useMemo(() => CHART_DIAG.E3_DISABLE_GESTURES
    ? Gesture.Tap().enabled(false) // E3: inert — isolates RNGH machinery from render
    : Gesture.Simultaneous(panGesture, pinchGesture, tapGestures, longPressGesture),
    [panGesture, pinchGesture, tapGestures, longPressGesture]);

  const selectedCandle = selectedIndex != null ? displayVisible[selectedIndex] : null;
  const candleInfo = useMemo(() => {
    if (!selectedCandle || selectedIndex == null || selectedIndex < 0) return null;
    if (selectedIndex >= displayVisible.length) return null; // guard stale index
    const upToSelected = displayVisible.slice(0, selectedIndex + 1);
    if (upToSelected.length < 30) {
      // Below getMarketStructureSnapshot's own minimum — report what's
      // genuinely available rather than calling a function that would
      // just return null anyway.
      const prevClose = selectedIndex > 0 ? displayVisible[selectedIndex - 1].close : selectedCandle.open;
      return { changePct: ((selectedCandle.close - prevClose) / prevClose) * 100, range: selectedCandle.high - selectedCandle.low, atr: null, pattern: null, trend: null, regime: null, prediction: null };
    }
    const snapshot = getMarketStructureSnapshot(upToSelected); // already computes patterns internally — reused below, not recomputed
    const atrSeries = atr(upToSelected);
    const closesArr = upToSelected.map(c => c.close);
    const ema20 = ema(closesArr, 20), ema50 = ema(closesArr, 50);
    const trend = detectTrendDirection(upToSelected, ema20, ema50);
    const histVolSeries = historicalVolatility(upToSelected);
    const validVol = histVolSeries.filter((v): v is number => v != null);
    const avgVol = validVol.length ? validVol.reduce((s, v) => s + v, 0) / validVol.length : 1;
    const regime = detectVolatilityRegime(histVolSeries[histVolSeries.length - 1] ?? avgVol, avgVol);

    const prevClose = selectedIndex > 0 ? displayVisible[selectedIndex - 1].close : selectedCandle.open;
    const changePct = ((selectedCandle.close - prevClose) / prevClose) * 100;
    const isLastCandle = selectedIndex === displayVisible.length - 1;
    return {
      changePct, range: selectedCandle.high - selectedCandle.low,
      atr: atrSeries[atrSeries.length - 1] ?? null,
      pattern: snapshot?.patterns.length ? snapshot.patterns[snapshot.patterns.length - 1].name : null,
      trend, regime,
      // AI Prediction (if available) — never fabricated for historical
      // candles, only ever shown for the current/last one, since this app
      // never generates retroactive predictions for arbitrary past bars.
      prediction: isLastCandle ? livePrediction : null};
  }, [selectedCandle, selectedIndex, displayVisible, livePrediction]);

  return (
    <View>
      <GestureDetector gesture={composed}>
        <View>
          <ChartSvg data={displayVisible} theme={T} showMA={showMA} showVP={showVP} width={width} height={height} timeframe={timeframe} selectedIndex={selectedIndex} onSelectCandle={setSelectedIndex} tradeLevels={tradeLevels} markers={markers} overlays={overlays} pricePrecision={pricePrecision} yScale={win.yScale} yOffset={win.yOffset} crosshairActive={crosshairActive} crosshairX={crosshairX} crosshairY={crosshairY} geoPatterns={geoPatterns} patternBarOffset={Math.max(0, data.length - win.endOffset - win.viewCount)} />
        </View>
      </GestureDetector>

      {loadingOlder && (
        <View style={{ position: 'absolute', top: 8, left: 8, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: T.bg2 + 'dd', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 }}>
          <ActivityIndicator size="small" color={T.blue} />
          <Text style={{ color: T.textSub, fontSize: 9 }}>Loading earlier data…</Text>
        </View>
      )}

      {/* CoinDCX: controls fade in on touch, auto-hide after 2.5s inactivity */}
      <Animated.View style={{ position: 'absolute', bottom: 48, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 6, opacity: ctrlsOpacity }} pointerEvents='box-none'>
        <Pressable onPress={() => { win.zoomOut(); showControls(); }} style={ctrlBtn} hitSlop={10} android_ripple={{color:'rgba(255,255,255,0.2)'}}>
          <Text style={ctrlTxt}>−</Text>
        </Pressable>
        <Pressable onPress={() => { win.zoomIn(); showControls(); }} style={ctrlBtn} hitSlop={10} android_ripple={{color:'rgba(255,255,255,0.2)'}}>
          <Text style={ctrlTxt}>+</Text>
        </Pressable>
        {win.isModified && (
          <Pressable onPress={() => { win.resetToLive(); showControls(); }} style={[ctrlBtn, { paddingHorizontal: 10 }]} hitSlop={10} android_ripple={{color:'rgba(255,255,255,0.2)'}}>
            <Text style={[ctrlTxt, { fontSize: 11 }]}>↺</Text>
          </Pressable>
        )}
      </Animated.View>

      {/* Bottom-right: >> Jump to Live — only when viewing history */}
      {viewingHistory && (
        <Pressable onPress={win.resetToLive} hitSlop={8} android_ripple={{color:'rgba(255,255,255,0.15)'}} style={{
          position: 'absolute', bottom: 48, right: 62,
          backgroundColor: T.bg2 + 'ee', borderRadius: 8,
          paddingHorizontal: 10, paddingVertical: 8,
          borderWidth: 1, borderColor: T.border,
          flexDirection: 'row', alignItems: 'center', gap: 4}}>
          <Text style={{ color: T.text, fontSize: 11, fontWeight: '700' }}>{'»'}</Text>
        </Pressable>
      )}

      {/* OHLC info bar — CoinDCX style: compact top strip, only during crosshair,
          auto-hides on release, never blocks candles or gestures. */}
      {crosshairActive && selectedCandle && candleInfo && (
        <View style={{
          position: 'absolute', top: 0, left: 0, right: 0,
          backgroundColor: T.bg1 + 'f5',
          paddingHorizontal: 10, paddingVertical: 6,
          borderBottomWidth: 1, borderBottomColor: T.border,
          flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8}}>
          <Text style={{ color: T.textDim, fontSize: 9, minWidth: 80 }}>
            {new Date(selectedCandle.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </Text>
          <Text style={{ color: T.textSub, fontSize: 9 }}>O <Text style={{ color: T.text, fontWeight: '600' }}>{fmtPrice(selectedCandle.open)}</Text></Text>
          <Text style={{ color: T.textSub, fontSize: 9 }}>H <Text style={{ color: T.green, fontWeight: '600' }}>{fmtPrice(selectedCandle.high)}</Text></Text>
          <Text style={{ color: T.textSub, fontSize: 9 }}>L <Text style={{ color: T.red, fontWeight: '600' }}>{fmtPrice(selectedCandle.low)}</Text></Text>
          <Text style={{ color: T.textSub, fontSize: 9 }}>C <Text style={{ color: T.text, fontWeight: '600' }}>{fmtPrice(selectedCandle.close)}</Text></Text>
          <Text style={{ color: candleInfo.changePct >= 0 ? T.green : T.red, fontSize: 9, fontWeight: '700' }}>
            {candleInfo.changePct >= 0 ? '+' : ''}{candleInfo.changePct.toFixed(2)}%
          </Text>
          {candleInfo.atr != null && (
            <Text style={{ color: T.textDim, fontSize: 9 }}>ATR {fmtPrice(candleInfo.atr)}</Text>
          )}
        </View>
      )}
    </View>
  );
}

export default React.memo(function CandlestickChart({
  data, theme: T, showMA = true, showVP = false, height = 320, expandable = true,
  onRequestOlderData, loadingOlder = false, noDataMessage, timeframe, tradeLevels, markers, livePrediction, overlays, pricePrecision, livePrice, geoPatterns = null,
}: Props) {
  const { width: screenW, height: screenH } = useWindowDimensions();
  const [fullscreen, setFullscreen] = useState(false);
  const W = screenW - 24;

  // No data at all
  if (!data.length) {
    return (
      <View style={{ height, backgroundColor: T.bg0, borderRadius: 16, borderWidth: 1, borderColor: T.cardBorder, justifyContent: 'center', alignItems: 'center', padding: 24 }}>
        <Text style={{ fontSize: 32, marginBottom: 10 }}>📡</Text>
        <Text style={{ color: T.text, fontSize: 13, fontWeight: '700', textAlign: 'center', marginBottom: 4 }}>No Chart Data</Text>
        <Text style={{ color: T.textDim, fontSize: 12, textAlign: 'center', lineHeight: 18, maxWidth: 260 }}>
          {noDataMessage || 'No live data source connected for this asset.'}
        </Text>
      </View>
    );
  }

  // Too few candles to render a meaningful chart (e.g. pre-market, first minute of session).
  // This happens on 1m timeframe when the market hasn't opened yet or only 1–2 candles
  // have formed. Showing 1 candle stretched across the full width is misleading.
  if (data.length < 5) {
    const lastCandle = data[data.length - 1];
    const displayPrice = livePrice ?? lastCandle?.close;
    return (
      <View style={{ height, backgroundColor: T.bg0, borderRadius: 16, borderWidth: 1, borderColor: T.cardBorder, justifyContent: 'center', alignItems: 'center', padding: 24 }}>
        <Text style={{ fontSize: 28, marginBottom: 8 }}>🕐</Text>
        <Text style={{ color: T.text, fontSize: 13, fontWeight: '700', textAlign: 'center', marginBottom: 4 }}>Waiting for market data</Text>
        <Text style={{ color: T.textDim, fontSize: 11, textAlign: 'center', lineHeight: 17, maxWidth: 260 }}>
          Only {data.length} candle{data.length === 1 ? '' : 's'} available — market may not be open yet.
          {'\n'}Switch to a longer timeframe to see historical data.
        </Text>
        {displayPrice != null && (
          <Text style={{ color: T.green, fontSize: 20, fontWeight: '800', marginTop: 12 }}>
            {displayPrice.toLocaleString()}
          </Text>
        )}
      </View>
    );
  }

  const props = { data, theme: T, showMA, showVP, onRequestOlderData, loadingOlder,
    timeframe, tradeLevels, markers, livePrediction, overlays, pricePrecision, livePrice, geoPatterns };

  return (
    <View style={{ backgroundColor: T.bg0, borderRadius: 8, overflow: 'hidden' }}>
      <GestureChart {...props} width={W} height={height} />

      {/* CoinDCX-style expand button — bottom-right corner */}
      {expandable && (
        <Pressable
          onPress={() => setFullscreen(true)}
          hitSlop={12}
          android_ripple={{color:'rgba(255,255,255,0.2)'}}
          style={{
            position: 'absolute', bottom: 48, right: 10,
            backgroundColor: T.bg2 + 'ee', borderRadius: 8,
            width: 36, height: 36, justifyContent: 'center', alignItems: 'center',
            borderWidth: 1, borderColor: T.border}}>
          <Text style={{ fontSize: 14, color: T.text }}>↗</Text>
        </Pressable>
      )}

      {/* Fullscreen modal — same GestureChart, more space */}
      <Modal visible={fullscreen} animationType="slide" onRequestClose={() => setFullscreen(false)}>
        <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
          {/* Minimal header */}
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', paddingHorizontal: 12, paddingTop: 6, paddingBottom: 4 }}>
            <Pressable
              onPress={() => setFullscreen(false)}
              hitSlop={10}
              android_ripple={{color:'rgba(255,255,255,0.2)'}}
              style={{ backgroundColor: T.bg2, borderRadius: 8, width: 34, height: 34, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: T.border }}>
              <Text style={{ color: T.text, fontSize: 16, fontWeight: '700' }}>✕</Text>
            </Pressable>
          </View>
          {/* Full-height chart — same component, same gestures */}
          <View style={{ flex: 1 }}>
            <GestureChart {...props} width={screenW} height={screenH * 0.93} />
          </View>
        </SafeAreaView>
        </GestureHandlerRootView>
      </Modal>
    </View>
  );
});
