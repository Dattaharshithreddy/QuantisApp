import { Candle } from '../utils/indicators';
import { withRetry } from '../utils/retry';
import { DepthLevel, OrderBookSnapshot } from '../utils/orderBook';

const TF_BN: Record<string, string> = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '4h': '4h', '1D': '1d', '1W': '1w' };

// TASK 5 (Price Scale) — real exchange-defined precision, fetched from
// Binance's own exchangeInfo endpoint (the PRICE_FILTER's tickSize),
// never guessed from "how big is the number." A tick size like
// "0.01000000" means 2 decimal places; "0.00010000" means 4. Counting
// the position of the '1' after the decimal point is the standard way to
// derive decimal count from a tick size string.
export async function fetchSymbolPricePrecision(bnSym: string): Promise<number | null> {
  return withRetry(async () => {
    const res = await fetch(`https://api.binance.com/api/v3/exchangeInfo?symbol=${bnSym}`);
    if (!res.ok) throw new Error(`exchangeInfo HTTP ${res.status}`);
    const data = await res.json();
    const symbolInfo = data.symbols?.[0];
    const priceFilter = symbolInfo?.filters?.find((f: any) => f.filterType === 'PRICE_FILTER');
    const tickSize = priceFilter?.tickSize;
    if (!tickSize) return null;
    const decimalPart = tickSize.split('.')[1] ?? '';
    const oneIndex = decimalPart.indexOf('1');
    return oneIndex === -1 ? 0 : oneIndex + 1;
  });
}

// GOAL 1 — real Binance Spot order book via the official public endpoint.
// limit=20 covers both the "top 5" and "top 10" display modes from a
// single call (sliced client-side), without over-fetching. Binance's
// response gives bids/asks as string tuples [price, qty], already sorted
// (bids descending = best bid first, asks ascending = best ask first) —
// no client-side sorting needed, just numeric parsing.
export async function fetchBinanceDepth(bnSym: string, limit: 5 | 10 | 20 = 20): Promise<OrderBookSnapshot> {
  return withRetry(async () => {
    const res = await fetch(`https://api.binance.com/api/v3/depth?symbol=${bnSym}&limit=${limit}`);
    if (!res.ok) throw new Error(`Binance depth HTTP ${res.status}`);
    const json = await res.json();
    const toLevels = (rows: [string, string][]): DepthLevel[] => rows.map(([price, qty]) => ({ price: +price, qty: +qty }));
    return {
      source: 'binance', symbol: bnSym, timestamp: Date.now(),
      buy: toLevels(json.bids || []), sell: toLevels(json.asks || []),
    };
  }, { tag: 'binance-depth', retries: 2 });
}

export async function fetchBnKlines(bnSym: string, tf: string, limit = 150, endTime?: number): Promise<Candle[]> {
  return withRetry(async () => {
    const interval = TF_BN[tf] || '15m';
    let url = `https://api.binance.com/api/v3/klines?symbol=${bnSym}&interval=${interval}&limit=${limit}`;
    if (endTime) url += `&endTime=${endTime}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Binance HTTP ${r.status}`);
    const json = await r.json();
    return json.map((k: any[]) => ({ time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
  }, { tag: 'binance-klines', retries: 2 });
}

export function openBinanceStream(
  bnSymbols: string[],
  onTick: (bnSym: string, price: number, chgPct: number) => void,
  onStatus: (status: 'live' | 'connecting' | 'reconnecting' | 'error') => void
) {
  const streams = bnSymbols.map(s => `${s.toLowerCase()}@miniTicker`).join('/');
  let ws: WebSocket | null = null;
  let retryT: any = null;
  let closed = false;

  function connect() {
    onStatus('connecting');
    ws = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams}`);
    ws.onopen = () => onStatus('live');
    ws.onmessage = (evt: any) => {
      try {
        const { data } = JSON.parse(evt.data);
        if (!data?.s) return;
        const price = parseFloat(data.c);
        const open24 = parseFloat(data.o);
        onTick(data.s, price, open24 !== 0 ? ((price - open24) / open24) * 100 : 0);
      } catch (_) {}
    };
    ws.onerror = () => onStatus('error');
    ws.onclose = () => {
      if (closed) return;
      onStatus('reconnecting');
      retryT = setTimeout(connect, 5000);
    };
  }
  connect();

  return () => {
    closed = true;
    ws?.close();
    clearTimeout(retryT);
  };
}
