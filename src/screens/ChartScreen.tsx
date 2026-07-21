// ─────────────────────────────────────────────────────────────────────────────
// ChartScreen  (v6.0.2 — orchestrator only)
//
// Responsibility: wire hooks → compose components → handle navigation.
// No business logic, no inline JSX calculations, no engine calls.
// All state lives in the four hooks. All display lives in components.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import { View, Text, TouchableOpacity, Alert, useWindowDimensions, RefreshControl } from 'react-native';
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
import { Candle, pFmt } from '../utils/indicators';
import { managementOutcomeLabel } from '../utils/predictionResult';
import { generateObservations } from '../utils/tradeObservations';
import { getPricePrecisionSync, getPricePrecision } from '../utils/pricePrecision';
import { logger } from '../utils/logger';
import { generateExplanation } from '../utils/aiExplanation';
import { getLatestTrainingStatus, TrainingStatusInfo } from '../utils/trainingHistory';
import { analyzeWithClaude, buildAnalysisPrompt, AIAnalysis } from '../api/claude';
import { calcMA, calcRSI, calcVolumeProfile } from '../utils/indicators';
import { getMarketStructureSnapshot } from '../utils/marketStructureSnapshot';
import { computeConfidence } from '../utils/confidence/confidenceEngine';
import { computeTradeReadiness } from '../utils/mtf/tradeReadiness';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { TrainingSummaryModal } from '../components/TrainingSummaryModal';
import { OrderBookCard } from '../components/OrderBookCard';
import CandlestickChart from '../components/chart/ChartAdapter';
import type { OverlayToggles } from '../components/chart/ChartAdapter';
import { Card, SectionLabel, Skeleton, Pill, GradientButton } from '../components/Common';
import { RADIUS, SPACING } from '../theme/colors';
import { trainAndPredict, MLPrediction, PRIMARY_HORIZON, FEATURE_NAMES } from '../utils/mlSignal';
import { getOptimalConfig } from '../utils/modelOptimization';
import { resolveOutcomes } from '../utils/predictionHistory';

// Hooks
import { useChartData }       from './chart/hooks/useChartData';
import { useChartIndicators } from './chart/hooks/useChartIndicators';
import { usePrediction }      from './chart/hooks/usePrediction';
import { useChartOverlays }   from './chart/hooks/useChartOverlays';
import { useLiveTrading }     from './chart/hooks/useLiveTrading';

// Components
import { ChartHeader }         from './chart/components/ChartHeader';
import { ChartToolbar }        from './chart/components/ChartToolbar';
import { IndicatorPanel }      from './chart/components/IndicatorPanel';
import { MarketStructureCard } from './chart/components/MarketStructureCard';
import { usePatternOutcomeMonitor } from '../utils/patternValidation/patternOutcomeMonitor';
import { PredictionCard } from './chart/components/PredictionCard';
import { SessionExpiredBanner } from '../components/SessionExpiredBanner';
import { AICopilotPanel }      from './chart/components/AICopilotPanel';
import { getActiveStrategyId } from '../utils/strategy/strategyStorage';
import { getProfile } from '../utils/strategy/strategyProfiles';

export default function ChartScreen({ route, navigation }: any) {
  const { height: screenHeight } = useWindowDimensions();
  if (__DEV__) console.count('ChartScreen render');
  const { theme: T } = useTheme();
  const { prices, aoSession, avKey, anthropicKey, news, allAssets } = useData();
  const initialSymbol = route?.params?.symbol || 'NIFTY50';
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
  const onBeforeLoad = useCallback(
    () => setAi({ status: 'idle', data: null, err: null }),
    [], // setAi is stable from useState — no deps needed
  );

  const chartData = useChartData(initialSymbol, { onBeforeLoad });
  const {
    symbol, setSymbol, tf, setTf, candles, loading, errMsg,
    candleLoadExplanation, dataSrc, pricePrecision, cp, asset,
    liveCandleInfo, assetType, loadMoreHistory, TIMEFRAMES: TF_LIST,
  } = chartData;

  const indicators = useChartIndicators(candles);
  const {
    geoPatterns, validatedPatterns, candlePatterns, msSnapshot, msStr, smcSnap, fvgSnap, fvgBull, fvgBear,
    vwapSnap, vpSnap, mtfSnap, mtfSignals, regimeSnap, techSummary,
  } = indicators ?? {};

  const prediction = usePrediction(symbol, tf, candles, assetType);

  // Pattern Outcome Monitor — per new candle, updates TP/SL/expiry state.
  usePatternOutcomeMonitor(symbol, tf, candles, validatedPatterns ?? []);
  const { ml, retrainDecision, postPredictionMsg, runMLPrediction, tradeQualityResult } = prediction;

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
    if (!mtfSnap || !regimeSnap) return null;
    const topPat = (validatedPatterns ?? [])
      .filter(vp => vp.status !== 'FAILED' && vp.status !== 'EXPIRED' && vp.confidence >= 40)
      .sort((a: any, b: any) => b.confidence - a.confidence)[0] ?? null;
    return computeTradeReadiness({
      prediction: ml.data,
      mtfSnap,
      mtfSignals: mtfSignals ?? [],
      regimeSnap,
      baseTF: tf as any,
      smcSnap: smcSnap ?? null,
      topPattern: topPat ? { direction: topPat.direction, confidence: topPat.confidence } : null,
      // Strategy profile: gates applied inside computeTradeReadiness AFTER engine
      // state is derived. This is the correct position in the flow:
      //   Predict → Confidence → Strategy Filters → Trade Readiness → UI
      strategyProfile: activeStrategyProfile ?? null,
    });
  }, [ml.data, mtfSnap, regimeSnap, tf, smcSnap, validatedPatterns, mtfSignals, activeStrategyProfile]);
  const {
    openPosition, autoOpenResult, setAutoOpenResult,
    handlePaperTrade, chartTradeLevels, chartMarkers, chartLivePrediction,
    showMA, setShowMA, showVP, setShowVP, overlayToggles, toggleOverlay,
    showQualityBreakdown, setShowQualityBreakdown,
    showConfidenceBreakdown, setShowConfidenceBreakdown,
  } = overlays;

  // ── Local state: Training Summary (screen-level only) ────────────────────
  const [trainingSummary, setTrainingSummary] = useState<TrainingStatusInfo | null>(null);
  const [showTrainingSummary, setShowTrainingSummary] = useState(false);



  // Handle route param change (new symbol from search)
  useEffect(() => {
    const newSym = route?.params?.symbol;
    const newTf  = route?.params?.initialTf;
    if (newSym && newSym !== symbol) setSymbol(newSym);
    if (newTf  && newTf  !== tf)     setTf(newTf);
    if (route?.params?.reviewTrade !== undefined) setReviewTrade(route.params.reviewTrade);
  }, [route?.params?.symbol, route?.params?.initialTf, route?.params?.reviewTrade]);

  // Load training summary for training history card
  useEffect(() => {
    getLatestTrainingStatus(symbol, tf).then(setTrainingSummary).catch(() => {});
  }, [symbol, tf, ml.data]);


  // ── AI Copilot analysis ────────────────────────────────────────────────────
  const runAnalysis = useCallback(async () => {
    if (!candles.length) return;
    setAi({ status: 'loading', data: null, err: null });
    // Yield to React so the skeleton paints THIS frame.
    // Without this, setState is queued but JS continues running the sync
    // work below — the spinner only appears at the first real await
    // (analyzeWithClaude), 15-80ms later depending on device speed.
    await Promise.resolve();
    try {
      const last  = candles[candles.length - 1];
      const l10   = candles.slice(-10);
      const ma20  = calcMA(candles, 20)[candles.length - 1];
      const ma50  = calcMA(candles, 50)[candles.length - 1];
      const p5    = candles[candles.length - 6]?.close;
      const ch5   = p5 ? (((last.close - p5) / p5) * 100).toFixed(3) : '0';
      const rsi   = calcRSI(candles);
      const ohlc  = l10.map(c => `O:${pFmt(c.open)} H:${pFmt(c.high)} L:${pFmt(c.low)} C:${pFmt(c.close)} V:${(c.volume / 1000).toFixed(0)}K`).join('\n');
      const { poc } = calcVolumeProfile(candles, 28);
      const depth = cp?.depth;
      let depthLine = '';
      if (depth) {
        const buyQ = depth.buy.reduce((s: number, d: any) => s + d.qty, 0);
        const sellQ = depth.sell.reduce((s: number, d: any) => s + d.qty, 0);
        const total = buyQ + sellQ || 1;
        depthLine = `Order Book: Buy ${((buyQ / total) * 100).toFixed(0)}% / Sell ${((sellQ / total) * 100).toFixed(0)}%`;
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
      const high10 = Math.max(...l10.map((x: any) => x.high));
      const low10  = Math.min(...l10.map((x: any) => x.low));
      const prompt = buildAnalysisPrompt({
        assetName:  asset?.name ?? symbol,
        symbol,
        type:       asset?.type ?? 'crypto',
        tf,
        srcLabel:   asset?.src  ?? 'binance',
        price:      last.close,
        ch5,
        rsi:        rsi?.[rsi.length - 1] ?? 50,
        ma20:       ma20 ?? null,
        ma50:       ma50 ?? null,
        high10,
        low10,
        ohlc,
        recentNews,
        pocLine:    poc ? `POC: ${poc.price?.toFixed?.(2)}` : undefined,
        obLine:     depthLine || undefined,
        mlLine:     mlLine   || undefined,
      });
      const data = await analyzeWithClaude(prompt, anthropicKey);
      setAi({ status: 'done', data, err: null });
    } catch (e: any) { setAi({ status: 'error', data: null, err: e.message ?? 'Analysis failed' }); }
  }, [candles, symbol, tf, asset, cp, ml, news, anthropicKey]);

  // ── Derived display values ─────────────────────────────────────────────────
  const isPos      = (cp?.chg || 0) >= 0;
  const priceColor = isPos ? T.green : T.red;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={{ padding: 16, paddingTop: 12, paddingBottom: 40 }}
        refreshControl={
          <RefreshControl refreshing={false} onRefresh={() => {}} tintColor={T.accent} />
        }>

        {/* ── Header: symbol selector + price card ─────────────────────── */}
        <ChartHeader
          symbol={symbol} asset={asset} allAssets={allAssets}
          dataSrc={dataSrc} cp={cp} priceColor={priceColor} isPos={isPos}
          onSymbol={setSymbol}
          onSearch={() => navigation.navigate('SymbolSearch', { returnTo: 'Chart' })}
          T={T}
        />

        {/* ── PAPER / LIVE trading mode toggle ─────────────────────────── */}
        {/* Only shown for AO and Binance assets — not for forex/AV */}
        {(asset?.src === 'ao' || asset?.src === 'binance') && (
          <View style={{ flexDirection: 'row', alignItems: 'center',
            paddingHorizontal: 12, paddingVertical: 6,
            backgroundColor: live.isLiveMode ? T.red + '10' : T.bg2 ?? T.bg3,
            borderBottomWidth: 0.5, borderBottomColor: T.border }}>
            <View style={{ flexDirection: 'row', flex: 1, gap: 6 }}>
              {(['PAPER', 'LIVE'] as const).map(mode => (
                <TouchableOpacity
                  key={mode}
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
                      : T.border,
                  }}>
                  <Text style={{
                    color: live.tradingMode === mode ? '#fff' : T.textDim,
                    fontSize: 10, fontWeight: '700',
                  }}>
                    {mode === 'LIVE' ? '● LIVE' : '○ PAPER'}
                  </Text>
                </TouchableOpacity>
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
                overflow: 'hidden',
              }}>
                {/* Header row: symbol + strategy + dismiss */}
                <View style={{
                  flexDirection: 'row', alignItems: 'center',
                  justifyContent: 'space-between',
                  backgroundColor: T.bg3,
                  paddingHorizontal: 12, paddingVertical: 8,
                  borderBottomWidth: 1, borderBottomColor: T.border,
                }}>
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
                  <TouchableOpacity
                    onPress={() => setReviewTrade(null)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    style={{ backgroundColor: T.bg0, borderRadius: 12,
                      width: 24, height: 24, alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={{ color: T.textDim, fontSize: 13, lineHeight: 16 }}>✕</Text>
                  </TouchableOpacity>
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
                      {(rt.holdingMs / 60000).toFixed(0)}m held
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
                      paddingTop: 8, paddingHorizontal: 10, paddingBottom: 10,
                    }}>
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
              onRequestOlderData={loadMoreHistory} loadingOlder={false}
              tradeLevels={reviewTrade ? overlays.reviewTradeLevels : chartTradeLevels} markers={reviewTrade ? overlays.reviewMarkers : chartMarkers}
              livePrediction={chartLivePrediction} overlays={overlayToggles}
              pricePrecision={pricePrecision}
              geoPatterns={geoPatterns ?? null}
              onChartTouchStart={onChartTouchStart}
              onChartTouchEnd={onChartTouchEnd}
            />
          </View>
        </View>
        )}

        {/* ── Live candle info bar ──────────────────────────────────────── */}
        {liveCandleInfo && (
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', backgroundColor: T.bg2, borderRadius: RADIUS.sm, padding: 10, marginTop: 8 }}>
            <Text style={{ color: T.textDim, fontSize: 10 }}>Live candle · closes in <Text style={{ color: T.text, fontWeight: '700' }}>{liveCandleInfo.countdownLabel}</Text></Text>
            <Text style={{ color: liveCandleInfo.changePct >= 0 ? T.green : T.red, fontSize: 10, fontWeight: '700' }}>
              {liveCandleInfo.changePct >= 0 ? '+' : ''}{liveCandleInfo.changePct.toFixed(2)}%
            </Text>
          </View>
        )}

        {/* ── Error / no-data ───────────────────────────────────────────── */}
        {!loading && errMsg ? (
          <View style={{ backgroundColor: T.red + '15', padding: 12, borderRadius: RADIUS.md, marginTop: 12 }}>
            <Text style={{ color: T.red, fontSize: 12 }}>{errMsg}</Text>
          </View>
        ) : null}

        {/* ── Technical Indicators ─────────────────────────────────────── */}
        {!loading && techSummary && <IndicatorPanel techSummary={techSummary} T={T} />}

        {/* ── Market Structure / SMC / FVG / VWAP / MTF / Regime ───────── */}
        {!loading && candles.length > 0 && (
          <MarketStructureCard
            candles={candles} msSnapshot={msSnapshot ?? null}
            smcSnap={smcSnap ?? null} fvgSnap={fvgSnap ?? null}
            fvgBull={fvgBull ?? []} fvgBear={fvgBear ?? []}
            vwapSnap={vwapSnap ?? null} vpSnap={vpSnap ?? null}
            mtfSnap={mtfSnap ?? null} mtfSignals={mtfSignals ?? []}
            regimeSnap={regimeSnap ?? null}
            strategyProfile={activeStrategyProfile ?? null}
            geoPatterns={geoPatterns ?? null}
            validatedPatterns={validatedPatterns ?? []}
            candlePatterns={candlePatterns ?? []}
            prediction={ml.data}
            baseTF={tf}
            pricePrecision={pricePrecision}
            T={T}
          />
        )}

        {/* ── Order Book ────────────────────────────────────────────────── */}
        {(asset.src === 'ao' || asset.src === 'binance') && (
          <Card theme={T} style={{ marginTop: 14 }}>
            <SectionLabel theme={T}>ORDER BOOK · LIVE DEPTH</SectionLabel>
            <OrderBookCard
              snapshot={cp?.depth ? { source: asset.src as 'ao'|'binance', symbol, buy: cp.depth.buy, sell: cp.depth.sell, timestamp: cp.lastUpdated ?? Date.now() } : null}
              unavailableReason={
                asset.type === 'INDEX' ? `${asset.name} is an index — no order book.`
                : asset.src === 'ao' && !aoSession?.jwtToken ? 'Connect Angel One in Settings.'
                : null
              }
              pricePrecision={pricePrecision}
              theme={T}
            />
          </Card>
        )}

        {/* ── AO session expiry warning ─────────────────────────────────── */}
        <SessionExpiredBanner />

        {/* ── Signal Engine (Prediction Card) ──────────────────────────── */}
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
          T={T}
        />

        {/* ── AI Copilot ────────────────────────────────────────────────── */}
        <AICopilotPanel
          ai={ai} assetName={asset.name} symbol={symbol}
          anthropicKey={anthropicKey} loading={loading}
          onAnalyze={runAnalysis}
          onNavigateChat={sym => navigation.navigate('AIChat', { symbol: sym })}
          T={T}
        />

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
