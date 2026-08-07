// ─────────────────────────────────────────────────────────────────────────────
// TRADINGVIEW CHART PROVIDER  (v6.4.0)
//
// Renders Quantis data with TradingView's Lightweight Charts (Apache-2.0)
// inside a WebView. This file is ONLY a rendering adapter:
//   - identical props to the legacy CandlestickChart (drop-in)
//   - all indicator math REUSED from technicalIndicators.ts (zero new calcs)
//   - all decisions stay in Quantis; the WebView never computes anything
//
// Why WebView: the legacy chart's RNGH gesture arena caused a native crash on
// touch on Android. WebView touch handling is fully independent of RNGH and
// react-native-svg — pan/pinch/crosshair are handled by Lightweight Charts.
//
// Bridge (RN → web): full JSON payload injected on data/prop change.
// Bridge (web → RN): postMessage events:
//   { t:'crosshair', i }   — crosshair over candle i (absolute index)
//   { t:'select', i }      — tap-select candle i
//   { t:'edge' }           — user scrolled to oldest data → onRequestOlderData
// ─────────────────────────────────────────────────────────────────────────────
import React, { useMemo, useRef, useState, useCallback, useEffect } from 'react';
import Svg, { Line, Polyline } from 'react-native-svg';
import { View, Text, TouchableOpacity, Modal, useWindowDimensions, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { Candle, pFmt, calcVolumeProfile } from '../../utils/indicators';
import { ema, bollinger, keltnerChannel, donchianChannel, atr, historicalVolatility } from '../../utils/technicalIndicators';
import { detectTrendDirection, detectVolatilityRegime } from '../../utils/marketStructure';
import { getMarketStructureSnapshot } from '../../utils/marketStructureSnapshot';
import { LWC_JS } from './lwcAsset';
import type { ChartPatternSummary } from '../../utils/chartPatterns';

export type OverlayToggles = { bollinger?: boolean; donchian?: boolean; keltner?: boolean; fib?: boolean; pivots?: boolean };
type TradeLevel = { label: string; price: number; color: string; dashed?: boolean };
type ChartMarker = { time: number; type: string; price: number; label?: string; confQuality?: { overall: number; grade: string } };
type Theme = any;

type Props = {
  data: Candle[]; theme: Theme; showMA?: boolean; showVP?: boolean;
  height?: number; expandable?: boolean;
  onRequestOlderData?: () => Promise<boolean>; loadingOlder?: boolean;
  noDataMessage?: string; timeframe?: string;
  tradeLevels?: TradeLevel[]; markers?: ChartMarker[];
  livePrediction?: any; overlays?: OverlayToggles;
  pricePrecision?: number; livePrice?: number;
  geoPatterns?: ChartPatternSummary | null;
  onChartTouchStart?: () => void; // notify parent when WebView touch begins (disable pull-to-refresh)
  onChartTouchEnd?:   () => void; // notify parent when WebView touch ends
};

// HTML shell: chart container + bridge. LWC lib injected separately (kept out of
// the HTML string so Metro doesn't reparse 160KB on every edit of this file).
const HTML = `<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<style>html,body,#c{margin:0;padding:0;width:100%;height:100%;background:transparent;overflow:hidden}</style>
</head><body><div id="c"></div><script>
window.onerror=function(m){try{window.ReactNativeWebView.postMessage(JSON.stringify({t:'err',m:String(m)}))}catch(e){}};
</script></body></html>`;

// Bridge script — runs inside the WebView after the LWC lib.
const BRIDGE = `
(function(){
  var chart=null, cs=null, vs=null, lines={}, maSeries=[], patSeries=[], vpSeries=null, edgeSent=false, N=0;
  var lastRangeMs=0; // throttle: max 10fps for range+VP updates during scroll
  function post(o){ window.ReactNativeWebView.postMessage(JSON.stringify(o)); }
  window.__setup=function(p){
    var el=document.getElementById('c');
    if(chart){ chart.remove(); lines={}; maSeries=[]; patSeries=[]; vpSeries=null; }
    chart=LightweightCharts.createChart(el,{
      autoSize:true,
      layout:{ background:{type:'solid',color:p.th.bg}, textColor:p.th.text, fontSize:10 },
      grid:{ vertLines:{color:p.th.grid}, horzLines:{color:p.th.grid} },
      rightPriceScale:{ borderColor:p.th.grid },
      timeScale:{ borderColor:p.th.grid, timeVisible:true, secondsVisible:false, rightOffset:2 },
      crosshair:{ mode:0 },
      handleScroll:true, handleScale:true});
    cs=chart.addCandlestickSeries({ upColor:p.th.up, downColor:p.th.down,
      wickUpColor:p.th.up, wickDownColor:p.th.down, borderVisible:false,
      priceFormat:{ type:'price', precision:p.prec, minMove:Math.pow(10,-p.prec) } });
    vs=chart.addHistogramSeries({ priceScaleId:'vol', priceFormat:{type:'volume'},
      color:p.th.volDim, priceLineVisible:false });
    chart.priceScale('vol').applyOptions({ scaleMargins:{ top:0.82, bottom:0 } });
    chart.subscribeCrosshairMove(function(par){
      if(par && par.time!=null && par.logical!=null) post({t:'crosshair', i:Math.round(par.logical)});
    });
    chart.subscribeClick(function(par){
      if(par && par.logical!=null) post({t:'select', i:Math.round(par.logical)});
    });
    chart.timeScale().subscribeVisibleLogicalRangeChange(function(r){
      if(!r) return;
      // Edge detection: always immediate (not throttled) so history loads promptly.
      if(r.from<10 && !edgeSent && N>0){ edgeSent=true; post({t:'edge'}); }
      // Throttle range+VP to 100ms (10fps) — fires every animation frame during
      // scroll (60fps) which would cause 60 React re-renders/sec without throttle.
      var now=Date.now();
      if(now-lastRangeMs<100) return;
      lastRangeMs=now;
      post({t:'range', from:Math.round(r.from), to:Math.round(r.to)});
      if(window.__sendVP) window.__sendVP();
    });
  };
  window.__data=function(p){
    if(!chart) return;
    // Save viewport BEFORE setData so we can restore it afterwards.
    // LWC's setData() resets the view to the newest bars (right edge).
    // When older bars are prepended, we shift the saved range by prependCount
    // so the user stays at the same visual position in the chart.
    var savedRange = chart.timeScale().getVisibleLogicalRange();
    N=p.candles.length; edgeSent=false;
    cs.setData(p.candles); vs.setData(p.vols);
    // Restore viewport (shifted for prepended bars)
    if(savedRange && p.prependCount>0){
      chart.timeScale().setVisibleLogicalRange({
        from: savedRange.from + p.prependCount,
        to:   savedRange.to  + p.prependCount
      });
    }
    // Send initial range immediately after data loads so VP can display
    // without waiting for the user to scroll (which normally triggers the range event).
    var ir=chart.timeScale().getVisibleLogicalRange();
    if(ir) post({t:'range', from:Math.round(ir.from), to:Math.round(ir.to)});
    if(window.__sendVP) window.__sendVP();
    // Store patMarkers so __markers can merge them with chart markers
    window.__patMk = p.patMarkers||[];
    // trade levels → native price lines
    Object.keys(lines).forEach(function(k){ cs.removePriceLine(lines[k]); }); lines={};
    (p.levels||[]).forEach(function(L,ix){
      lines['L'+ix]=cs.createPriceLine({ price:L.price, color:L.color, lineWidth:1,
        lineStyle:L.dashed?2:0, axisLabelVisible:true, title:L.label });
    });
    // Markers are managed exclusively by __markers() — never set here.
    // Removing this prevents a one-frame flash where __data clears markers
    // and __markers has not yet re-applied them.
    // MA / band overlays → line series
    maSeries.forEach(function(s){ chart.removeSeries(s); }); maSeries=[];
    (p.lines||[]).forEach(function(Ln){
      var s=chart.addLineSeries({ color:Ln.color, lineWidth:1,
        lineStyle:Ln.dashed?2:0, priceLineVisible:false, lastValueVisible:false,
        crosshairMarkerVisible:false });
      s.setData(Ln.points); maSeries.push(s);
    });
    // chart pattern lines (TradingView-style, reusing exact keyPoint prices)
    patSeries.forEach(function(s){ chart.removeSeries(s); }); patSeries=[];
    (p.patterns||[]).forEach(function(Pt){
      var s=chart.addLineSeries({ color:Pt.color, lineWidth:2, lineStyle:Pt.dashed?2:0,
        priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false });
      s.setData(Pt.points); patSeries.push(s);
    });
  };
  window.__live=function(c){
    if(!cs||!c) return;
    cs.update(c);
    // Update volume histogram with the forming candle's cumulative volume.
    // Before this, vs only updated on __append (candle close), so the volume
    // label stayed at the previous candle's value until close. Now it
    // reflects the live kline volume on every miniTicker tick.
    if(vs && c.volume != null) vs.update({ time: c.time, value: c.volume,
      color: c.close >= c.open ? 'rgba(34,197,94,0.33)' : 'rgba(239,68,68,0.33)' });
    if(window.__vpLevels&&window.__vpLevels.length&&window.__sendVP) window.__sendVP();
  };
  // __append: single new candle + vol bar — avoids full setData on every new bar.
  // Called when data.length grows by exactly 1 and all prior bars are unchanged.
  window.__append=function(p){
    if(!cs||!vs) return;
    cs.update(p.candle); vs.update(p.vol);
    N++; edgeSent=false;
    // Guard: skip VP update if VP not active (saves 20 lookups + postMessage per candle).
    if(window.__vpLevels&&window.__vpLevels.length&&window.__sendVP) window.__sendVP();
  };
  // __markers: update markers only — no candle/series rebuild.
  // __setVP: receive VP levels from RN, store for coordinate conversion.
  window.__setVP=function(p){
    window.__vpLevels=p.levels||[];
    window.__vpMaxVol=p.maxVol||1;
    window.__sendVP();
  };
  window.__markers=function(mk){
    if(!cs) return;
    // Merge chart markers with pattern circle markers, sort by time
    var all=(mk||[]).concat(window.__patMk||[]).sort(function(a,b){return a.time-b.time;});
    cs.setMarkers(all);
  };
  // __destroy: explicit cleanup called on unmount via injectJavaScript.
  // Cancels all LWC subscriptions, frees the chart DOM node, nulls all refs.
  // Normally the OS kills the WebView process on unmount (sufficient on Android),
  // but __destroy defends against WebView process reuse (non-standard but possible).
  window.__jumpToLive=function(){
    if(chart) chart.timeScale().scrollToRealTime();
  };
  window.__zoomIn=function(){
    if(!chart) return;
    var r=chart.timeScale().getVisibleLogicalRange();
    if(!r) return;
    var mid=(r.from+r.to)/2, half=(r.to-r.from)/2;
    chart.timeScale().setVisibleLogicalRange({from:mid-half*0.7, to:mid+half*0.7});
  };
  window.__zoomOut=function(){
    if(!chart) return;
    var r=chart.timeScale().getVisibleLogicalRange();
    if(!r) return;
    var mid=(r.from+r.to)/2, half=(r.to-r.from)/2;
    chart.timeScale().setVisibleLogicalRange({from:mid-half*1.4, to:mid+half*1.4});
  };
  // __sendVP: compute VP bar pixel Y positions using cs.priceToCoordinate.
  // This is the ONLY correct approach in LWC 4.2.3 because:
  //   - IPriceScaleApi has no getVisibleRange() (verified from typings.d.ts)
  //   - A linear formula would be wrong due to LWC's scaleMargins (10% each side)
  //   - priceToCoordinate is the documented API on ISeriesApi for this purpose
  window.__sendVP=function(){
    if(!cs||!window.__vpLevels) return;
    var coords=window.__vpLevels.map(function(lv){
      return {vol:lv.vol, isPoc:lv.isPoc,
        yCoord: cs.priceToCoordinate(lv.price)};
    }).filter(function(lv){ return lv.yCoord!=null; });
    post({t:'vpCoords', coords:coords,
      maxVol:window.__vpMaxVol||1});
  };
  window.__destroy=function(){
    if(chart){ chart.remove(); chart=null; cs=null; vs=null;
      lines={}; maSeries=[]; patSeries=[]; }
  };
  // Disable pull-to-refresh when any finger lands inside the WebView.
  // These fire in WebView's JS thread before the Android gesture threshold.
  // RN receives the message and calls setNativeProps({ scrollEnabled: false })
  // which prevents SwipeRefreshLayout from triggering on downward drags.
  document.addEventListener('touchstart', function() {
    post({t:'chartTouchStart'});
  }, { passive: true });
  document.addEventListener('touchend', function() {
    post({t:'chartTouchEnd'});
  }, { passive: true });
  document.addEventListener('touchcancel', function() {
    post({t:'chartTouchEnd'});
  }, { passive: true });
  post({t:'ready'});
})();`;

// theme → LWC palette (Quantis theme keys reused directly)
function themePayload(T: Theme) {
  return { bg: T.bg0 ?? '#0B0E14', text: T.textDim ?? '#8B93A7',
    grid: (T.border ?? '#232838') + '55', up: T.green ?? '#22C55E',
    down: T.red ?? '#EF4444', volDim: (T.textDim ?? '#8B93A7') + '44' };
}

export default function TradingViewChart({
  data, theme: T, showMA = true, showVP = false, height = 320, expandable = true,
  onRequestOlderData, loadingOlder = false, noDataMessage, timeframe, tradeLevels,
  markers, livePrediction, overlays, pricePrecision, livePrice, geoPatterns = null,
  onChartTouchStart, onChartTouchEnd,
}: Props) {
  const { height: screenH } = useWindowDimensions();
  const webRef   = useRef<any>(null); // inline
  const fsWebRef = useRef<any>(null); // fullscreen modal
  const injectAll = useCallback((js: string) => {
    [webRef, fsWebRef].forEach(r => { try { r.current?.injectJavaScript(js); } catch {} });
  }, []);
  const readyRef = useRef(false);
  const dataRef  = useRef<any[]>([]); // stable ref so livePrice effect doesn't dep on data
  const [fullscreen, setFullscreen] = useState(false);
  const [selIdx, setSelIdx] = useState<number | null>(null);
  const [visibleRange, setVisibleRange] = useState<{from:number;to:number}|null>(null);
  const [vpCoords, setVpCoords] = useState<Array<{vol:number;isPoc:boolean;yCoord:number}>>([]);
  const [viewingHistory, setViewingHistory] = useState(false);
  const loadingRef = useRef(false);
  useEffect(() => { dataRef.current = data; }, [data]);

  // Stable theme dep: only recompute when actual colour values change, not
  // just because ThemeContext returned a new object reference this render.
  const themeKey = useMemo(() => JSON.stringify(themePayload(T)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [T.bg0, T.green, T.red, T.textDim, T.border, T.amber]);

  const prec = pricePrecision ?? (data.length ? Math.max(0, Math.min(8,
    (data[data.length - 1].close < 1 ? 6 : data[data.length - 1].close < 100 ? 4 : 2))) : 2);

  // ── Chart data payload (candles, series, patterns — heavy, only on real data change) ──
  const chartPayload = useMemo(() => {
    if (!data.length) return null;
    const t = (i: number) => {
      if (i < 0 || i >= data.length) return 0;
      return Math.floor(data[i].time / 1000);
    };
    const candles = data.map((c, i) => ({ time: t(i), open: c.open, high: c.high, low: c.low, close: c.close }));
    const vols = data.map((c, i) => ({ time: t(i), value: c.volume,
      color: (c.close >= c.open ? (T.green ?? '#22C55E') : (T.red ?? '#EF4444')) + '55' }));

    const lines: any[] = [];
    const closes = data.map(c => c.close);
    const seriesLine = (arr: (number | null)[], color: string, dashed = false) => {
      const points = [];
      for (let i = 0; i < arr.length; i++) if (arr[i] != null && Number.isFinite(arr[i]!))
        points.push({ time: t(i), value: arr[i] });
      if (points.length > 1) lines.push({ color, dashed, points });
    };
    if (showMA) { seriesLine(ema(closes, 20) as (number|null)[], '#3B82F6'); seriesLine(ema(closes, 50) as (number|null)[], '#F59E0B'); }
    if (overlays?.bollinger) { const b = bollinger(data, 20, 2); seriesLine(b.map(x=>x.upper), '#60A5FA'); seriesLine(b.map(x=>x.lower), '#60A5FA'); }
    if (overlays?.keltner)   { const k = keltnerChannel(data, 20, 10, 1.5); seriesLine(k.map(x=>x.upper), '#A78BFA', true); seriesLine(k.map(x=>x.lower), '#A78BFA', true); }
    if (overlays?.donchian)  { const d = donchianChannel(data, 20); seriesLine(d.map(x=>x.upper), '#F59E0B', true); seriesLine(d.map(x=>x.lower), '#F59E0B', true); }

    const levels: any[] = (tradeLevels ?? []).map(L => ({ label: L.label, price: L.price, color: L.color, dashed: !!L.dashed }));
    if (overlays?.pivots || overlays?.fib) {
      const last = data.slice(-60); const hi = Math.max(...last.map(c => c.high)); const lo = Math.min(...last.map(c => c.low));
      if (overlays?.pivots) {
        const piv=(hi+lo+last[last.length-1].close)/3;
        const r1=2*piv-lo, s1=2*piv-hi, r2=piv+(hi-lo), s2=piv-(hi-lo);
        [{l:'P',price:piv,col:'#94A3B8'},{l:'R1',price:r1,col:'#EF4444'},{l:'R2',price:r2,col:'#EF444488'},
         {l:'S1',price:s1,col:'#22C55E'},{l:'S2',price:s2,col:'#22C55E88'}]
          .forEach(({l,price,col})=>levels.push({label:l,price,color:col,dashed:true}));
      }
      if (overlays?.fib) [0.382, 0.5, 0.618].forEach(f =>
        levels.push({ label: `fib ${f}`, price: lo + (hi - lo) * f, color: '#F59E0B', dashed: true }));
    }

    const patterns: any[] = [];
    const patMarkers: any[] = [];  // circle markers for DoubleTop/HS key points
    const lastBarTime = data.length ? Math.floor(data[data.length-1].time / 1000) : 0;

    const best = geoPatterns?.patterns[0];
    const second = geoPatterns?.patterns[1] &&
      Math.abs((best?.strength ?? 0) - (geoPatterns!.patterns[1].strength ?? 0)) <= 0.05
      ? geoPatterns!.patterns[1] : null;
    for (const p of [best, second].filter(Boolean) as any[]) {
      const col = p.direction === 'bullish' ? (T.green ?? '#22C55E')
                : p.direction === 'bearish' ? (T.red ?? '#EF4444') : (T.amber ?? '#F59E0B');
      const kp = p.keyPoints ?? [];
      const by = (role: string) => { const pt = kp.find((k: any) => k.role === role); return (pt && pt.barIndex >= 0 && pt.barIndex < data.length) ? pt : null; };
      const seg = (a: any, b: any, dashed = false) => {
        if (!a || !b) return;
        const ta = t(a.barIndex), tb = t(b.barIndex);
        if (!ta || !tb || ta === tb) return;
        const pts = ta < tb
          ? [{ time: ta, value: a.price }, { time: tb, value: b.price }]
          : [{ time: tb, value: b.price }, { time: ta, value: a.price }];
        patterns.push({ color: col, dashed, points: pts });
      };
      const circle = (pt: any, large = false) => {
        if (!pt) return;
        patMarkers.push({ time: t(pt.barIndex), position: 'inBar', shape: 'circle',
          color: col + (large ? 'ff' : '99'), size: large ? 1 : 0.6 });
      };

      // Trendline / Wedge / Channel / Pennant
      seg(by('upperStart'), by('upperEnd')); seg(by('lowerStart'), by('lowerEnd'));
      // Flag pole + channel
      seg(by('poleBase'), by('poleTip'), false); seg(by('flagStart'), by('flagEnd'), true);
      // Double Top/Bottom: circles + neckline + extension to current bar
      const t1 = by('top1') ?? by('bottom1'), t2 = by('top2') ?? by('bottom2');
      circle(t1); circle(t2);
      const nlL = by('necklineLeft'), nlR = by('necklineRight');
      seg(nlL, nlR, true);
      if (nlR && lastBarTime > t(nlR.barIndex))
        patterns.push({ color: col + '80', dashed: true, points: [{ time: t(nlR.barIndex), value: nlR.price }, { time: lastBarTime, value: nlR.price }] });
      // Head & Shoulders: circles + connecting lines + neckline
      const lsh = by('leftShoulder'), hd = by('head'), rsh = by('rightShoulder');
      circle(lsh); circle(hd, true); circle(rsh);
      seg(lsh, hd); seg(hd, rsh);
      seg(by('necklineLeft'), by('necklineRight'), true);
      // Cup & Handle
      const cRL = by('cupRimLeft'), cB = by('cupBottom'), cRR = by('cupRimRight');
      seg(cRL, cB); seg(cB, cRR); seg(by('handleStart'), by('handleEnd'), true);
      // Support/Resistance horizontal lines
      if (p.target    != null && p.name?.startsWith('Support'))
        levels.push({ label: 'S', price: p.target,    color: col, dashed: true });
      if (p.stopLevel != null && p.name?.startsWith('Resistance'))
        levels.push({ label: 'R', price: p.stopLevel, color: col, dashed: true });
      // Target / Stop lines
      if (p.target    != null) levels.push({ label: 'TP',   price: p.target,    color: col,               dashed: true });
      if (p.stopLevel != null) levels.push({ label: 'Stop', price: p.stopLevel, color: T.red ?? '#EF4444', dashed: true });
    }

    return { candles, vols, lines, levels, patterns, patMarkers };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, showMA, showVP, overlaysSer, tradeLevelsSer, geoPatternsSer, themeKey]);
  // Note: markers intentionally excluded — handled by markerPayload below.

  // ── Marker payload (fast — only markers, no candle rebuild) ──────────────────
  const markerPayload = useMemo(() => {
    if (!data.length) return null;
    return (markers ?? []).map(m => {
      const buyish  = m.type === 'BUY' || m.type === 'ENTRY' || m.type === 'TP_HIT';
      const sellish = m.type === 'SELL' || m.type === 'EXIT' || m.type === 'SL_HIT';
      // TRAIL: amber circle (neither buy nor sell)
      const text = [m.label, m.confQuality ? `${m.confQuality.overall.toFixed(0)}% ${m.confQuality.grade}` : null]
        .filter(Boolean).join(' ');
      return { time: Math.floor(m.time / 1000),
        position: buyish ? 'belowBar' : 'aboveBar',
        shape: buyish ? 'arrowUp' : sellish ? 'arrowDown' : 'circle',
        color: buyish ? (T.green ?? '#22C55E') : sellish ? (T.red ?? '#EF4444') : (T.amber ?? '#F59E0B'),
        text };
    }).sort((a: any, b: any) => a.time - b.time);
  }, [markers, data.length, themeKey]);

  // ── Injection: setup / full data / incremental append / markers ─────────────
  // __setup  — fires only when theme or precision changes (rare)
  // __data   — fires on significant data change (overlay toggle, pattern change,
  //            symbol switch, or data length change > 1 = history prepend)
  // __append — fires when exactly ONE new candle is added (normal streaming)
  //            uses cs.update() — no series rebuild, no MA re-injection
  // __markers — fires when only markers change (prediction arrives)
  //             calls cs.setMarkers() only — no candle/series touch
  const setupRef        = useRef<string>('');
  // Stable serialised dep strings — computed only when source ref changes,
  // not on every render like JSON.stringify() in the dep array would do.
  const overlaysSerRef   = useRef('');
  const tradeLvlSerRef   = useRef('');
  const geoPatSerRef     = useRef('');
  const overlaysSer      = useMemo(() => { const s = JSON.stringify(overlays);      overlaysSerRef.current   = s; return s; }, [overlays]);
  const tradeLevelsSer   = useMemo(() => { const s = JSON.stringify(tradeLevels);   tradeLvlSerRef.current   = s; return s; }, [tradeLevels]);
  const geoPatternsSer   = useMemo(() => { const s = JSON.stringify(geoPatterns);   geoPatSerRef.current     = s; return s; }, [geoPatterns]);
  const prevLenRef = useRef<number>(0);
  const mountedRef = useRef<boolean>(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      readyRef.current  = false;
      // Explicitly destroy the LWC chart on unmount.
      // On Android the WebView process is killed anyway, but __destroy
      // ensures clean teardown if the process is reused.
      try { injectAll('window.__destroy&&window.__destroy();true;'); } catch {}
    };
  }, []);

  const injectChart = useCallback(() => {
    if (!readyRef.current || !chartPayload) return;
    const setupKey = JSON.stringify({ th: themePayload(T), prec });
    if (setupRef.current !== setupKey) {
      setupRef.current = setupKey;
      injectAll(`window.__setup(${setupKey});true;`);
    }
    const currentLen = chartPayload.candles.length;
    const prevLen    = prevLenRef.current;
    if (prevLen > 0 && currentLen === prevLen + 1) {
      // Single new candle appended — incremental update, no series rebuild
      const last = chartPayload.candles[currentLen - 1];
      const lastV = chartPayload.vols[currentLen - 1];
      injectAll(`window.__append(${JSON.stringify({ candle: last, vol: lastV })});true;`);
    } else {
      // Full reload: symbol switch, history prepend, or first load.
      // Pass prependCount so the bridge can restore the viewport position
      // after setData() — otherwise LWC jumps to the newest bars.
      const prependCount = prevLen > 0 ? Math.max(0, currentLen - prevLen) : 0;
      injectAll(`window.__data(${JSON.stringify({ ...chartPayload, prependCount })});true;`);
    }
    prevLenRef.current = currentLen;
  }, [chartPayload, themeKey, prec]);

  const injectMarkers = useCallback(() => {
    if (!readyRef.current || !markerPayload) return;
    injectAll(`window.__markers(${JSON.stringify(markerPayload)});true;`);
  }, [markerPayload]);

  useEffect(() => { injectChart(); }, [injectChart]);
  useEffect(() => { injectMarkers(); }, [injectMarkers]);

  // live price → update the last candle only (display-only, never written to data)
  // Deps: [livePrice, lastCandleTime]
  // livePrice    — fires when cp.price changes (~1/sec via miniTicker)
  // lastCandleTime — fires when a NEW candle opens (once per TF duration)
  //
  // WHY lastCandleTime is needed:
  // When the kline stream opens a new candle, injectChart/__append sets the
  // chart's last-candle close to the kline close. If cp.price hasn't changed
  // since then, livePrice dep doesn't re-fire and __live is never called.
  // Result: chart shows the kline close; header shows cp.price — visible desync.
  // Adding lastCandleTime re-fires __live on every new candle open, immediately
  // resyncing the chart to cp.price. It does NOT fire on intra-candle kline
  // updates (candle time is stable until close).
  const lastCandleTime = data.length ? data[data.length - 1].time : 0;
  useEffect(() => {
    if (!readyRef.current || livePrice == null || !dataRef.current.length) return;
    const c = dataRef.current[dataRef.current.length - 1];
    injectAll(`window.__live(${JSON.stringify({
      time: Math.floor(c.time / 1000), open: c.open,
      high: Math.max(c.high, livePrice), low: Math.min(c.low, livePrice),
      close: livePrice, volume: c.volume })});true;`);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [livePrice, lastCandleTime]); // lastCandleTime resyncs chart when new candle opens

  const onMessage = useCallback(async (e: any) => {
    try {
      const msg = JSON.parse(e.nativeEvent.data);
      if (msg.t === 'chartTouchStart') {
        // WebView reported finger down — disable ScrollView scroll synchronously
        // before Android's SwipeRefreshLayout gesture threshold is reached.
        onChartTouchStart?.();
      }
      else if (msg.t === 'chartTouchEnd') {
        onChartTouchEnd?.();
      }
      else if (msg.t === 'ready') {
        readyRef.current = true;
        prevLenRef.current = 0;
        // Always send __setup on ready — the WebView is freshly initialized.
        // setupRef guards against re-setup on the same chart, but a newly
        // mounted WebView (fullscreen modal) must receive __setup even when
        // setupRef already matches. Without this the fullscreen chart is blank.
        const sk = JSON.stringify({ th: themePayload(T), prec });
        setupRef.current = sk;
        injectAll(`window.__setup(${sk});true;`);
        injectChart(); injectMarkers();
        if (vpLevels) injectAll(`window.__setVP&&window.__setVP(${JSON.stringify(vpLevels)});true;`);
      }
      else if (msg.t === 'select') setSelIdx(cur => (cur === msg.i ? null : msg.i));
      else if (msg.t === 'vpCoords') {
        setVpCoords(msg.coords ?? []);
      }
      else if (msg.t === 'range') {
        setVisibleRange({ from: msg.from, to: msg.to });
        // Functional update: skip re-render if value hasn't changed
        const newViewing = msg.to < (data.length - 1);
        setViewingHistory(prev => prev === newViewing ? prev : newViewing);
      }
      else if (msg.t === 'edge' && onRequestOlderData && !loadingRef.current) {
        loadingRef.current = true;
        try {
          await onRequestOlderData();
          // After older data prepends, prevLenRef must reset so __data fires
          // (not __append — the entire array grew from the front)
          prevLenRef.current = 0;
        } finally {
          if (mountedRef.current) loadingRef.current = false;
        }
      }
    } catch { /* malformed bridge message — ignore */ }
  }, [injectChart, injectMarkers, onRequestOlderData]);

  const candleInfo = useMemo(() => {
    if (selIdx == null || selIdx < 0 || selIdx >= data.length) return null;
    const sel = data[selIdx];
    const prevClose = selIdx > 0 ? data[selIdx - 1].close : sel.open;
    const changePct = ((sel.close - prevClose) / prevClose) * 100;
    if (data.slice(0, selIdx + 1).length < 30) return { sel, changePct, atr: null, trend: null, regime: null, prediction: null };
    const upTo = data.slice(0, selIdx + 1);
    const atrV = atr(upTo); const cl = upTo.map(c => c.close);
    const e20 = ema(cl, 20), e50 = ema(cl, 50);
    const trend = detectTrendDirection(upTo, e20, e50);
    const hv = historicalVolatility(upTo); const valids = hv.filter((v): v is number => v != null);
    const avgVol = valids.length ? valids.reduce((s,v)=>s+v,0)/valids.length : 1;
    const regime = detectVolatilityRegime(hv[hv.length-1] ?? avgVol, avgVol);
    const isLast = selIdx === data.length - 1;
    const msSnap = getMarketStructureSnapshot(upTo);
    const patternName = msSnap?.patterns?.length
      ? msSnap.patterns[msSnap.patterns.length - 1].name : null;
    return { sel, changePct, atr: atrV[atrV.length-1] ?? null, trend, regime,
      patternName, prediction: isLast ? livePrediction : null };
  // P7: Historical candle OHLC never changes — only live candle (selIdx===last)
  // needs data in deps. Using data.length + last-candle-time avoids recomputing
  // the heavy slice/atr/ema/regime on every new candle while a past bar is selected.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selIdx, data.length, data[data.length - 1]?.close, livePrediction]);

  // VP levels memo (RN side): compute which bars are visible, build level list
  const vpLevels = useMemo(() => {
    if (!showVP || !visibleRange || !data.length) return null;
    const from = Math.max(0, visibleRange.from);
    const to   = Math.min(data.length - 1, visibleRange.to);
    if (to <= from) return null;
    const vp = calcVolumeProfile(data.slice(from, to + 1), 20);
    if (!vp?.levels.length) return null;
    const maxVol = Math.max(...vp.levels.map((l: any) => l.vol), 1);
    return { levels: vp.levels.map((l: any) => ({
      price: l.price, vol: l.vol,
      isPoc: vp.poc != null && Math.abs(l.price - vp.poc.price) < 1e-9})), maxVol };
  }, [showVP, visibleRange, data]);

  // Send VP levels to bridge; bridge calls cs.priceToCoordinate() on each level
  // and posts back vpCoords with pixel Y values that exactly match LWC's Y axis.
  useEffect(() => {
    if (!readyRef.current) return;
    if (vpLevels) {
      injectAll(`window.__setVP&&window.__setVP(${JSON.stringify(vpLevels)});true;`);
    } else {
      setVpCoords([]);
    }
  }, [vpLevels]);

  // Pattern badge: top-left RN View with coloured pill showing name + direction
  const onZoomOut    = useCallback(() => injectAll('window.__zoomOut&&window.__zoomOut();true;'),    [injectAll]);
  const onZoomIn     = useCallback(() => injectAll('window.__zoomIn&&window.__zoomIn();true;'),      [injectAll]);
  const onJumpToLive = useCallback(() => injectAll('window.__jumpToLive&&window.__jumpToLive();true;'), [injectAll]);

  const patternBadges = useMemo(() => {
    const best = geoPatterns?.patterns[0];
    const second = geoPatterns?.patterns[1] &&
      Math.abs((best?.strength ?? 0) - (geoPatterns!.patterns[1].strength ?? 0)) <= 0.05
      ? geoPatterns!.patterns[1] : null;
    return [best, second].filter(Boolean) as any[];
  }, [geoPatterns]);

  if (data.length > 0 && data.length < 5) {
    const displayPrice = livePrice ?? data[data.length - 1]?.close;
    return (
      <View style={{ height, backgroundColor: T.bg0, borderRadius: 16, borderWidth: 1, borderColor: T.cardBorder ?? T.border, justifyContent: 'center', alignItems: 'center', padding: 24 }}>
        <Text style={{ fontSize: 28, marginBottom: 8 }}>🕐</Text>
        <Text style={{ color: T.text, fontSize: 13, fontWeight: '700', textAlign: 'center', marginBottom: 4 }}>Waiting for market data</Text>
        <Text style={{ color: T.textDim, fontSize: 11, textAlign: 'center', lineHeight: 17, maxWidth: 260 }}>
          Only {data.length} candle{data.length === 1 ? '' : 's'} available — market may not be open yet.{`\n`}Switch to a longer timeframe to see historical data.
        </Text>
        {displayPrice != null && <Text style={{ color: T.green, fontSize: 20, fontWeight: '800', marginTop: 12 }}>{displayPrice.toLocaleString()}</Text>}
      </View>
    );
  }

  // NOTE: PaperReplayScreen uses a frozen candle snapshot (trade.recentCandles).
  // data never changes after mount in replay, so __data fires once (on ready).
  // If step-by-step replay is added in the future, grow data one bar at a time
  // and __append will handle it incrementally (prevLenRef +1 path above).
  if (!data.length) return (
    <View style={{ height, backgroundColor: T.bg0, borderRadius: 16, borderWidth: 1, borderColor: T.cardBorder, justifyContent: 'center', alignItems: 'center', padding: 24 }}>
      <Text style={{ fontSize: 32, marginBottom: 10 }}>📡</Text>
      <Text style={{ color: T.text, fontSize: 13, fontWeight: '700', textAlign: 'center', marginBottom: 4 }}>No Chart Data</Text>
      <Text style={{ color: T.textDim, fontSize: 12, textAlign: 'center', lineHeight: 18, maxWidth: 260 }}>{noDataMessage || 'No live data source connected for this asset.'}</Text>
    </View>
  );

  const body = (h: number, ref: any) => (
    <View style={{ height: h, backgroundColor: T.bg0, borderRadius: 8, overflow: 'hidden' }}>
      <WebView
        ref={ref}
        source={{ html: HTML }}
        injectedJavaScript={LWC_JS + ';' + BRIDGE + ';true;'}
        onMessage={onMessage}
        style={{ backgroundColor: 'transparent' }}
        javaScriptEnabled domStorageEnabled={false}
        originWhitelist={['*']}
        setSupportMultipleWindows={false}
        androidLayerType="hardware"
        overScrollMode="never"
        // Chart owns its touches; page scrolling is handled by the outer ScrollView
        // only when the finger is outside the WebView. No RNGH involvement at all.
        nestedScrollEnabled
      />
      {candleInfo && (
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0,
          backgroundColor: (T.bg1 ?? T.bg0) + 'f5', paddingHorizontal: 10, paddingVertical: 6,
          borderBottomWidth: 1, borderBottomColor: T.border,
          flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <Text style={{ color: T.textDim, fontSize: 9, minWidth: 80 }}>
            {new Date(candleInfo.sel.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </Text>
          <Text style={{ color: T.textSub ?? T.textDim, fontSize: 9 }}>O <Text style={{ color: T.text, fontWeight: '600' }}>{pFmt(candleInfo.sel.open)}</Text></Text>
          <Text style={{ color: T.textSub ?? T.textDim, fontSize: 9 }}>H <Text style={{ color: T.green, fontWeight: '600' }}>{pFmt(candleInfo.sel.high)}</Text></Text>
          <Text style={{ color: T.textSub ?? T.textDim, fontSize: 9 }}>L <Text style={{ color: T.red, fontWeight: '600' }}>{pFmt(candleInfo.sel.low)}</Text></Text>
          <Text style={{ color: T.textSub ?? T.textDim, fontSize: 9 }}>C <Text style={{ color: T.text, fontWeight: '600' }}>{pFmt(candleInfo.sel.close)}</Text></Text>
          <Text style={{ color: candleInfo.changePct >= 0 ? T.green : T.red, fontSize: 9, fontWeight: '700' }}>
            {candleInfo.changePct >= 0 ? '+' : ''}{candleInfo.changePct.toFixed(2)}%
          </Text>
          {candleInfo.atr != null && <Text style={{ color: T.textDim, fontSize: 9 }}>ATR {pFmt(candleInfo.atr)}</Text>}
          {candleInfo.trend && <Text style={{ color: T.textDim, fontSize: 9 }}>{candleInfo.trend}</Text>}
          {candleInfo.regime && <Text style={{ color: T.textDim, fontSize: 9 }}>{candleInfo.regime}</Text>}
          {(candleInfo as any).patternName && <Text style={{ color: T.textDim, fontSize: 9 }}>{(candleInfo as any).patternName}</Text>}
          {candleInfo.prediction && <Text style={{ color: candleInfo.prediction.action === 'BUY' ? T.green : T.red, fontSize: 9, fontWeight: '700' }}>
            {candleInfo.prediction.action} {candleInfo.prediction.confidence.toFixed(0)}%
          </Text>}
        </View>
      )}
      {/* Loading indicator */}
      {loadingOlder && (
        <View style={{ position: 'absolute', top: 8, left: 8, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: (T.bg2??T.bg0) + 'dd', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 }}>
          <ActivityIndicator size="small" color={T.blue??T.accent??'#3B82F6'} />
          <Text style={{ color: T.textDim, fontSize: 9 }}>Loading earlier data…</Text>
        </View>
      )}

      {/* Pattern name badges (top-left, matches legacy coloured pill) */}
      {patternBadges.map((p: any, i: number) => {
        const col = p.direction === 'bullish' ? (T.green??'#22C55E') : p.direction === 'bearish' ? (T.red??'#EF4444') : (T.amber??'#F59E0B');
        const arrow = p.direction === 'bullish' ? '▲' : p.direction === 'bearish' ? '▼' : '◆';
        // Push badge below the OHLC info strip when a candle is selected.
        // The info strip is ~58px tall; without selection it's hidden so top: 8 is fine.
        const badgeTop = candleInfo ? 62 + i * 20 : 8 + i * 20;
        return (
          <View key={i} style={{ position: 'absolute', top: badgeTop, left: 8,
            backgroundColor: col + 'e0', borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 }}>
            <Text style={{ color: '#fff', fontSize: 8.5, fontWeight: '700' }}>{arrow} {p.name}</Text>
          </View>
        );
      })}

      {/* Zoom +/- and Jump-to-Live buttons (fade visible — always shown for WebView) */}
      <View style={{ position: 'absolute', bottom: 48, left: 0, right: 0, flexDirection: 'row', justifyContent: 'center', gap: 6 }} pointerEvents="box-none">
        <TouchableOpacity onPress={onZoomOut}
          style={{ backgroundColor: (T.bg2??T.bg0) + 'ee', borderRadius: 8, width: 36, height: 36, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: T.border }}>
          <Text style={{ color: T.text, fontSize: 16, fontWeight: '700' }}>−</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={onZoomIn}
          style={{ backgroundColor: (T.bg2??T.bg0) + 'ee', borderRadius: 8, width: 36, height: 36, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: T.border }}>
          <Text style={{ color: T.text, fontSize: 16, fontWeight: '700' }}>+</Text>
        </TouchableOpacity>
        {viewingHistory && (
          <TouchableOpacity onPress={onJumpToLive}
            style={{ backgroundColor: (T.bg2??T.bg0) + 'ee', borderRadius: 8, paddingHorizontal: 10, height: 36, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: T.border }}>
            <Text style={{ color: T.text, fontSize: 11, fontWeight: '700' }}>↺</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Volume Profile overlay — pixel Y from cs.priceToCoordinate() (ISeriesApi).
          This is the only API-correct approach in LWC 4.2.3: IPriceScaleApi has
          no getVisibleRange(), and a linear formula ignores LWC's scaleMargins
          (10% top+bottom padding by default). Bridge calls priceToCoordinate() per
          VP level and posts back pixel Y values via the 'vpCoords' message. */}
      {showVP && vpCoords.length > 0 && vpCoords.map((lv, i) => (
        <View key={i} style={{
          position: 'absolute', right: 56, top: lv.yCoord - 1.2,
          width: (lv.vol / (vpLevels?.maxVol ?? 1)) * 50,
          height: 2.4, borderRadius: 1,
          backgroundColor: lv.isPoc ? '#F59E0B55' : '#3B82F622', opacity: 0.85}} />
      ))}
    </View>
  );

  return (
    <View>
      {body(height, webRef)}
      {expandable && (
        <TouchableOpacity onPress={() => setFullscreen(true)} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          style={{ position: 'absolute', top: 8, right: 8, backgroundColor: (T.bg2 ?? '#151A26') + 'ee', borderRadius: 8, width: 32, height: 32, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: T.border }}>
          <Svg width={16} height={16} viewBox="0 0 16 16">
            <Line x1="3" y1="13" x2="13" y2="3" stroke={T.text??'#fff'} strokeWidth="1.5" strokeLinecap="round"/>
            <Polyline points="8,3 13,3 13,8" fill="none" stroke={T.text??'#fff'} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            <Polyline points="8,13 3,13 3,8" fill="none" stroke={T.text??'#fff'} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </Svg>
        </TouchableOpacity>
      )}
      <Modal visible={fullscreen} animationType="slide" onRequestClose={() => setFullscreen(false)}>
        <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: 12, paddingVertical: 6 }}>
            <TouchableOpacity onPress={() => setFullscreen(false)}><Text style={{ color: T.text, fontSize: 16 }}>✕</Text></TouchableOpacity>
          </View>
          {fullscreen && body(screenH - 90, fsWebRef)}
        </SafeAreaView>
      </Modal>
    </View>
  );
}
