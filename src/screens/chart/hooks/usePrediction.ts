// ─────────────────────────────────────────────────────────────────────────────
// usePrediction — ML prediction state, training trigger, retrain decision
// ─────────────────────────────────────────────────────────────────────────────
import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { Candle } from '../../../utils/indicators';
import { getLatestTrainingStatus } from '../../../utils/trainingHistory';
import { trainAndPredict, MLPrediction, predictRetrainDecision, loadModelMetadata, warmPrecomputeCache, clearPrecomputeCache, setForegroundPredicting } from '../../../utils/mlSignal';
import { scheduleBackgroundTrain, cancelBackgroundTrain } from '../../../utils/backgroundTraining';
import { getOptimalConfig } from '../../../utils/modelOptimization';
import { fromSinglePrediction } from '../../../utils/tradeQuality';
import { getIndicatorSnapshot } from '../../../utils/liveIndicatorSnapshot';
import { checkRegimeFilter } from '../../../utils/regimeFilter';
import { useData } from '../../../context/DataContext';
import { fetchUnifiedMarketContext } from '../../../utils/cryptoMarketContext/marketContextRouter';
import { captureSnapshot } from '../../../utils/marketContextSnapshot';

export type PredictionState = {
  status: 'idle' | 'training' | 'done' | 'error';
  data:   MLPrediction | null;
  err:    string | null;
};

export function usePrediction(
  symbol: string,
  tf: string,
  candles: Candle[],
  assetType: string,
) {
  // candlesRef keeps callbacks + memos up-to-date without listing candles
  // as a dep. Removes the new-function-every-tick problem from runMLPrediction
  // and the new-object-every-tick problem from tradeQualityResult.
  const candlesRef = useRef<Candle[]>(candles);
  candlesRef.current = candles;

  const { prices } = useData();
  // Keep a ref so runMLPrediction's useCallback doesn't need prices in its deps
  // (which would recreate the callback — and trigger React.memo checks — on every
  // price tick from aggTrade at 50-200ms frequency).
  const pricesRef = useRef(prices);
  pricesRef.current = prices;
  const [ml, setMl] = useState<PredictionState>({ status: 'idle', data: null, err: null });
  const [retrainDecision, setRetrainDecision] = useState<{ willRetrain: boolean; reason: string; newCandles: number | null } | null>(null);
  const [postPredictionMsg, setPostPredictionMsg] = useState<string | null>(null);
  const mlRequestRef = useRef(0);

  // Reset prediction state immediately when symbol or timeframe changes.
  // Without this, the previous symbol's prediction stays visible until the
  // new one finishes — user sees ETH prediction on NIFTY50 chart, etc.
  const prevSymbolRef = useRef(symbol);
  const prevTfRef = useRef(tf);
  useEffect(() => {
    if (symbol !== prevSymbolRef.current || tf !== prevTfRef.current) {
      prevSymbolRef.current = symbol;
      prevTfRef.current = tf;
      ++mlRequestRef.current;
      setMl({ status: 'idle', data: null, err: null });
      setRetrainDecision(null);
      setPostPredictionMsg(null);
      // Clear precompute cache so previous symbol/tf series is never reused
      clearPrecomputeCache();
      cancelBackgroundTrain(symbol, tf);
    }
  }, [symbol, tf]);

  // Load retrain decision whenever symbol/tf/candle count changes
  useEffect(() => {
    let cancelled = false;
    loadModelMetadata(symbol, tf).then(meta => {
      if (!cancelled) setRetrainDecision(predictRetrainDecision(meta, candles.length, false));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [symbol, tf, candles.length]);

  // FIX (Audit items #1, #2, UI level): Reference to whether a prediction is
  // currently running in this hook instance. The engine-level dedup in mlSignal.ts
  // handles concurrent calls across the whole app; this ref handles the case where
  // the same component re-renders and tries to start a second call while the first
  // is still awaiting. It also enables the "already running" check before setting
  // the spinner — without it, a double-tap would show two consecutive spinners.
  const isRunningRef = useRef(false);

  const runMLPrediction = useCallback(async (forceRetrain = false) => {
    // Drop duplicate calls while one is already in-flight for this component.
    if (isRunningRef.current) return;
    isRunningRef.current = true;
    // ── PERF PROBE (remove after profiling) ─────────────────────────────────
    // Filter logcat: adb logcat -s ReactNativeJS | grep "\[PERF\]"
    const _p0 = Date.now();
    // ────────────────────────────────────────────────────────────────────────
    // FIX C-1 (race condition): grab the request ID BEFORE the 32ms yield.
    // Previously myRequestId was assigned AFTER the setTimeout. If the user
    // switches symbol/TF during those 32ms, the useEffect at line 51 fires
    // synchronously and increments mlRequestRef to N. The timer then fires
    // and does ++mlRequestRef = N+1, making myRequestId = N+1. The stale
    // check at line 125 sees myRequestId === mlRequestRef.current (both N+1)
    // and INCORRECTLY continues, writing the old symbol's prediction to state.
    // By grabbing myRequestId here (before the await), any useEffect increment
    // during the 32ms will produce a HIGHER value than myRequestId, so the
    // stale check correctly fires and the prediction is cleanly dropped.
    const myRequestId = ++mlRequestRef.current;
    // Set loading state immediately so button responds at tap time
    setMl({ status: 'training', data: null, err: null });
    // Yield 2 frames so the spinner paints before heavy work starts.
    // Previously used InteractionManager.runAfterInteractions — but on Android
    // that NEVER resolves when there are continuous state updates (aggTrade stream
    // fires setCandles every 50-200ms, which counts as an "interaction").
    // Result: trainAndPredict was never called, spinner showed forever.
    // setTimeout(32) = ~2 frames at 60fps — always resolves, achieves the same goal.
    await new Promise<void>(resolve => setTimeout(resolve, 32));
    setForegroundPredicting(true); // Phase 4: yield to foreground over background training
    try {
      const cp = pricesRef.current[symbol];
      const obSnapshot = cp?.depth
        ? { source: 'binance' as const, symbol, buy: cp.depth.buy, sell: cp.depth.sell, timestamp: cp.lastUpdated ?? Date.now() }
        : null;

      // Run getOptimalConfig and fetchUnifiedMarketContext in PARALLEL with
      // each other, and start trainAndPredict immediately with a context
      // promise that resolves when context is ready.
      // Previously these ran sequentially BEFORE trainAndPredict — fetchUnifiedMarketContext
      // alone could take 200ms-2s (4 network calls) before ML even started.
      // Now trainAndPredict starts in the same tick, context is injected if it
      // arrives before the ML finishes (warm path ~1s), otherwise null is used.
      const contextPromise = fetchUnifiedMarketContext(symbol, symbol, assetType)
        .then(unified => captureSnapshot(unified))
        .catch(() => null);

      const _p1 = Date.now();
      const optimalConfig = await getOptimalConfig(symbol, tf);

      // trainAndPredict starts NOW — context injected from promise
      const _p2 = Date.now();
      const [result, contextSnap] = await Promise.all([
        trainAndPredict(
          symbol, tf, candlesRef.current,
          optimalConfig?.bestHorizon, optimalConfig?.bestThreshold,
          forceRetrain, assetType, obSnapshot,
          null,  // context injected below after both settle
        ),
        contextPromise,
      ]);
      if (myRequestId !== mlRequestRef.current) return;
      if (!result) {
        // trainAndPredict returns null for two reasons:
        //   1. Intentional skip (insufficient candles, dedup, etc.) → type:'skipped' recorded
        //   2. Caught exception or timeout → type:'failed' recorded
        // Use getLatestTrainingStatus (reads a single dedicated key) rather than
        // getTrainingHistory (reads full array) — faster and avoids the index bug
        // where history[history.length-1] was the OLDEST entry (history is newest-first).
        try {
          const latest = await getLatestTrainingStatus(symbol, tf);
          if (latest?.type === 'skipped' && latest?.skipReason) {
            setMl({ status: 'error', data: null, err: `Skipped: ${latest.skipReason}` });
          } else if (latest?.type === 'failed' && latest?.explanation) {
            setMl({ status: 'error', data: null, err: latest.explanation });
          } else if (latest?.type === 'failed' && latest?.errorMessage) {
            setMl({ status: 'error', data: null, err: latest.errorMessage });
          } else {
            setMl({ status: 'error', data: null, err: 'Training returned no result.' });
          }
        } catch {
          setMl({ status: 'error', data: null, err: 'Training returned no result.' });
        }
        return;
      }
      // Attach context snapshot to result (for UI display, paper-trade logging).
      // Context was already fed into the ML vector above — this attaches it
      // separately for the UI layer which reads result.marketContext.
      const resultWithContext = contextSnap
        ? { ...result, marketContext: contextSnap }
        : result;
      setMl({ status: 'done', data: resultWithContext, err: null });
      const n = result.newCandlesSinceLastTraining;
      setPostPredictionMsg(
        result.action !== 'HOLD' && result.confidence > 0.6
          ? `Signal: ${result.action} with ${(result.confidence * 100).toFixed(0)}% confidence`
          : n != null ? `Model reused (${n} new candles)` : null
      );
    } catch (e: any) {
      if (myRequestId !== mlRequestRef.current) return;
      setMl({ status: 'error', data: null, err: e.message ?? 'Prediction failed' });
    } finally {
      // Always clear the running flag — even on error or cancellation.
      isRunningRef.current = false;
      setForegroundPredicting(false); // Phase 4: background training may resume
    }
  }, [symbol, tf, assetType]);

  // Trade quality — memoized separately from prediction runner
  const tradeQualityResult = useMemo(() => {
    if (!ml.data || ml.data.action === 'HOLD' || !candlesRef.current.length) return null;
    const snapshot = getIndicatorSnapshot(candlesRef.current);
    // FIX: checkRegimeFilter is async — calling without await returned a Promise,
    // causing volRegimeFromLabel(Promise).includes() to crash.
    // Use memoryResult?.regime if available, otherwise 'UNKNOWN' — safe string fallback.
    const regimeLabel: string = (ml.data.memoryResult as any)?.regime ?? 'UNKNOWN';
    return fromSinglePrediction(ml.data, candlesRef.current, snapshot, symbol, assetType, regimeLabel);
  }, [ml.data, symbol, assetType]);

  // Cancel any pending background train on symbol/tf change
  useEffect(() => {
    return () => { cancelBackgroundTrain(symbol, tf); };
  }, [symbol, tf]);

  // Stable callback — passed to useChartData's onCandleClose to:
  // 1. Warm the precomputeSeries cache (immediate, synchronous kick-off)
  // 2. Schedule background training (debounced 5s) so next Predict tap is instant
  const onCandleClose = useCallback((closedCandles: Candle[]) => {
    warmPrecomputeCache(closedCandles);
    scheduleBackgroundTrain(symbol, tf, closedCandles, assetType);
  }, [symbol, tf, assetType]);

  return {
    ml, retrainDecision, postPredictionMsg,
    runMLPrediction, tradeQualityResult, onCandleClose};
}
