import { Candle } from '../utils/indicators';
import { withRetry } from '../utils/retry';
import { calculatePnLWithMultiplier, calculatePnLPct } from '../utils/pnlCalculator';

// IMPORTANT: In a native Android app there is NO browser, so CORS does not apply.
// These calls go straight to Angel One's servers — no local proxy server needed
// (unlike the web version, which required ao-proxy.js).
const AO_BASE = 'https://apiconnect.angelbroking.com';

export type AOSession = {
  apiKey:      string;
  clientCode:  string;
  jwtToken:    string;
  feedToken?:  string;
  loginAt:     number;   // Unix ms — used to detect 24h token expiry
};

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
    Authorization: `Bearer ${session.jwtToken}`};
}

export async function aoLogin(apiKey: string, clientCode: string, password: string, totp: string): Promise<AOSession> {
  const r = await fetch(`${AO_BASE}/rest/auth/angelbroking/user/v1/loginByPassword`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', Accept: 'application/json',
      'X-UserType': 'USER', 'X-SourceID': 'WEB',
      'X-ClientLocalIP': '192.168.1.1', 'X-ClientPublicIP': '1.1.1.1',
      'X-MACAddress': 'fe80::1', 'X-PrivateKey': apiKey},
    body: JSON.stringify({ clientcode: clientCode, password, totp })});
  if (!r.ok) throw new Error(`Angel One HTTP ${r.status}`);
  const json = await r.json();
  if (!json.status || !json.data?.jwtToken) throw new Error(json.message || 'Angel One auth failed');
  return { apiKey, clientCode, jwtToken: json.data.jwtToken, feedToken: json.data.feedToken, loginAt: Date.now() };
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
    body: JSON.stringify({ exchange, symboltoken: token, interval, fromdate: fmtAODate(from), todate: fmtAODate(to) })});
  if (!r.ok) throw new Error(`AO candles HTTP ${r.status}`);
  const json = await r.json();
  if (!json.status) throw new Error(json.message || 'AO candles failed');
  if (!json.data?.length) return [];
  return json.data.map((d: any[]) => ({ time: new Date(d[0]).getTime(), open: d[1], high: d[2], low: d[3], close: d[4], volume: d[5] }));
}

// Fetch candles FROM a specific timestamp forward — used by incremental cache updates.
// Returns only candles with time > fromTime. Uses current time as todate.
export async function aoCandlesFrom(token: string, exchange: string, tf: string, fromTime: number, session: AOSession): Promise<Candle[]> {
  return withRetry(async () => {
    const from = new Date(fromTime);
    const now  = new Date();
    const data = await aoCandlesRange(token, exchange, tf, from, now, session);
    if (!data.length) return [];
    return data.filter(c => c.time > fromTime);  // strict > to exclude the candle we already have
  }, { tag: 'angelone-candles-from', retries: 2 });
}

export async function aoCandles(token: string, exchange: string, tf: string, session: AOSession): Promise<Candle[]> {
  return withRetry(async () => {
    const now = new Date();
    // Window per single fetch — AngelOne accepts up to 60-90 days per request.
    // Increased for short timeframes so fetchMaxHistoryAO pagination gets more bars per chunk.
    const daysMap: Record<string, number> = { '1m': 3, '5m': 30, '15m': 60, '30m': 60, '1h': 90, '4h': 90, '1D': 365, '1W': 730 };
    const from = new Date(now.getTime() - (daysMap[tf] || 60) * 864e5);
    const data = await aoCandlesRange(token, exchange, tf, from, now, session);
    if (!data.length) throw new Error('AO: no candle data');
    return data;
  }, { tag: 'angelone-candles', retries: 2 });
}

// Fetches an earlier window of candles ending right before `beforeTime`, for
// "scroll back in history" panning on the chart. Window length mirrors the
// same lookback period used for the initial load, per timeframe.
export async function aoCandlesBefore(token: string, exchange: string, tf: string, beforeTime: number, session: AOSession): Promise<Candle[]> {
  // Match the same extended windows as aoCandles so each pagination chunk is equally sized.
  const daysMap: Record<string, number> = { '1m': 3, '5m': 30, '15m': 60, '30m': 60, '1h': 90, '4h': 90, '1D': 365, '1W': 730 };
  const windowMs = (daysMap[tf] || 60) * 864e5;
  const to = new Date(beforeTime - 60000); // 1 min before the oldest candle we already have, avoid overlap
  const from = new Date(to.getTime() - windowMs);
  return aoCandlesRange(token, exchange, tf, from, to, session); // may legitimately return [] if no earlier data exists
}

export type AODepthLevel = { price: number; qty: number; orders: number };
export type AOQuote = {
  price: number; chg: number; live: true; volume: number;
  totBuyQty?: number; totSellQty?: number;
  upperCircuit?: number;   // circuit filter upper limit (from FULL mode)
  lowerCircuit?: number;   // circuit filter lower limit
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
    body: JSON.stringify({ mode: 'FULL', exchangeTokens })});
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
      upperCircuit: q.upperCircuit  ? parseFloat(q.upperCircuit)  : undefined,
      lowerCircuit: q.lowerCircuit  ? parseFloat(q.lowerCircuit)  : undefined,
      depth: q.depth ? {
        buy: (q.depth.buy || []).map((d: any) => ({ price: d.price, qty: d.quantity, orders: d.orders })),
        sell: (q.depth.sell || []).map((d: any) => ({ price: d.price, qty: d.quantity, orders: d.orders }))} : null};
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
    method: 'GET', headers: headers(session)});
  if (!r.ok) throw new Error(`AO holdings HTTP ${r.status}`);
  const json = await r.json();
  if (!json.status) throw new Error(json.message || 'AO holdings failed');
  return (json.data || []).map((h: any) => ({
    symbol: h.tradingsymbol, quantity: h.quantity, avgPrice: h.averageprice,
    ltp: h.ltp, pnl: calculatePnLWithMultiplier(h.averageprice, h.ltp, h.quantity, 1),
    pnlPct: calculatePnLPct(calculatePnLWithMultiplier(h.averageprice, h.ltp, h.quantity, 1), h.averageprice, h.quantity), product: h.product}));
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

// ── Margin / RMS (Risk Management System) ────────────────────────────────────

export type AORMSData = {
  net:                  number;   // Net available margin after utilisations
  availablecash:        number;   // Cash component of available margin
  utiliseddebits:       number;   // Total debits utilised
  collateral:           number;   // Collateral value (shares pledged etc.)
  m2munrealisedmtom:   number;   // Unrealised MTM on open positions
  m2mrealisedmtom:     number;   // Realised MTM settled today
  utilisedpayout:       number;   // Payout amount blocked
};

/**
 * Fetches available margin from Angel One RMS endpoint.
 * Returns null on any failure — callers must handle gracefully.
 * Used for pre-trade margin check before placing futures orders.
 */
export async function aoGetRMS(session: AOSession): Promise<AORMSData | null> {
  try {
    const r = await fetch(`${AO_BASE}/rest/secure/angelbroking/user/v1/getRMS`, {
      headers: headers(session)});
    if (!r.ok) return null;
    const json = await r.json();
    if (json.status !== true || !json.data) return null;
    const d = json.data;
    return {
      net:                 parseFloat(d.net               ?? '0'),
      availablecash:       parseFloat(d.availablecash     ?? '0'),
      utiliseddebits:      parseFloat(d.utiliseddebits    ?? '0'),
      collateral:          parseFloat(d.collateral        ?? '0'),
      m2munrealisedmtom:  parseFloat(d.m2munrealisedmtom ?? '0'),
      m2mrealisedmtom:    parseFloat(d.m2mrealisedmtom   ?? '0'),
      utilisedpayout:      parseFloat(d.utilisedpayout    ?? '0')};
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SMARTAPI MARKET FEED WEBSOCKET
// ─────────────────────────────────────────────────────────────────────────────
// Angel One SmartAPI provides a binary WebSocket feed for tick-by-tick LTP.
// URL: wss://smartapisocket.angelone.in/smart-stream
// Auth: JWT token + feedToken from aoLogin response.
// Protocol: JSON auth/subscribe messages, binary tick responses (51 bytes).
//
// Modes:
//   LTP_MODE   (1) — last traded price only. Fastest, lowest bandwidth.
//   QUOTE_MODE (2) — LTP + OHLC + volume. Used for chart candle updates.
//   SNAP_MODE  (3) — full market depth. Heavy — not used here.
//
// Exchange type map (SmartAPI internal):
//   NSE cash  → 1
//   NSE F&O   → 2
//   BSE cash  → 3
//   MCX       → 5
//
// Binary tick packet layout (51 bytes, little-endian):
//   [0]      uint8  subscription mode (1/2/3)
//   [1]      uint8  exchange type
//   [2..25]  char   token (zero-padded ASCII)
//   [26..33] int64  sequence number
//   [34..41] int64  exchange timestamp (ms since epoch)
//   [42..49] int32  LTP × 100 (divide by 100 for actual price)
//   [50]     uint8  (reserved)
//   Mode 2 adds 28 more bytes: last trade qty, avg price, volume, total buy qty,
//   total sell qty, open, high, low, close — all int32 × 100, little-endian.
// ─────────────────────────────────────────────────────────────────────────────

const AO_WS_URL = 'wss://smartapisocket.angelone.in/smart-stream';

// SmartAPI exchange type codes
const AO_EXCH_TYPE: Record<string, number> = {
  NSE: 1, NFO: 2, BSE: 3, MCX: 5,
};

export type AOTickCallback = (symbol: string, ltp: number, ohlcv?: {
  open: number; high: number; low: number; close: number; volume: number;
}) => void;

export type AOWSStatus = 'connecting' | 'live' | 'reconnecting' | 'error' | 'closed';

/**
 * Opens a SmartAPI Market Feed WebSocket for the given list of tokens.
 * Streams LTP (and optionally OHLCV) ticks for NSE/NFO/BSE symbols.
 *
 * @param items     List of { symbol, token, aoEx } to subscribe to.
 * @param session   AOSession with jwtToken and feedToken from aoLogin.
 * @param onTick    Called on every price tick with symbol + ltp.
 * @param onStatus  Called when connection state changes.
 * @param mode      1=LTP only (default), 2=LTP+OHLCV (chart screen).
 * @returns         Cleanup function — call to close the WebSocket.
 */
export function openAOMarketFeed(
  items: { symbol: string; token: string; aoEx: string }[],
  session: AOSession,
  onTick: AOTickCallback,
  onStatus: (s: AOWSStatus) => void,
  mode: 1 | 2 = 1,
): () => void {
  let ws: WebSocket | null = null;
  let retryT: any = null;
  let closed = false;
  let pingT: any = null;

  // Token → symbol reverse map for decoding binary ticks
  const tokenToSymbol: Record<string, string> = {};
  items.forEach(it => { tokenToSymbol[it.token] = it.symbol; });

  // Build subscription list grouped by exchange type
  const tokenList = Object.entries(
    items.reduce((acc, it) => {
      const exType = AO_EXCH_TYPE[it.aoEx] ?? 1;
      (acc[exType] ||= []).push(it.token);
      return acc;
    }, {} as Record<number, string[]>)
  ).map(([exchangeType, tokens]) => ({ exchangeType: Number(exchangeType), tokens }));

  function parseTick(buf: ArrayBuffer): void {
    const view = new DataView(buf);
    if (view.byteLength < 51) return;

    const tickMode = view.getUint8(0);

    // Token: bytes 2-26 (25 bytes), null-terminated ASCII
    let token = '';
    for (let i = 2; i < 27; i++) {
      const b = view.getUint8(i);
      if (b === 0) break;
      token += String.fromCharCode(b);
    }
    const symbol = tokenToSymbol[token];
    if (!symbol) return;

    // LTP: bytes 43-46, int32 LE, divide by 100
    const ltp = view.getInt32(43, true) / 100;
    if (ltp <= 0) return;

    // Mode 2 (Quote): 87 bytes total
    // Bytes 51-54: last_traded_qty
    // Bytes 55-58: avg_traded_price × 100
    // Bytes 59-62: volume_traded
    // Bytes 63-66: total_buy_qty
    // Bytes 67-70: total_sell_qty
    // Bytes 71-74: open × 100
    // Bytes 75-78: high × 100
    // Bytes 79-82: low × 100
    // Bytes 83-86: close × 100
    if (tickMode === 2 && view.byteLength >= 87) {
      const volume = view.getInt32(59, true);
      const open   = view.getInt32(71, true) / 100;
      const high   = view.getInt32(75, true) / 100;
      const low    = view.getInt32(79, true) / 100;
      const close  = view.getInt32(83, true) / 100;
      onTick(symbol, ltp, { open, high, low, close, volume });
    } else {
      onTick(symbol, ltp);
    }
  }

  function connect() {
    onStatus('connecting');
    ws = new WebSocket(AO_WS_URL);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      // SmartAPI v3: authenticate immediately on connect
      // Field names are camelCase in v3 protocol
      ws!.send(JSON.stringify({
        feedToken:  session.feedToken ?? '',
        clientCode: session.clientCode,
      }));
    };

    ws.onmessage = (evt: any) => {
      if (typeof evt.data === 'string') {
        try {
          const msg = JSON.parse(evt.data);
          // 'cn' = connection acknowledged; subscribe now
          if (msg.type === 'cn') {
            ws!.send(JSON.stringify({
              action:    1,
              params:    { mode, tokenList },
              correlationID: 'quantis_chart',
            }));
            onStatus('live');
            // Heartbeat: SmartAPI expects the string 'ping' every 25s
            clearInterval(pingT);
            pingT = setInterval(() => {
              if (ws?.readyState === WebSocket.OPEN) ws.send('ping');
            }, 25_000);
          }
        } catch (_) {}
        return;
      }
      if (evt.data instanceof ArrayBuffer) parseTick(evt.data);
    };

    ws.onerror = () => onStatus('error');

    ws.onclose = () => {
      clearInterval(pingT);
      if (closed) return;
      onStatus('reconnecting');
      retryT = setTimeout(connect, 5_000);
    };
  }

  connect();

  return () => {
    closed = true;
    clearInterval(pingT);
    clearTimeout(retryT);
    ws?.close();
  };
}
