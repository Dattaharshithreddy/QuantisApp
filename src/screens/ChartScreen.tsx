import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { View, Text, ScrollView, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useData } from '../context/DataContext';
import { Candle, calcMA, calcRSI, calcVolumeProfile, pFmt } from '../utils/indicators';
import { atr, bollinger } from '../utils/technicalIndicators';
import { getPricePrecisionSync, getPricePrecision } from '../utils/pricePrecision';
import { fetchBnKlines } from '../api/binance';
import { fetchAVKlines } from '../api/alphaVantage';
import { aoCandles, aoCandlesBefore } from '../api/angelOne';
import { getCachedCandles, setCachedCandles, mergeCandles } from '../utils/candleCache';
import { recordSampleCount } from '../utils/sampleHistory';
import { detectGaps, repairGaps } from '../utils/gapDetection';
import { logger } from '../utils/logger';
import { getMarketStructureSnapshot } from '../utils/marketStructureSnapshot';
import { generateExplanation } from '../utils/aiExplanation';
import { checkRegimeFilter } from '../utils/regimeFilter';
import { getIndicatorSnapshot } from '../utils/liveIndicatorSnapshot';
import { fromSinglePrediction, formatTradeQualityScore } from '../utils/tradeQuality';
import { getOptimalConfig } from '../utils/modelOptimization';
import { TrainingStatusCard } from '../components/TrainingStatusCard';
import { PredictionSourceCard } from '../components/PredictionSourceCard';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { OrderBookCard } from '../components/OrderBookCard';
import { ModelUsageTimeline } from '../components/ModelUsageTimeline';
import { TrainingSummaryModal } from '../components/TrainingSummaryModal';
import { getLatestTrainingStatus, TrainingStatusInfo } from '../utils/trainingHistory';
import { resolveOutcomes } from '../utils/predictionHistory';
import { getPortfolio, PaperPosition } from '../utils/paperPortfolio';
import { getPaperTrades, PaperTradeRecord } from '../utils/paperTradeJournal';
import { attemptOpenPosition } from '../utils/paperTradingEngine';
import { analyzeWithClaude, buildAnalysisPrompt, AIAnalysis } from '../api/claude';
import CandlestickChart from '../components/CandlestickChart';
import { Card, SectionLabel, Pill, GradientButton, Skeleton, Gauge, ExpandableToggle, AnimatedReveal, MetricBox, IconChip } from '../components/Common';
import { RADIUS, SPACING } from '../theme/colors';
import { trainAndPredict, MLPrediction, PRIMARY_HORIZON, WALK_FORWARD_FOLDS, FEATURE_NAMES } from '../utils/mlSignal';

const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1D', '1W'];

const TRADE_LABELS: Record<string, { l: string; bg: string }> = {
  LONG: { l: '▲ LONG', bg: '#26a69a' }, SHORT: { l: '▼ SHORT', bg: '#ef5350' },
  BUY_CE: { l: '↑ BUY CE', bg: '#2962ff' }, BUY_PE: { l: '↓ BUY PE', bg: '#9c27b0' },
  SELL_CE: { l: '↑ SELL CE', bg: '#f5a623' }, SELL_PE: { l: '↓ SELL PE', bg: '#fb923c' },
  NO_TRADE: { l: '— NO TRADE', bg: '#4c535e' },
};

export default function ChartScreen({ route, navigation }: any) {
  const { theme: T } = useTheme();
  const { prices, aoSession, avKey, anthropicKey, news, allAssets } = useData();
  const initialSymbol = route?.params?.symbol || 'NIFTY50';
  const [symbol, setSymbol] = useState(initialSymbol);
  const [autoOpenResult, setAutoOpenResult] = useState<{ title: string; reason: string } | null>(null);
  const [tf, setTf] = useState('15m');
  // FIX (root cause of the ChartScreen crash — "Cannot read property 'type'
  // of undefined"): this was previously declared at its old historical
  // location much further down in the file, but several newer hooks
  // (tradeQualityResult, chartMarkers, the paper-trade-data effect, etc.)
  // were added ABOVE that point and reference asset.type. Every render,
  // those hooks ran BEFORE this line ever executed, so `asset` was read
  // while still undefined — RN's Metro/Babel block-scoping transform
  // doesn't enforce strict const TDZ the way spec-compliant JS normally
  // would, so this silently evaluated to `undefined` instead of throwing
  // a clearer "used before initialization" error, producing exactly the
  // reported crash, deterministically, on every single render. The fix is
  // purely a declaration-order move — asset's own logic is unchanged.
  const asset = allAssets.find(a => a.symbol === symbol) || allAssets[0];
  const [candles, setCandles] = useState<Candle[]>([]);
  // TASK 5 (Price Scale) — initializes with the synchronous class-level
  // default immediately (never blocks first render), then updates to the
  // real exchange-fetched precision once available, triggering a
  // re-render so labels sharpen up rather than staying wrong silently.
  const [pricePrecision, setPricePrecision] = useState<number>(2);
  useEffect(() => {
    setPricePrecision(getPricePrecisionSync(asset));
    getPricePrecision(asset).then(setPricePrecision).catch(() => {});
  }, [asset.symbol, asset.src]);
  const [candleLoadExplanation, setCandleLoadExplanation] = useState('');
  const [loading, setLoading] = useState(false);
  const [errMsg, setErrMsg] = useState('');
  const [ai, setAi] = useState<{ status: 'idle' | 'loading' | 'done' | 'error'; data: AIAnalysis | null; err: string | null }>({ status: 'idle', data: null, err: null });
  const [ml, setMl] = useState<{ status: 'idle' | 'training' | 'done' | 'error'; data: MLPrediction | null; err: string | null }>({ status: 'idle', data: null, err: null });
  const [showQualityBreakdown, setShowQualityBreakdown] = useState(false);
  const [showConfidenceBreakdown, setShowConfidenceBreakdown] = useState(false);
  // Phase 1 (Phase 8 Part 2) — real data for the chart's tradeLevels/markers
  // props, refreshed whenever candles reload or a paper trade is acted on
  // from this screen. Never placeholder values — null/empty when there's
  // genuinely nothing to show.
  const [openPosition, setOpenPosition] = useState<PaperPosition | null>(null);
  const [symbolTrades, setSymbolTrades] = useState<PaperTradeRecord[]>([]);

  const refreshTradeData = useCallback(async () => {
    const portfolio = await getPortfolio();
    setOpenPosition(portfolio.openPositions.find(p => p.symbol === symbol) ?? null);
    const trades = await getPaperTrades();
    setSymbolTrades(trades.filter(t => t.symbol === symbol && t.timeframe === tf));
  }, [symbol, tf]);

  useEffect(() => { refreshTradeData(); }, [refreshTradeData]);

  // Phase 1 (Phase 8 Part 2) — real data for the chart's tradeLevels/markers
  // props. Computed at the top level (not nested inside JSX) since useMemo
  // must follow React's Rules of Hooks — a stable position on every render,
  // never inside a conditionally-invoked inline closure.
  const chartTradeLevels = useMemo(() => {
    if (!openPosition) return [];
    return [
      { label: 'Entry', price: openPosition.entryPrice, color: T.blue },
      { label: 'SL', price: openPosition.stopLoss, color: T.red },
      { label: 'TP', price: openPosition.takeProfit, color: T.green },
    ];
  }, [openPosition, T]);

  // Computed once, reused both for the chart marker AND the tappable
  // strengths/weaknesses panel below — single computation, single source
  // of truth, never duplicated.
  const tradeQualityResult = useMemo(() => {
    if (!ml.data || ml.data.action === 'HOLD' || !candles.length) return null;
    const snapshot = getIndicatorSnapshot(candles);
    const regimeLabel = checkRegimeFilter(candles, 'DISABLED').currentRegime;
    return fromSinglePrediction(ml.data, candles, snapshot, symbol, asset.type, regimeLabel);
  }, [ml.data, candles, symbol, asset.type]);

  // DISPLAY-ONLY technical summary (Phase 3C) — reuses the exact same
  // getIndicatorSnapshot() already called above for Trade Quality (not a
  // second/different implementation), plus atr()/bollinger() from
  // technicalIndicators.ts, both already-existing, already-used-elsewhere
  // functions. Nothing computed here feeds back into ML, confidence,
  // training, or trading logic — it's read-only, for showing the user
  // what the indicators currently say.
  const techSummary = useMemo(() => {
    if (!candles.length || candles.length < 60) return null;
    const snapshot = getIndicatorSnapshot(candles);
    if (!snapshot) return null;
    const atrSeries = atr(candles);
    const bbSeries = bollinger(candles);
    return { snapshot, atrValue: atrSeries[atrSeries.length - 1], bb: bbSeries[bbSeries.length - 1] };
  }, [candles]);

  const chartMarkers = useMemo(() => {
    if (!candles.length) return [];
    const firstCandleTime = candles[0].time;
    const result: { time: number; type: 'BUY' | 'SELL' | 'HOLD' | 'ENTRY' | 'EXIT' | 'SL_HIT' | 'TP_HIT' | 'TRAIL'; price: number; label?: string }[] = [];

    symbolTrades.forEach(t => {
      if (t.entryTime >= firstCandleTime) result.push({ time: t.entryTime, type: 'ENTRY', price: t.entryPrice, label: 'Entry' });
      if (t.exitTime >= firstCandleTime) {
        const exitType = t.exitReason === 'STOP_LOSS' ? 'SL_HIT' : t.exitReason === 'TAKE_PROFIT' ? 'TP_HIT' : 'EXIT';
        result.push({ time: t.exitTime, type: exitType, price: t.exitPrice, label: t.exitReason === 'STOP_LOSS' ? 'SL Hit' : t.exitReason === 'TAKE_PROFIT' ? 'TP Hit' : 'Exit' });
      }
    });

    if (openPosition && openPosition.entryTime >= firstCandleTime) {
      result.push({ time: openPosition.entryTime, type: 'ENTRY', price: openPosition.entryPrice, label: 'Entry' });
    }

    // The latest live AI signal — only ever for the current/last candle,
    // never fabricated retroactively for historical bars. Trade quality
    // reuses THE single scoring implementation (tradeQuality.ts), which
    // itself reuses computeCompositeScore from opportunityRanking.ts.
    if (ml.data && ml.data.action !== 'HOLD' && tradeQualityResult) {
      const last = candles[candles.length - 1];
      result.push({ time: last.time, type: ml.data.action as 'BUY' | 'SELL', price: last.close, label: ml.data.action, quality: tradeQualityResult.quality });
    }

    return result;
  }, [candles, symbolTrades, openPosition, ml.data, tradeQualityResult]);

  const chartLivePrediction = ml.data ? { action: ml.data.action, confidence: ml.data.confidence, horizon: PRIMARY_HORIZON } : null;

  // Phase 2 (Phase 8 Part 2) — Live Candle. Updates the forming candle's
  // high/low/close in place as real price ticks arrive (only while still
  // within that candle's own time window — never edits a candle that's
  // already closed). Volume is NOT live-updated here: the live price feed
  // (DataContext) only ever carries price + a 24h session change, never
  // per-tick trade volume, so faking a "live volume" number would be
  // fabricated data — it's shown as of the last full candle fetch instead,
  // labeled honestly.
  const TF_MS: Record<string, number> = { '5m': 300000, '15m': 900000, '30m': 1800000, '1h': 3600000, '4h': 14400000, '1D': 86400000 };
  useEffect(() => {
    if (!cp?.price || !candles.length) return;
    const intervalMs = TF_MS[tf];
    if (!intervalMs) return;
    const last = candles[candles.length - 1];
    if (Date.now() >= last.time + intervalMs) return; // this candle has already closed, don't edit it
    setCandles(prev => {
      if (!prev.length) return prev;
      const updated = [...prev];
      const i = updated.length - 1;
      updated[i] = { ...updated[i], high: Math.max(updated[i].high, cp.price), low: Math.min(updated[i].low, cp.price), close: cp.price };
      return updated;
    });
  }, [cp?.price]);

  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const liveCandleInfo = useMemo(() => {
    if (!candles.length) return null;
    const intervalMs = TF_MS[tf];
    if (!intervalMs) return null;
    const last = candles[candles.length - 1];
    const closeTime = last.time + intervalMs;
    const remainingMs = Math.max(0, closeTime - nowTick);
    if (remainingMs <= 0) return null; // already closed and no newer candle fetched yet — don't show a stale countdown
    const mins = Math.floor(remainingMs / 60000), secs = Math.floor((remainingMs % 60000) / 1000);
    const changePct = ((last.close - last.open) / last.open) * 100;
    return { candle: last, countdownLabel: mins > 0 ? `${mins}m ${secs}s` : `${secs}s`, changePct };
  }, [candles, tf, nowTick]);

  // FIX (metadata gap): switching assets previously just blanked the Signal
  // Engine card back to 'idle' with nothing shown, even if this symbol had
  // been trained before in a prior session. Now it explicitly reloads the
  // persisted metadata record for whichever symbol is active, so the last
  // real training info (candle counts, accuracy, version, timestamp) is
  // always shown — never stale, never blank when real data exists.
  const [showMA, setShowMA] = useState(true);
  const [showVP, setShowVP] = useState(false);
  // Phase 3 (Phase 8 Part 2) — individually toggleable technical overlays
  const [overlayToggles, setOverlayToggles] = useState({ bollinger: false, donchian: false, keltner: false, fib: false, pivots: false });
  const toggleOverlay = (key: keyof typeof overlayToggles) => setOverlayToggles(prev => ({ ...prev, [key]: !prev[key] }));

  const cp = prices[symbol];
  const [dataSrc, setDataSrc] = useState<'live' | 'none'>('none');
  const [loadingOlder, setLoadingOlder] = useState(false);

  // FIX (Sample Count Audit — root cause of "trained on 5m at 260
  // samples, switched to 15m, returned to 5m, saw 110"): loadCandles had
  // NO race guard at all, unlike runMLPrediction below which already
  // uses this exact pattern (mlRequestRef). Switching timeframes fires a
  // brand new loadCandles() call via the effect below, but never cancels
  // whatever previous call might still be in flight. If a user switches
  // 5m->15m->5m quickly, the ABANDONED 15m fetch can resolve LATE and
  // silently overwrite the screen's current 5m candles with 15m's own
  // default-sized fetch — verified the math: a previously-merged 300-raw-
  // candle 5m set gives ~260 features after burn-in; an abandoned 15m
  // fetch's default 150-raw-candle result gives ~110 — matching BOTH
  // reported numbers simultaneously, not just one.
  const candlesRequestRef = useRef(0);
  const [trainingSummary, setTrainingSummary] = useState<TrainingStatusInfo | null>(null);
  const [showTrainingSummary, setShowTrainingSummary] = useState(false);

  // FIX: bottom-tab screens stay mounted in the background — React Navigation
  // updates route.params on every navigate(), but useState(initialSymbol) only
  // reads that value once, on first mount. Without this effect, tapping a
  // different asset in Markets always re-opens whatever symbol Chart first
  // loaded with (Nifty), because the already-mounted screen never re-reads
  // the new params. This effect makes the symbol actually follow navigation.
  useEffect(() => {
    const incoming = route?.params?.symbol;
    if (incoming && incoming !== symbol) {
      setSymbol(incoming);
    }
  }, [route?.params?.symbol]);

  const loadCandles = useCallback(async () => {
    const myRequestId = ++candlesRequestRef.current;
    setErrMsg(''); setAi({ status: 'idle', data: null, err: null }); setMl({ status: 'idle', data: null, err: null });

    // Show cached data INSTANTLY if available (even if stale) so the chart
    // never sits on a blank loading spinner when we already have something
    // real to show — then a fresh fetch runs in the background regardless.
    const cached = await getCachedCandles(symbol, tf);
    if (myRequestId !== candlesRequestRef.current) return; // a newer load started while this cache read was in flight — abandon before touching any state
    if (cached?.candles.length) {
      setCandles(cached.candles);
      setDataSrc('live');
      setLoading(false);
      if (cached.isFresh) {
        logger.info('ChartScreen', `Using fresh cache for ${symbol}/${tf}, skipping network fetch`);
        await recordSampleCount(symbol, tf, cached.candles.length, `History restored from cache (still within freshness window) — ${cached.candles.length} candles.`, 'cache_fresh').catch(() => {});
        return; // cache is still within TTL — no need to hit the network at all
      }
    } else {
      setLoading(true);
    }

    try {
      let data: Candle[] = [];
      if (asset.src === 'binance' && asset.bnSym) { data = await fetchBnKlines(asset.bnSym, tf); setDataSrc('live'); }
      else if (asset.src === 'ao' && aoSession?.jwtToken && asset.aoToken && asset.aoEx) { data = await aoCandles(asset.aoToken, asset.aoEx, tf, aoSession); setDataSrc('live'); }
      else if (asset.src === 'av' && asset.avSym && avKey) { data = await fetchAVKlines(asset.avSym, tf, avKey); setDataSrc('live'); }
      else {
        // No live source connected — show nothing fabricated, just be honest about why.
        if (!cached?.candles.length) setDataSrc('none');
        if (asset.src === 'ao') setErrMsg('Angel One not connected — connect it in Settings to see this chart.');
        else if (asset.src === 'av') setErrMsg('Alpha Vantage key not set — add one in Settings to see this chart.');
        else setErrMsg('No live data source available for this asset.');
        setLoading(false);
        return;
      }

      // Automatic gap detection + repair — re-fetches any detected gap from
      // the same source rather than leaving a silent hole in the series.
      const gaps = detectGaps(data, tf);
      if (gaps.length) {
        data = await repairGaps(data, gaps, async (fromTime, toTime) => {
          if (asset.src === 'binance' && asset.bnSym) {
            const filler = await fetchBnKlines(asset.bnSym, tf, 150, toTime);
            return filler.filter(c => c.time >= fromTime && c.time <= toTime);
          }
          if (asset.src === 'ao' && aoSession?.jwtToken && asset.aoToken && asset.aoEx) {
            const filler = await aoCandlesBefore(asset.aoToken, asset.aoEx, tf, toTime + 60000, aoSession);
            return filler.filter(c => c.time >= fromTime && c.time <= toTime);
          }
          return []; // Alpha Vantage has no clean range-query for gap-filling
        });
      }

      // TASK 2 (Preserve Candle History) — root cause: mergeCandles
      // already existed (utils/candleCache.ts), correctly deduplicating by
      // time and keeping chronological order, but had ZERO callers
      // anywhere in the codebase. Every fresh fetch unconditionally
      // overwrote state via setCandles(data), silently discarding any
      // extra history a user had previously loaded by scrolling back,
      // the moment the cache went stale. Now merged instead of replaced.
      const freshCount = data.length;
      const cachedCount = cached?.candles.length ?? 0;
      const merged = cachedCount > 0 ? mergeCandles(cached!.candles, data) : data;
      const duplicatesRemoved = freshCount + cachedCount - merged.length;

      // FIX (Sample Count Audit): checked here, before ANY state mutation
      // in this block (including the explanation text) - not just before
      // the final candle commit. The merge computation above is pure and
      // side-effect-free, so computing it is harmless even if discarded;
      // nothing after this point should run for an abandoned request.
      if (myRequestId !== candlesRequestRef.current) {
        logger.info('ChartScreen', `Discarding stale candle load for ${symbol}/${tf} (request ${myRequestId}, current is ${candlesRequestRef.current})`);
        return;
      }

      // TASK 6 (Explain Sample Count) — built from the actual numbers
      // just computed above, not a generic message.
      let explanation: string;
      if (cachedCount > 0) {
        const parts = [`Loaded ${freshCount} fresh candles.`];
        if (cachedCount > 0) parts.push(`Merged with ${cachedCount} previously-cached candles.`);
        if (duplicatesRemoved > 0) parts.push(`Removed ${duplicatesRemoved} duplicate(s) (same candle present in both).`);
        parts.push(`Final candle count: ${merged.length}.`);
        explanation = parts.join(' ');
        setCandleLoadExplanation(explanation);
        logger.info('ChartScreen', `${symbol}/${tf}: ${explanation}`);
      } else {
        explanation = `Loaded ${freshCount} fresh candles (no prior cache to merge).`;
        setCandleLoadExplanation(explanation);
      }
      // Sample History — reuses the exact explanation built above, just
      // also persists it so "why did the count change" survives navigation
      // away and back, not just the current render. Category reflects
      // what genuinely happened: gap-repair is the most specific real
      // reason when it occurred, otherwise cache-expired-merge vs a
      // genuine fresh download depending on whether prior cache existed.
      const category = gaps.length > 0 ? 'gap_repaired' : (cachedCount > 0 ? 'cache_expired_merged' : 'fresh_download');

      setCandles(merged);
      await recordSampleCount(symbol, tf, merged.length, explanation, category).catch(() => {});
      await setCachedCandles(symbol, tf, merged);
      resolveOutcomes(symbol, tf, merged).catch(() => {}); // best-effort, never blocks the chart from loading
    } catch (e: any) {
      logger.error('ChartScreen', `loadCandles failed for ${symbol}/${tf}: ${e.message}`);
      if (cached?.candles.length) {
        // Network failed but we still have stale cached data on screen — keep
        // showing it rather than blanking out, just flag that it's stale.
        setErrMsg(`${e.message} — showing last cached data, may be outdated.`);
      } else {
        setErrMsg(e.message);
        setDataSrc('none');
        setCandles([]);
      }
    } finally { setLoading(false); }
  }, [symbol, tf, aoSession?.jwtToken, avKey]);

  // Pan-to-scroll triggers this when the user drags back to the oldest
  // currently-loaded candle. Fetches a real earlier window and prepends it —
  // never fabricates anything if the source has no more history to give.
  const loadMoreHistory = useCallback(async (): Promise<boolean> => {
    if (!candles.length || loadingOlder) return false;
    const oldestTime = candles[0].time;
    setLoadingOlder(true);
    try {
      let older: Candle[] = [];
      if (asset.src === 'binance' && asset.bnSym) {
        older = await fetchBnKlines(asset.bnSym, tf, 150, oldestTime - 1);
        older = older.filter(c => c.time < oldestTime); // Binance's endTime is inclusive-ish; guard against overlap
      } else if (asset.src === 'ao' && aoSession?.jwtToken && asset.aoToken && asset.aoEx) {
        older = await aoCandlesBefore(asset.aoToken, asset.aoEx, tf, oldestTime, aoSession);
      }
      // Alpha Vantage's free intraday endpoint doesn't support a clean
      // "give me data before X" pagination — its 'full' output already
      // returns the maximum available window, so there's no further history
      // for 'av' sources. Pan simply won't load more for those, by design.
      if (older.length) {
        // Functional form deliberately preserved here (not a closure-
        // captured `candles` value) — this is an async function with a
        // network call in between; the live-candle-tick effect elsewhere
        // also updates candles via this same functional form, and reading
        // a stale closure value here could silently discard a live tick
        // that landed while this fetch was in flight. extendedRef captures
        // the actual merged result for the cache write below, without
        // reintroducing that race.
        let extendedRef: Candle[] = [];
        setCandles(prev => { extendedRef = [...older, ...prev]; return extendedRef; });
        // Without this, loadCandles' merge fix above only ever merges
        // against whatever was LAST cached — which wouldn't include this
        // extension, since it was only ever in memory. Persisting it here
        // closes the loop completely: scroll-loaded history now survives
        // a cache-staleness refresh too, not just an in-session re-render.
        await setCachedCandles(symbol, tf, extendedRef);
        await recordSampleCount(symbol, tf, extendedRef.length, `User scrolled back to load older history — ${older.length} additional candle(s) loaded. New total: ${extendedRef.length}.`, 'history_extended').catch(() => {});
        return true;
      }
      return false;
    } catch (_) {
      return false;
    } finally {
      setLoadingOlder(false);
    }
  }, [candles, asset, tf, aoSession, loadingOlder]);

  useEffect(() => { loadCandles(); }, [symbol, tf]);

  // FIX (training metadata race condition): if the user starts a second
  // training run before the first finishes (e.g. after loading more history
  // and re-tapping quickly), training time scales with candle count — the
  // OLDER, SLOWER call could finish AFTER the newer one and silently
  // overwrite its result with stale numbers. This token guard discards any
  // result that isn't from the most recently started call.
  const mlRequestRef = useRef(0);

  async function handlePaperTrade(prediction: MLPrediction) {
    const portfolio = await getPortfolio();
    if (portfolio.mode === 'AUTO') {
      const currentPrice = cp?.price ?? prediction.suggestedEntry;
      const result = await attemptOpenPosition(symbol, tf, prediction, currentPrice, candles, asset.type);
      setAutoOpenResult({ title: result.opened ? '✓ Auto-opened' : 'Not opened', reason: result.reason });
      await refreshTradeData();
    } else {
      navigation.navigate('PaperTrading', { pendingSignal: { symbol, prediction }, candles, timeframe: tf });
    }
  }

  async function runMLPrediction(forceRetrain = false) {
    if (!candles.length) return;
    const myRequestId = ++mlRequestRef.current;
    setMl({ status: 'training', data: null, err: null });
    try {
      const optimalConfig = await getOptimalConfig(symbol, tf);
      const obSnapshot = cp?.depth ? { source: asset.src as 'ao' | 'binance', symbol, buy: cp.depth.buy, sell: cp.depth.sell, timestamp: cp.lastUpdated ?? Date.now() } : null;
      const result = await trainAndPredict(symbol, tf, candles, optimalConfig?.bestHorizon, optimalConfig?.bestThreshold, forceRetrain, asset.type, obSnapshot);
      if (myRequestId !== mlRequestRef.current) {
        logger.warn('ChartScreen', `Discarding stale training result for ${symbol} (request ${myRequestId}, current is ${mlRequestRef.current})`);
        return; // a newer training run superseded this one — don't apply stale data
      }
      // TRAINING SUMMARY — fetched fresh after every attempt (trained,
      // reused, rejected, skipped, or failed), not reconstructed from the
      // prediction result. trainAndPredict always records a real status
      // even when it returns null, so this works uniformly for every
      // outcome rather than only when a prediction actually came back.
      getLatestTrainingStatus(symbol, tf).then(s => { setTrainingSummary(s); setShowTrainingSummary(true); });
      if (!result) { setMl({ status: 'error', data: null, err: 'Not enough price history to train (need 60+ bars).' }); return; }
      setMl({ status: 'done', data: result, err: null });
    } catch (e: any) {
      if (myRequestId !== mlRequestRef.current) return; // also discard stale errors
      setMl({ status: 'error', data: null, err: e.message });
    }
  }

  async function runAnalysis() {
    if (!candles.length) return;
    setAi({ status: 'loading', data: null, err: null });
    const last = candles[candles.length - 1];
    const l10 = candles.slice(-10);
    const ma20 = calcMA(candles, 20)[candles.length - 1];
    const ma50 = calcMA(candles, 50)[candles.length - 1];
    const p5 = candles[candles.length - 6]?.close;
    const ch5 = p5 ? (((last.close - p5) / p5) * 100).toFixed(3) : '0';
    const rsi = calcRSI(candles);
    const ohlc = l10.map(c => `O:${pFmt(c.open)} H:${pFmt(c.high)} L:${pFmt(c.low)} C:${pFmt(c.close)} V:${(c.volume / 1000).toFixed(0)}K`).join('\n');
    const { poc } = calcVolumeProfile(candles, 28);
    const recentNews = news.slice(0, 5).map(n => `[${n.t}] ${n.txt} (${n.imp})`).join('\n');
    const depth = cp?.depth;
    let obLine = '';
    if (depth) {
      const buyQ = depth.buy.reduce((s, d) => s + d.qty, 0);
      const sellQ = depth.sell.reduce((s, d) => s + d.qty, 0);
      const total = buyQ + sellQ || 1;
      obLine = `ORDER BOOK: Buy ${((buyQ / total) * 100).toFixed(1)}% vs Sell ${((sellQ / total) * 100).toFixed(1)}%`;
    }
    const mlLine = ml.status === 'done' && ml.data
      ? `ON-DEVICE SIGNAL ENGINE: Ensemble (neural net + logistic regression) suggests ${ml.data.action}, P(up, ${PRIMARY_HORIZON}-bar)=${(ml.data.ensembleProbUp * 100).toFixed(1)}%, models ${ml.data.ensembleAgree ? 'AGREE' : 'DISAGREE'}, confidence ${ml.data.confidence.toFixed(0)}/100, risk score ${ml.data.riskScore.toFixed(0)}/100. ` +
        `Walk-forward validated accuracy: ${ml.data.walkForwardAccuracy >= 0 ? ml.data.walkForwardAccuracy.toFixed(0) + '%' : 'insufficient data'} (trained on ${ml.data.sampleCount} bars per horizon — treat as a minor input, not a strong signal given small sample size). ` +
        `ATR-based levels suggested: entry ${pFmt(ml.data.suggestedEntry)}, SL ${pFmt(ml.data.suggestedStopLoss)}, TP ${pFmt(ml.data.suggestedTakeProfit)}. ` +
        `Top drivers: ${ml.data.topFeatures.slice(0, 3).map(f => f.name).join(', ')}.`
      : '';
    const prompt = buildAnalysisPrompt({
      assetName: asset.name, symbol, type: asset.type, tf,
      srcLabel: asset.src === 'ao' ? 'LIVE Angel One' : asset.src === 'binance' ? 'LIVE Binance' : asset.src === 'av' ? 'LIVE Alpha Vantage' : 'Live',
      price: last.close, ch5, rsi, ma20, ma50,
      high10: Math.max(...l10.map(c => c.high)), low10: Math.min(...l10.map(c => c.low)),
      ohlc, recentNews, obLine, pocLine: poc ? `VOLUME POC: ${pFmt(poc.price)}` : '', mlLine,
    });
    try {
      const data = await analyzeWithClaude(prompt, anthropicKey);
      setAi({ status: 'done', data, err: null });
    } catch (e: any) {
      setAi({ status: 'error', data: null, err: e.message });
    }
  }

  const isPos = (cp?.chg || 0) >= 0;
  const priceColor = isPos ? T.green : T.red;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 12, paddingBottom: 40 }}>
        {/* Symbol selector */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 14 }} contentContainerStyle={{ paddingRight: 20 }}>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TouchableOpacity onPress={() => navigation.navigate('SymbolSearch', { returnTo: 'Chart' })} activeOpacity={0.7} style={{
              flexDirection: 'row', alignItems: 'center', gap: 4,
              paddingHorizontal: 13, paddingVertical: 7, borderRadius: RADIUS.pill, backgroundColor: T.purple + '18', borderWidth: 1, borderColor: T.purple + '40',
            }}>
              <Text style={{ fontSize: 11 }}>🔍</Text>
              <Text style={{ color: T.purple, fontSize: 11, fontWeight: '700' }}>Search symbol</Text>
            </TouchableOpacity>
            {allAssets.slice(0, 12).map(a => (
              <Pill key={a.symbol + a.src} label={a.symbol} color={T.blue} active={a.symbol === symbol} onPress={() => setSymbol(a.symbol)} />
            ))}
          </View>
        </ScrollView>

        {/* Price header — elevated card, the screen's primary visual anchor */}
        <View style={{
          flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
          backgroundColor: T.card, borderRadius: RADIUS.lg, borderWidth: 1, borderColor: T.cardBorder,
          paddingVertical: 14, paddingHorizontal: SPACING.lg, marginBottom: 14, ...T.elev1,
        }}>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 3 }}>
              <Text style={{ color: T.text, fontSize: 21, fontWeight: '800', letterSpacing: -0.3 }}>{symbol}</Text>
              <View style={{
                flexDirection: 'row', alignItems: 'center', gap: 3,
                paddingHorizontal: 7, paddingVertical: 3, borderRadius: RADIUS.sm,
                backgroundColor: dataSrc === 'live' ? T.green + '18' : T.amber + '18',
              }}>
                <View style={{
                  width: 5, height: 5, borderRadius: 3,
                  backgroundColor: dataSrc === 'live' ? (cp?.status === 'stale' ? T.amber : T.green) : T.amber,
                }} />
                <Text style={{ color: dataSrc === 'live' ? (cp?.status === 'stale' ? T.amber : T.green) : T.amber, fontSize: 9, fontWeight: '800', letterSpacing: 0.4 }}>
                  {dataSrc === 'live' ? (cp?.status === 'stale' ? 'STALE' : 'LIVE') : 'NO DATA'}
                </Text>
              </View>
            </View>
            <Text style={{ color: T.textDim, fontSize: 12, fontWeight: '500' }}>{asset.name}</Text>
          </View>
          {cp && (
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={{ color: priceColor, fontSize: 24, fontWeight: '800', letterSpacing: -0.4 }}>{pFmt(cp.price)}</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 2 }}>
                <Text style={{ color: priceColor, fontSize: 12, fontWeight: '700' }}>{isPos ? '▲' : '▼'} {Math.abs(cp.chg).toFixed(2)}%</Text>
              </View>
            </View>
          )}
        </View>

        {/* Timeframes */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 10 }} contentContainerStyle={{ paddingRight: 20 }}>
          <View style={{ flexDirection: 'row', gap: 6 }}>
            {TIMEFRAMES.map(t => (
              <TouchableOpacity key={t} onPress={() => setTf(t)} activeOpacity={0.75} style={{
                paddingHorizontal: 14, paddingVertical: 7, borderRadius: RADIUS.sm,
                backgroundColor: tf === t ? T.accent : T.bg3,
                borderWidth: 1, borderColor: tf === t ? T.accent : T.border,
              }}>
                <Text style={{ color: tf === t ? '#fff' : T.textSub, fontSize: 11, fontWeight: '700' }}>{t}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </ScrollView>

        {/* Overlays — separated from timeframe selection above so a
            quick timeframe change never requires scrolling past
            secondary, occasionally-used toggles, and vice versa. */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 10 }} contentContainerStyle={{ paddingRight: 20 }}>
          <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
            <Pill label="MA" color={T.blue} active={showMA} onPress={() => setShowMA(v => !v)} />
            <Pill label="VP" color={T.amber} active={showVP} onPress={() => setShowVP(v => !v)} />
            <Pill label="Bollinger" color={T.blue} active={overlayToggles.bollinger} onPress={() => toggleOverlay('bollinger')} />
            <Pill label="Donchian" color={T.amber} active={overlayToggles.donchian} onPress={() => toggleOverlay('donchian')} />
            <Pill label="Keltner" color={T.purple} active={overlayToggles.keltner} onPress={() => toggleOverlay('keltner')} />
            <Pill label="Fib" color={T.amber} active={overlayToggles.fib} onPress={() => toggleOverlay('fib')} />
            <Pill label="Pivots" color={T.purple} active={overlayToggles.pivots} onPress={() => toggleOverlay('pivots')} />
          </View>
        </ScrollView>

        {/* Chart */}
        {loading ? (
          <View style={{ height: 320, justifyContent: 'center', padding: SPACING.lg, backgroundColor: T.card, borderRadius: RADIUS.lg, borderWidth: 1, borderColor: T.cardBorder }}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 6, height: 160, marginBottom: 16 }}>
              {[60, 95, 70, 120, 85, 140, 100, 75, 110, 90].map((h, i) => (
                <Skeleton key={i} width={18} height={h} radius={3} theme={T} />
              ))}
            </View>
            <Skeleton width={140} height={11} theme={T} />
            <Text style={{ color: T.textDim, fontSize: 11, marginTop: 10, textAlign: 'center' }}>Loading {symbol}…</Text>
          </View>
        ) : (
          <CandlestickChart
            key={`${symbol}_${tf}`}
            data={candles} theme={T} showMA={showMA} showVP={showVP}
            onRequestOlderData={loadMoreHistory} loadingOlder={loadingOlder}
            noDataMessage={errMsg || 'No live data source connected for this asset.'}
            timeframe={tf} tradeLevels={chartTradeLevels} markers={chartMarkers} livePrediction={chartLivePrediction} overlays={overlayToggles} pricePrecision={pricePrecision} livePrice={cp?.price}
          />
        )}
        {errMsg && candles.length > 0 && <Text style={{ color: T.amber, fontSize: 10, marginTop: 6, textAlign: 'center' }}>⚠ {errMsg}</Text>}

        {/* Phase 2 (Phase 8 Part 2) — Live Candle */}
        {liveCandleInfo && (
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', backgroundColor: T.bg2, borderRadius: RADIUS.sm, padding: 10, marginTop: 8 }}>
            <View>
              <Text style={{ color: T.textDim, fontSize: 8 }}>CLOSES IN</Text>
              <Text style={{ color: T.amber, fontWeight: '700', fontSize: 13 }}>{liveCandleInfo.countdownLabel}</Text>
            </View>
            <View>
              <Text style={{ color: T.textDim, fontSize: 8 }}>OHLC</Text>
              <Text style={{ color: T.textSub, fontSize: 10 }}>{liveCandleInfo.candle.open.toFixed(pricePrecision)} / {liveCandleInfo.candle.high.toFixed(pricePrecision)} / {liveCandleInfo.candle.low.toFixed(pricePrecision)} / {liveCandleInfo.candle.close.toFixed(pricePrecision)}</Text>
            </View>
            <View>
              <Text style={{ color: T.textDim, fontSize: 8 }}>VOLUME (last fetch)</Text>
              <Text style={{ color: T.textSub, fontSize: 10 }}>{liveCandleInfo.candle.volume.toFixed(0)}</Text>
            </View>
            <View>
              <Text style={{ color: T.textDim, fontSize: 8 }}>CANDLE CHANGE</Text>
              <Text style={{ color: liveCandleInfo.changePct >= 0 ? T.green : T.red, fontWeight: '700', fontSize: 10 }}>{liveCandleInfo.changePct >= 0 ? '+' : ''}{liveCandleInfo.changePct.toFixed(2)}%</Text>
            </View>
          </View>
        )}
        {!loading && candles.length > 0 && (
          <Text style={{ color: T.textDim, fontSize: 9, marginTop: 6, textAlign: 'center' }}>Pinch to zoom · Drag to scroll back in time</Text>
        )}

        {/* Technical Indicator Summary (Phase 3C) — surfaces RSI/MACD/EMA200/
            ADX/Volume that were already computed via getIndicatorSnapshot()
            (used internally for Trade Quality scoring) but never shown to
            the user directly, plus ATR/Bollinger via already-existing,
            already-tested functions. Read-only display - none of this
            feeds back into ML/confidence/training/trading logic. */}
        {!loading && techSummary && (() => {
          const s = techSummary.snapshot;
          const rsiZone = s.rsi >= 70 ? { label: 'Overbought', color: T.red } : s.rsi <= 30 ? { label: 'Oversold', color: T.green } : { label: 'Neutral', color: T.textDim };
          const macdColor = s.macdBullish ? T.green : T.red;
          const trendColor = s.aboveEma200 == null ? T.textDim : s.aboveEma200 ? T.green : T.red;
          const trendLabel = s.aboveEma200 == null ? 'n/a' : s.aboveEma200 ? 'Above EMA200 (Bullish)' : 'Below EMA200 (Bearish)';
          return (
            <Card theme={T} style={{ marginTop: 14 }}>
              <SectionLabel theme={T}>📐 TECHNICAL INDICATORS</SectionLabel>

              {/* RSI — gauge + zone badge */}
              <View style={{ marginBottom: 12 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
                  <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', letterSpacing: 0.4 }}>RSI (14)</Text>
                  <View style={{ backgroundColor: rsiZone.color + '18', borderRadius: RADIUS.sm, paddingHorizontal: 8, paddingVertical: 2 }}>
                    <Text style={{ color: rsiZone.color, fontSize: 9, fontWeight: '800' }}>{rsiZone.label}</Text>
                  </View>
                </View>
                <Gauge value={s.rsi} color={rsiZone.color} label="" theme={T} size="sm" />
              </View>

              <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
                <MetricBox label="MACD" value={s.macdBullish ? '▲ Bullish' : '▼ Bearish'} valueColor={macdColor} bg={macdColor + '12'} sub={s.macdHistogram != null ? `hist ${s.macdHistogram.toFixed(2)}` : undefined} theme={T} />
                <MetricBox label="TREND (EMA200)" value={trendLabel} valueColor={trendColor} bg={trendColor + '12'} theme={T} />
              </View>

              <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
                <MetricBox label="ADX (TREND STRENGTH)" value={`${s.adxValue != null ? s.adxValue.toFixed(0) : 'n/a'}${s.adxStrengthening ? ' ↗' : ''}`} theme={T} />
                <MetricBox
                  label="VOLUME"
                  value={`${s.relativeVolume != null ? `${s.relativeVolume.toFixed(2)}×` : 'n/a'}${s.volumeExpansion ? ' Expansion' : ''}`}
                  valueColor={s.volumeExpansion ? T.amber : T.text}
                  bg={s.volumeExpansion ? T.amber + '12' : T.bg3}
                  theme={T}
                />
              </View>

              <View style={{ flexDirection: 'row', gap: 8 }}>
                <View style={{ flex: 1, backgroundColor: T.bg3, borderRadius: RADIUS.sm, padding: 9 }}>
                  <Text style={{ color: T.textDim, fontSize: 8, fontWeight: '700', letterSpacing: 0.3 }}>ATR (14) — VOLATILITY</Text>
                  <Text style={{ color: T.text, fontSize: 12, fontWeight: '800', marginTop: 3 }}>{techSummary.atrValue != null ? pFmt(techSummary.atrValue) : 'n/a'}</Text>
                  <Text style={{ color: T.textDim, fontSize: 8, marginTop: 1 }}>Avg true range — used for SL/TP sizing</Text>
                </View>
                <View style={{ flex: 1, backgroundColor: T.bg3, borderRadius: RADIUS.sm, padding: 9 }}>
                  <Text style={{ color: T.textDim, fontSize: 8, fontWeight: '700', letterSpacing: 0.3 }}>BOLLINGER BANDS (20, 2σ)</Text>
                  {techSummary.bb?.upper != null ? (
                    <>
                      <Text style={{ color: T.text, fontSize: 11, fontWeight: '700', marginTop: 3 }}>{pFmt(techSummary.bb.upper)} / {pFmt(techSummary.bb.mid!)} / {pFmt(techSummary.bb.lower!)}</Text>
                      <Text style={{ color: T.textDim, fontSize: 8, marginTop: 1 }}>Width {techSummary.bb.widthPct!.toFixed(2)}%</Text>
                    </>
                  ) : <Text style={{ color: T.textDim, fontSize: 11, marginTop: 3 }}>n/a</Text>}
                </View>
              </View>
            </Card>
          );
        })()}

        {/* Market Structure — PRIORITY 2: surfaces candlestick patterns,
            swing structure (HH/HL/LH/LL), rolling pivots, and Fibonacci
            levels that previously existed as verified-correct functions but
            were never shown anywhere in the UI. Computed fresh from current
            candles each time (not cached/stale). */}
        {!loading && candles.length > 0 && (() => {
          const snap = getMarketStructureSnapshot(candles);
          if (!snap) return null;
          const structColor = (s: string) => s === 'HH' || s === 'HL' ? T.green : s === 'LH' || s === 'LL' ? T.red : T.textDim;
          const structIcon = (s: string) => s === 'HH' || s === 'HL' ? '▲' : s === 'LH' || s === 'LL' ? '▼' : '—';
          const PricePill = ({ label, value, color }: { label: string; value: number; color: string }) => (
            <View style={{ alignItems: 'center', backgroundColor: color + '14', borderRadius: RADIUS.sm, paddingVertical: 6, paddingHorizontal: 10, borderWidth: 1, borderColor: color + '35' }}>
              <Text style={{ color, fontSize: 9, fontWeight: '700', letterSpacing: 0.3 }}>{label}</Text>
              <Text style={{ color, fontSize: 11, fontWeight: '800', marginTop: 1 }}>{pFmt(value)}</Text>
            </View>
          );
          return (
            <Card theme={T} style={{ marginTop: 14 }}>
              <SectionLabel theme={T}>MARKET STRUCTURE</SectionLabel>
              <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
                <View style={{ flex: 1, backgroundColor: structColor(snap.structureHighs) + '12', borderRadius: RADIUS.sm, padding: 10, alignItems: 'center' }}>
                  <Text style={{ color: structColor(snap.structureHighs), fontWeight: '800', fontSize: 15 }}>{structIcon(snap.structureHighs)} {snap.structureHighs}</Text>
                  <Text style={{ color: T.textDim, fontSize: 8, marginTop: 3, fontWeight: '700', letterSpacing: 0.3 }}>SWING HIGHS</Text>
                </View>
                <View style={{ flex: 1, backgroundColor: structColor(snap.structureLows) + '12', borderRadius: RADIUS.sm, padding: 10, alignItems: 'center' }}>
                  <Text style={{ color: structColor(snap.structureLows), fontWeight: '800', fontSize: 15 }}>{structIcon(snap.structureLows)} {snap.structureLows}</Text>
                  <Text style={{ color: T.textDim, fontSize: 8, marginTop: 3, fontWeight: '700', letterSpacing: 0.3 }}>SWING LOWS</Text>
                </View>
              </View>

              {snap.patterns.length > 0 && (
                <View style={{ marginBottom: 12 }}>
                  <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', letterSpacing: 0.4, marginBottom: 6 }}>🕯️ CANDLESTICK PATTERN (LATEST BAR)</Text>
                  <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                    {snap.patterns.map((p, i) => (
                      <Pill key={i} label={p.name} color={p.bullish === true ? T.green : p.bullish === false ? T.red : T.textDim} active />
                    ))}
                  </View>
                </View>
              )}

              {snap.pivots && (
                <View style={{ marginBottom: 12 }}>
                  <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', letterSpacing: 0.4, marginBottom: 6 }}>📍 SUPPORT / RESISTANCE — ROLLING PIVOTS (PRIOR 20-BAR)</Text>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 6 }}>
                    <PricePill label="S1" value={snap.pivots.s1} color={T.red} />
                    <PricePill label="PIVOT" value={snap.pivots.pp} color={T.text} />
                    <PricePill label="R1" value={snap.pivots.r1} color={T.green} />
                  </View>
                </View>
              )}

              {snap.fib && (
                <View>
                  <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', letterSpacing: 0.4, marginBottom: 6 }}>📐 FIBONACCI (LAST SWING {pFmt(snap.lastSwingLow)} → {pFmt(snap.lastSwingHigh)})</Text>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                    {[['23.6%', snap.fib.level236], ['38.2%', snap.fib.level382], ['50%', snap.fib.level500], ['61.8%', snap.fib.level618]].map(([l, v]: any) => (
                      <PricePill key={l} label={l} value={v} color={T.purple} />
                    ))}
                  </View>
                </View>
              )}
            </Card>
          );
        })()}

        {/* Order Book — GOAL 1: now real for both Angel One (existing,
            FULL quote mode) and Binance (new, /api/v3/depth). Both render
            through the exact same OrderBookCard - one implementation, not
            a second copy for the second source. */}
        {(asset.src === 'ao' || asset.src === 'binance') && (
          <Card theme={T} style={{ marginTop: 14 }}>
            <SectionLabel theme={T}>ORDER BOOK · LIVE DEPTH</SectionLabel>
            <OrderBookCard
              snapshot={cp?.depth ? { source: asset.src as 'ao' | 'binance', symbol, buy: cp.depth.buy, sell: cp.depth.sell, timestamp: cp.lastUpdated ?? Date.now() } : null}
              unavailableReason={
                asset.type === 'INDEX'
                  ? `${asset.name} is an index, not a directly tradeable instrument — there's no order book for it. Depth is only available for stocks and other directly tradeable instruments (futures/options on this index would have their own depth, but aren't tracked here).`
                  : asset.src === 'ao' && !aoSession?.jwtToken
                  ? 'Connect Angel One in Settings to see live order book depth for this asset.'
                  : null
              }
              pricePrecision={pricePrecision}
              theme={T}
            />
          </Card>
        )}

        {/* On-device Multi-Model Signal Engine */}
        <Card theme={T} style={{ marginTop: 18 }}>
          <View style={{ marginBottom: 12 }}>
            <Text style={{ color: T.purple, fontWeight: '800', fontSize: 12, letterSpacing: 1 }}>🧠 SIGNAL ENGINE</Text>
            <Text style={{ color: T.textDim, fontSize: 9, marginTop: 2 }}>Neural net + logistic regression ensemble · 30 features</Text>
          </View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TouchableOpacity onPress={() => runMLPrediction(true)} disabled={ml.status === 'training' || loading} activeOpacity={0.75} style={{
              flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: T.purple + '12', paddingHorizontal: 10, paddingVertical: 13, borderRadius: RADIUS.md, borderWidth: 1, borderColor: T.purple + '40',
              opacity: (ml.status === 'training' || loading) ? 0.5 : 1,
            }}>
              <Text style={{ color: T.purple, fontWeight: '700', fontSize: 12 }} numberOfLines={1}>↻ Force Retrain</Text>
            </TouchableOpacity>
            <View style={{ flex: 1.4 }}>
              <GradientButton
                theme={T}
                label={ml.status === 'training' ? 'Training…' : 'Train & Predict'}
                onPress={() => runMLPrediction(false)}
                disabled={ml.status === 'training' || loading}
              />
            </View>
          </View>

          {ml.status === 'idle' && (
            <View>
              <TrainingStatusCard symbol={symbol} timeframe={tf} theme={T} refreshKey={ml.data} />
              <Text style={{ color: T.textDim, fontSize: 11, lineHeight: 17 }}>
                Trains two structurally different models (a small neural net + logistic regression) across 5 time horizons, on {FEATURE_NAMES.length} real technical/market-structure/time features computed from {symbol}'s own price history — no fabricated data, chronological splits, no lookahead. Read every number honestly: this is a genuine but limited-sample signal, not a guarantee.
              </Text>
            </View>
          )}
          {ml.status === 'training' && (
            <View style={{ paddingVertical: 6 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <Skeleton width={28} height={28} radius={14} theme={T} />
                <View style={{ flex: 1, gap: 6 }}>
                  <Skeleton width="70%" height={9} theme={T} />
                  <Skeleton width="45%" height={9} theme={T} />
                </View>
              </View>
              <Text style={{ color: T.textDim, fontSize: 10, textAlign: 'center' }}>Training 5 horizon models + ensemble + walk-forward validation…</Text>
            </View>
          )}
          {ml.status === 'error' && <Text style={{ color: T.red, fontSize: 12 }}>⚠ {ml.err}</Text>}
          {ml.status === 'done' && ml.data && (() => {
            const d = ml.data;
            const dirColor = d.direction === 'UP' ? T.green : d.direction === 'DOWN' ? T.red : T.textDim;
            const actionColor = d.action === 'BUY' ? T.green : d.action === 'SELL' ? T.red : T.amber;
            const wfReliable = d.walkForwardAccuracy >= 55;
            return (
              <View>
                <PredictionSourceCard prediction={d} symbol={symbol} timeframe={tf} theme={T} />
                <ModelUsageTimeline prediction={d} theme={T} />
                {/* Action badge */}
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4, marginBottom: 10 }}>
                  <View style={{ backgroundColor: actionColor + '18', paddingHorizontal: 18, paddingVertical: 11, borderRadius: RADIUS.md, borderWidth: 1, borderColor: actionColor + '40' }}>
                    <Text style={{ color: actionColor, fontWeight: '800', fontSize: 16, letterSpacing: 0.3 }}>{d.action === 'BUY' ? '▲' : d.action === 'SELL' ? '▼' : '—'} {d.action}</Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={{ color: T.text, fontSize: 19, fontWeight: '800', letterSpacing: -0.3 }}>{(d.ensembleProbUp * 100).toFixed(1)}%</Text>
                    <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '600' }}>Ensemble P(up), {PRIMARY_HORIZON}-bar</Text>
                  </View>
                </View>

                {/* Final Feature — Trade Quality Score. The SINGLE
                    implementation used everywhere in the app
                    (tradeQuality.ts), reusing computeCompositeScore from
                    opportunityRanking.ts — never a second scoring system. */}
                {tradeQualityResult && (
                  <View style={{ backgroundColor: T.card, borderRadius: RADIUS.md, borderWidth: 1, borderColor: T.cardBorder, padding: SPACING.md, marginBottom: 10, ...T.elev1 }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                      <View>
                        <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', letterSpacing: 0.6 }}>TRADE QUALITY</Text>
                        <Text style={{ color: T.text, fontWeight: '800', fontSize: 16, marginTop: 2 }}>{formatTradeQualityScore(tradeQualityResult.quality.score)}/100 {tradeQualityResult.quality.stars}</Text>
                      </View>
                      <View style={{ alignItems: 'flex-end' }}>
                        <Text style={{ color: T.accent, fontWeight: '800', fontSize: 14 }}>Grade: {tradeQualityResult.quality.grade}</Text>
                        <Text style={{ color: tradeQualityResult.quality.riskBadge === 'Low' ? T.green : tradeQualityResult.quality.riskBadge === 'Medium' ? T.amber : T.red, fontSize: 10, fontWeight: '700', marginTop: 1 }}>{tradeQualityResult.quality.riskBadge} Risk</Text>
                      </View>
                    </View>
                    <ExpandableToggle expanded={showQualityBreakdown} label="Strengths & Weaknesses" onPress={() => setShowQualityBreakdown(v => !v)} theme={T} />
                    {showQualityBreakdown && (
                      <AnimatedReveal>
                      <View style={{ marginTop: 4, paddingTop: 10, borderTopWidth: 1, borderTopColor: T.border, gap: 10 }}>
                        {tradeQualityResult.breakdown.strengths.length > 0 && (
                          <View>
                            <Text style={{ color: T.green, fontSize: 9, fontWeight: '700', letterSpacing: 0.5, marginBottom: 6 }}>STRENGTHS</Text>
                            <View style={{ gap: 5 }}>
                              {tradeQualityResult.breakdown.strengths.map((s, i) => (
                                <IconChip key={i} icon="✓" text={s} color={T.green} bg={T.green + '12'} theme={T} />
                              ))}
                            </View>
                          </View>
                        )}
                        {tradeQualityResult.breakdown.weaknesses.length > 0 && (
                          <View>
                            <Text style={{ color: T.amber, fontSize: 9, fontWeight: '700', letterSpacing: 0.5, marginBottom: 6 }}>WEAKNESSES</Text>
                            <View style={{ gap: 5 }}>
                              {tradeQualityResult.breakdown.weaknesses.map((w, i) => (
                                <IconChip key={i} icon="!" text={w} color={T.amber} bg={T.amber + '12'} theme={T} />
                              ))}
                            </View>
                          </View>
                        )}
                      </View>
                      </AnimatedReveal>
                    )}
                  </View>
                )}

                {/* Phase 4 — AI Explanation: every reason below is a real,
                    directionally-evaluated check against real indicator
                    values and real model outputs — not placeholder text. */}
                {(() => {
                  const regimeCheck = checkRegimeFilter(candles, 'DISABLED');
                  const explanation = generateExplanation(d, candles, tf, regimeCheck.currentRegime);
                  if (!explanation || explanation.action === 'HOLD') return null;
                  return (
                    <View style={{ backgroundColor: T.card, borderRadius: RADIUS.md, borderWidth: 1, borderColor: T.cardBorder, padding: SPACING.md, marginBottom: 10, ...T.elev1 }}>
                      <SectionLabel theme={T}>
                        AI REASONS ({explanation.supportingReasons.length}/{explanation.totalChecked} CHECKS SUPPORT THIS SIGNAL)
                      </SectionLabel>
                      <View style={{ gap: 5, marginBottom: 4 }}>
                        {explanation.supportingReasons.map(r => (
                          <IconChip key={r.text} icon="✓" text={r.text} color={T.green} theme={T} />
                        ))}
                      </View>
                      {explanation.supportingReasons.length < explanation.totalChecked * 0.5 && (
                        <Text style={{ color: T.amber, fontSize: 9, marginTop: 6, lineHeight: 13 }}>⚠ Fewer than half the checks support this signal — a weaker setup than the confidence number alone might suggest.</Text>
                      )}
                      <View style={{ height: 1, backgroundColor: T.border, marginVertical: 10 }} />
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                        <View>
                          <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', letterSpacing: 0.4 }}>RISK</Text>
                          <Text style={{ color: explanation.riskLabel === 'Low' ? T.green : explanation.riskLabel === 'Medium' ? T.amber : T.red, fontWeight: '700', fontSize: 12, marginTop: 2 }}>{explanation.riskLabel}</Text>
                        </View>
                        <View>
                          <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', letterSpacing: 0.4 }}>EXPECTED HOLDING</Text>
                          <Text style={{ color: T.text, fontWeight: '700', fontSize: 12, marginTop: 2 }}>{explanation.expectedHoldingLabel}</Text>
                        </View>
                      </View>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 10 }}>
                        <View>
                          <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', letterSpacing: 0.4 }}>SUGGESTED STOP LOSS</Text>
                          <Text style={{ color: T.red, fontWeight: '700', fontSize: 12, marginTop: 2 }}>{pFmt(explanation.suggestedStopLoss)}</Text>
                        </View>
                        <View>
                          <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', letterSpacing: 0.4 }}>SUGGESTED TAKE PROFIT</Text>
                          <Text style={{ color: T.green, fontWeight: '700', fontSize: 12, marginTop: 2 }}>{pFmt(explanation.suggestedTakeProfit)}</Text>
                        </View>
                      </View>
                    </View>
                  );
                })()}
                {(d.action === 'BUY' || d.action === 'SELL') && (
                  <TouchableOpacity onPress={() => handlePaperTrade(d)} style={{
                    backgroundColor: d.action === 'BUY' ? T.purple : T.red, paddingVertical: 9, borderRadius: RADIUS.sm, alignItems: 'center', marginBottom: 8,
                  }}>
                    <Text style={{ color: '#fff', fontWeight: '700', fontSize: 11 }}>🧪 Paper Trade This Signal ({d.action === 'BUY' ? 'Long' : 'Short'})</Text>
                  </TouchableOpacity>
                )}
                <Text style={{ color: d.ensembleAgree ? T.green : T.amber, fontSize: 10, marginBottom: 4 }}>
                  {d.ensembleAgree ? '✓ Neural net and logistic regression agree on direction' : '⚠ Models disagree — neural net and logistic regression point different ways'}
                </Text>
                <Text style={{ color: d.warmStart ? T.purple : T.textDim, fontSize: 9, marginBottom: 8 }}>
                  {d.warmStart ? '♻ Continued training from previously saved weights' : '🆕 First training run for this symbol'}
                </Text>

                {/* Training Progress — before/after comparison + accept/reject status */}
                <View style={{ backgroundColor: d.modelAccepted ? T.green + '12' : T.red + '12', borderRadius: RADIUS.sm, padding: 10, marginBottom: 12, borderWidth: 1, borderColor: d.modelAccepted ? T.green + '40' : T.red + '40' }}>
                  <Text style={{ color: d.modelAccepted ? T.green : T.red, fontWeight: '800', fontSize: 11, marginBottom: 6 }}>
                    {d.modelAccepted ? '✓ MODEL ACCEPTED' : '✗ MODEL REJECTED — previous weights kept'}
                  </Text>
                  <Text style={{ color: T.textDim, fontSize: 9, marginBottom: 8, lineHeight: 13 }}>{d.acceptRejectReason}</Text>

                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2 }}>
                    <Text style={{ color: T.textSub, fontSize: 10 }}>Validation accuracy</Text>
                    <Text style={{ fontSize: 10 }}>
                      <Text style={{ color: T.textDim }}>{d.previousValidationAccuracy != null ? d.previousValidationAccuracy.toFixed(1) + '%' : 'n/a'} → </Text>
                      <Text style={{ color: T.text, fontWeight: '700' }}>{d.primaryValidationAccuracy.toFixed(1)}%</Text>
                    </Text>
                  </View>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2 }}>
                    <Text style={{ color: T.textSub, fontSize: 10 }}>Walk-forward accuracy</Text>
                    <Text style={{ fontSize: 10 }}>
                      <Text style={{ color: T.textDim }}>{d.previousWalkForwardAccuracy != null && d.previousWalkForwardAccuracy >= 0 ? d.previousWalkForwardAccuracy.toFixed(1) + '%' : 'n/a'} → </Text>
                      <Text style={{ color: T.text, fontWeight: '700' }}>{d.walkForwardAccuracy >= 0 ? d.walkForwardAccuracy.toFixed(1) + '%' : 'n/a'}</Text>
                    </Text>
                  </View>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2 }}>
                    <Text style={{ color: T.textSub, fontSize: 10 }}>Loss (lower is better)</Text>
                    <Text style={{ fontSize: 10 }}>
                      <Text style={{ color: T.textDim }}>{d.previousLoss != null ? d.previousLoss.toFixed(4) : 'n/a'} → </Text>
                      <Text style={{ color: T.text, fontWeight: '700' }}>{d.primaryLoss.toFixed(4)}</Text>
                    </Text>
                  </View>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2 }}>
                    <Text style={{ color: T.textSub, fontSize: 10 }}>Epochs completed</Text>
                    <Text style={{ color: T.text, fontWeight: '700', fontSize: 10 }}>{d.epochsCompleted}{d.earlyStopped ? ' (stopped early)' : ''}</Text>
                  </View>
                </View>

                {/* Confidence / Risk */}
                <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10, backgroundColor: T.card, borderRadius: RADIUS.md, borderWidth: 1, borderColor: T.cardBorder, padding: SPACING.md, ...T.elev1 }}>
                  <View style={{ flex: 1 }}>
                    <Gauge value={d.confidence} color={d.confidence >= 60 ? T.green : T.amber} label="CONFIDENCE" theme={T} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Gauge value={d.riskScore} color={d.riskScore <= 40 ? T.green : d.riskScore <= 70 ? T.amber : T.red} label="RISK SCORE" theme={T} />
                  </View>
                  <View style={{ flex: 1 }}>
                    {d.walkForwardAccuracy >= 0 ? (
                      <Gauge value={d.walkForwardAccuracy} color={wfReliable ? T.green : T.amber} label="WALK-FWD ACC." theme={T} />
                    ) : (
                      <View>
                        <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', letterSpacing: 0.4, marginBottom: 5 }}>WALK-FWD ACC.</Text>
                        <Text style={{ color: T.textDim, fontSize: 18, fontWeight: '800' }}>n/a</Text>
                      </View>
                    )}
                  </View>
                </View>

                {/* Full transparency: exactly how the confidence number above
                    was computed, component by component — so a high P(up)
                    with low confidence (or vice versa) is never a mystery. */}
                <ExpandableToggle expanded={showConfidenceBreakdown} label="How was this confidence calculated?" onPress={() => setShowConfidenceBreakdown(v => !v)} theme={T} />
                {showConfidenceBreakdown && (
                  <AnimatedReveal>
                  <View style={{ backgroundColor: T.bg3, borderRadius: RADIUS.sm, padding: 10, marginBottom: 12 }}>
                    {[
                      ['Raw probability strength', d.confidenceBreakdown.probabilityComponent, d.confidenceBreakdown.weights.probability],
                      ['Model agreement (NN vs LR)', d.confidenceBreakdown.agreementComponent, d.confidenceBreakdown.weights.agreement],
                      ['Walk-forward accuracy', d.confidenceBreakdown.walkForwardComponent, d.confidenceBreakdown.weights.walkForward],
                      ['This run\'s validation accuracy', d.confidenceBreakdown.validationComponent, d.confidenceBreakdown.weights.validation],
                    ].map(([label, val, weight]: any) => (
                      <View key={label} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 }}>
                        <Text style={{ color: T.textSub, fontSize: 10 }}>{label} (×{(weight * 100).toFixed(0)}%)</Text>
                        <Text style={{ color: T.text, fontWeight: '700', fontSize: 10 }}>{val.toFixed(0)}/100</Text>
                      </View>
                    ))}
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 }}>
                      <Text style={{ color: T.textSub, fontSize: 10 }}>
                        Historical calibration (×{(d.confidenceBreakdown.weights.calibration * 100).toFixed(0)}%)
                      </Text>
                      <Text style={{ color: T.text, fontWeight: '700', fontSize: 10 }}>
                        {d.confidenceBreakdown.calibrationComponent != null ? `${d.confidenceBreakdown.calibrationComponent.toFixed(0)}/100` : 'not enough history yet'}
                      </Text>
                    </View>
                    <Text style={{ color: T.textDim, fontSize: 8, marginTop: 6, lineHeight: 12 }}>
                      {d.confidenceBreakdown.calibrationComponent == null
                        ? `Calibration needs 20+ resolved past predictions for this symbol (have ${d.confidenceBreakdown.calibrationSampleCount}) — until then its weight is redistributed across the other components, never faked.`
                        : `Based on ${d.confidenceBreakdown.calibrationSampleCount} resolved past predictions: how often similar-confidence calls actually turned out correct.`}
                    </Text>
                  </View>
                  </AnimatedReveal>
                )}

                {!wfReliable && d.walkForwardAccuracy >= 0 && (
                  <View style={{ backgroundColor: T.amber + '15', padding: 10, borderRadius: RADIUS.sm, marginBottom: 12 }}>
                    <Text style={{ color: T.amber, fontSize: 10, lineHeight: 15 }}>
                      ⚠ Walk-forward accuracy (averaged across {WALK_FORWARD_FOLDS} sliding time periods) is near coin-flip — this signal has not shown it generalizes across different periods. Treat as exploratory.
                    </Text>
                  </View>
                )}

                {/* Multi-horizon table */}
                <Text style={{ color: T.textDim, fontSize: 9, marginBottom: 6, letterSpacing: 1 }}>P(PRICE UP) BY HORIZON</Text>
                <View style={{ flexDirection: 'row', backgroundColor: T.bg3, borderRadius: RADIUS.sm, padding: 8, marginBottom: 12 }}>
                  {d.horizons.map(h => (
                    <View key={h.horizon} style={{ flex: 1, alignItems: 'center' }}>
                      <Text style={{ color: T.textDim, fontSize: 8 }}>{h.horizon}-bar</Text>
                      <Text style={{ color: h.probUp > 0.5 ? T.green : T.red, fontWeight: '700', fontSize: 12, marginTop: 2 }}>{(h.probUp * 100).toFixed(0)}%</Text>
                      <Text style={{ color: T.textDim, fontSize: 9, marginTop: 1 }}>{h.testAccuracy.toFixed(0)}% acc</Text>
                    </View>
                  ))}
                </View>

                {/* SL/TP */}
                {d.action !== 'HOLD' && (
                  <View style={{ backgroundColor: T.bg3, borderRadius: RADIUS.sm, padding: 10, marginBottom: 12 }}>
                    <Text style={{ color: T.textDim, fontSize: 9, letterSpacing: 1, marginBottom: 7 }}>ATR-BASED TRADE LEVELS</Text>
                    {[['ENTRY', d.suggestedEntry, T.blue], ['STOP LOSS', d.suggestedStopLoss, T.red], ['TAKE PROFIT', d.suggestedTakeProfit, T.green], ['R:R RATIO', `1 : ${d.riskRewardRatio.toFixed(2)}`, T.amber]].map(([l, v, c]: any) => (
                      <View key={l} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3, borderBottomWidth: 1, borderBottomColor: T.border }}>
                        <Text style={{ color: T.textDim, fontSize: 10 }}>{l}</Text>
                        <Text style={{ color: c, fontWeight: '700', fontSize: 11 }}>{typeof v === 'number' ? pFmt(v) : v}</Text>
                      </View>
                    ))}
                    <Text style={{ color: T.textDim, fontSize: 8, marginTop: 6, lineHeight: 12 }}>1.5× ATR stop, 2.5× ATR target — a standard risk convention, not a guaranteed outcome.</Text>
                  </View>
                )}

                {/* Feature importance */}
                <Text style={{ color: T.textDim, fontSize: 9, marginBottom: 2, letterSpacing: 1 }}>TOP CONTRIBUTING FEATURES</Text>
                <Text style={{ color: T.textDim, fontSize: 8.5, marginBottom: 8, lineHeight: 12 }}>
                  Ranked by influence = connection strength × how unusual the value is right now (heuristic, not true SHAP).
                </Text>
                {(() => {
                  const maxInfluence = Math.max(...d.topFeatures.map(f => f.influence), 1e-9);
                  return d.topFeatures.map((f, i) => (
                    <View key={i} style={{ marginBottom: 9 }}>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 3 }}>
                        <Text style={{ color: T.textSub, fontSize: 10 }}>{f.name}</Text>
                        <View style={{ flexDirection: 'row', gap: 8 }}>
                          <Text style={{ color: T.textDim, fontSize: 9 }}>val {f.value.toFixed(4)}</Text>
                          <Text style={{ color: T.purple, fontSize: 10, fontWeight: '700' }}>{f.influence.toFixed(3)}</Text>
                        </View>
                      </View>
                      <View style={{ height: 4, backgroundColor: T.bg0, borderRadius: 2, overflow: 'hidden' }}>
                        <View style={{ width: `${(f.influence / maxInfluence) * 100}%`, height: '100%', backgroundColor: T.purple, borderRadius: 2 }} />
                      </View>
                    </View>
                  ));
                })()}
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 6, paddingTop: 8, borderTopWidth: 1, borderTopColor: T.border }}>
                  <Text style={{ color: T.textDim, fontSize: 8.5 }}>Training: <Text style={{ color: T.text, fontWeight: '700' }}>{d.sampleCount}</Text></Text>
                  <Text style={{ color: T.textDim, fontSize: 8.5 }}>Validation: <Text style={{ color: T.text, fontWeight: '700' }}>{d.validationCount}</Text></Text>
                  <Text style={{ color: T.textDim, fontSize: 8.5 }}>Features: <Text style={{ color: T.text, fontWeight: '700' }}>{d.featureCount}</Text></Text>
                  <Text style={{ color: T.textDim, fontSize: 8.5 }}>Version: <Text style={{ color: T.text, fontWeight: '700' }}>v{d.modelVersion}</Text></Text>
                  <Text style={{ color: T.textDim, fontSize: 8.5 }}>Trained: <Text style={{ color: T.text, fontWeight: '700' }}>{new Date(d.trainedAt).toLocaleTimeString()}</Text></Text>
                </View>
              </View>
            );
          })()}
        </Card>

        {/* AI Copilot */}
        <Card theme={T} style={{ marginTop: 18 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <View>
              <Text style={{ color: T.blue, fontWeight: '800', fontSize: 12, letterSpacing: 1 }}>⬡ AI COPILOT</Text>
              <Text style={{ color: T.textDim, fontSize: 9, marginTop: 2 }}>Claude Sonnet · Institutional Grade</Text>
            </View>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TouchableOpacity onPress={() => navigation.navigate('AIChat', { symbol })} style={{
                backgroundColor: T.purple, paddingHorizontal: 12, paddingVertical: 8, borderRadius: RADIUS.sm,
              }}>
                <Text style={{ color: '#fff', fontWeight: '700', fontSize: 11 }}>💬 Chat</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={runAnalysis} disabled={ai.status === 'loading' || loading} style={{
                backgroundColor: T.accent, paddingHorizontal: 16, paddingVertical: 8, borderRadius: RADIUS.sm, opacity: ai.status === 'loading' ? 0.6 : 1,
              }}>
                <Text style={{ color: '#fff', fontWeight: '700', fontSize: 11 }}>{ai.status === 'loading' ? 'ANALYZING…' : 'ANALYZE'}</Text>
              </TouchableOpacity>
            </View>
          </View>

          {ai.status === 'idle' && (
            <View>
              {!anthropicKey && (
                <View style={{ backgroundColor: T.amber + '15', padding: 10, borderRadius: RADIUS.sm, marginBottom: 10 }}>
                  <Text style={{ color: T.amber, fontSize: 11, lineHeight: 16 }}>⚙ Add your Anthropic API key in Settings to use the AI Copilot.</Text>
                </View>
              )}
              <Text style={{ color: T.textDim, fontSize: 12, lineHeight: 20 }}>Tap ANALYZE for institutional-grade AI reasoning on {asset.name}.</Text>
            </View>
          )}
          {ai.status === 'loading' && (
            <View style={{ gap: 8, paddingVertical: 4 }}>
              <Skeleton width="92%" height={11} theme={T} />
              <Skeleton width="78%" height={11} theme={T} />
              <Skeleton width="85%" height={11} theme={T} />
            </View>
          )}
          {ai.status === 'error' && <Text style={{ color: T.red, fontSize: 12 }}>⚠ {ai.err}</Text>}
          {ai.status === 'done' && ai.data && (
            <View>
              <View style={{ backgroundColor: TRADE_LABELS[ai.data.tradeType]?.bg || T.textDim, padding: 10, borderRadius: RADIUS.sm, alignItems: 'center', marginBottom: 10 }}>
                <Text style={{ color: '#fff', fontWeight: '800', fontSize: 14, letterSpacing: 1 }}>{TRADE_LABELS[ai.data.tradeType]?.l || ai.data.tradeType}</Text>
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 }}>
                <Text style={{ color: T.textDim, fontSize: 10 }}>CONFIDENCE</Text>
                <Text style={{ color: ai.data.confidence >= 70 ? T.green : T.amber, fontWeight: '800', fontSize: 18 }}>{ai.data.confidence}%</Text>
              </View>
              {ai.data.tradeType !== 'NO_TRADE' && (
                <View style={{ marginBottom: 10 }}>
                  {[
                    ['ENTRY', ai.data.entry, T.blue], ['STOP LOSS', ai.data.stopLoss, T.red],
                    ['TARGET 1', ai.data.target1, T.green], ['TARGET 2', ai.data.target2, T.green],
                    ['R:R', `1:${ai.data.riskReward?.toFixed(1)}`, T.amber],
                  ].map(([l, v, c]: any) => (
                    <View key={l} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: T.border }}>
                      <Text style={{ color: T.textDim, fontSize: 10 }}>{l}</Text>
                      <Text style={{ color: c, fontWeight: '700', fontSize: 12 }}>{typeof v === 'number' ? pFmt(v) : v}</Text>
                    </View>
                  ))}
                </View>
              )}
              {[
                ['TECHNICAL SETUP', ai.data.technicalSetup, T.blue], ['SMART MONEY', ai.data.smartMoney, T.purple],
                ['MACRO + NEWS', ai.data.macroContext, T.amber], ['RISK FACTORS', ai.data.riskFactors, T.red],
              ].map(([title, body, c]: any) => (
                <View key={title} style={{ borderLeftWidth: 2, borderLeftColor: c, paddingLeft: 8, marginBottom: 10 }}>
                  <Text style={{ color: c, fontSize: 9, fontWeight: '700', marginBottom: 2 }}>{title}</Text>
                  <Text style={{ color: T.textSub, fontSize: 11, lineHeight: 17 }}>{body}</Text>
                </View>
              ))}
              <View style={{ backgroundColor: T.accent + '15', padding: 10, borderRadius: RADIUS.sm }}>
                <Text style={{ color: T.accent, fontSize: 9, fontWeight: '700', marginBottom: 4 }}>EXECUTIVE SUMMARY</Text>
                <Text style={{ color: T.text, fontSize: 12, fontStyle: 'italic', lineHeight: 18 }}>{ai.data.executiveSummary}</Text>
              </View>
            </View>
          )}
        </Card>
      </ScrollView>
      <TrainingSummaryModal visible={showTrainingSummary} onClose={() => setShowTrainingSummary(false)} status={trainingSummary} theme={T} />
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
