// ─────────────────────────────────────────────────────────────────────────────
// useChartData  (v6.0.4)
//
// Owns ALL candle loading logic. No as-any bridge. Strict TypeScript throughout.
//
// Design decision:
//   The only external side effect during a load is the caller resetting its own
//   AI state. Rather than exposing internal setters (which breaks encapsulation),
//   the hook accepts an optional `onBeforeLoad` callback. ChartScreen passes
//   `() => setAi({ status: 'idle', data: null, err: null })`. This is the
//   standard React pattern for side-effect injection — identical to how
//   useEffect cleanup functions work.
// ─────────────────────────────────────────────────────────────────────────────
import { useState, useEffect, useRef, useCallback } from 'react';
import { Candle } from '../../../utils/indicators';
import { useData } from '../../../context/DataContext';
import { fetchBnKlines, subscribeToBnKline } from '../../../api/binance';
import { fetchAVKlines } from '../../../api/alphaVantage';
import { aoCandles, aoCandlesBefore } from '../../../api/angelOne';
import { getCachedCandles, setCachedCandles, mergeCandles } from '../../../utils/candleCache';
import { recordSampleCount } from '../../../utils/sampleHistory';
import { detectGaps, repairGaps } from '../../../utils/gapDetection';
import { getPricePrecision, getPricePrecisionSync } from '../../../utils/pricePrecision';
import { invalidateCorrelationCache } from '../../../utils/correlationEngine';
import { logger } from '../../../utils/logger';

const TF_MS: Record<string, number> = {
  '5m': 300000, '15m': 900000, '30m': 1800000,
  '1h': 3600000, '4h': 14400000, '1D': 86400000,
};
export const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1D', '1W'];

type UseChartDataCallbacks = {
  /** Called once at the start of every loadCandles invocation.
   *  Use this to reset screen-level state (e.g. AI copilot result)
   *  before new candle data arrives. */
  onBeforeLoad?: () => void;
};

export function useChartData(
  initialSymbol: string,
  callbacks: UseChartDataCallbacks = {},
) {
  const { prices, aoSession, avKey, allAssets } = useData();
  const { onBeforeLoad } = callbacks;

  const [symbol, setSymbol] = useState(initialSymbol);
  const [tf, setTf] = useState('15m');
  const [candles, setCandles] = useState<Candle[]>([]);
  const [loading, setLoading] = useState(false);
  const [errMsg, setErrMsg] = useState('');
  const [candleLoadExplanation, setCandleLoadExplanation] = useState('');
  const [dataSrc, setDataSrc] = useState<'live' | 'none'>('none');
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [pricePrecision, setPricePrecision] = useState(2);
  const [nowTick, setNowTick] = useState(Date.now());
  const loadRequestRef  = useRef(0);
  // Fix 1: throttle kline → setCandles to 500ms so the expensive
  // useChartIndicators useMemo runs at most 2×/sec instead of every message.
  // The candle close (k.isClosed) path is always immediate — not throttled.
  const lastKlinePaintMs = useRef(0);
  // Fix 2: when kline stream is active for a Binance symbol, miniTicker's
  // setCandles call is redundant (kline owns OHLCV). This ref prevents the
  // duplicate render without touching DataContext or miniTicker itself.
  const klineActiveRef  = useRef(false);

  const asset = allAssets.find(a => a.symbol === symbol) || allAssets[0];
  const cp = prices[symbol];

  // ── Price precision ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!asset) return;
    let cancelled = false;
    setPricePrecision(getPricePrecisionSync(asset));
    getPricePrecision(asset)
      .then(p => { if (!cancelled) setPricePrecision(p); })
      .catch(() => {});
    // Fix 3: evict correlation cache entries for the previous symbol.
    // The cleanup function receives the OLD symbol value (the one being
    // replaced) so we capture it in a const at effect entry time.
    const prevSymbol = symbol;
    return () => {
      cancelled = true;
      invalidateCorrelationCache(prevSymbol);
    };
  }, [symbol, asset]);

  // ── 1-second tick for live candle countdown ──────────────────────────────────
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // ── Live candle price update (tick-level close/high/low update) ──────────────
  useEffect(() => {
    if (!cp?.price || !candles.length) return;
    const intervalMs = TF_MS[tf];
    if (!intervalMs) return;
    const last = candles[candles.length - 1];
    const now = Date.now();

    if (now >= last.time + intervalMs) {
      // Current candle has closed. Open the next candle using the live price.
      // Align the new candle's open time to the nearest TF boundary so it
      // matches what the exchange will eventually return.
      const newCandleTime = last.time + intervalMs;
      setCandles(prev => {
        if (!prev.length) return prev;
        // Only append if the last candle is still the closed one (guard against
        // the effect running multiple times before the new candle arrives).
        const tail = prev[prev.length - 1];
        if (tail.time >= newCandleTime) return prev; // already appended
        // volume: use cp.volume if the data source provides it (AO ticks do).
        // Binance tick doesn't carry cumulative interval volume, so 0 is the
        // correct placeholder — it will be replaced when mergeCandles() receives
        // the real candle from the exchange (fresh data wins by timestamp).
        return [...prev, {
          time:   newCandleTime,
          open:   cp.price,
          high:   cp.price,
          low:    cp.price,
          close:  cp.price,
          volume: (cp as any).volume ?? 0,
        }];
      });
      return;
    }

    // Candle still open — update high/low/close with latest tick.
    // Skip if kline stream is active for this Binance symbol: kline already
    // provides more accurate OHLCV and a duplicate setCandles here would
    // cause a redundant indicator recomputation on every price tick.
    if (klineActiveRef.current && asset?.src === 'binance') return;
    setCandles(prev => {
      if (!prev.length) return prev;
      const updated = [...prev];
      const i = updated.length - 1;
      updated[i] = {
        ...updated[i],
        high:  Math.max(updated[i].high, cp.price),
        low:   Math.min(updated[i].low,  cp.price),
        close: cp.price,
      };
      return updated;
    });
  }, [cp?.price]);

  // ── Primary candle load — full implementation (previously split across hook
  //    and ChartScreen). Race-guarded with loadRequestRef. ─────────────────────
  const loadCandles = useCallback(async () => {
    const myRequestId = ++loadRequestRef.current;

    // Notify caller before any state changes (used to reset AI state)
    onBeforeLoad?.();
    setErrMsg('');
    setCandleLoadExplanation('');

    // 1. Show cached data instantly if available so the chart never sits blank
    const cached = await getCachedCandles(symbol, tf);
    if (myRequestId !== loadRequestRef.current) return;

    if (cached?.candles?.length) {
      setCandles(cached.candles);
      setDataSrc('live');
      setLoading(false);
      if (cached.isFresh) {
        // Cache is within TTL — skip network entirely, no stale data risk
        await recordSampleCount(
          symbol, tf, cached.candles.length,
          `History restored from cache (still within freshness window) — ${cached.candles.length} candles.`,
          'cache_fresh',
        ).catch(() => {});
        return;
      }
    } else {
      setLoading(true);
    }

    // 2. Fetch fresh data from the appropriate source
    try {
      let data: Candle[] = [];

      if (asset.src === 'binance' && asset.bnSym) {
        data = await fetchBnKlines(asset.bnSym, tf, 500);
        setDataSrc('live');
      } else if (asset.src === 'ao' && aoSession?.jwtToken && asset.aoToken && asset.aoEx) {
        data = await aoCandles(asset.aoToken, asset.aoEx, tf, aoSession);
        setDataSrc('live');
      } else if (asset.src === 'av' && asset.avSym && avKey) {
        data = await fetchAVKlines(asset.avSym, tf, avKey);
        setDataSrc('live');
      } else {
        // No usable source — surface a clear reason, never fabricate data
        if (!cached?.candles?.length) setDataSrc('none');
        if (asset.src === 'ao') {
          setErrMsg('Angel One not connected — connect it in Settings to see this chart.');
        } else if (asset.src === 'av') {
          setErrMsg('Alpha Vantage key not set — add one in Settings to see this chart.');
        } else {
          setErrMsg('No live data source available for this asset.');
        }
        setLoading(false);
        return;
      }

      if (myRequestId !== loadRequestRef.current) {
        logger.info('useChartData', `Discarding stale candle load for ${symbol}/${tf} (req ${myRequestId}, current ${loadRequestRef.current})`);
        return;
      }

      // 3. Gap detection and repair
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
          return []; // av has no clean range-query for gap-filling
        });
      }

      if (myRequestId !== loadRequestRef.current) return;

      // 4. Merge with previously loaded history (preserves scroll-back data)
      const merged = cached?.candles?.length
        ? mergeCandles(cached.candles, data)
        : data;

      setCandles(merged);
      setDataSrc('live');
      setCachedCandles(symbol, tf, merged).catch(() => {});
      await recordSampleCount(symbol, tf, merged.length).catch(() => {});
    } catch (e: any) {
      if (myRequestId !== loadRequestRef.current) return;
      setErrMsg(e.message ?? 'Failed to load candles');
    } finally {
      if (myRequestId === loadRequestRef.current) setLoading(false);
    }
  }, [symbol, tf, asset, aoSession, avKey, onBeforeLoad]);

  // Auto-reload when symbol/TF changes
  useEffect(() => { loadCandles(); }, [loadCandles]);

  // ── Binance kline stream: real-time OHLCV + candle-close detection ──────────
  // Provides live cumulative volume for the forming candle and a proper isClosed
  // flag — replacing the synthetic candle approach and fixing the stale volume label.
  useEffect(() => {
    if (!asset?.bnSym || !TF_MS[tf]) return;
    const unsub = subscribeToBnKline(
      asset.bnSym, tf,
      (k) => {
        klineActiveRef.current = true;
        if (k.isClosed) {
          // Candle close: always immediate — append new candle without throttle
          lastKlinePaintMs.current = 0; // reset so next intra update paints fast
          setCandles(prev => {
            if (!prev.length) return prev;
            const tail = prev[prev.length - 1];
            // Update the closing candle's final OHLCV
            const closed = [...prev];
            const ci = closed.length - 1;
            closed[ci] = { ...closed[ci], high: Math.max(closed[ci].high, k.high),
              low: Math.min(closed[ci].low, k.low), close: k.close, volume: k.volume };
            // If the new candle time differs, append it
            if (tail.time < k.time) {
              return [...closed, { time: k.time, open: k.open, high: k.high,
                low: k.low, close: k.close, volume: k.volume }];
            }
            return closed;
          });
          return;
        }
        // Intra-candle update: throttle to 500ms so useChartIndicators
        // runs at most 2×/sec (was running on every kline message ~1/sec+).
        const now = Date.now();
        if (now - lastKlinePaintMs.current < 500) return;
        lastKlinePaintMs.current = now;
        setCandles(prev => {
          if (!prev.length) return prev;
          const tail = prev[prev.length - 1];
          const kTime = k.time;
          if (tail.time !== kTime) return prev; // guard: wrong candle
          const updated = [...prev];
          const i = updated.length - 1;
          updated[i] = { ...updated[i], high: Math.max(updated[i].high, k.high),
            low: Math.min(updated[i].low, k.low), close: k.close, volume: k.volume };
          return updated;
        });
      },
      () => {},
    );
    return () => {
      klineActiveRef.current = false;
      unsub();
    };
  }, [asset?.bnSym, tf]);

  // ── Load older history (scroll-back) ─────────────────────────────────────────
  const loadMoreHistory = useCallback(async () => {
    if (!candles.length || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const oldest = candles[0].time;
      let older: Candle[] = [];
      if (asset.src === 'binance' && asset.bnSym) {
        // Binance: fetch 500 candles ending just before the oldest candle we have.
        // endTime is exclusive in Binance API so subtract 1ms.
        older = await fetchBnKlines(asset.bnSym, tf, 500, oldest - 1);
      } else if (asset.src === 'ao' && aoSession?.jwtToken && asset.aoToken && asset.aoEx) {
        older = await aoCandlesBefore(asset.aoToken, asset.aoEx, tf, oldest, aoSession);
      }
      if (older.length) setCandles(prev => mergeCandles(older, prev));
    } catch (e: any) {
      logger.warn('useChartData', e.message);
    } finally {
      setLoadingOlder(false);
    }
  }, [candles, symbol, tf, asset, aoSession, loadingOlder]);

  // ── Live candle countdown info (derived, not stored) ──────────────────────────
  const liveCandleInfo = (() => {
    if (!candles.length) return null;
    const intervalMs = TF_MS[tf];
    if (!intervalMs) return null;
    const last = candles[candles.length - 1];
    const remainingMs = Math.max(0, last.time + intervalMs - nowTick);
    if (remainingMs <= 0) return null;
    const mins = Math.floor(remainingMs / 60000);
    const secs = Math.floor((remainingMs % 60000) / 1000);
    const changePct = ((last.close - last.open) / last.open) * 100;
    return {
      candle:         last,
      countdownLabel: mins > 0 ? `${mins}m ${secs}s` : `${secs}s`,
      changePct,
    };
  })();

  return {
    // Identity
    symbol, setSymbol,
    tf,     setTf,
    // Candles
    candles,
    loading,
    errMsg,
    candleLoadExplanation,
    dataSrc,
    loadingOlder,
    // Actions
    loadCandles,
    loadMoreHistory,
    // Derived
    pricePrecision,
    cp,
    asset,
    assetType: asset?.type ?? 'crypto',
    liveCandleInfo,
    TIMEFRAMES,
  };
}
