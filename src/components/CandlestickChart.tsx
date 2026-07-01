import React, { useMemo, useState, useRef, useCallback, useEffect } from 'react';
import { View, TouchableOpacity, Text, Modal, useWindowDimensions, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Svg, { Line, Rect, Path, Text as SvgText, G, Circle } from 'react-native-svg';
import { Candle, calcMA, pFmt, calcVolumeProfile } from '../utils/indicators';
import { formatPriceWithPrecision } from '../utils/pricePrecision';
import { atr, ema, historicalVolatility, bollinger, keltnerChannel, donchianChannel } from '../utils/technicalIndicators';
import { detectTrendDirection, detectVolatilityRegime } from '../utils/marketStructure';
import { getMarketStructureSnapshot } from '../utils/marketStructureSnapshot';
import { formatTradeQualityScore } from '../utils/tradeQuality';
import { Theme } from '../theme/colors';

type ChartMarker = { time: number; type: 'BUY' | 'SELL' | 'HOLD' | 'ENTRY' | 'EXIT' | 'SL_HIT' | 'TP_HIT' | 'TRAIL'; price: number; label?: string; quality?: { score: number; grade: string; stars: string } };
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

function ChartSvg({
  data, theme: T, showMA, showVP, width, height, timeframe, selectedIndex, onSelectCandle,
  tradeLevels, markers, overlays, pricePrecision,
}: {
  data: Candle[]; theme: Theme; showMA: boolean; showVP: boolean; width: number; height: number; timeframe?: string;
  selectedIndex: number | null; onSelectCandle: (i: number) => void;
  tradeLevels?: TradeLevel[]; markers?: ChartMarker[]; overlays?: OverlayToggles; pricePrecision?: number;
}) {
  const fmtPrice = (v: number | null | undefined) => pricePrecision != null ? formatPriceWithPrecision(v, pricePrecision) : pFmt(v);
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

  const hi = Math.max(...data.map(c => c.high), ...overlayValues, ...tradeLevelPrices);
  const lo = Math.min(...data.map(c => c.low), ...overlayValues, ...tradeLevelPrices);
  const pad = (hi - lo) * 0.06 || hi * 0.01 || 1;
  const maxP = hi + pad, minP = lo - pad, pRng = maxP - minP || 1;
  const cW = width - PAD.left - PAD.right;
  const gap = cW / data.length || 1;
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

  // Phase 3 — band overlays (Bollinger/Keltner/Donchian) as upper/lower
  // path lines, built from the SAME series already computed above for the
  // price-range extension — not recomputed a second time.
  function buildBandPaths(series: { upper: number | null; lower: number | null }[] | null, color: string) {
    if (!series) return null;
    let upperD = '', lowerD = '';
    series.forEach((pt, i) => {
      if (pt.upper != null) upperD += (upperD === '' ? 'M' : 'L') + `${toX(i)},${toY(pt.upper)} `;
      if (pt.lower != null) lowerD += (lowerD === '' ? 'M' : 'L') + `${toX(i)},${toY(pt.lower)} `;
    });
    return { upperD, lowerD, color };
  }
  const bollingerPaths = buildBandPaths(bollingerSeries, T.blue);
  const keltnerPaths = buildBandPaths(keltnerSeries, T.purple);
  const donchianPaths = buildBandPaths(donchianSeries, T.amber);

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
          <Line x1={PAD.left} y1={g.y} x2={width - PAD.right} y2={g.y} stroke={T.grid} strokeWidth={0.5} />
          <SvgText x={width - PAD.right + 4} y={g.y + 3} fontSize={9} fill={T.textDim}>{fmtPrice(g.price)}</SvgText>
        </G>
      ))}
      {vp?.levels.map((lv, i) => {
        if (lv.price < minP || lv.price > maxP) return null;
        const y = toY(lv.price);
        const w = (lv.vol / Math.max(...vp.levels.map(l => l.vol), 1)) * 50;
        const isPoc = vp.poc && Math.abs(lv.price - vp.poc.price) < 1e-9;
        return <Rect key={i} x={width - PAD.right - w} y={y - 1.2} width={w} height={2.4} fill={isPoc ? T.amber + '99' : T.blue + '33'} />;
      })}
      {maLines.map((l, i) => l.d && <Path key={i} d={l.d} stroke={l.color} strokeWidth={1.4} fill="none" />)}
      {[bollingerPaths, keltnerPaths, donchianPaths].map((b, bi) => b && (
        <G key={'band' + bi}>
          {b.upperD && <Path d={b.upperD} stroke={b.color} strokeWidth={1} strokeDasharray="2,2" fill="none" opacity={0.7} />}
          {b.lowerD && <Path d={b.lowerD} stroke={b.color} strokeWidth={1} strokeDasharray="2,2" fill="none" opacity={0.7} />}
        </G>
      ))}
      {overlays?.fib && snapshot?.fib && Object.entries(snapshot.fib).map(([key, price]) => (
        <G key={'fib' + key}>
          <Line x1={PAD.left} y1={toY(price)} x2={width - PAD.right} y2={toY(price)} stroke={T.amber} strokeWidth={0.5} strokeDasharray="1,4" opacity={0.6} />
          <SvgText x={PAD.left + 2} y={toY(price) - 2} fontSize={7} fill={T.amber}>{key.replace('level', '')}</SvgText>
        </G>
      ))}
      {overlays?.pivots && snapshot?.pivots && Object.entries(snapshot.pivots).map(([key, price]) => (
        <Line key={'pivot' + key} x1={PAD.left} y1={toY(price)} x2={width - PAD.right} y2={toY(price)} stroke={T.purple} strokeWidth={0.5} strokeDasharray="1,4" opacity={0.5} />
      ))}
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
            {/* Phase 7 — Trade Quality, reusing the existing composite
                score (computeCompositeScore in opportunityRanking.ts) —
                not a second scoring system. */}
            {m.quality && (
              <SvgText x={x} y={y + yOff + (isBuyLike ? 24 : -18)} fontSize={6} fill={T.textDim} textAnchor="middle">
                {formatTradeQualityScore(m.quality.score)} {m.quality.stars} {m.quality.grade}
              </SvgText>
            )}
          </G>
        );
      })}

      {/* Selected-candle highlight */}
      {selectedIndex != null && selectedIndex >= 0 && selectedIndex < data.length && (
        <Line x1={toX(selectedIndex)} y1={PAD.top} x2={toX(selectedIndex)} y2={PAD.top + mainH} stroke={T.accent} strokeWidth={1} strokeDasharray="2,3" />
      )}
    </Svg>
  );
}

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
  const [viewCount, setViewCount] = useState(Math.min(60, dataLength) || 60);
  const [endOffset, setEndOffset] = useState(0);
  const gestureBase = useRef({ viewCount, endOffset });
  const triggeredEdgeRef = useRef(false);
  const momentumFrameRef = useRef<number | null>(null);

  const clamp = useCallback((vc: number, eo: number) => {
    const safeVc = Math.max(MIN_VIEW, Math.min(MAX_VIEW, Math.min(vc, dataLength || MIN_VIEW)));
    const maxOffset = Math.max(0, dataLength - safeVc);
    const safeEo = Math.max(0, Math.min(eo, maxOffset));
    return { viewCount: safeVc, endOffset: safeEo };
  }, [dataLength]);

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
    const friction = 0.92;
    const candleWidth = width / Math.max(1, gestureBase.current.viewCount);
    let accumulatedCandles = 0;

    function step() {
      if (Math.abs(velocity) < 20) { momentumFrameRef.current = null; return; } // negligible — stop rather than crawl forever
      accumulatedCandles += (-velocity * (1 / 60)) / candleWidth;
      velocity *= friction;
      const delta = Math.round(accumulatedCandles);
      if (delta !== 0) {
        const requestedOffset = gestureBase.current.endOffset + delta; // the UNCLAMPED target — captured before clamping, for a real before/after comparison
        const next = clamp(gestureBase.current.viewCount, requestedOffset);
        setEndOffset(next.endOffset);
        const hitEdge = next.endOffset !== requestedOffset; // true clamp-detection, fixed: compares against the pre-clamp value, not gestureBase AFTER it's been overwritten
        gestureBase.current = next;
        accumulatedCandles -= delta;
        // Hit either edge — stop immediately rather than keep "pushing"
        // against it, which is what prevents bounce/overscroll.
        if (hitEdge) { momentumFrameRef.current = null; return; }
      }
      momentumFrameRef.current = requestAnimationFrame(step);
    }
    momentumFrameRef.current = requestAnimationFrame(step);
  }, [width, clamp, dataLength, stopMomentum]);

  const onPinchUpdate = useCallback((scale: number) => {
    stopMomentum();
    const next = clamp(Math.round(gestureBase.current.viewCount / scale), gestureBase.current.endOffset);
    setViewCount(next.viewCount); setEndOffset(next.endOffset);
  }, [clamp, stopMomentum]);

  const onPinchEnd = useCallback(() => {
    gestureBase.current = { viewCount, endOffset };
  }, [viewCount, endOffset]);

  const onPanUpdate = useCallback((translationX: number) => {
    stopMomentum(); // a fresh manual pan always takes priority over any leftover momentum
    const candleWidth = width / Math.max(1, gestureBase.current.viewCount);
    const candleDelta = Math.round(-translationX / candleWidth);
    const next = clamp(gestureBase.current.viewCount, gestureBase.current.endOffset + candleDelta);
    setEndOffset(next.endOffset);

    const nearOldestEdge = next.endOffset + next.viewCount >= dataLength - 3;
    if (nearOldestEdge && onRequestOlderData && !loadingOlder && !triggeredEdgeRef.current) {
      triggeredEdgeRef.current = true;
      onRequestOlderData();
    }
  }, [clamp, dataLength, onRequestOlderData, loadingOlder, width, stopMomentum]);

  const onPanEnd = useCallback((velocityX: number = 0) => {
    gestureBase.current = { viewCount, endOffset };
    triggeredEdgeRef.current = false;
    if (Math.abs(velocityX) > 50) startMomentum(velocityX); // a real flick, not just lifting the finger off a slow drag
  }, [viewCount, endOffset, startMomentum]);

  const resetToLive = useCallback(() => {
    const next = clamp(viewCount, 0);
    setEndOffset(0);
    gestureBase.current = next;
  }, [clamp, viewCount]);

  return { viewCount, endOffset, onPinchUpdate, onPinchEnd, onPanUpdate, onPanEnd, resetToLive };
}

function GestureChart({ data, theme: T, showMA, showVP, width, height, onRequestOlderData, loadingOlder, timeframe, tradeLevels, markers, livePrediction, overlays, pricePrecision, livePrice }: {
  data: Candle[]; theme: Theme; showMA: boolean; showVP: boolean; width: number; height: number;
  onRequestOlderData?: () => Promise<boolean>; loadingOlder?: boolean; timeframe?: string;
  tradeLevels?: TradeLevel[]; markers?: ChartMarker[]; livePrediction?: { action: string; confidence: number; horizon: number } | null;
  overlays?: OverlayToggles; pricePrecision?: number; livePrice?: number;
}) {
  const win = useChartWindow(data.length, width, onRequestOlderData, loadingOlder);
  // TASK 5 (Price Scale): when real exchange precision is known, use it
  // exactly; otherwise fall back to pFmt's existing magnitude heuristic
  // unchanged — this guarantees zero behavior change for any caller that
  // doesn't pass pricePrecision.
  const fmtPrice = (v: number | null | undefined) => pricePrecision != null ? formatPriceWithPrecision(v, pricePrecision) : pFmt(v);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
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

  const selectNearestCandle = useCallback((touchX: number) => {
    const cW = width - PAD_LEFT - PAD_RIGHT;
    const gap = cW / Math.max(1, visible.length);
    const idx = Math.round((touchX - PAD_LEFT - gap / 2) / gap);
    setSelectedIndex(Math.max(0, Math.min(visible.length - 1, idx)));
  }, [width, visible.length]);

  const panGesture = useMemo(() =>
    Gesture.Pan()
      .minDistance(4)
      .runOnJS(true)
      .onUpdate(e => win.onPanUpdate(e.translationX))
      .onEnd(e => win.onPanEnd(e.velocityX))
  , [win.onPanUpdate, win.onPanEnd]);

  const pinchGesture = useMemo(() =>
    Gesture.Pinch()
      .runOnJS(true)
      .onUpdate(e => win.onPinchUpdate(e.scale))
      .onEnd(() => win.onPinchEnd())
  , [win.onPinchUpdate, win.onPinchEnd]);

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
  const composed = useMemo(() => Gesture.Simultaneous(panGesture, pinchGesture, tapGestures), [panGesture, pinchGesture, tapGestures]);

  const selectedCandle = selectedIndex != null ? displayVisible[selectedIndex] : null;
  const candleInfo = useMemo(() => {
    if (!selectedCandle || selectedIndex == null) return null;
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
      prediction: isLastCandle ? livePrediction : null,
    };
  }, [selectedCandle, selectedIndex, displayVisible, livePrediction]);

  return (
    <View>
      <GestureDetector gesture={composed}>
        <View>
          <ChartSvg data={displayVisible} theme={T} showMA={showMA} showVP={showVP} width={width} height={height} timeframe={timeframe} selectedIndex={selectedIndex} onSelectCandle={setSelectedIndex} tradeLevels={tradeLevels} markers={markers} overlays={overlays} pricePrecision={pricePrecision} />
        </View>
      </GestureDetector>

      {loadingOlder && (
        <View style={{ position: 'absolute', top: 8, left: 8, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: T.bg2 + 'dd', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 }}>
          <ActivityIndicator size="small" color={T.blue} />
          <Text style={{ color: T.textSub, fontSize: 9 }}>Loading earlier data…</Text>
        </View>
      )}

      {viewingHistory && (
        <TouchableOpacity onPress={win.resetToLive} style={{
          position: 'absolute', bottom: 8, left: 8, backgroundColor: T.accent, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 5,
        }}>
          <Text style={{ color: '#fff', fontSize: 10, fontWeight: '700' }}>▶ Jump to live</Text>
        </TouchableOpacity>
      )}

      {selectedCandle && candleInfo && (
        <View style={{ position: 'absolute', top: 46, left: 8, right: 8, backgroundColor: T.bg2 + 'ee', borderRadius: 8, padding: 10, borderWidth: 1, borderColor: T.border }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Text style={{ color: T.textDim, fontSize: 9 }}>{new Date(selectedCandle.time).toLocaleString()}</Text>
            <TouchableOpacity onPress={() => setSelectedIndex(null)}><Text style={{ color: T.textDim, fontSize: 11 }}>✕</Text></TouchableOpacity>
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 4 }}>
            <Text style={{ color: T.textSub, fontSize: 9 }}>O {fmtPrice(selectedCandle.open)}</Text>
            <Text style={{ color: T.textSub, fontSize: 9 }}>H {fmtPrice(selectedCandle.high)}</Text>
            <Text style={{ color: T.textSub, fontSize: 9 }}>L {fmtPrice(selectedCandle.low)}</Text>
            <Text style={{ color: T.textSub, fontSize: 9 }}>C {fmtPrice(selectedCandle.close)}</Text>
            <Text style={{ color: T.textSub, fontSize: 9 }}>Vol {selectedCandle.volume.toFixed(0)}</Text>
            <Text style={{ color: candleInfo.changePct >= 0 ? T.green : T.red, fontSize: 9, fontWeight: '700' }}>{candleInfo.changePct >= 0 ? '+' : ''}{candleInfo.changePct.toFixed(2)}%</Text>
            <Text style={{ color: T.textDim, fontSize: 9 }}>Range {fmtPrice(candleInfo.range)}</Text>
            {candleInfo.atr != null && <Text style={{ color: T.textDim, fontSize: 9 }}>ATR {fmtPrice(candleInfo.atr)}</Text>}
          </View>
          {(candleInfo.pattern || candleInfo.trend || candleInfo.regime) && (
            <Text style={{ color: T.textDim, fontSize: 9, marginTop: 4 }}>
              {[candleInfo.pattern, candleInfo.trend, candleInfo.regime].filter(Boolean).join(' · ')}
            </Text>
          )}
          {candleInfo.prediction && (
            <Text style={{ color: T.accent, fontSize: 9, marginTop: 4, fontWeight: '700' }}>
              AI: {candleInfo.prediction.action} · {candleInfo.prediction.confidence.toFixed(0)}% confidence · {candleInfo.prediction.horizon}-bar
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

export default function CandlestickChart({
  data, theme: T, showMA = true, showVP = false, height = 320, expandable = true,
  onRequestOlderData, loadingOlder = false, noDataMessage, timeframe, tradeLevels, markers, livePrediction, overlays, pricePrecision, livePrice,
}: Props) {
  const { width: screenW, height: screenH } = useWindowDimensions();
  const [fullscreen, setFullscreen] = useState(false);
  const W = screenW - 24;

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

  return (
    <View>
      <View style={{ backgroundColor: T.bg0, borderRadius: 8, overflow: 'hidden' }}>
        <GestureChart data={data} theme={T} showMA={showMA} showVP={showVP} width={W} height={height} onRequestOlderData={onRequestOlderData} loadingOlder={loadingOlder} timeframe={timeframe} tradeLevels={tradeLevels} markers={markers} livePrediction={livePrediction} overlays={overlays} pricePrecision={pricePrecision} livePrice={livePrice} />
      </View>
      {expandable && (
        <TouchableOpacity onPress={() => setFullscreen(true)} style={{
          position: 'absolute', top: 8, right: 8, backgroundColor: T.bg2 + 'dd', borderRadius: 8, padding: 9, borderWidth: 1, borderColor: T.border,
        }}>
          <Text style={{ fontSize: 14 }}>⛶</Text>
        </TouchableOpacity>
      )}

      <Modal visible={fullscreen} animationType="fade" onRequestClose={() => setFullscreen(false)}>
        <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 10 }}>
            <Text style={{ color: T.textDim, fontSize: 10 }}>Pinch to zoom · Drag to scroll history</Text>
            <TouchableOpacity onPress={() => setFullscreen(false)} style={{ backgroundColor: T.bg3, borderRadius: 18, paddingHorizontal: 16, paddingVertical: 11, minHeight: 36 }}>
              <Text style={{ color: T.text, fontWeight: '700', fontSize: 12 }}>✕ Close</Text>
            </TouchableOpacity>
          </View>
          <View style={{ flex: 1, justifyContent: 'center' }}>
            <GestureChart data={data} theme={T} showMA={showMA} showVP={showVP} width={screenW} height={screenH * 0.88} onRequestOlderData={onRequestOlderData} loadingOlder={loadingOlder} timeframe={timeframe} tradeLevels={tradeLevels} markers={markers} livePrediction={livePrediction} overlays={overlays} pricePrecision={pricePrecision} livePrice={livePrice} />
          </View>
        </SafeAreaView>
        </GestureHandlerRootView>
      </Modal>
    </View>
  );
}
