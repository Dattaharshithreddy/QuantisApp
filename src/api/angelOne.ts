import { Candle } from '../utils/indicators';
import { withRetry } from '../utils/retry';
import { calculatePnLWithMultiplier, calculatePnLPct } from '../utils/pnlCalculator';

// IMPORTANT: In a native Android app there is NO browser, so CORS does not apply.
// These calls go straight to Angel One's servers — no local proxy server needed
// (unlike the web version, which required ao-proxy.js).
const AO_BASE = 'https://apiconnect.angelbroking.com';

export type AOSession = { apiKey: string; clientCode: string; jwtToken: string; feedToken?: string };

function headers(session: AOSession) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-UserType': 'USER',
    'X-SourceID': 'WEB',
    'X-ClientLocalIP': '192.168.1.1',
    'X-ClientPublicIP': '1.1.1.1',
    'X-MACAddress': 'fe80::1',
    'X-PrivateKey': session.apiKey,
    Authorization: `Bearer ${session.jwtToken}`,
  };
}

export async function aoLogin(apiKey: string, clientCode: string, password: string, totp: string): Promise<AOSession> {
  const r = await fetch(`${AO_BASE}/rest/auth/angelbroking/user/v1/loginByPassword`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', Accept: 'application/json',
      'X-UserType': 'USER', 'X-SourceID': 'WEB',
      'X-ClientLocalIP': '192.168.1.1', 'X-ClientPublicIP': '1.1.1.1',
      'X-MACAddress': 'fe80::1', 'X-PrivateKey': apiKey,
    },
    body: JSON.stringify({ clientcode: clientCode, password, totp }),
  });
  if (!r.ok) throw new Error(`Angel One HTTP ${r.status}`);
  const json = await r.json();
  if (!json.status || !json.data?.jwtToken) throw new Error(json.message || 'Angel One auth failed');
  return { apiKey, clientCode, jwtToken: json.data.jwtToken, feedToken: json.data.feedToken };
}

const TF_AO: Record<string, string> = {
  '1m': 'ONE_MINUTE', '5m': 'FIVE_MINUTE', '15m': 'FIFTEEN_MINUTE', '30m': 'THIRTY_MINUTE',
  '1h': 'ONE_HOUR', '4h': 'FOUR_HOUR', '1D': 'ONE_DAY', '1W': 'ONE_WEEK',
};

function fmtAODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

async function aoCandlesRange(token: string, exchange: string, tf: string, from: Date, to: Date, session: AOSession): Promise<Candle[]> {
  const interval = TF_AO[tf] || 'FIFTEEN_MINUTE';
  const r = await fetch(`${AO_BASE}/rest/secure/angelbroking/historical/v1/getCandleData`, {
    method: 'POST', headers: headers(session),
    body: JSON.stringify({ exchange, symboltoken: token, interval, fromdate: fmtAODate(from), todate: fmtAODate(to) }),
  });
  if (!r.ok) throw new Error(`AO candles HTTP ${r.status}`);
  const json = await r.json();
  if (!json.status) throw new Error(json.message || 'AO candles failed');
  if (!json.data?.length) return [];
  return json.data.map((d: any[]) => ({ time: new Date(d[0]).getTime(), open: d[1], high: d[2], low: d[3], close: d[4], volume: d[5] }));
}

export async function aoCandles(token: string, exchange: string, tf: string, session: AOSession): Promise<Candle[]> {
  return withRetry(async () => {
    const now = new Date();
    const daysMap: Record<string, number> = { '1m': 1, '5m': 7, '15m': 30, '30m': 45, '1h': 60, '4h': 90, '1D': 365, '1W': 730 };
    const from = new Date(now.getTime() - (daysMap[tf] || 30) * 864e5);
    const data = await aoCandlesRange(token, exchange, tf, from, now, session);
    if (!data.length) throw new Error('AO: no candle data');
    return data;
  }, { tag: 'angelone-candles', retries: 2 });
}

// Fetches an earlier window of candles ending right before `beforeTime`, for
// "scroll back in history" panning on the chart. Window length mirrors the
// same lookback period used for the initial load, per timeframe.
export async function aoCandlesBefore(token: string, exchange: string, tf: string, beforeTime: number, session: AOSession): Promise<Candle[]> {
  const daysMap: Record<string, number> = { '1m': 1, '5m': 7, '15m': 30, '30m': 45, '1h': 60, '4h': 90, '1D': 365, '1W': 730 };
  const windowMs = (daysMap[tf] || 30) * 864e5;
  const to = new Date(beforeTime - 60000); // 1 min before the oldest candle we already have, avoid overlap
  const from = new Date(to.getTime() - windowMs);
  return aoCandlesRange(token, exchange, tf, from, to, session); // may legitimately return [] if no earlier data exists
}

export type AODepthLevel = { price: number; qty: number; orders: number };
export type AOQuote = {
  price: number; chg: number; live: true; volume: number;
  totBuyQty?: number; totSellQty?: number;
  depth?: { buy: AODepthLevel[]; sell: AODepthLevel[] } | null;
};

// CHANGED: takes a list of {symbol, token, ex} directly (built from whatever
// assets — static or searched — are currently being tracked), instead of
// resolving names through a hardcoded map. Returns results keyed by symbol
// so callers don't need to change.
export async function aoLTP(items: { symbol: string; token: string; ex: string }[], session: AOSession): Promise<Record<string, AOQuote>> {
  const exchangeTokens: Record<string, string[]> = {};
  const tokenToSymbol: Record<string, string> = {};
  items.forEach(({ symbol, token, ex }) => {
    (exchangeTokens[ex] ||= []).push(token);
    tokenToSymbol[token] = symbol;
  });
  if (!Object.keys(exchangeTokens).length) return {};
  const r = await fetch(`${AO_BASE}/rest/secure/angelbroking/market/v1/quote/`, {
    method: 'POST', headers: headers(session),
    body: JSON.stringify({ mode: 'FULL', exchangeTokens }),
  });
  if (!r.ok) throw new Error(`AO LTP HTTP ${r.status}`);
  const json = await r.json();
  if (!json.status) throw new Error(json.message);
  const result: Record<string, AOQuote> = {};
  (json.data?.fetched || []).forEach((q: any) => {
    const sym = tokenToSymbol[String(q.symbolToken)];
    if (!sym) return;
    result[sym] = {
      price: q.ltp, chg: q.percentChange, live: true, volume: q.tradeVolume || q.volume || 0,
      totBuyQty: q.totBuyQuantity, totSellQty: q.totSellQuantity,
      depth: q.depth ? {
        buy: (q.depth.buy || []).map((d: any) => ({ price: d.price, qty: d.quantity, orders: d.orders })),
        sell: (q.depth.sell || []).map((d: any) => ({ price: d.price, qty: d.quantity, orders: d.orders })),
      } : null,
    };
  });
  return result;
}

// Real portfolio holdings — pulls your actual Angel One positions
export type Holding = {
  symbol: string; quantity: number; avgPrice: number; ltp: number;
  pnl: number; pnlPct: number; product: string;
};

export async function aoHoldings(session: AOSession): Promise<Holding[]> {
  const r = await fetch(`${AO_BASE}/rest/secure/angelbroking/portfolio/v1/getHolding`, {
    method: 'GET', headers: headers(session),
  });
  if (!r.ok) throw new Error(`AO holdings HTTP ${r.status}`);
  const json = await r.json();
  if (!json.status) throw new Error(json.message || 'AO holdings failed');
  return (json.data || []).map((h: any) => ({
    symbol: h.tradingsymbol, quantity: h.quantity, avgPrice: h.averageprice,
    ltp: h.ltp, pnl: calculatePnLWithMultiplier(h.averageprice, h.ltp, h.quantity, 1),
    pnlPct: calculatePnLPct(calculatePnLWithMultiplier(h.averageprice, h.ltp, h.quantity, 1), h.averageprice, h.quantity), product: h.product,
  }));
}

// ─────────────────────────────────────────────────
// SYMBOL SEARCH — Angel One's public scrip master
// ─────────────────────────────────────────────────
// This is the real, official instrument list Angel One publishes for every
// tradable NSE/BSE/NFO symbol with its token — the same file algo-trading
// communities use to resolve symbol→token. No API key or session needed to
// fetch it; it's a public static file. It's large, so we fetch once, filter
// down to NSE equities + indices immediately (discard F&O/strikes to save
// memory), and cache the filtered result in AsyncStorage for a week.
const SCRIP_MASTER_URL = 'https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json';

export type ScripEntry = { token: string; symbol: string; name: string; exch_seg: string };

export async function fetchAOScripMaster(): Promise<ScripEntry[]> {
  const r = await fetch(SCRIP_MASTER_URL);
  if (!r.ok) throw new Error(`Scrip master HTTP ${r.status}`);
  const raw: any[] = await r.json();
  // Keep only NSE cash-market equities and indices — drop F&O contracts,
  // strikes, and other exchanges to keep this list small and relevant.
  return raw
    .filter(e => e.exch_seg === 'NSE' && (e.instrumenttype === '' || e.instrumenttype === 'AMXIDX') && e.symbol)
    .map(e => ({ token: e.token, symbol: e.symbol.replace(/-EQ$/, ''), name: e.name || e.symbol, exch_seg: e.exch_seg }));
}
