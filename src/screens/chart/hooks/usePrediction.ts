// ─────────────────────────────────────────────────────────────────────────────
// usePrediction — ML prediction state, training trigger, retrain decision
// ─────────────────────────────────────────────────────────────────────────────
import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { Candle } from '../../../utils/indicators';
import { getTrainingHistory } from '../../../utils/trainingHistory';
import { trainAndPredict, MLPrediction, PRIMARY_HORIZON, predictRetrainDecision, loadModelMetadata } from '../../../utils/mlSignal';
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
      ++mlRequestRef.current; // cancel in-flight request
      setMl({ status: 'idle', data: null, err: null });
      setRetrainDecision(null);
      setPostPredictionMsg(null);
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

  const runMLPrediction = useCallback(async (forceRetrain = false) => {
    setMl({ status: 'training', data: null, err: null });
    const myRequestId = ++mlRequestRef.current;
    try {
      const optimalConfig = await getOptimalConfig(symbol, tf);
      const cp = prices[symbol];
      const obSnapshot = cp?.depth
        ? { source: 'binance' as const, symbol, buy: cp.depth.buy, sell: cp.depth.sell, timestamp: cp.lastUpdated ?? Date.now() }
        : null;

      // Module 1: Fetch market context BEFORE trainAndPredict so it can be
      // fed into the feature vector (contextSnapshot parameter).
      // Best-effort: context fetch failure never blocks prediction.
      let contextSnap: import('../../../utils/marketContextSnapshot').MarketContextSnapshot | null = null;
      try {
        const unified = await fetchUnifiedMarketContext(symbol, symbol, assetType);
        contextSnap = captureSnapshot(unified);
      } catch { /* non-fatal */ }

      const result = await trainAndPredict(
        symbol, tf, candlesRef.current,
        optimalConfig?.bestHorizon, optimalConfig?.bestThreshold,
        forceRetrain, assetType, obSnapshot,
        contextSnap,  // Module 1: pass context into ML feature vector
      );
      if (myRequestId !== mlRequestRef.current) return;
      if (!result) {
        // trainAndPredict returns null for two reasons:
        //   1. Intentional skip (insufficient candlesRef.current, etc.) → type:'skipped' recorded
        //   2. Caught exception → type:'failed' recorded
        // Read the latest training status to show the actual reason.
        try {
          const history = await getTrainingHistory(symbol, tf);
          const latest = history?.[history.length - 1];
          if (latest?.type === 'skipped' && latest?.skipReason) {
            setMl({ status: 'error', data: null, err: `Skipped: ${latest.skipReason}` });
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
    }
  }, [symbol, tf, assetType, prices]);

  // Trade quality — memoized separately from prediction runner
  const tradeQualityResult = useMemo(() => {
    if (!ml.data || ml.data.action === 'HOLD' || !candlesRef.current.length) return null;
    const snapshot = getIndicatorSnapshot(candlesRef.current);
    const regimeLabel = checkRegimeFilter(candlesRef.current, 'DISABLED').currentRegime;
    return fromSinglePrediction(ml.data, candlesRef.current, snapshot, symbol, assetType, regimeLabel);
  }, [ml.data, symbol, assetType]);

  return {
    ml, retrainDecision, postPredictionMsg,
    runMLPrediction, tradeQualityResult,
  };
}
