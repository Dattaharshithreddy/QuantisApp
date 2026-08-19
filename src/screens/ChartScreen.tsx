// ─────────────────────────────────────────────────────────────────────────────
// ChartScreen  (v6.0.2 — orchestrator only)
//
// Responsibility: wire hooks → compose components → handle navigation.
// No business logic, no inline JSX calculations, no engine calls.
// All state lives in the four hooks. All display lives in components.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import { View, Text, TouchableOpacity, Pressable, Alert, useWindowDimensions } from 'react-native';
// ScrollView MUST come from react-native-gesture-handler here: the chart inside
// uses RNGH GestureDetector, and RN's ScrollView fights RNGH's gesture arena on
// Android → native crash on touch. RNGH's ScrollView participates in the same
// arena, so the chart pan and page scroll negotiate cleanly.
import { ScrollView } from 'react-native-gesture-handler';
// E2 crash-isolation flag: true = chart ignores ALL touches (page still scrolls).
// crash stops → fault inside chart · still crashes → fault outside chart
const E2_CHART_INERT = false;
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useData } from '../context/DataContext';
import { calcMA, calcRSI, calcVolumeProfile, pFmt } from '../utils/indicators';
import { managementOutcomeLabel } from '../utils/predictionResult';
import { generateObservations } from '../utils/tradeObservations';
import { getLatestTrainingStatus, TrainingStatusInfo } from '../utils/trainingHistory';
import { analyzeWithClaude, buildAnalysisPrompt, AIAnalysis } from '../api/claude';
import { computeConfidence } from '../utils/confidence/confidenceEngine';
import { computeTradeReadiness } from '../utils/mtf/tradeReadiness';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { TrainingSummaryModal } from '../components/TrainingSummaryModal';
import { OrderBookCard } from '../components/OrderBookCard';
import CandlestickChart, { OverlayToggles } from '../components/chart/ChartAdapter';
import { Card, SectionLabel, StatBox, PrimaryButton, GradientButton, Pill, Skeleton } from '../components/Common';
import { RADIUS, SPACING } from '../theme/colors';

// Hooks
import { useChartData } from './chart/hooks/useChartData';
import { useChartIndicators } from './chart/hooks/useChartIndicators';
import { usePrediction } from './chart/hooks/usePrediction';
import { useChartOverlays } from './chart/hooks/useChartOverlays';
import { useLiveTrading } from './chart/hooks/useLiveTrading';

// Components
import { ChartHeader } from './chart/components/ChartHeader';
import { ChartToolbar } from './chart/components/ChartToolbar';
import { IndicatorPanel } from './chart/components/IndicatorPanel';
import { MarketStructureCard } from './chart/components/MarketStructureCard';
import { usePriceSelector } from '../hooks/usePriceSelector';
import { usePatternOutcomeMonitor } from '../utils/patternValidation/patternOutcomeMonitor';
import { PredictionCard } from './chart/components/PredictionCard';
import { SessionExpiredBanner } from '../components/SessionExpiredBanner';
import { AICopilotPanel } from './chart/components/AICopilotPanel';
import { getActiveStrategyId } from '../utils/strategy/strategyStorage';
import { getProfile } from '../utils/strategy/strategyProfiles';
import { LiveCandleCountdown } from './chart/components/LiveCandleCountdown';
import { ExchangeSelector } from './chart/components/ExchangeSelector';
// setExchangePreference moved to DataContext.updateExchangePreference

// FIX H-5: Module-level stable empty arrays/arrays so `?? []` in JSX never
// creates a new object reference on every render. When these are created inline
// (e.g. `validatedPatterns ?? []`), React.memo on child components always sees a
// new prop reference and re-renders unnecessarily — once per 1s nowTick cycle.
const EMPTY_VALIDATED_PATTERNS: any[] = [];
const EMPTY_CANDLE_PATTERNS:    any[] = [];
const EMPTY_MTF_SIGNALS:        any[] = [];
const EMPTY_FVG:                any[] = [];

export default function ChartScreen({ route, navigation }: any) {
  const { height: screenHeight } = useWindowDimensions();
  const { theme: T } = useTheme();
  const { aoSession, avKey, anthropicKey, news, allAssets, logicalAssets, updateExchangePreference, nftTokenError, retryNFOTokens } = useData();
  // Active strategy profile — loaded from AsyncStorage on mount and when symbol changes.
  // Passed into computeTradeReadiness so strategy gates are applied before the UI renders.
  const [activeStrategyProfile, setActiveStrategyProfile] = React.useState<any>(null);
  React.useEffect(() => {
    getActiveStrategyId().then(id => setActiveStrategyProfile(getProfile(id))).catch(() => {});
  }, []);

  // reviewTrade: completed PaperTradeRecord passed from PaperJournalScreen.
  // When set, chart shows static entry/exit/SL/TP overlays for that trade.
  const [reviewTrade, setReviewTrade] = React.useState<any>(route?.params?.reviewTrade ?? null);

  // ── Hooks ─────────────────────────────────────────────────────────────────
  // AI state — screen-level (ChartScreen is the only consumer)

  // Pull-to-refresh: disabled ONLY over the chart area, active everywhere else.
  // setNativeProps is synchronous — avoids the async setState race where the
  // native pull gesture starts before React re-renders with scrollEnabled=false.
  const scrollRef = useRef<any>(null);
  const onChartTouchStart = useCallback(() =>
    scrollRef.current?.setNativeProps?.({ scrollEnabled: false }), []);
  const onChartTouchEnd = useCallback(() =>
    scrollRef.current?.setNativeProps?.({ scrollEnabled: true }), []);

  const [ai, setAi] = useState<{ status: 'idle'|'loading'|'done'|'error'; data: AIAnalysis | null; err: string | null }>({ status: 'idle', data: null, err: null });

  // Stable callback — wrapped in useCallback so the reference never changes
  // between renders. Without this, every price-tick re-render of ChartScreen
  // creates a new arrow function, which changes the loadCandles useCallback
  // dep, which fires useEffect, which triggers a full candle reload every second.
  // Stable ref for onCandleClose — allows useChartData to call it before
  // usePrediction is initialized (hooks must be called in fixed order).
  const onCandleCloseRef = useRef<((c: any[]) => void) | undefined>(undefined);
  const onCandleCloseStable = useCallback((c: any[]) => {
    onCandleCloseRef.current?.(c);
  }, []);

  const onBeforeLoad = useCallback(
    () => setAi({ status: 'idle', data: null, err: null }),
    [], // setAi is stable from useState — no deps needed
  );

  // Stable callbacks for ChartHeader — inline arrows would break React.memo
  // on ChartHeader since a new function reference is created on every render
  // (every ~1s price tick), defeating the memo entirely.
  const onSymbolChange = useCallback((assetId: string, exchange: string) => {
    // Use the direct assetId+exchange path — avoids the legacy-symbol shim
    // and correctly resolves built-in assets like 'BTC' → Binance variant
    setAssetId(assetId);
    setExchange(exchange);
    setReviewTrade(null);
  }, [setAssetId, setExchange]);
  const onSearch = useCallback(() =>
    navigation.navigate('SymbolSearch', { returnTo: 'Chart' }), [navigation]);
  const initialSymbol = route?.params?.symbol || 'NIFTY50';
  const initialAssetId = route?.params?.assetId ?? route?.params?.symbol ?? 'NIFTY50';
  const initialExchange = route?.params?.exchange ?? '';
  const chartData = useChartData(initialAssetId, initialExchange, { onBeforeLoad, onCandleClose: onCandleCloseStable });
  const {
    assetId, setAssetId, exchange, setExchange, variant,
    symbol, setSymbol, tf, setTf, candles, loading, errMsg,
    candleLoadExplanation, dataSrc, pricePrecision, asset,
    assetType, loadMoreHistory, loadingOlder, TIMEFRAMES: TF_LIST} = chartData;
  // FIX H-2: liveCandleInfo removed — rendered by LiveCandleCountdown component below

  // Stable memoized lookup of the LogicalAsset for the current assetId
  // Avoids running logicalAssets.find on every render
  const activeLogicalAsset = React.useMemo(
    () => logicalAssets.find((a: any) => a.id === assetId) ?? null,
    [logicalAssets, assetId]
  );

  // cp: throttled price selector — re-renders ChartScreen at most 2x/sec.
  // cpRef.current always has the latest price for prediction/order book reads.
  // Previously ChartScreen consumed `prices` directly from useData(), causing
  // a re-render on every aggTrade tick (50-200ms) — 5-20 renders/second.
  const { cp, cpRef } = usePriceSelector(symbol);

  const indicators = useChartIndicators(candles);
  const {
    geoPatterns, validatedPatterns, candlePatterns, msSnapshot, msStr, smcSnap, fvgSnap, fvgBull, fvgBear,
    vwapSnap, vpSnap, mtfSnap, mtfSignals, regimeSnap, techSummary} = indicators ?? {};

  const prediction = usePrediction(symbol, tf, candles, assetType);

  // Pattern Outcome Monitor — per new candle, updates TP/SL/expiry state.
  usePatternOutcomeMonitor(symbol, tf, candles, validatedPatterns ?? EMPTY_VALIDATED_PATTERNS);
  const { ml, retrainDecision, postPredictionMsg, runMLPrediction, tradeQualityResult, onCandleClose } = prediction;
  // Wire prediction's onCandleClose into the stable ref used by useChartData
  onCandleCloseRef.current = onCandleClose;

  const overlays = useChartOverlays(symbol, tf, candles, ml.data, tradeQualityResult, assetType, regimeSnap ?? null, reviewTrade);
  const live     = useLiveTrading(asset, aoSession, navigation);

  // Compute readiness for PredictionCard signal hierarchy — same inputs as MarketStructureCard.
  // computeTradeReadiness is a pure translator: reads engine outputs, no new logic.
  const chartReadiness = React.useMemo(() => {
    // Return null only when no prediction — never null after mlStatus=done
    // so the CTA button renders without waiting for MTF/regime snapshots.
    if (!ml.data) return null;
    // If MTF/regime not yet computed, use a lightweight fallback that still
    // renders the button. The full readiness replaces it in the next frame.
    // NOTE: mtfSnap is permanently null on 1D timeframe (TF_ORDER tops out at '1d',
    // no higher TF available). Without this fallback the CTA shows an infinite spinner
    // on 1D charts. We pass null snaps — computeTradeReadiness handles them gracefully.
    const topPat = (validatedPatterns ?? EMPTY_VALIDATED_PATTERNS)
      .filter(vp => vp.status !== 'FAILED' && vp.status !== 'EXPIRED' && vp.confidence >= 40)
      .sort((a: any, b: any) => b.confidence - a.confidence)[0] ?? null;
    return computeTradeReadiness({
      prediction: ml.data,
      mtfSnap:    mtfSnap ?? null,
      mtfSignals: mtfSignals ?? EMPTY_MTF_SIGNALS,
      regimeSnap: regimeSnap ?? null,
      baseTF: tf as any,
      smcSnap: smcSnap ?? null,
      topPattern: topPat ? { direction: topPat.direction, confidence: topPat.confidence } : null,
      strategyProfile: activeStrategyProfile ?? null});
  }, [ml.data, mtfSnap, regimeSnap, tf, smcSnap, validatedPatterns, mtfSignals, activeStrategyProfile]);
  const {
    openPosition, autoOpenResult, setAutoOpenResult,
    handlePaperTrade, chartTradeLevels, chartMarkers, chartLivePrediction,
    showMA, setShowMA, showVP, setShowVP, overlayToggles, toggleOverlay,
    showQualityBreakdown, setShowQualityBreakdown,
    showConfidenceBreakdown, setShowConfidenceBreakdown} = overlays;

  // ── Local state: Training Summary (screen-level only) ────────────────────
  const [trainingSummary, setTrainingSummary] = useState<TrainingStatusInfo | null>(null);
  const [showTrainingSummary, setShowTrainingSummary] = useState(false);

  // Handle route param change (new symbol or new assetId/exchange from Markets)
  useEffect(() => {
    const newSym     = route?.params?.symbol;
    const newAssetId = route?.params?.assetId;
    const newExchange = route?.params?.exchange ?? '';
    const newTf      = route?.params?.initialTf;

    // Priority 1: assetId+exchange navigation (from Markets with LogicalAsset)
    if (newAssetId && (newAssetId !== assetId || newExchange !== exchange)) {
      setAssetId(newAssetId);
      setExchange(newExchange);
      setReviewTrade(null);
    }
    // Priority 2: legacy symbol navigation (from Search, Journal, Alerts)
    else if (newSym && newSym !== symbol) {
      setSymbol(newSym);
      setReviewTrade(null);
    }
    if (newTf && newTf !== tf) setTf(newTf);
    if (route?.params?.reviewTrade !== undefined) setReviewTrade(route.params.reviewTrade);
  // _ts is a timestamp added by MarketsScreen to force this effect to fire
  // even when assetId/exchange are unchanged (same symbol tapped twice, or
  // tab navigator serving stale params from a previous visit).
  }, [route?.params?.assetId, route?.params?.exchange, route?.params?.symbol,
      route?.params?.initialTf, route?.params?.reviewTrade, route?.params?._ts]);

  // Load training summary for training history card
  useEffect(() => {
    getLatestTrainingStatus(symbol, tf).then(setTrainingSummary).catch(() => {});
  }, [symbol, tf, ml.data]);

  // Per-symbol analysis history for continuity across Analyze calls
  const priorAnalysisRef = React.useRef<Record<string, import('../api/claude').AIAnalysis>>({});

  // ── AI Copilot analysis ────────────────────────────────────────────────────
  const runAnalysis = useCallback(async () => {
    if (!candles.length) return;
    setAi({ status: 'loading', data: null, err: null });
    await Promise.resolve();
    try {
      const last  = candles[candles.length - 1];
      const l30   = candles.slice(-30);
      const ma20v = calcMA(candles, 20)[candles.length - 1];
      const ma50v = calcMA(candles, 50)[candles.length - 1];
      const p5    = candles[candles.length - 6]?.close;
      const ch5   = p5 ? (((last.close - p5) / p5) * 100).toFixed(3) : '0';
      const rsi   = calcRSI(candles);
      const atrRaw = candles.slice(-15).reduce((s: number, c: any, i: number) => i === 0 ? s : s + Math.abs(c.high - c.low), 0) / 14;
      const ohlc  = l30.map(c => `O:${pFmt(c.open)} H:${pFmt(c.high)} L:${pFmt(c.low)} C:${pFmt(c.close)} V:${(c.volume / 1000).toFixed(0)}K`).join('\n');
      const { poc } = calcVolumeProfile(candles, 28);
      const depth = cpRef.current?.depth;
      let depthLine = '';
      let depthDetailLines = '';
      if (depth) {
        const buyQ  = depth.buy.reduce((s: number, d: any) => s + d.qty, 0);
        const sellQ = depth.sell.reduce((s: number, d: any) => s + d.qty, 0);
        const total = buyQ + sellQ || 1;
        const spread = depth.sell[0]?.price && depth.buy[0]?.price ? (depth.sell[0].price - depth.buy[0].price).toFixed(4) : 'n/a';
        depthLine = `ORDER BOOK: Buy ${((buyQ / total) * 100).toFixed(0)}% / Sell ${((sellQ / total) * 100).toFixed(0)}% | Best Bid:${depth.buy[0]?.price ?? 'n/a'} | Best Ask:${depth.sell[0]?.price ?? 'n/a'} | Spread:${spread}`;
        const bidRows = depth.buy.slice(0, 5).map((d: any) => `  BID ${pFmt(d.price)} x ${d.qty.toFixed(3)}`).join('\n');
        const askRows = depth.sell.slice(0, 5).map((d: any) => `  ASK ${pFmt(d.price)} x ${d.qty.toFixed(3)}`).join('\n');
        depthDetailLines = `ORDER BOOK DEPTH (top 5):\n${bidRows}\n${askRows}`;
      }
      let mlLine = '';
      if (ml.status === 'done' && ml.data) {
        const d = ml.data;
        // Single computeConfidence() call — result reused for overall, grade,
        // breakdown, and weakest dims. Previously called twice with identical
        // arguments (regression introduced when confidence breakdown was added).
        let overallConf: number | null = null;
        let breakdownLine = '';
        let weakestLine   = '';
        let confGrade     = '';
        try {
          if (msStr && smcSnap && fvgSnap && vwapSnap && vpSnap && mtfSnap && regimeSnap) {
            const conf = computeConfidence(
              d.confidenceBreakdown, d.ensembleProbUp, (d.direction ?? (d.action === 'BUY' ? 'UP' : d.action === 'SELL' ? 'DOWN' : 'NEUTRAL')), d.ensembleAgree,
              d.walkForwardAccuracy, d.riskScore,
              msStr, candles.length - 1, smcSnap, fvgSnap, vwapSnap, vpSnap, mtfSnap, regimeSnap,
              null,
            );
            overallConf = conf.overall;
            confGrade   = conf.grade;
            const dim = conf.dimensions;
            const fmt = (v: number) => v.toFixed(0);
            breakdownLine =
              `\n  Confidence Breakdown (all 0-100):`
              + `\n    ML Model:           ${fmt(dim.mlModel)}%`
              + `\n    Trend:              ${fmt(dim.trend)}%`
              + `\n    Market Structure:   ${fmt(dim.structure)}%`
              + `\n    Smart Money (SMC):  ${fmt(dim.smc)}%`
              + `\n    Fair Value Gaps:    ${fmt(dim.fvg)}%`
              + `\n    Volume/VWAP:        ${fmt(dim.volume)}%`
              + `\n    Multi-Timeframe:    ${fmt(dim.mtf)}%`
              + `\n    Regime:             ${fmt(dim.regime)}%`
              + `\n    Pattern Validation: ${fmt((dim as any).patternValidation ?? 0)}%`;
            const dimMap: [string, number][] = [
              ['ML Model', dim.mlModel], ['Trend', dim.trend],
              ['Market Structure', dim.structure], ['Smart Money', dim.smc],
              ['Fair Value Gaps', dim.fvg], ['Volume/VWAP', dim.volume],
              ['Multi-Timeframe', dim.mtf], ['Regime', dim.regime],
              ['Pattern Validation', (dim as any).patternValidation ?? 0],
            ];
            const weak = dimMap.filter(([, v]) => v < 25).sort((a, b) => a[1] - b[1]);
            if (weak.length)
              weakestLine = `\n  Weakest dimensions dragging down confidence: `
                + weak.map(([n, v]) => `${n} (${v.toFixed(0)}%)`).join(', ') + '.';
          }
        } catch {}
        const mlConf    = d.confidence;
        const finalConf = overallConf ?? mlConf;
        const delta     = Math.abs(finalConf - mlConf);
        const diverged  = delta >= 8;
        mlLine = `ML Signal: ${d.action} | Direction P(up): ${(d.ensembleProbUp * 100).toFixed(1)}%`
          + `\n  Overall Confidence (Final Quantis Consensus): ${finalConf.toFixed(0)}%${confGrade ? ' (Grade ' + confGrade + ')' : ''}`
          + `\n  ML Confidence (AI Model Only): ${mlConf.toFixed(0)}%`
          + breakdownLine
          + weakestLine
          + (diverged
            ? `\n  Note: Overall and ML confidence differ by ${delta.toFixed(0)} points.`
              + ` The ML model sees ${mlConf > finalConf ? 'more' : 'less'} signal than the`
              + ` full engine consensus. Overall Confidence is the primary trading metric.`
            : '');
      };
      const recentNews = news.slice(0, 5).map((n: any) => `[${n.t}] ${n.txt} (${n.imp})`).join('\n');
      const high30 = Math.max(...l30.map((x: any) => x.high));
      const low30  = Math.min(...l30.map((x: any) => x.low));
      // Prior analysis for continuity
      const priorKey  = `${symbol}/${tf}`;
      const priorData = priorAnalysisRef.current[priorKey];
      const priorAnalysis = priorData
        ? `Prior call: ${priorData.tradeType} @ entry:${pFmt(priorData.entry ?? 0)} SL:${pFmt(priorData.stopLoss ?? 0)} TP1:${pFmt(priorData.target1 ?? 0)} confidence:${priorData.confidence}% | ${priorData.executiveSummary?.slice(0, 100)}`
        : undefined;
      const prompt = buildAnalysisPrompt({
        assetName:  asset?.name ?? symbol,
        symbol,
        type:       asset?.type ?? 'crypto',
        tf,
        srcLabel:   asset?.src  ?? 'binance',
        price:      last.close,
        ch5, atr: atrRaw,
        rsi:        rsi?.[rsi.length - 1] ?? 50,
        ma20:       ma20v ?? null,
        ma50:       ma50v ?? null,
        high10:     high30, low10: low30,
        ohlc, recentNews,
        pocLine:       poc ? `VOLUME POC: ${poc.price?.toFixed?.(2)} (highest volume price)` : undefined,
        obLine:        depthLine || undefined,
        obDepthLines:  depthDetailLines || undefined,
        mlLine:        mlLine || undefined,
        priorAnalysis,
      });
      const data = await analyzeWithClaude(prompt, anthropicKey);
      priorAnalysisRef.current[priorKey] = data;
      setAi({ status: 'done', data, err: null });
    } catch (e: any) { setAi({ status: 'error', data: null, err: e.message ?? 'Analysis failed' }); }
  // FIX H-3: `candles` in deps caused runAnalysis to rebuild on every kline update
  // (throttled to 1s), which gave AICopilotPanel a new onAnalyze prop every second,
  // defeating its React.memo entirely. `ml` (whole object) rebuilt on every prediction
  // status change even though only ml.status and ml.data are actually read inside.
  // candles.length is a stable primitive that only changes when a candle is added/closed.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles.length, symbol, tf, asset, ml.status, ml.data, news, anthropicKey]);

  // ── Derived display values ─────────────────────────────────────────────────
  // Use last candle's open vs close for color — matches the chart candle color exactly
  const lastCandle     = candles.length > 0 ? candles[candles.length - 1] : null;
  const liveCandleClose = lastCandle?.close ?? cp?.price ?? 0;
  const isPos      = lastCandle
    ? liveCandleClose >= lastCandle.open   // green if close >= open (same as chart candle)
    : (cp?.chg || 0) >= 0;
  const priceColor = isPos ? T.green : T.red;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      <ScrollView
        ref={scrollRef}
        scrollEventThrottle={16}
        removeClippedSubviews={true}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 16, paddingTop: 12, paddingBottom: 40 }}>

        {/* ── Exchange selector — TradingView-style exchange switcher ─── */}
        {activeLogicalAsset && Object.keys(activeLogicalAsset.exchanges).length > 1 && (
          <ExchangeSelector
            asset={activeLogicalAsset}
            currentExchange={exchange || activeLogicalAsset.defaultExchange}
            T={T}
            onSelect={(newExchange: string) => {
              setExchange(newExchange); // instant — don't await
              updateExchangePreference(activeLogicalAsset.name, newExchange); // persist in background
            }}
          />
        )}
        {/* ── Header: symbol selector + price card ─────────────────────── */}
        <ChartHeader
          symbol={symbol} asset={asset} allAssets={allAssets}
          dataSrc={dataSrc} cp={cp} priceColor={priceColor} isPos={isPos}
          livePrice={candles.length > 0 ? candles[candles.length - 1].close : undefined}
          onSymbol={onSymbolChange}
          onSearch={onSearch}
          T={T}
        />

        {/* ── PAPER / LIVE trading mode toggle ─────────────────────────── */}
        {/* Only shown for AO and Binance assets — not for forex/AV */}
        {/* FIX: added 'ao_futures' — NFO futures use Angel One and support Paper/Live mode */}
        {(asset?.src === 'ao' || asset?.src === 'ao_futures' ||
           asset?.src === 'binance' || asset?.src === 'binance_futures' ||
           asset?.src === 'coindcx' || asset?.src === 'coindcx_futures') && (
          <View style={{ flexDirection: 'row', alignItems: 'center',
            paddingHorizontal: 12, paddingVertical: 6,
            backgroundColor: live.isLiveMode ? T.red + '10' : T.bg2 ?? T.bg3,
            borderBottomWidth: 0.5, borderBottomColor: T.border }}>
            <View style={{ flexDirection: 'row', flex: 1, gap: 6 }}>
              {(['PAPER', 'LIVE'] as const).map(mode => (
                <Pressable
                  key={mode}
                  hitSlop={6}
                  android_ripple={{color:'rgba(255,255,255,0.15)'}}
                  onPress={() => {
                    if (mode === 'LIVE') {
                      const err = live.validateLiveReady();
                      if (err) { Alert.alert('Live Trading', err); return; }
                    }
                    live.setTradingMode(mode);
                  }}
                  style={{
                    paddingHorizontal: 12, paddingVertical: 4, borderRadius: 5,
                    backgroundColor: live.tradingMode === mode
                      ? (mode === 'LIVE' ? T.red : T.accent)
                      : T.bg3,
                    borderWidth: 1,
                    borderColor: live.tradingMode === mode
                      ? (mode === 'LIVE' ? T.red : T.accent)
                      : T.border}}>
                  <Text style={{
                    color: live.tradingMode === mode ? '#fff' : T.textDim,
                    fontSize: 10, fontWeight: '700'}}>
                    {mode === 'LIVE' ? '● LIVE' : '○ PAPER'}
                  </Text>
                </Pressable>
              ))}
            </View>
            {live.isLiveMode && (
              <Text style={{ color: T.red, fontSize: 9, fontWeight: '700' }}>
                REAL MONEY
              </Text>
            )}
          </View>
        )}

        {/* ── Toolbar: timeframe tabs + overlay toggles ─────────────────── */}
        <ChartToolbar
          tf={tf} setTf={setTf}
          showMA={showMA} setShowMA={setShowMA}
          showVP={showVP} setShowVP={setShowVP}
          overlayToggles={overlayToggles} toggleOverlay={toggleOverlay}
          T={T}
        />

        {/* ── Chart ────────────────────────────────────────────────────── */}
        {loading ? (
          <View style={{ height: 320, justifyContent: 'center', padding: SPACING.lg, backgroundColor: T.card, borderRadius: RADIUS.lg, borderWidth: 1, borderColor: T.cardBorder }}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 6, height: 160, marginBottom: 16 }}>
              {[40, 80, 55, 100, 70, 90, 60, 110, 75, 95].map((h, i) => (
                <View key={i} style={{ flex: 1, height: h, backgroundColor: T.bg3, borderRadius: 2, opacity: 0.4 + i * 0.06 }} />
              ))}
            </View>
            <Skeleton width="60%" height={12} theme={T} />
          </View>
        ) : (
          <View>
          {/* ── Trade Review Banner ─────────────────────────────────────────── */}
          {/* Shown when navigated from PaperJournalScreen with a completed trade. */}
          {/* Static — never updates after trade close. Dismiss to return to live. */}
          {reviewTrade && (() => {
            const rt = reviewTrade as any;
            const pnlPct = rt.pnlPct ?? 0;
            const isProfit = rt.pnl > 0;
            const predCol = rt.predictionResult === 'CORRECT' ? T.green
                          : rt.predictionResult === 'INCORRECT' ? T.red : T.textDim;
            const predLabel = rt.predictionResult === 'CORRECT' ? '✅ Correct'
                            : rt.predictionResult === 'INCORRECT' ? '❌ Incorrect' : '➖ Neutral';
            const mgmtOutcome = rt.tradeManagementOutcome ?? null;
            const mgmtLabel = mgmtOutcome
              ? managementOutcomeLabel(mgmtOutcome)
              : rt.exitReason === 'STOP_LOSS' ? '🛑 Stop Loss'
              : rt.exitReason === 'TAKE_PROFIT' ? '✅ Take Profit'
              : rt.exitReason === 'MANUAL_EXIT' || rt.exitReason === 'MANUAL_CLOSE' ? '🤚 Manual Close'
              : rt.exitReason === 'TIME_EXIT' ? '⏱ Time Exit'
              : '🤖 AI Exit';

            return (
              <View style={{
                backgroundColor: T.bg2,
                borderRadius: RADIUS.md,
                borderWidth: 1,
                borderColor: isProfit ? (T.green + '50') : (T.red + '50'),
                marginBottom: 8,
                overflow: 'hidden'}}>
                {/* Header row: symbol + strategy + dismiss */}
                <View style={{
                  flexDirection: 'row', alignItems: 'center',
                  justifyContent: 'space-between',
                  backgroundColor: T.bg3,
                  paddingHorizontal: 12, paddingVertical: 8,
                  borderBottomWidth: 1, borderBottomColor: T.border}}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Text style={{ color: T.textDim, fontSize: 8, fontWeight: '700',
                      letterSpacing: 0.5, backgroundColor: T.bg0,
                      paddingHorizontal: 5, paddingVertical: 2, borderRadius: 4 }}>
                      TRADE REVIEW
                    </Text>
                    <Text style={{ color: T.text, fontSize: 13, fontWeight: '800' }}>
                      {rt.symbol}
                    </Text>
                    {rt.strategyId && (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3,
                        backgroundColor: T.bg0, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 2 }}>
                        <Text style={{ fontSize: 10 }}>{rt.strategyIcon ?? '⚙️'}</Text>
                        <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '600' }}>
                          {rt.strategyName ?? rt.strategyId}
                        </Text>
                      </View>
                    )}
                  </View>
                  {/* Dismiss — clears review, returns to live chart */}
                  <Pressable
                    hitSlop={8}
                    onPress={() => setReviewTrade(null)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    style={{ backgroundColor: T.bg0, borderRadius: 12,
                      width: 24, height: 24, alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={{ color: T.textDim, fontSize: 13, lineHeight: 16 }}>✕</Text>
                  </Pressable>
                </View>

                {/* Body: two columns */}
                <View style={{ flexDirection: 'row', padding: 10, gap: 12 }}>
                  {/* Left column: trade metrics */}
                  <View style={{ flex: 1, gap: 4 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                      <View style={{ backgroundColor: (rt.direction === 'LONG' ? T.green : T.red) + '22',
                        borderRadius: 4, paddingHorizontal: 5, paddingVertical: 2 }}>
                        <Text style={{ color: rt.direction === 'LONG' ? T.green : T.red,
                          fontSize: 9, fontWeight: '800' }}>
                          {rt.direction === 'LONG' ? '▲ BUY' : '▼ SELL'}
                        </Text>
                      </View>
                      <Text style={{ color: isProfit ? T.green : T.red,
                        fontSize: 13, fontWeight: '800' }}>
                        {rt.pnl >= 0 ? '+' : ''}{pFmt(rt.pnl)}
                        {'  '}
                        <Text style={{ fontSize: 10 }}>
                          ({pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%)
                        </Text>
                      </Text>
                    </View>
                    <View style={{ gap: 2 }}>
                      <Text style={{ color: T.textDim, fontSize: 9 }}>
                        Entry{' '}<Text style={{ color: T.text, fontWeight: '700' }}>
                          {pFmt(rt.entryPrice)}
                        </Text>
                      </Text>
                      <Text style={{ color: T.textDim, fontSize: 9 }}>
                        Exit{' '}<Text style={{ color: isProfit ? T.green : T.red, fontWeight: '700' }}>
                          {pFmt(rt.exitPrice)}
                        </Text>
                      </Text>
                      {rt.reviewLevels?.stopLoss > 0 && (
                        <Text style={{ color: T.textDim, fontSize: 9 }}>
                          SL{' '}<Text style={{ color: T.red, fontWeight: '600' }}>
                            {pFmt(rt.reviewLevels.stopLoss)}
                          </Text>
                          {'  '}
                          TP{' '}<Text style={{ color: T.green, fontWeight: '600' }}>
                            {pFmt(rt.reviewLevels.takeProfit)}
                          </Text>
                        </Text>
                      )}
                    </View>
                  </View>

                  {/* Right column: prediction + management */}
                  <View style={{ flex: 1, gap: 4, alignItems: 'flex-end' }}>
                    <View style={{ alignItems: 'flex-end', gap: 3 }}>
                      <Text style={{ color: T.textDim, fontSize: 8, fontWeight: '700',
                        letterSpacing: 0.4 }}>PREDICTION</Text>
                      <View style={{ backgroundColor: predCol + '20', borderRadius: 4,
                        paddingHorizontal: 6, paddingVertical: 2 }}>
                        <Text style={{ color: predCol, fontSize: 10, fontWeight: '800' }}>
                          {predLabel}
                        </Text>
                      </View>
                    </View>
                    <View style={{ alignItems: 'flex-end', gap: 3 }}>
                      <Text style={{ color: T.textDim, fontSize: 8, fontWeight: '700',
                        letterSpacing: 0.4 }}>MANAGEMENT</Text>
                      <View style={{ backgroundColor: T.bg0, borderRadius: 4,
                        paddingHorizontal: 6, paddingVertical: 2 }}>
                        <Text style={{ color: T.text, fontSize: 10, fontWeight: '700' }}>
                          {mgmtLabel}
                        </Text>
                      </View>
                    </View>
                    <Text style={{ color: T.textDim, fontSize: 8, textAlign: 'right',
                      lineHeight: 12, marginTop: 2 }}>
                      {new Date(rt.entryTime).toLocaleDateString()}{' · '}
                      {rt.holdingMs < 60000
                        ? `${Math.round(rt.holdingMs / 1000)}s held`
                        : rt.holdingMs < 3600000
                          ? `${(rt.holdingMs / 60000).toFixed(0)}m held`
                          : `${(rt.holdingMs / 3600000).toFixed(1)}h held`}
                    </Text>
                  </View>
                </View>

                {/* Deterministic observations — derived only from stored trade fields */}
                {(() => {
                  const observations = generateObservations(rt);
                  if (!observations.length) return null;
                  return (
                    <View style={{
                      borderTopWidth: 1, borderTopColor: T.border,
                      paddingTop: 8, paddingHorizontal: 10, paddingBottom: 10}}>
                      <Text style={{ color: T.textDim, fontSize: 8, fontWeight: '700',
                        letterSpacing: 0.5, marginBottom: 5 }}>OBSERVATIONS</Text>
                      {observations.map((obs, i) => (
                        <View key={i} style={{ flexDirection: 'row', gap: 6, marginBottom: 3 }}>
                          <Text style={{ color: T.textDim, fontSize: 9, lineHeight: 14, marginTop: 1 }}>•</Text>
                          <Text style={{ color: T.textSub ?? T.textDim, fontSize: 9,
                            lineHeight: 14, flex: 1 }}>{obs}</Text>
                        </View>
                      ))}
                    </View>
                  );
                })()}
              </View>
            );
          })()}

          <View
            pointerEvents={E2_CHART_INERT ? 'none' : 'auto'}
            onTouchStart={onChartTouchStart}
            onTouchEnd={onChartTouchEnd}
            onTouchCancel={onChartTouchEnd}>
            <CandlestickChart
              data={candles} theme={T} showMA={showMA} showVP={showVP}
              height={Math.round(screenHeight * 0.52)}
              onRequestOlderData={loadMoreHistory} loadingOlder={loadingOlder}
              tradeLevels={reviewTrade ? overlays.reviewTradeLevels : chartTradeLevels} markers={reviewTrade ? overlays.reviewMarkers : chartMarkers}
              livePrediction={chartLivePrediction} overlays={overlayToggles}
              pricePrecision={pricePrecision}
              geoPatterns={geoPatterns ?? null}
              livePrice={cp?.price}
              onChartTouchStart={onChartTouchStart}
              onChartTouchEnd={onChartTouchEnd}
            />
          </View>
        </View>
        )}

        {/* ── Live candle info bar ─────────────────────────────────────────── */}
        {/* FIX H-2: LiveCandleCountdown owns its own 1s timer — only this tiny
            component re-renders per second, not all of ChartScreen. */}
        <LiveCandleCountdown
          lastCandle={candles.length > 0 ? candles[candles.length - 1] : null}
          tf={tf}
          T={T}
        />

        {/* ── Error / no-data ───────────────────────────────────────────── */}
        {!loading && errMsg ? (
          <View style={{ backgroundColor: T.red + '15', padding: 12, borderRadius: RADIUS.md, marginTop: 12 }}>
            <Text style={{ color: T.red, fontSize: 12 }}>{errMsg}</Text>
            {/* Show retry button when NFO token fetch failed or is stuck loading */}
            {asset?.src === 'ao_futures' && aoSession?.jwtToken ? (
              <Pressable
                hitSlop={8}
                android_ripple={{color:'rgba(255,255,255,0.15)'}}
                onPress={retryNFOTokens}
                style={{ marginTop: 10, alignSelf: 'flex-start', backgroundColor: T.accent + '22',
                         borderRadius: 8, paddingHorizontal: 14, paddingVertical: 7,
                         borderWidth: 1, borderColor: T.accent + '55' }}>
                <Text style={{ color: T.accent, fontSize: 12, fontWeight: '700' }}>↻ Retry Loading Token</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {/* ── Technical Indicators ─────────────────────────────────────── */}
        {!loading && techSummary && <IndicatorPanel techSummary={techSummary} T={T} />}

        {/* ── Market Structure / SMC / FVG / VWAP / MTF / Regime ───────── */}
        {!loading && candles.length > 0 && (
          <MarketStructureCard
            candles={candles} msSnapshot={msSnapshot ?? null}
            smcSnap={smcSnap ?? null} fvgSnap={fvgSnap ?? null}
            fvgBull={fvgBull ?? EMPTY_FVG} fvgBear={fvgBear ?? EMPTY_FVG}
            vwapSnap={vwapSnap ?? null} vpSnap={vpSnap ?? null}
            mtfSnap={mtfSnap ?? null} mtfSignals={mtfSignals ?? EMPTY_MTF_SIGNALS}
            regimeSnap={regimeSnap ?? null}
            strategyProfile={activeStrategyProfile ?? null}
            geoPatterns={geoPatterns ?? null}
            validatedPatterns={validatedPatterns ?? EMPTY_VALIDATED_PATTERNS}
            candlePatterns={candlePatterns ?? EMPTY_CANDLE_PATTERNS}
            prediction={ml.data}
            baseTF={tf}
            pricePrecision={pricePrecision}
            T={T}
          />
        )}

        {/* ── Order Book ────────────────────────────────────────────────── */}
        {/* FIX: added 'ao_futures' — NFO futures have live depth data via Angel One */}
        {(asset.src === 'ao' || asset.src === 'ao_futures' || asset.src === 'binance') && (
          <Card theme={T} style={{ marginTop: 14 }}>
            <SectionLabel theme={T}>ORDER BOOK · LIVE DEPTH</SectionLabel>
            <OrderBookCard
              snapshot={cp?.depth ? { source: asset.src as 'ao'|'binance', symbol, buy: cp.depth.buy, sell: cp.depth.sell, timestamp: cp.lastUpdated ?? Date.now() } : null}
              unavailableReason={
                asset.type === 'INDEX' ? `${asset.name} is an index — no order book.`
                : (asset.src === 'ao' || asset.src === 'ao_futures') && !aoSession?.jwtToken ? 'Connect Angel One in Settings.'
                : null
              }
              pricePrecision={pricePrecision}
              theme={T}
            />
          </Card>
        )}

        {/* ── AO session expiry warning ─────────────────────────────────── */}
        <SessionExpiredBanner />

        {/* ── Signal Engine (Prediction Card) — hidden during trade review ── */}
        {!reviewTrade && (
          <PredictionCard
            symbol={symbol} tf={tf} candlesLength={candles.length}
            mlStatus={ml.status} mlData={ml.data} mlErr={ml.err}
            tradeQualityResult={tradeQualityResult}
            validatedPatterns={validatedPatterns ?? null}
            retrainDecision={retrainDecision}
            postPredictionMsg={postPredictionMsg}
            showQualityBreakdown={showQualityBreakdown} setShowQualityBreakdown={setShowQualityBreakdown}
            showConfidenceBreakdown={showConfidenceBreakdown} setShowConfidenceBreakdown={setShowConfidenceBreakdown}
            msStr={msStr ?? null} smcSnap={smcSnap ?? null} fvgSnap={fvgSnap ?? null}
            vwapSnap={vwapSnap ?? null} vpSnap={vpSnap ?? null}
            mtfSnap={mtfSnap ?? null} regimeSnap={regimeSnap ?? null}
            onRunPrediction={runMLPrediction} onPaperTrade={handlePaperTrade}
            readiness={chartReadiness}
            isLiveMode={live.isLiveMode}
            onLiveTrade={live.handleLiveTrade}
            hasOpenPosition={!!openPosition}
            T={T}
          />
        )}

        {/* ── AI Copilot — hidden during trade review ───────────────────── */}
        {!reviewTrade && (
          <AICopilotPanel
            ai={ai} assetName={asset.name} symbol={symbol}
            anthropicKey={anthropicKey} loading={loading}
            onAnalyze={runAnalysis}
            onNavigateChat={sym => navigation.navigate('AIChat', {
              symbol: sym,
              asset,
              tf,
              // Full ML signal + memory engine result
              mlSignal: ml.data ? {
                action:              ml.data.action,
                direction:           ml.data.direction,
                ensembleProbUp:      ml.data.ensembleProbUp,
                confidence:          ml.data.confidence,
                walkForwardAccuracy: ml.data.walkForwardAccuracy,
                topFeatures:         ml.data.topFeatures?.slice(0, 6) ?? [],
                memoryResult:        ml.data.memoryResult ?? null,
                suggestedEntry:      ml.data.suggestedEntry,
                suggestedStopLoss:   ml.data.suggestedStopLoss,
                suggestedTakeProfit: ml.data.suggestedTakeProfit,
              } : null,
              // Volume profile
              vpSnap: vpSnap ? {
                poc: vpSnap.poc, vah: vpSnap.vah, val: vpSnap.val,
                sessionVwap: vwapSnap?.sessionVwap,
              } : null,
              // Market structure & regime
              regimeSnap: regimeSnap ? {
                label: regimeSnap.label, confidence: regimeSnap.confidence,
              } : null,
              // MTF alignment
              mtfSnap: mtfSnap ? {
                trend: mtfSnap.trend, alignment: mtfSnap.alignment,
              } : null,
              // Technical summary (ATR, RSI, MACD state etc.)
              techSummary: techSummary ? {
                atr: techSummary.atr, rsi: techSummary.rsi,
                bbPosition: techSummary.bbPosition, macdState: techSummary.macdState,
                trend: techSummary.trend,
              } : null,
              // Open positions on this symbol
              openPosition: overlays.openPosition ? {
                direction:  overlays.openPosition.direction,
                entryPrice: overlays.openPosition.entryPrice,
                stopLoss:   overlays.openPosition.stopLoss,
                takeProfit: overlays.openPosition.takeProfit,
                pnlPct:     overlays.openPosition.pnlPct,
              } : null,
            })}
            T={T}
          />
        )}

      </ScrollView>

      {/* ── Modals ────────────────────────────────────────────────────────── */}
      <TrainingSummaryModal
        visible={showTrainingSummary} status={trainingSummary}
        onClose={() => setShowTrainingSummary(false)} theme={T}
      />
      <ConfirmDialog
        visible={!!autoOpenResult}
        title={autoOpenResult?.title || ''}
        message={autoOpenResult?.reason}
        theme={T}
        onRequestClose={() => setAutoOpenResult(null)}
        actions={[{ label: 'OK', primary: true, onPress: () => setAutoOpenResult(null) }]}
      />
    </SafeAreaView>
  );
}
