// ─────────────────────────────────────────────────────────────────────────────
// COINDCX DATA API  (v1.0.0)
//
// Candle history + live price feed for CoinDCX spot markets.
// Mirrors the structure of binance.ts: same Candle shape, same return types,
// same WebSocket reconnect pattern.
//
// Endpoints used:
//   Candles:   GET https://public.coindcx.com/market_data/candles
//   Ticker:    GET https://api.coindcx.com/exchange/ticker
//   Live LTP:  GET https://api.coindcx.com/exchange/ticker (polled — CoinDCX
//              WebSocket requires socket.io-client v2.4.0 which is a native
//              module dependency; REST poll avoids that dependency for Phase 1.
//              Phase 2 will upgrade to socket.io for true tick-level updates.)
//
// Notes:
//   - CoinDCX candles return in DESCENDING order (newest first).
//     We reverse to ascending (oldest first) to match what the rest of the
//     app expects from Binance and Angel One.
//   - pair format: 'B-BTC_USDT' (exchange-prefixed).
//     market format: 'BTCUSDT' (no prefix, used for orders and ticker lookups).
//   - Timeframe mapping: app uses '1D', CoinDCX uses '1d'.
// ─────────────────────────────────────────────────────────────────────────────

import { AppState, AppStateStatus } from 'react-native';
import { Candle } from '../utils/indicators';
import { withRetry } from '../utils/retry';
import { logger } from '../utils/logger';

const CDX_PUBLIC = 'https://public.coindcx.com';
const CDX_BASE   = 'https://api.coindcx.com';

// AbortSignal.timeout() is ES2022 and not available on older Android/Hermes.
// This polyfill creates an equivalent signal using AbortController + setTimeout.
function timeoutSignal(ms: number): AbortSignal {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  // Clean up timer if signal is used in a way that completes normally
  ctrl.signal.addEventListener('abort', () => clearTimeout(id));
  return ctrl.signal;
}

// ── Timeframe mapping ─────────────────────────────────────────────────────────
// App TF → CoinDCX interval string.
// CoinDCX supports: 1m 5m 15m 30m 1h 2h 4h 6h 8h 1d 3d 1w 1M
const TF_CDX: Record<string, string> = {
  '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m',
  '1h': '1h', '4h': '4h', '1D': '1d', '1W': '1w',
};

// ── Candles ───────────────────────────────────────────────────────────────────
// pair:  the CoinDCX pair string, e.g. 'B-BTC_USDT' (from asset.cdxSym)
// tf:    app timeframe string, e.g. '15m', '1D'
// limit: max 1000; we default to 500 to match Binance parity
// endTime: if provided, fetch candles ending at or before this timestamp (ms)
//
// CoinDCX returns candles NEWEST FIRST. We reverse to OLDEST FIRST so the
// app's indicator engine (which expects chronological order) works unchanged.
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

    // Map to app Candle shape and sort ascending (oldest first)
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

// ── REST snapshot — current price + 24h change for a list of markets ─────────
// market: CoinDCX market name without exchange prefix, e.g. 'BTCUSDT', 'ETHUSDT'
// Returns a map from market → { price, chg }
// Used by DataContext on startup and foreground to seed the price display
// before the poll interval fires.
export async function fetchCdxSnapshot(
  markets: string[],
): Promise<Record<string, { price: number; chg: number }>> {
  if (!markets.length) return {};
  try {
    const r = await fetch(`${CDX_BASE}/exchange/ticker`, {
      signal: timeoutSignal(8_000),
    });
    if (!r.ok) return {};
    const tickers: any[] = await r.json();

    const set = new Set(markets.map(m => m.toUpperCase()));
    const result: Record<string, { price: number; chg: number }> = {};

    tickers.forEach(t => {
      // ticker.market is the symbol without prefix, e.g. 'BTCUSDT'
      const market = (t.market ?? '').toUpperCase();
      if (!set.has(market)) return;
      const price = parseFloat(t.last_price ?? '0');
      const high  = parseFloat(t.high ?? '0');
      const low   = parseFloat(t.low  ?? '0');
      const open24 = (high + low) / 2; // approx: CDX ticker has no open24
      const chg = price > 0 && open24 > 0
        ? ((price - open24) / open24) * 100
        : parseFloat(t.change_24_hour ?? '0');
      if (price > 0) result[market] = { price, chg };
    });

    return result;
  } catch (e: any) {
    logger.warn('cdx-snapshot', e.message);
    return {};
  }
}

// ── Polling price stream for CoinDCX assets ───────────────────────────────────
// CoinDCX's WebSocket requires socket.io-client v2.4.0 — a native npm module
// that needs a build step. For Phase 1 we use a simple REST poll (every 2s)
// which gives the Markets screen live prices without adding a new native dep.
//
// The poll is intentionally lightweight: one call fetches ALL tickers at once,
// not one call per symbol, so adding more CoinDCX assets costs zero extra calls.
//
// Returns an unsubscribe function (matches Binance openBinanceStream pattern).
export function openCdxPriceStream(
  markets: string[],                                          // e.g. ['BTCUSDT', 'ETHUSDT']
  onTick: (market: string, price: number, chg: number) => void,
  onStatus: (s: 'live' | 'connecting' | 'reconnecting' | 'error') => void,
): () => void {
  if (!markets.length) return () => {};

  const set = new Set(markets.map(m => m.toUpperCase()));
  let timerId: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  let consecutiveErrors = 0;
  let appActive = AppState.currentState === 'active';

  // Pause polling when app is backgrounded — critical for low-memory devices.
  // Without this, fetch promises accumulate while the app is invisible and
  // can exhaust the 256-512MB heap on mid-range Android devices.
  const appStateSub = AppState.addEventListener('change', (state: AppStateStatus) => {
    appActive = state === 'active';
    if (appActive && !closed) {
      // Resume: fire one poll immediately then restart interval
      poll();
      if (timerId === null) timerId = setInterval(poll, 5000);
    } else if (!appActive && timerId !== null) {
      // Pause: clear interval, let in-flight requests complete naturally
      clearInterval(timerId);
      timerId = null;
    }
  });

  async function poll() {
    if (!appActive || closed) return; // guard: don't fire if backgrounded
    try {
      const r = await fetch(`${CDX_BASE}/exchange/ticker`, {
        signal: timeoutSignal(5_000),
      });
      if (!r.ok) throw new Error(`ticker HTTP ${r.status}`);
      const tickers: any[] = await r.json();
      consecutiveErrors = 0;
      onStatus('live');

      tickers.forEach(t => {
        const market = (t.market ?? '').toUpperCase();
        if (!set.has(market)) return;
        const price = parseFloat(t.last_price ?? '0');
        if (price <= 0) return;
        const high   = parseFloat(t.high ?? '0');
        const low    = parseFloat(t.low  ?? '0');
        const open24 = (high + low) / 2;
        const chg    = open24 > 0 ? ((price - open24) / open24) * 100
                                  : parseFloat(t.change_24_hour ?? '0');
        onTick(market, price, chg);
      });
    } catch (e: any) {
      consecutiveErrors++;
      logger.warn('cdx-stream', `Poll error #${consecutiveErrors}: ${e.message}`);
      onStatus(consecutiveErrors === 1 ? 'reconnecting' : 'error');
    }
  }

  // Poll every 5s — matches Binance futures poll rate.
  onStatus('connecting');
  poll();
  timerId = setInterval(poll, 5000);

  return () => {
    closed = true;
    appStateSub.remove();
    if (timerId !== null) { clearInterval(timerId); timerId = null; }
  };
}

// ── Live candle stream (poll-based) ──────────────────────────────────────────
// Mirrors subscribeToBnKline but uses REST polling since we don't have a
// socket.io dep yet. Polls the most recent candle every 3s and fires onCandle
// with the updated OHLCV. On a candle close (new candle time appears) it fires
// with isClosed=true for the closed candle, then immediately again for the new one.
//
// Returns an unsubscribe function.
export function subscribeToCdxKline(
  pair: string,
  tf: string,
  onCandle: (c: { time: number; open: number; high: number; low: number; close: number; volume: number; isClosed: boolean }) => void,
  onStatus: (s: 'live' | 'connecting' | 'reconnecting' | 'error') => void,
): () => void {
  let timerId: ReturnType<typeof setInterval> | null = null;
  let lastTime = 0;
  let closed = false;
  let errors = 0;

  async function poll() {
    try {
      // Fetch only the 2 most recent candles — enough to detect a close
      const candles = await fetchCdxCandles(pair, tf, 2);
      if (!candles.length) return;
      errors = 0;
      onStatus('live');

      const latest = candles[candles.length - 1];

      if (lastTime !== 0 && latest.time !== lastTime) {
        // The forming candle has closed — a new one started
        // Find the old candle (second to last, if available)
        const prev = candles.find(c => c.time === lastTime);
        if (prev) {
          onCandle({ ...prev, isClosed: true });
        }
      }

      // Always fire with the latest (forming) candle
      onCandle({ ...latest, isClosed: false });
      lastTime = latest.time;
    } catch (e: any) {
      errors++;
      logger.warn('cdx-kline', `Poll error #${errors}: ${(e as Error).message}`);
      onStatus(errors === 1 ? 'reconnecting' : 'error');
    }
  }

  onStatus('connecting');
  poll();
  timerId = setInterval(poll, 5000); // slowed from 3s to match price poll rate

  return () => {
    closed = true;
    if (timerId !== null) { clearInterval(timerId); timerId = null; }
  };
}
