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
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Candle } from '../../../utils/indicators';
import { useData } from '../../../context/DataContext';
import { resolveVariant, findAssetByLegacySymbol } from '../../../utils/assetResolver';
import type { LogicalAsset, ExchangeVariant } from '../../../api/assets';
import { fetchBnKlines, subscribeToBnKline, openBinanceAggTradeStream } from '../../../api/binance';
import { fetchCdxCandles, fetchCdxFuturesCandles, subscribeToCdxKline } from '../../../api/coindcx';
import { fetchAVKlines } from '../../../api/alphaVantage';
import { aoCandles, aoCandlesBefore, openAOMarketFeed } from '../../../api/angelOne';
import { getCachedCandles, setCachedCandles, mergeCandles } from '../../../utils/candleCache';
import { memGet, memSet, memEvict, getAdjacentTfs } from '../../../utils/candleMemoryCache';
import { recordSampleCount } from '../../../utils/sampleHistory';
import { detectGaps, repairGaps } from '../../../utils/gapDetection';
import { getPricePrecision, getPricePrecisionSync } from '../../../utils/pricePrecision';
import { invalidateCorrelationCache } from '../../../utils/correlationEngine';
import { logger } from '../../../utils/logger';

const TF_MS: Record<string, number> = {
  '1m': 60000, '5m': 300000, '15m': 900000, '30m': 1800000,
  '1h': 3600000, '4h': 14400000, '1D': 86400000, '1W': 604800000,
};
export const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1D', '1W'];

type UseChartDataCallbacks = {
  /** Called once at the start of every loadCandles invocation.
   *  Use this to reset screen-level state (e.g. AI copilot result)
   *  before new candle data arrives. */
  onBeforeLoad?: () => void;
  /** Called whenever a candle closes (kline isClosed = true).
   *  Used to trigger background precomputeSeries so the cache is warm
   *  before the user taps Predict. Receives the updated candles array. */
  onCandleClose?: (candles: Candle[]) => void;
};

export function useChartData(
  initialAssetId: string,
  initialExchange?: string,
  callbacks: UseChartDataCallbacks = {},
) {
  const { prices, aoSession, avKey, allAssets, nftTokenVersion, nftTokenError, updateSpotPrice } = useData();
  const { onBeforeLoad, onCandleClose } = callbacks;
  const onCandleCloseRef = useRef(onCandleClose);
  onCandleCloseRef.current = onCandleClose;

  // ── Resolve assetId + exchange to variant ──────────────────────────────────
  // Backward compat: if initialAssetId looks like a legacy symbol (e.g. 'BTCUSD'),
  // resolve it to (assetId, exchange) so old navigation params still work.
  const resolveInitial = () => {
    // Try as legacy symbol first
    const legacy = findAssetByLegacySymbol(initialAssetId);
    if (legacy) return { assetId: legacy.assetId, exchange: legacy.exchange };
    // Otherwise treat as assetId directly
    return { assetId: initialAssetId, exchange: initialExchange ?? '' };
  };
  const initial = resolveInitial();

  const [assetId,  setAssetId]  = useState(initial.assetId);
  const [exchange, setExchange] = useState(initial.exchange);
  const [tf, setTf] = useState('15m');

  // Derive the active variant — O(1) lookup, recomputes only on assetId/exchange change
  // FIX REGRESSION: variant was computed inline as a new object on every render.
  // Because it was in loadCandles' dep array, loadCandles rebuilt every render →
  // useEffect fired → candle reload → setCandles → render → new variant → loop.
  // Memoized by [assetId, exchange] so it only changes when the user actually
  // switches asset or exchange.
  const variant: ExchangeVariant | undefined = useMemo(() => {
    const built = resolveVariant(assetId, exchange);
    if (built) return built;
    // Fallback for custom assets not in built-in ASSETS
    const customFlat = allAssets.find((a: any) =>
      (a.assetId ?? a.symbol) === assetId && (!exchange || a.src === exchange)
    ) ?? allAssets.find((a: any) => (a.assetId ?? a.symbol) === assetId);
    if (!customFlat) return undefined;
    return {
      src: customFlat.src, symbol: customFlat.symbol, base: customFlat.base, vol: customFlat.vol,
      bnSym: customFlat.bnSym, cdxSym: (customFlat as any).cdxSym, cdxMkt: (customFlat as any).cdxMkt,
      aoToken: customFlat.aoToken, aoEx: customFlat.aoEx, avSym: customFlat.avSym,
      fxKey: customFlat.fxKey, fxInv: customFlat.fxInv,
    } as ExchangeVariant;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetId, exchange]); // allAssets intentionally omitted — built-ins are stable

  // symbol = variant.symbol — the internal ML/cache/price key
  // Fallback chain: variant.symbol → find in allAssets by symbol → assetId itself
  // This prevents undefined symbol crashing trainAndPredict, candleCache etc.
  const symbol = variant?.symbol
    ?? allAssets.find((a: any) => a.symbol === assetId || a.assetId === assetId)?.symbol
    ?? assetId;
  const [candles, setCandles] = useState<Candle[]>([]);
  const [loading, setLoading] = useState(false);
  const [errMsg, setErrMsg] = useState('');
  const [candleLoadExplanation, setCandleLoadExplanation] = useState('');
  const [dataSrc, setDataSrc] = useState<'live' | 'none'>('none');
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [pricePrecision, setPricePrecision] = useState(2);
  // FIX H-2: nowTick removed from this hook — moved into LiveCandleCountdown component
  // to prevent the 1s setInterval from causing full ChartScreen re-renders every second.
  const loadRequestRef  = useRef(0);
  // Fix 1: throttle kline → setCandles to 500ms so the expensive
  // useChartIndicators useMemo runs at most 2×/sec instead of every message.
  // The candle close (k.isClosed) path is always immediate — not throttled.
  const lastKlinePaintMs = useRef(0);
  // Fix 2: when kline stream is active for a Binance symbol, miniTicker's
  // setCandles call is redundant (kline owns OHLCV). This ref prevents the
  // duplicate render without touching DataContext or miniTicker itself.
  const klineActiveRef  = useRef(false);

  // asset: the flat Asset entry for the current (assetId, exchange) pair.
  // The compatibility shim in DataContext adds `assetId` to each flat Asset entry,
  // so we can find the correct variant (e.g. Binance BTC vs CoinDCX BTC).
  // Falls back to first asset if not found (e.g. during initial render).
  const asset = allAssets.find((a: any) =>
    a.assetId === assetId && a.src === (exchange || '')
  ) ?? allAssets.find((a: any) => a.assetId === assetId) ?? allAssets[0];
  const cp = prices[symbol];

  // ── Price precision ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!variant) return;
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
          volume: (cp as any).volume ?? 0}];
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
        close: cp.price};
      return updated;
    });
  }, [cp?.price]);

  // ── Primary candle load — full implementation (previously split across hook
  //    and ChartScreen). Race-guarded with loadRequestRef. ─────────────────────
  const loadCandles = useCallback(async () => {
    const myRequestId = ++loadRequestRef.current;
    // ── PERF PROBE ───────────────────────────────────────────────────────────
    const _lc0 = Date.now();
    // ────────────────────────────────────────────────────────────────────────

    // Notify caller before any state changes (used to reset AI state)
    onBeforeLoad?.();
    setErrMsg('');
    setCandleLoadExplanation('');

    // 1a. L1: Memory cache (0ms) — fastest possible, survives TF switches
    const memCached = memGet(symbol, tf);
    if (memCached?.length) {
      setCandles(memCached);
      setDataSrc('live');
      setLoading(false);
      // Still refresh in background if memory is stale (>3 min for 1m, etc.)
      // but don't wait for it — user sees data instantly
    }

    // 1b. L2: AsyncStorage cache (~50ms) — survives app restarts
    const cached = await getCachedCandles(symbol, tf);
    if (myRequestId !== loadRequestRef.current) return;

    if (cached?.candles?.length) {
      if (!memCached?.length) {
        // Only update if memory cache was empty (don't downgrade fresh memory)
        setCandles(cached.candles);
        memSet(symbol, tf, cached.candles); // promote to L1
      }
      setDataSrc('live');
      setLoading(false);
      if (cached.isFresh && memCached?.length) {
        // Cache is within TTL — skip network entirely, no stale data risk
        await recordSampleCount(
          symbol, tf, cached.candles.length,
          `History restored from cache (still within freshness window) — ${cached.candles.length} candles.`,
          'cache_fresh',
        ).catch(() => {});
        return;
      }
    } else {
      // No cache for this TF — show loading but keep previous candles visible
      // so chart doesn't go blank during TF switch
      setLoading(true);
      // Don't clear candles here — let old candles show until new ones arrive
    }

    // 2. Fetch fresh data from the appropriate source
    try {
      let data: Candle[] = [];

      if (variant?.src === 'binance' && variant?.bnSym) {
        const _nw = Date.now();
        data = await fetchBnKlines(variant!.bnSym!, tf, 300); // 300 = ~40% faster than 500, still enough for all indicators
        setDataSrc('live');
      } else if (variant?.src === 'coindcx' && variant?.cdxSym) {
        data = await fetchCdxCandles(variant!.cdxSym!, tf, 500);
        setDataSrc('live');
      } else if (variant?.src === 'coindcx_futures' && variant?.cdxSym) {
        // fetchCdxFuturesCandles internally converts to spot pair format (ETHUSDT)
        // CoinDCX perp tracks spot price exactly — spot candles are correct
        data = await fetchCdxFuturesCandles(variant!.cdxSym!, tf, 500);
        setDataSrc('live');
      } else if ((variant?.src === 'ao' || variant?.src === 'ao_futures') && aoSession?.jwtToken && variant?.aoToken && variant?.aoEx) {
        // ao_futures uses the same Angel One API as ao — only the exchange (NFO) differs,
        // which is already encoded in asset.aoEx on futures assets.
        console.log(
          `[NFO Pipeline] Fetching candles` +
          ` | symbol=${symbol}` +
          ` | token=${asset.aoToken}` +
          ` | exchange=${asset.aoEx}` +
          ` | tf=${tf}` +
          ` | src=${asset.src}`
        );
        data = await aoCandles(variant!.aoToken!, variant!.aoEx!, tf, aoSession);
        console.log(`[NFO Pipeline] Response candles=${data.length} | symbol=${symbol} | token=${asset.aoToken}`);
        setDataSrc('live');
      } else if (variant?.src === 'av' && variant?.avSym && avKey) {
        data = await fetchAVKlines(variant!.avSym!, tf, avKey);
        setDataSrc('live');
      } else {
        // No usable source — surface a clear reason, never fabricate data
        if (!cached?.candles?.length) setDataSrc('none');
        if (variant?.src === 'ao' || variant?.src === 'ao_futures') {
          const hasSession = !!aoSession?.jwtToken;
          const hasToken   = !!variant?.aoToken;
          const hasEx      = !!variant?.aoEx;
          console.log(
            `[NFO Pipeline] Cannot fetch candles` +
            ` | symbol=${symbol}` +
            ` | hasSession=${hasSession}` +
            ` | token=${asset.aoToken || '(empty)'}` +
            ` | exchange=${asset.aoEx || '(empty)'}` +
            ` | src=${asset.src}` +
            ` | nftTokenError=${nftTokenError ?? 'none'}`
          );
          // Three distinct states — each with actionable feedback:
          // Show error only after resolution has been attempted (nftTokenVersion > 0).
          // While nftTokenVersion === 0, the scrip master fetch is still in progress —
          // showing an error at this point is premature (the fetch may succeed in 5-15s).
          const resolutionAttempted = nftTokenVersion > 0;
          const msg = !hasSession
            ? 'Angel One not connected — connect it in Settings to see this chart.'
            : nftTokenError && resolutionAttempted
            ? `Instrument token fetch failed: ${nftTokenError}. Check your connection and re-login to Angel One.`
            : !hasToken
            ? 'Loading instrument data from Angel One — chart will load automatically in a few seconds.'
            : 'Angel One exchange not configured for this asset.';
          setErrMsg(msg);
        } else if (variant?.src === 'av') {
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
          if (variant?.src === 'binance' && variant?.bnSym) {
            const filler = await fetchBnKlines(asset.bnSym, tf, 150, toTime);
            return filler.filter(c => c.time >= fromTime && c.time <= toTime);
          }
          if (variant?.src === 'coindcx' && variant?.cdxSym) {
            const filler = await fetchCdxCandles(variant!.cdxSym!, tf, 150, toTime);
            return filler.filter(c => c.time >= fromTime && c.time <= toTime);
          }
          if ((variant?.src === 'ao' || variant?.src === 'ao_futures') && aoSession?.jwtToken && variant?.aoToken && variant?.aoEx) {
            const filler = await aoCandlesBefore(variant!.aoToken!, variant!.aoEx!, tf, toTime + 60000, aoSession);
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
      memSet(symbol, tf, merged); // L1: 0ms for next TF switch this session
      setCachedCandles(symbol, tf, merged).catch(() => {}); // L2: persists across restarts
      await recordSampleCount(symbol, tf, merged.length).catch(() => {});
    } catch (e: any) {
      if (myRequestId !== loadRequestRef.current) return;
      setErrMsg(e.message ?? 'Failed to load candles');
    } finally {
      if (myRequestId === loadRequestRef.current) setLoading(false);
    }
  }, [symbol, tf, variant, aoSession, avKey, onBeforeLoad, nftTokenVersion, nftTokenError]);

  // Auto-reload when symbol/TF changes
  useEffect(() => { loadCandles(); }, [loadCandles]);

  // Evict memory cache for previous symbol to free memory
  const prevSymbolRef = React.useRef(symbol);
  useEffect(() => {
    if (prevSymbolRef.current !== symbol) {
      memEvict(prevSymbolRef.current);
      prevSymbolRef.current = symbol;
    }
  }, [symbol]);

  // ── Adjacent TF prefetch — makes TF switching instant ────────────────────────
  // After loading candles for current TF, silently prefetch adjacent TFs
  // so switching to them reads from memory (0ms) instead of network (800ms).
  // Fire-and-forget — never blocks the current chart load.
  React.useEffect(() => {
    if (!variant?.bnSym || !candles.length) return;
    const adjacentTfs = getAdjacentTfs(tf);
    adjacentTfs.forEach(adjTf => {
      // Skip if already in memory (already prefetched or loaded before)
      if (memGet(symbol, adjTf)) return;
      // Fire-and-forget background fetch
      fetchBnKlines(variant!.bnSym!, adjTf, 300)
        .then(data => {
          if (data.length) {
            memSet(symbol, adjTf, data);
            setCachedCandles(symbol, adjTf, data).catch(() => {});
          }
        })
        .catch(() => {}); // silent — prefetch failure is non-fatal
    });
  }, [symbol, tf, candles.length > 0]); // only runs when candles actually loaded

  // ── Kline stream: real-time OHLCV + candle-close detection ──────────
  // ── Binance kline stream: real-time OHLCV + candle-close detection ──────────
  // Provides live cumulative volume for the forming candle and a proper isClosed
  // flag — replacing the synthetic candle approach and fixing the stale volume label.
  useEffect(() => {
    if (!variant?.bnSym || !TF_MS[tf]) return;
    const unsub = subscribeToBnKline(
      variant!.bnSym!, tf,
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
            const next = tail.time < k.time
              ? [...closed, { time: k.time, open: k.open, high: k.high,
                  low: k.low, close: k.close, volume: k.volume }]
              : closed;
            // Fire onCandleClose with the settled candles array so the
            // prediction engine can warm the precomputeSeries cache before
            // the user taps Predict.
            setTimeout(() => onCandleCloseRef.current?.(next), 0);
            return next;
          });
          return;
        }
        // Intra-candle update: throttle to 1000ms so useChartIndicators
        // runs at most 1×/sec (was 500ms = 2×/sec, causing continuous recomputation).
        const now = Date.now();
        if (now - lastKlinePaintMs.current < 1000) return;
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
  }, [variant?.bnSym, tf]);

  // ── Binance aggTrade stream: per-trade price for the chart screen ──────────
  // miniTicker in DataContext updates prices at 1s. For the chart screen header
  // price display we want trade-level frequency (~50-200ms on liquid pairs).
  // This stream updates DataContext's price for the current symbol only,
  // running alongside the kline stream. It's lightweight (text only, ~40 bytes
  // per message) and is closed when the symbol changes or component unmounts.
  // The chg% comes from the last miniTicker value — we only override the price.
  const aggTradeRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!variant?.bnSym) return;
    aggTradeRef.current?.();
    aggTradeRef.current = openBinanceAggTradeStream(
      variant!.bnSym!,
      (tradePrice) => {
        // 1. Update the forming candle's close/high/low for chart rendering
        setCandles(prev => {
          if (!prev.length) return prev;
          const now = Date.now();
          if (now - lastKlinePaintMs.current < 1000) return prev;
          const updated = [...prev];
          const last = updated[updated.length - 1];
          updated[updated.length - 1] = {
            ...last,
            close: tradePrice,
            high: Math.max(last.high, tradePrice),
            low: Math.min(last.low, tradePrice),
          };
          return updated;
        });
        // 2. Update DataContext prices so cp.price (header + livePrice prop) refreshes
        //    at trade frequency — not just miniTicker 1s cadence.
        if (asset?.symbol) updateSpotPrice(asset.symbol, tradePrice);
      },
    );
    return () => {
      aggTradeRef.current?.();
      aggTradeRef.current = null;
    };
  }, [variant?.bnSym]);

  // ── Angel One SmartAPI WebSocket: tick-by-tick LTP for chart screen ───────
  // For AO/AO_futures assets, subscribe to the active symbol's token in
  // QUOTE_MODE (2) which gives LTP + OHLCV per tick. This replaces the 5s poll
  // latency with near-real-time updates (~100-500ms on liquid NSE stocks).
  // DataContext's existing poll still runs for depth — this stream only updates
  // price and updates the forming candle's close/high/low.
  const aoWSChartRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    aoWSChartRef.current?.();
    aoWSChartRef.current = null;
    const isAO = variant?.src === 'ao' || variant?.src === 'ao_futures';
    if (!isAO || !aoSession?.feedToken || !variant?.aoToken || !variant?.aoEx) return;

    aoWSChartRef.current = openAOMarketFeed(
      [{ symbol: symbol, token: variant!.aoToken!, aoEx: variant!.aoEx! }],
      aoSession,
      (sym, ltp, ohlcv) => {
        // Update forming candle
        setCandles(prev => {
          if (!prev.length) return prev;
          const updated = [...prev];
          const last = updated[updated.length - 1];
          updated[updated.length - 1] = {
            ...last,
            close: ltp,
            high: Math.max(last.high, ltp),
            low: Math.min(last.low, ltp),
            ...(ohlcv ? { volume: ohlcv.volume } : {}),
          };
          return updated;
        });
        // Update DataContext price so header refreshes
        updateSpotPrice(sym, ltp);
      },
      () => {}, // Status handled by DataContext's WS
      2,        // QUOTE_MODE: LTP + OHLCV — gives us volume for forming candle
    );
    return () => {
      aoWSChartRef.current?.();
      aoWSChartRef.current = null;
    };

  // ── CoinDCX kline poll: real-time candle + candle-close detection ────────────
  // Uses subscribeToCdxKline which polls the latest candle every 3s (REST-based,
  // no socket.io dependency). On candle close, fires onCandleClose to warm the
  // precompute cache — identical behaviour to the Binance kline stream.
  const cdxKlineRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    cdxKlineRef.current?.();
    cdxKlineRef.current = null;
    if (!variant?.cdxSym || !TF_MS[tf]) return;

    cdxKlineRef.current = subscribeToCdxKline(
      variant!.cdxSym!, tf,
      (k) => {
        klineActiveRef.current = true;
        if (k.isClosed) {
          lastKlinePaintMs.current = 0;
          setCandles(prev => {
            if (!prev.length) return prev;
            const closed = [...prev];
            const ci = closed.length - 1;
            closed[ci] = {
              ...closed[ci],
              high:   Math.max(closed[ci].high, k.high),
              low:    Math.min(closed[ci].low,  k.low),
              close:  k.close,
              volume: k.volume,
            };
            // Append new candle if time differs
            const tail = prev[prev.length - 1];
            const next = tail.time < k.time
              ? [...closed, { time: k.time, open: k.open, high: k.high,
                  low: k.low, close: k.close, volume: k.volume }]
              : closed;
            setTimeout(() => onCandleCloseRef.current?.(next), 0);
            return next;
          });
          return;
        }
        // Intra-candle update: throttle to 3s (poll interval)
        const now = Date.now();
        if (now - lastKlinePaintMs.current < 3000) return;
        lastKlinePaintMs.current = now;
        setCandles(prev => {
          if (!prev.length) return prev;
          const tail = prev[prev.length - 1];
          if (tail.time !== k.time) return prev;
          const updated = [...prev];
          const i = updated.length - 1;
          updated[i] = {
            ...updated[i],
            high:   Math.max(updated[i].high, k.high),
            low:    Math.min(updated[i].low,  k.low),
            close:  k.close,
            volume: k.volume,
          };
          return updated;
        });
      },
      () => {},
    );

    return () => {
      cdxKlineRef.current?.();
      cdxKlineRef.current = null;
    };
  }, [variant?.cdxSym, tf]);
  }, [variant?.aoToken, variant?.aoEx, aoSession?.feedToken]);

  // ── Load older history (scroll-back) ─────────────────────────────────────────
  const loadMoreHistory = useCallback(async () => {
    if (!candles.length || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const oldest = candles[0].time;
      let older: Candle[] = [];
      if (variant?.src === 'binance' && variant?.bnSym) {
        // Binance: fetch 500 candles ending just before the oldest candle we have.
        // endTime is exclusive in Binance API so subtract 1ms.
        older = await fetchBnKlines(asset.bnSym, tf, 500, oldest - 1);
      } else if ((variant?.src === 'coindcx' || variant?.src === 'coindcx_futures') && variant?.cdxSym) {
        // CoinDCX: same pattern — fetch ending just before oldest.
        older = await fetchCdxCandles(asset.cdxSym, tf, 500, oldest - 1);
      } else if ((variant?.src === 'ao' || variant?.src === 'ao_futures') && aoSession?.jwtToken && variant?.aoToken && variant?.aoEx) {
        older = await aoCandlesBefore(asset.aoToken, asset.aoEx, tf, oldest, aoSession);
      }
      if (older.length) setCandles(prev => mergeCandles(older, prev));
    } catch (e: any) {
      logger.warn('useChartData', e.message);
    } finally {
      setLoadingOlder(false);
    }
  }, [candles, symbol, tf, variant, aoSession, loadingOlder]);

  return {
    // Identity — new production API
    assetId,  setAssetId,
    exchange, setExchange,
    variant,
    // symbol: internal ML/cache/price key — derived from variant.symbol
    // Still exposed for consumers that read it directly (ML hooks, price display)
    symbol,
    // Legacy setSymbol — resolves a legacy symbol string back to (assetId, exchange)
    // Keeps SymbolSearch and other consumers working without changes
    setSymbol: (legacySymbol: string) => {
      const resolved = findAssetByLegacySymbol(legacySymbol);
      if (resolved) {
        setAssetId(resolved.assetId);
        setExchange(resolved.exchange);
      } else {
        // Unknown symbol (custom asset) — treat assetId = symbol, use default exchange
        setAssetId(legacySymbol);
        setExchange('');
      }
    },
    tf, setTf,
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
    asset,       // LogicalAsset (for type, name, available exchanges)
    assetType: asset?.type ?? 'crypto',
    // liveCandleInfo removed — use LiveCandleCountdown component directly (FIX H-2)
    TIMEFRAMES};
}
