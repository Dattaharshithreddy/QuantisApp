// ─────────────────────────────────────────────────────────────────────────────
// useChartOverlays — chart marker/level computation + overlay toggles
// + paper trading state that feeds the chart directly
// ─────────────────────────────────────────────────────────────────────────────
import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { Candle } from '../../../utils/indicators';
import { MLPrediction } from '../../../utils/mlSignal';
import { getPortfolio, PaperPosition } from '../../../utils/paperPortfolio';
import { getPaperTrades, PaperTradeRecord } from '../../../utils/paperTradeJournal';
import { attemptOpenPosition } from '../../../utils/paperTradingEngine';
import { useTheme } from '../../../context/ThemeContext';

type TradeQualityResult = { quality: string } | null;

export function useChartOverlays(
  symbol: string,
  tf: string,
  candles: Candle[],
  mlData: MLPrediction | null,
  tradeQualityResult: TradeQualityResult,
  assetType: string = 'crypto',
  regimeSnap?: { label: string } | null,
  // Optional completed trade to review — renders static (non-updating) overlays
  reviewTrade?: import('../../../utils/paperTradeJournal').PaperTradeRecord | null,
) {
  const candlesRef = useRef<typeof candles>(candles);
  candlesRef.current = candles;

  const { theme: T } = useTheme();

  // Paper trade data
  const [openPosition, setOpenPosition] = useState<PaperPosition | null>(null);
  const [symbolTrades, setSymbolTrades] = useState<PaperTradeRecord[]>([]);
  const [autoOpenResult, setAutoOpenResult] = useState<{ title: string; reason: string } | null>(null);

  // Fix 4: mountedRef is set once and lives for the entire component lifetime.
  // It is shared between the useEffect path and the handlePaperTrade path,
  // so both are protected by the same single source of truth.
  // Pattern: mountedRef.current is false AFTER cleanup — safe across all paths.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const refreshTradeData = useCallback(async () => {
    const portfolio = await getPortfolio();
    if (!mountedRef.current) return;
    setOpenPosition(portfolio.openPositions.find(p => p.symbol === symbol) ?? null);
    const trades = await getPaperTrades();
    if (!mountedRef.current) return;
    setSymbolTrades(trades.filter(t => t.symbol === symbol && t.timeframe === tf));
  }, [symbol, tf]);

  useEffect(() => {
    refreshTradeData();
  }, [refreshTradeData]);

  const handlePaperTrade = useCallback(async (prediction: MLPrediction, bypassGates: boolean = false, mtfReadinessState?: 'READY' | 'WAIT' | 'AVOID' | null) => {
    const portfolio = await getPortfolio();
    const latestCandle = candlesRef.current[candlesRef.current.length - 1];
    const currentPrice = latestCandle ? latestCandle.close : prediction.suggestedEntry;
    const liveConf = (prediction as any)._liveOverallConfidence;
    const ctx = (prediction as any).marketContext ?? null;
    const result = await attemptOpenPosition(symbol, tf, prediction, currentPrice, candlesRef.current, assetType, liveConf, regimeSnap?.label, ctx, bypassGates, mtfReadinessState ?? null);
    // FIX: only surface autoOpenResult for non-override paths — override paths
    // handle their own success/failure modal in PredictionCard using the returned result.
    // For the READY button (bypassGates=false), we still use autoOpenResult as before.
    if (!bypassGates) {
      setAutoOpenResult({ title: result.opened ? 'Position Opened' : 'Not Opened', reason: result.reason });
    }
    if (result.opened) await refreshTradeData();
    // FIX A: return the result so PredictionCard can show correct success/failure
    // modals and only increment override analytics on confirmed executions.
    return result;
  }, [symbol, tf, refreshTradeData]);

  // Chart trade levels (SL/TP/Entry lines)
  const chartTradeLevels = useMemo(() => {
    if (!openPosition) return [];
    // Show which timeframe the position was opened on — helps when viewing across TFs
    const posTF = (openPosition as any).timeframe ?? tf;
    const tfTag = posTF !== tf ? ` (${posTF})` : '';
    return [
      { label: `Entry${tfTag}`, price: openPosition.entryPrice, color: T.blue },
      { label: `SL${tfTag}`,    price: openPosition.stopLoss,   color: T.red },
      { label: `TP${tfTag}`,    price: openPosition.takeProfit,  color: T.green },
    ];
  }, [openPosition, T, tf]);

  // Static review overlay — shown when a completed trade is selected from the journal.
  // These levels are FROZEN at the trade's close time and never update.
  // Active trade levels continue to update normally (separate useMemo above).
  const reviewTradeLevels = useMemo(() => {
    if (!reviewTrade) return [];
    const levels = [
      { label: 'Entry',  price: reviewTrade.entryPrice,                    color: T.blue,   dashed: false },
      { label: 'Exit',   price: reviewTrade.exitPrice,                     color: T.accent, dashed: false },
      { label: 'SL',     price: reviewTrade.reviewLevels?.stopLoss   ?? 0, color: T.red,    dashed: true  },
      { label: 'TP',     price: reviewTrade.reviewLevels?.takeProfit  ?? 0, color: T.green,  dashed: true  },
    ].filter(l => l.price > 0);
    return levels;
  }, [reviewTrade, T]);

  // Review markers — entry and exit markers for the reviewed trade
  const reviewMarkers = useMemo(() => {
    if (!reviewTrade || !candles.length) return [];
    const firstTime = candles[0].time;
    const result: any[] = [];
    if (reviewTrade.entryTime >= firstTime)
      result.push({ time: reviewTrade.entryTime, type: 'ENTRY', price: reviewTrade.entryPrice, label: 'Entry' });
    if (reviewTrade.exitTime >= firstTime) {
      const exitType = reviewTrade.tradeManagementOutcome === 'STOP_LOSS' ? 'SL_HIT'
                     : reviewTrade.tradeManagementOutcome === 'TAKE_PROFIT' ? 'TP_HIT'
                     : reviewTrade.exitReason === 'STOP_LOSS' ? 'SL_HIT'   // legacy
                     : reviewTrade.exitReason === 'TAKE_PROFIT' ? 'TP_HIT' // legacy
                     : 'EXIT';
      result.push({ time: reviewTrade.exitTime, type: exitType, price: reviewTrade.exitPrice, label: 'Exit' });
    }
    return result;
  }, [reviewTrade, candles]);

  // Chart markers (entry/exit/signal dots)
  const chartMarkers = useMemo(() => {
    if (!candles.length) return [];
    const firstTime = candles[0].time;
    const result: any[] = [];
    symbolTrades.forEach(t => {
      if (t.entryTime >= firstTime) result.push({ time: t.entryTime, type: 'ENTRY', price: t.entryPrice, label: 'Entry' });
      if (t.exitTime  >= firstTime) {
        const exitType = t.exitReason === 'STOP_LOSS' ? 'SL_HIT' : t.exitReason === 'TAKE_PROFIT' ? 'TP_HIT' : 'EXIT';
        result.push({ time: t.exitTime, type: exitType, price: t.exitPrice, label: exitType });
      }
    });
    if (openPosition && openPosition.entryTime >= firstTime)
      result.push({ time: openPosition.entryTime, type: 'ENTRY', price: openPosition.entryPrice, label: 'Entry' });
    if (mlData && mlData.action !== 'HOLD') {
      const last = candles[candles.length - 1];
      // confQuality is the AI Confidence score/grade attached by PredictionCard
      // when the user presses the trade button. Before that first press it may
      // be absent — guard with optional chaining.
      const confOverall = (mlData as any)._liveOverallConfidence as number | undefined;
      const confGrade   = (mlData as any)._liveConfGrade as string | undefined;
      const confQuality = confOverall != null && confGrade != null
        ? { overall: confOverall, grade: confGrade }
        : undefined;
      result.push({
        time: last.time, type: mlData.action as 'BUY'|'SELL',
        price: last.close, label: mlData.action,
        confQuality,
      });
    }
    return result;
  }, [candles, symbolTrades, openPosition, mlData, tradeQualityResult]);

  // Overlay toggle state
  const [showMA, setShowMA] = useState(true);
  const [showVP, setShowVP] = useState(false);
  const [overlayToggles, setOverlayToggles] = useState({ bollinger: false, donchian: false, keltner: false, fib: false, pivots: false });
  const toggleOverlay = useCallback((key: keyof typeof overlayToggles) => {
    setOverlayToggles(prev => ({ ...prev, [key]: !prev[key] }));
  }, []);

  // UI breakdown toggles
  const [showQualityBreakdown, setShowQualityBreakdown] = useState(false);
  const [showConfidenceBreakdown, setShowConfidenceBreakdown] = useState(false);

  const chartLivePrediction = mlData
    ? { action: mlData.action, confidence: mlData.confidence, horizon: 5 }
    : null;

  return {
    openPosition, symbolTrades, autoOpenResult, setAutoOpenResult,
    refreshTradeData, handlePaperTrade,
    chartTradeLevels, chartMarkers, chartLivePrediction,
    reviewTradeLevels, reviewMarkers,
    showMA, setShowMA, showVP, setShowVP,
    overlayToggles, toggleOverlay,
    showQualityBreakdown, setShowQualityBreakdown,
    showConfidenceBreakdown, setShowConfidenceBreakdown,
  };
}
