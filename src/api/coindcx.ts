// ─────────────────────────────────────────────────────────────────────────────
// COINDCX DATA API  (v2.0.0 — Phase 8: Socket.IO real-time)
//
// Phase 8 upgrades from 5s REST poll to CoinDCX's socket.io v2.4.0 WebSocket,
// matching Binance's ~100ms latency for live price and kline updates.
//
// Architecture:
//   fetchCdxCandles     — unchanged (REST, used for chart history)
//   fetchCdxSnapshot    — unchanged (REST, used for initial price seed)
//   openCdxPriceStream  — UPGRADED: socket.io 'coindcx-ticker' event
//   subscribeToCdxKline — UPGRADED: socket.io 'new-trade' event per pair
//
// CoinDCX socket.io v2 API:
//   URL:        wss://stream.coindcx.com  (socket.io v2 path)
//   Subscribe:  socket.emit('join', { channelName: 'B-BTC_USDT' })
//   Trades:     socket.on('new-trade', ({ data }) => ...)
//                 data[i] = { p: priceStr, q: qtyStr, T: timestampMs, m: isMaker, s: 'B-BTC_USDT' }
//   Ticker:     socket.on('coindcx-ticker', (tickerArray) => ...)
//                 tickerArray[i] = { market:'BTCUSDT', last_price:'64984', ... }
//
// Fallback: if socket.io fails to connect within 8s, falls back to 5s REST poll
// so the app always has prices even if the WebSocket is unavailable.
// ─────────────────────────────────────────────────────────────────────────────

import { AppState, AppStateStatus } from 'react-native';
import { Candle } from '../utils/indicators';
import { withRetry } from '../utils/retry';
import { logger } from '../utils/logger';
// @ts-ignore — socket.io-client v2 has no bundled TS types for this import style
import io from 'socket.io-client';

const CDX_PUBLIC    = 'https://public.coindcx.com';
const CDX_BASE      = 'https://api.coindcx.com';
const CDX_STREAM    = 'https://stream.coindcx.com';
const CONNECT_TIMEOUT_MS = 8_000;  // fall back to REST poll if no connection in 8s
const RECONNECT_DELAY_MS = 3_000;  // wait 3s before reconnect attempt

// AbortSignal.timeout() polyfill for Hermes on older Android
function timeoutSignal(ms: number): AbortSignal {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  ctrl.signal.addEventListener('abort', () => clearTimeout(id));
  return ctrl.signal;
}

// ── Timeframe mapping ─────────────────────────────────────────────────────────
const TF_CDX: Record<string, string> = {
  '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m',
  '1h': '1h', '4h': '4h', '1D': '1d', '1W': '1w',
};

// ── Candles (unchanged from Phase 1) ─────────────────────────────────────────
// ── CoinDCX Futures candle fetch ─────────────────────────────────────────────
// CoinDCX futures uses the same candle endpoint as spot but with futures pair format
// Pair format for futures: 'B-ETH_USDT' (same as spot market identifier)
// If the main endpoint returns empty, try the derivatives endpoint
export async function fetchCdxFuturesCandles(
  pair: string,
  tf: string,
  limit = 500,
  endTime?: number,
): Promise<Candle[]> {
  // First try the same public candles endpoint — works for futures pairs too
  try {
    const candles = await fetchCdxCandles(pair, tf, limit, endTime);
    if (candles.length > 1) return candles;
  } catch { /* fall through to derivatives endpoint */ }

  // Fallback: try derivatives futures candles endpoint
  return withRetry(async () => {
    const interval = TF_CDX[tf] ?? '15m';
    let url = `${CDX_BASE}/exchange/v1/derivatives/futures/klines?pair=${encodeURIComponent(pair)}&interval=${interval}&limit=${limit}`;
    if (endTime) url += `&endTime=${endTime}`;
    const r = await fetch(url, { signal: timeoutSignal(10_000) });
    if (!r.ok) return [];
    const json: any[] = await r.json();
    const candles: Candle[] = json.map(k => ({
      time:   k.time ?? k[0],
      open:   Number(k.open ?? k[1]),
      high:   Number(k.high ?? k[2]),
      low:    Number(k.low  ?? k[3]),
      close:  Number(k.close ?? k[4]),
      volume: Number(k.volume ?? k[5]),
    }));
    candles.sort((a, b) => a.time - b.time);
    return candles;
  }, { tag: 'cdx-futures-candles', retries: 2 });
}

export async function fetchCdxCandles(
  pair: string,
  tf: string,
  limit = 500,
  endTime?: number,
): Promise<Candle[]> {
  return withRetry(async () => {
    const interval = TF_CDX[tf] ?? '15m';
    let url = `${CDX_PUBLIC}/market_data/candles?pair=${encodeURIComponent(pair)}&interval=${interval}&limit=${limit}`;
    if (endTime) url += `&endTime=${endTime}`;

    const r = await fetch(url, { signal: timeoutSignal(10_000) });
    if (!r.ok) throw new Error(`CoinDCX candles HTTP ${r.status}`);
    const json: any[] = await r.json();

    const candles: Candle[] = json.map(k => ({
      time:   k.time,
      open:   Number(k.open),
      high:   Number(k.high),
      low:    Number(k.low),
      close:  Number(k.close),
      volume: Number(k.volume),
    }));
    candles.sort((a, b) => a.time - b.time);
    return candles;
  }, { tag: 'cdx-candles', retries: 2 });
}

// ── REST snapshot (unchanged — used for initial price seed) ──────────────────
export async function fetchCdxSnapshot(
  markets: string[],
): Promise<Record<string, { price: number; chg: number }>> {
  if (!markets.length) return {};
  try {
    const r = await fetch(`${CDX_BASE}/exchange/ticker`, { signal: timeoutSignal(8_000) });
    if (!r.ok) return {};
    const tickers: any[] = await r.json();
    const set = new Set(markets.map(m => m.toUpperCase()));
    const result: Record<string, { price: number; chg: number }> = {};
    tickers.forEach(t => {
      const market = (t.market ?? '').toUpperCase();
      if (!set.has(market)) return;
      const price = parseFloat(t.last_price ?? '0');
      if (price <= 0) return;
      const open24 = parseFloat(t.open ?? '0') ||
                     ((parseFloat(t.high ?? '0') + parseFloat(t.low ?? '0')) / 2);
      const chg = open24 > 0
        ? ((price - open24) / open24) * 100
        : parseFloat(t.change_24_hour ?? '0');
      result[market] = { price, chg };
    });
    return result;
  } catch (e: any) {
    logger.warn('cdx-snapshot', e.message);
    return {};
  }
}

// ── Shared socket.io connection ────────────────────────────────────────────────
// One socket is shared across all subscribers to avoid creating multiple
// connections for each asset. Binance does the same with its single WebSocket.
let _socket: any | null = null;
let _socketRefCount = 0;
let _socketReady = false;

function getSocket(): Promise<any> {
  return new Promise((resolve, reject) => {
    if (_socket && _socketReady) { resolve(_socket); return; }
    if (_socket && !_socketReady) {
      // Socket exists but not yet connected — wait for it
      _socket.once('connect', () => resolve(_socket));
      _socket.once('connect_error', reject);
      return;
    }

    // Create new socket
    _socket = io(CDX_STREAM, {
      transports:         ['websocket'],
      reconnection:        true,
      reconnectionAttempts: 10,
      reconnectionDelay:   RECONNECT_DELAY_MS,
      timeout:             CONNECT_TIMEOUT_MS,
    });

    _socket.once('connect', () => {
      _socketReady = true;
      logger.info('cdx-socket', 'Socket.IO connected to CoinDCX stream');
      // Debug: log ALL events for first 30 seconds to identify correct event names
      const _debugStart = Date.now();
      _socket.onAny((eventName: string, ...args: any[]) => {
        if (Date.now() - _debugStart < 30000) {
          const preview = JSON.stringify(args[0]).slice(0, 150);
          logger.info('cdx-socket-debug', `event="${eventName}" data=${preview}`);
        }
      });
      resolve(_socket);
    });

    _socket.on('disconnect', (reason: string) => {
      _socketReady = false;
      logger.warn('cdx-socket', `Disconnected: ${reason}`);
    });

    _socket.on('reconnect', () => {
      _socketReady = true;
      logger.info('cdx-socket', 'Reconnected to CoinDCX stream');
    });

    _socket.once('connect_error', (err: Error) => {
      logger.warn('cdx-socket', `Connect error: ${err.message}`);
      reject(err);
    });
  });
}

function releaseSocket() {
  _socketRefCount = Math.max(0, _socketRefCount - 1);
  if (_socketRefCount === 0 && _socket) {
    _socket.disconnect();
    _socket = null;
    _socketReady = false;
    logger.info('cdx-socket', 'Socket disconnected (no more subscribers)');
  }
}

// ── Helper: parse price fields from CoinDCX ticker ───────────────────────────
function parseTicker(t: any): { market: string; price: number; chg: number } | null {
  const market = (t.market ?? '').toUpperCase();
  const price  = parseFloat(t.last_price ?? '0');
  if (!market || price <= 0) return null;
  const open24 = parseFloat(t.open ?? '0') ||
                 ((parseFloat(t.high ?? '0') + parseFloat(t.low ?? '0')) / 2);
  const chg = open24 > 0
    ? ((price - open24) / open24) * 100
    : parseFloat(t.change_24_hour ?? '0');
  return { market, price, chg };
}

// ── Phase 8: Socket.IO price stream ──────────────────────────────────────────
// Subscribes to CoinDCX's 'coindcx-ticker' event which fires on every price
// update (~100ms latency). Falls back to 5s REST poll if socket unavailable.
//
// Returns an unsubscribe function.
export function openCdxPriceStream(
  markets: string[],
  onTick: (market: string, price: number, chg: number) => void,
  onStatus: (s: 'live' | 'connecting' | 'reconnecting' | 'error') => void,
): () => void {
  if (!markets.length) return () => {};

  const set = new Set(markets.map(m => m.toUpperCase()));
  let closed = false;
  let fallbackTimer: ReturnType<typeof setInterval> | null = null;
  let appActive = AppState.currentState === 'active';

  onStatus('connecting');

  // AppState guard — pause when backgrounded
  const appStateSub = AppState.addEventListener('change', (state: AppStateStatus) => {
    appActive = state === 'active';
  });

  function startFallbackPoll() {
    if (fallbackTimer || closed) return;
    logger.warn('cdx-stream', 'Socket.IO unavailable — using REST poll fallback');
    onStatus('reconnecting');

    async function poll() {
      if (!appActive || closed) return;
      try {
        const r = await fetch(`${CDX_BASE}/exchange/ticker`, { signal: timeoutSignal(5_000) });
        if (!r.ok) return;
        const tickers: any[] = await r.json();
        onStatus('live');
        tickers.forEach(t => {
          const parsed = parseTicker(t);
          if (parsed && set.has(parsed.market)) {
            onTick(parsed.market, parsed.price, parsed.chg);
          }
        });
      } catch { /* silent */ }
    }

    poll();
    fallbackTimer = setInterval(poll, 5000);
  }

  function stopFallbackPoll() {
    if (fallbackTimer) { clearInterval(fallbackTimer); fallbackTimer = null; }
  }

  // Ticker event handler
  function onTickerEvent(payload: any) {
    if (!appActive || closed) return;
    // Handle both array payload and single object payload
    const tickerArray = Array.isArray(payload) ? payload : [payload];
    if (!tickerArray.length) return;
    let matched = false;
    tickerArray.forEach(t => {
      if (!t || typeof t !== 'object') return;
      const parsed = parseTicker(t);
      if (parsed && set.has(parsed.market)) {
        onTick(parsed.market, parsed.price, parsed.chg);
        matched = true;
      }
    });
    if (matched) {
      onStatus('live');
      stopFallbackPoll();
    }
  }

  _socketRefCount++;

  getSocket()
    .then(socket => {
      if (closed) { releaseSocket(); return; }
      // CoinDCX socket.io v2 event names (try all known variants)
      socket.on('coindcx-ticker', onTickerEvent);
      socket.on('coindcx', onTickerEvent);
      socket.on('ticker', onTickerEvent);
      socket.on('tickers', onTickerEvent);
      // Emit join/subscribe for channel-based subscriptions
      socket.emit('join', { channelName: 'coindcx' });
      socket.emit('subscribe', { channelNames: [...set] });
      onStatus('live');
      logger.info('cdx-stream', `Subscribed to coindcx-ticker + ticker for ${markets.length} markets`);

      // If socket disconnects, start fallback poll
      socket.on('disconnect', () => {
        if (!closed) { onStatus('reconnecting'); startFallbackPoll(); }
      });
      socket.on('reconnect', () => {
        if (!closed) { stopFallbackPoll(); onStatus('live'); }
      });
    })
    .catch(() => {
      // Socket.IO failed — use REST poll fallback
      _socketRefCount = Math.max(0, _socketRefCount - 1);
      startFallbackPoll();
    });

  return () => {
    closed = true;
    appStateSub.remove();
    stopFallbackPoll();
    if (_socket) _socket.off('coindcx-ticker', onTickerEvent);
    releaseSocket();
  };
}

// ── Phase 8: Socket.IO kline stream ───────────────────────────────────────────
// Subscribes to per-pair 'new-trade' events for real-time candle updates.
// Each trade fires an OHLCV update for the forming candle, then detects
// candle close when the candle timestamp changes.
// Falls back to 5s REST poll if socket unavailable.
//
// Returns an unsubscribe function.
export function subscribeToCdxKline(
  pair: string,    // CoinDCX pair, e.g. 'B-BTC_USDT'
  tf: string,
  onCandle: (c: {
    time: number; open: number; high: number; low: number;
    close: number; volume: number; isClosed: boolean;
  }) => void,
  onStatus: (s: 'live' | 'connecting' | 'reconnecting' | 'error') => void,
): () => void {
  let closed = false;
  let fallbackTimer: ReturnType<typeof setInterval> | null = null;
  let lastCandleTime = 0;

  // Forming candle tracker — accumulates trades into OHLCV
  let forming: { time: number; open: number; high: number; low: number; close: number; volume: number } | null = null;

  onStatus('connecting');

  function startFallbackPoll() {
    if (fallbackTimer || closed) return;
    logger.warn('cdx-kline', `${pair}: using REST kline fallback`);

    async function poll() {
      if (closed) return;
      try {
        const candles = await fetchCdxCandles(pair, tf, 2);
        if (!candles.length) return;
        onStatus('live');
        const latest = candles[candles.length - 1];
        if (lastCandleTime !== 0 && latest.time !== lastCandleTime) {
          const prev = candles.find(c => c.time === lastCandleTime);
          if (prev) onCandle({ ...prev, isClosed: true });
        }
        onCandle({ ...latest, isClosed: false });
        lastCandleTime = latest.time;
      } catch { /* silent */ }
    }

    poll();
    fallbackTimer = setInterval(poll, 5000);
  }

  function stopFallbackPoll() {
    if (fallbackTimer) { clearInterval(fallbackTimer); fallbackTimer = null; }
  }

  // Seed the forming candle from REST before socket starts
  // so the chart doesn't show a gap while socket connects
  fetchCdxCandles(pair, tf, 1).then(candles => {
    if (closed || !candles.length) return;
    const c = candles[0];
    forming = { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
    lastCandleTime = c.time;
    onCandle({ ...forming, isClosed: false });
  }).catch(() => {});

  // Trade event handler — builds forming candle from individual trades
  function onTradeEvent(trades: any[]) {
    if (closed || !Array.isArray(trades)) return;

    trades.forEach(trade => {
      if (trade.s !== pair) return; // filter to our pair
      const price  = parseFloat(trade.p ?? '0');
      const qty    = parseFloat(trade.q ?? '0');
      const ts     = trade.T ?? Date.now();
      if (price <= 0) return;

      // Compute the candle bucket start time for this trade
      // based on the current timeframe interval
      const intervalMs = tfToMs(tf);
      const candleTime = intervalMs > 0
        ? Math.floor(ts / intervalMs) * intervalMs
        : (forming?.time ?? ts);

      if (!forming || candleTime > forming.time) {
        // New candle started — close the old one
        if (forming) onCandle({ ...forming, isClosed: true });
        forming = { time: candleTime, open: price, high: price, low: price, close: price, volume: qty };
        lastCandleTime = candleTime;
      } else {
        // Update forming candle
        forming.high   = Math.max(forming.high, price);
        forming.low    = Math.min(forming.low, price);
        forming.close  = price;
        forming.volume += qty;
      }

      onCandle({ ...forming, isClosed: false });
      stopFallbackPoll();
    });
    onStatus('live');
  }

  _socketRefCount++;

  getSocket()
    .then(socket => {
      if (closed) { releaseSocket(); return; }
      // Subscribe to the pair channel
      socket.emit('join', { channelName: pair });
      socket.on('new-trade', onTradeEvent);
      onStatus('live');
      logger.info('cdx-kline', `Subscribed to new-trade for ${pair}`);

      socket.on('disconnect', () => { if (!closed) startFallbackPoll(); });
      socket.on('reconnect', () => {
        if (!closed) {
          // Re-join the channel after reconnect
          socket.emit('join', { channelName: pair });
          stopFallbackPoll();
          onStatus('live');
        }
      });
    })
    .catch(() => {
      _socketRefCount = Math.max(0, _socketRefCount - 1);
      startFallbackPoll();
    });

  return () => {
    closed = true;
    stopFallbackPoll();
    if (_socket) {
      _socket.emit('leave', { channelName: pair });
      _socket.off('new-trade', onTradeEvent);
    }
    releaseSocket();
  };
}

// ── Timeframe → milliseconds (for candle bucket calculation) ─────────────────
function tfToMs(tf: string): number {
  const map: Record<string, number> = {
    '1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
    '1h': 3_600_000, '4h': 14_400_000, '1D': 86_400_000, '1W': 604_800_000,
  };
  return map[tf] ?? 0;
}
