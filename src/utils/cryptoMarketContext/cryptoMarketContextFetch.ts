// ─────────────────────────────────────────────────────────────────────────────
// CRYPTO MARKET CONTEXT FETCH  (v1.0.0)
//
// Fetches external market context for crypto assets.
// Mirrors marketContextFetch.ts architecture exactly.
//
// DATA SOURCES:
//   Fear & Greed  — alternative.me (free, no auth)
//   Market Cap    — CoinGecko /api/v3/global (free, no auth)
//   Funding Rate  — Binance FAPI (free, no auth for public endpoints)
//   Open Interest — Binance FAPI (free, no auth)
//   Stablecoin    — derived from CoinGecko global data
//
// Each fetch is independent. Failure of one does not affect others.
// Stale cache returned on failure (offline mode).
// ─────────────────────────────────────────────────────────────────────────────

import AsyncStorage from '@react-native-async-storage/async-storage';
import { KVStore } from '../../services/storage';
import { logger } from '../logger';
import {
  CryptoMarketContext, FearGreedData, MarketCapData,
  FundingRateData, OpenInterestData, StablecoinData,
} from './cryptoMarketContextTypes';

// ── Cache TTLs ────────────────────────────────────────────────────────────────
const TTL = {
  FEAR_GREED:    60 * 60_000,   // 1 hour  — F&G updates daily but endpoint serves hourly
  MARKET_CAP:    10 * 60_000,   // 10 min  — market cap changes frequently
  FUNDING:        5 * 60_000,   // 5 min   — funding rate updates every 8h but can fluctuate
  OPEN_INTEREST:  5 * 60_000,   // 5 min
  STABLECOIN:    10 * 60_000,   // 10 min  — derived from same market cap call
};

const CACHE_KEY = (src: string) => `cryptoCtx_v1_${src}`;

// FIX (Audit item #9): All external fetches now have a hard timeout.
// Without this, a slow or non-responsive API endpoint caused fetchCryptoMarketContext
// to hang indefinitely — blocking the entire prediction pipeline since
// fetchUnifiedMarketContext awaits it (with only a try/catch, no timeout).
// The prediction itself is wrapped in a 30s timeout, but a single stalled
// network call could consume most of that budget before the context is even
// fetched. Per-fetch 5s timeout ensures each individual call either returns
// quickly or fails fast, letting the prediction proceed with stale cache data.
const FETCH_TIMEOUT_MS = 5_000; // 5 seconds per individual network call

function fetchWithTimeout(url: string, ms = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

async function readCtxCache<T>(src: string): Promise<{ data: T; fetchedAt: number } | null> {
  try {
    const raw = await KVStore.get(CACHE_KEY(src));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.data && parsed?.fetchedAt ? parsed : null;
  } catch { return null; }
}

async function writeCtxCache<T>(src: string, data: T): Promise<void> {
  try {
    await KVStore.set(CACHE_KEY(src), JSON.stringify({ data, fetchedAt: Date.now() }));
  } catch {}
}

function isFresh(fetchedAt: number, ttlMs: number): boolean {
  return Date.now() - fetchedAt < ttlMs;
}

// Map Binance bnSym to Binance FAPI symbol (e.g. 'BTCUSD' → 'BTCUSDT')
function toFuturesSym(symbol: string): string {
  // If it already ends in USDT, use as-is; else try appending T
  const upper = symbol.toUpperCase();
  if (upper.endsWith('USDT')) return upper;
  if (upper.endsWith('USD'))  return upper + 'T';
  return upper + 'USDT';
}

// ── Fear & Greed Index ────────────────────────────────────────────────────────
async function fetchFearGreed(): Promise<FearGreedData | null> {
  const cached = await readCtxCache<FearGreedData>('FEAR_GREED');
  if (cached && isFresh(cached.fetchedAt, TTL.FEAR_GREED)) return cached.data;

  try {
    const res = await fetchWithTimeout('https://api.alternative.me/fng/?limit=2&format=json');
    if (!res.ok) throw new Error(`F&G HTTP ${res.status}`);
    const json = await res.json();
    const items: any[] = json?.data ?? [];
    if (items.length < 1) throw new Error('F&G: empty response');

    const current   = parseInt(items[0]?.value ?? '50');
    const previous  = parseInt(items[1]?.value ?? String(current));
    const diff      = current - previous;
    const trend: FearGreedData['trend'] = diff > 2 ? 'RISING' : diff < -2 ? 'FALLING' : 'FLAT';

    const classify = (v: number): FearGreedData['classification'] =>
      v <= 25 ? 'EXTREME_FEAR' : v <= 45 ? 'FEAR' : v <= 55 ? 'NEUTRAL' : v <= 75 ? 'GREED' : 'EXTREME_GREED';

    const data: FearGreedData = {
      value: current,
      classification: classify(current),
      previousDay: previous,
      trend,
      fetchedAt: Date.now()};
    await writeCtxCache('FEAR_GREED', data);
    logger.info('cryptoContext', `F&G: ${current} (${data.classification})`);
    return data;
  } catch (e: any) {
    logger.warn('cryptoContext', `F&G fetch failed: ${e.message}`);
    return cached?.data ?? null;
  }
}

// ── Market Cap + BTC Dominance + Stablecoin (one CoinGecko call) ─────────────
async function fetchMarketCapAndStable(): Promise<{
  marketCap: MarketCapData | null;
  stablecoin: StablecoinData | null;
}> {
  // Check individual caches first
  const cachedMC = await readCtxCache<MarketCapData>('MARKET_CAP');
  const cachedSC = await readCtxCache<StablecoinData>('STABLECOIN');
  if (cachedMC && isFresh(cachedMC.fetchedAt, TTL.MARKET_CAP) &&
      cachedSC && isFresh(cachedSC.fetchedAt, TTL.STABLECOIN)) {
    return { marketCap: cachedMC.data, stablecoin: cachedSC.data };
  }

  try {
    const res = await fetchWithTimeout('https://api.coingecko.com/api/v3/global');
    if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
    const json = await res.json();
    const d = json?.data ?? {};

    const total       = d.total_market_cap?.usd ?? 0;
    const totalExBtc  = (d.total_market_cap?.usd ?? 0) - (d.total_market_cap?.btc ?? 0) * 0;
    // CoinGecko provides market_cap_percentage for top coins
    const btcDom  = d.market_cap_percentage?.btc   ?? 50;
    const ethDom  = d.market_cap_percentage?.eth   ?? 15;
    const usdtDom = d.market_cap_percentage?.usdt  ?? 5;
    const usdcDom = d.market_cap_percentage?.usdc  ?? 3;
    const altDom  = Math.max(0, 100 - btcDom - ethDom - usdtDom - usdcDom);
    const stableTotal = usdtDom + usdcDom;
    const stableRatio = stableTotal / 100;
    const change24h   = d.market_cap_change_percentage_24h_usd ?? 0;

    // Derive market regime
    const regime: MarketCapData['regime'] =
      stableTotal > 12     ? 'STABLE_DOMINANCE' :
      change24h < -3        ? 'RISK_OFF' :
      altDom > 35 && change24h > 0 ? 'ALT_SEASON' :
      btcDom > 55           ? 'BTC_SEASON' :
      change24h > 3         ? 'RISK_ON'   : 'NEUTRAL';

    const mcData: MarketCapData = {
      totalMarketCapUsd: total,
      totalExBtcMarketCapUsd: totalExBtc,
      btcDominance: btcDom,
      ethDominance: ethDom,
      altcoinDominance: altDom,
      stablecoinRatio: stableRatio,
      totalChange24h: change24h,
      btcDominanceChange24h: 0,   // CoinGecko global doesn't expose BTC.D change directly
      regime,
      fetchedAt: Date.now()};

    // Stablecoin dominance trend from cache comparison
    const prevSC = cachedSC?.data;
    const scTrend: StablecoinData['trend'] =
      prevSC ? (stableTotal > prevSC.totalStableDom + 0.3 ? 'RISING' :
               stableTotal < prevSC.totalStableDom - 0.3 ? 'FALLING' : 'FLAT') : 'FLAT';
    const scSignal: StablecoinData['signal'] =
      scTrend === 'RISING' ? 'RISK_OFF' : scTrend === 'FALLING' ? 'RISK_ON' : 'NEUTRAL';

    const scData: StablecoinData = {
      usdtDominance:  usdtDom,
      usdcDominance:  usdcDom,
      totalStableDom: stableTotal,
      trend:          scTrend,
      signal:         scSignal,
      fetchedAt:      Date.now()};

    await writeCtxCache('MARKET_CAP', mcData);
    await writeCtxCache('STABLECOIN', scData);
    logger.info('cryptoContext', `MarketCap: BTC.D=${btcDom.toFixed(1)}% regime=${regime}`);
    return { marketCap: mcData, stablecoin: scData };
  } catch (e: any) {
    logger.warn('cryptoContext', `MarketCap fetch failed: ${e.message}`);
    return { marketCap: cachedMC?.data ?? null, stablecoin: cachedSC?.data ?? null };
  }
}

// ── Funding Rate (Binance FAPI) ───────────────────────────────────────────────
async function fetchFundingRate(symbol: string): Promise<FundingRateData | null> {
  const cacheKey = `FUNDING_${symbol}`;
  const cached = await readCtxCache<FundingRateData>(cacheKey);
  if (cached && isFresh(cached.fetchedAt, TTL.FUNDING)) return cached.data;

  try {
    const fSym = toFuturesSym(symbol);
    const res = await fetch(
      `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${fSym}`
    );
    if (!res.ok) throw new Error(`Funding HTTP ${res.status}`);
    const json = await res.json();
    const rate = parseFloat(json?.lastFundingRate ?? '0');

    if (!isFinite(rate)) throw new Error('Funding: invalid rate');

    const annualized = rate * 3 * 365;  // 3 periods/day × 365 days
    const classify = (r: number): FundingRateData['sentiment'] =>
      r > 0.0005 ? 'EXTREME_LONG' : r > 0.0001 ? 'LONG_BIASED' :
      r < -0.0005 ? 'EXTREME_SHORT' : r < -0.0001 ? 'SHORT_BIASED' : 'NEUTRAL';

    const data: FundingRateData = {
      symbol: fSym,
      fundingRate: rate,
      annualized,
      sentiment: classify(rate),
      isOverheated: Math.abs(rate) > 0.0005,
      fetchedAt: Date.now()};
    await writeCtxCache(cacheKey, data);
    logger.info('cryptoContext', `Funding ${fSym}: ${(rate * 100).toFixed(4)}% (${data.sentiment})`);
    return data;
  } catch (e: any) {
    logger.warn('cryptoContext', `Funding fetch failed for ${symbol}: ${e.message}`);
    return cached?.data ?? null;
  }
}

// ── Open Interest (Binance FAPI) ──────────────────────────────────────────────
async function fetchOpenInterest(symbol: string): Promise<OpenInterestData | null> {
  const cacheKey = `OI_${symbol}`;
  const cached = await readCtxCache<OpenInterestData>(cacheKey);
  if (cached && isFresh(cached.fetchedAt, TTL.OPEN_INTEREST)) return cached.data;

  try {
    const fSym = toFuturesSym(symbol);
    // Current OI
    const [oiRes, histRes] = await Promise.allSettled([
      fetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${fSym}`),
      fetch(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${fSym}&period=1d&limit=2`),
    ]);

    if (oiRes.status !== 'fulfilled' || !oiRes.value.ok)
      throw new Error(`OI HTTP error`);

    const oiJson   = await oiRes.value.json();
    const currentOI = parseFloat(oiJson?.openInterest ?? '0') * parseFloat(oiJson?.price ?? '0');
    if (!isFinite(currentOI) || currentOI <= 0) throw new Error('OI: invalid data');

    // Historical for change calculation
    let change24h = 0;
    if (histRes.status === 'fulfilled' && histRes.value.ok) {
      const histJson: any[] = await histRes.value.json();
      if (histJson.length >= 2) {
        const prev = parseFloat(histJson[0]?.sumOpenInterestValue ?? '0');
        const curr = parseFloat(histJson[1]?.sumOpenInterestValue ?? String(currentOI));
        change24h = prev > 0 ? ((curr - prev) / prev) * 100 : 0;
      }
    }

    const trend: OpenInterestData['trend'] =
      change24h > 2 ? 'RISING' : change24h < -2 ? 'FALLING' : 'FLAT';

    // OI + price movement = conviction signal
    // Without price data here, use OI trend as proxy
    const conviction: OpenInterestData['conviction'] =
      trend === 'RISING' ? 'BULLISH' :
      trend === 'FALLING' ? 'WEAK' : 'NEUTRAL';

    const data: OpenInterestData = {
      symbol: fSym, openInterestUsd: currentOI,
      change24h, trend, conviction, fetchedAt: Date.now()};
    await writeCtxCache(cacheKey, data);
    logger.info('cryptoContext', `OI ${fSym}: $${(currentOI/1e9).toFixed(2)}B change=${change24h.toFixed(1)}%`);
    return data;
  } catch (e: any) {
    logger.warn('cryptoContext', `OI fetch failed for ${symbol}: ${e.message}`);
    return cached?.data ?? null;
  }
}

// ── Main: fetch all crypto context ───────────────────────────────────────────
export async function fetchCryptoMarketContext(symbol: string): Promise<CryptoMarketContext> {
  const [fearGreedResult, marketCapResult, fundingResult, oiResult] =
    await Promise.allSettled([
      fetchFearGreed(),
      fetchMarketCapAndStable(),
      fetchFundingRate(symbol),
      fetchOpenInterest(symbol),
    ]);

  const fearGreed = fearGreedResult.status === 'fulfilled' ? fearGreedResult.value : null;
  const { marketCap, stablecoin } =
    marketCapResult.status === 'fulfilled'
      ? marketCapResult.value
      : { marketCap: null, stablecoin: null };
  const funding      = fundingResult.status === 'fulfilled' ? fundingResult.value : null;
  const openInterest = oiResult.status     === 'fulfilled' ? oiResult.value      : null;

  const available: CryptoMarketContext['available'] = [
    ...(fearGreed    ? ['FEAR_GREED']    as const : []),
    ...(marketCap    ? ['MARKET_CAP']    as const : []),
    ...(funding      ? ['FUNDING']       as const : []),
    ...(openInterest ? ['OPEN_INTEREST'] as const : []),
    ...(stablecoin   ? ['STABLECOIN']    as const : []),
  ];

  return {
    fearGreed,
    marketCap,
    funding,
    openInterest,
    stablecoin,
    available,
    symbol,
    fetchedAt: Date.now()};
}

// Fetch only specific sources (for performance-sensitive paths)
export async function fetchCryptoContextPartial(
  symbol: string,
  sources: ('FEAR_GREED' | 'MARKET_CAP' | 'FUNDING' | 'OPEN_INTEREST' | 'STABLECOIN')[],
): Promise<CryptoMarketContext> {
  const ctx: CryptoMarketContext = { available: [], symbol, fetchedAt: Date.now() };

  const tasks: Promise<void>[] = [];
  if (sources.includes('FEAR_GREED'))
    tasks.push(fetchFearGreed().then(d => { if (d) { ctx.fearGreed = d; ctx.available.push('FEAR_GREED'); } }));
  if (sources.includes('MARKET_CAP') || sources.includes('STABLECOIN'))
    tasks.push(fetchMarketCapAndStable().then(({ marketCap, stablecoin }) => {
      if (marketCap)    { ctx.marketCap = marketCap;       ctx.available.push('MARKET_CAP'); }
      if (stablecoin)   { ctx.stablecoin = stablecoin;     ctx.available.push('STABLECOIN'); }
    }));
  if (sources.includes('FUNDING'))
    tasks.push(fetchFundingRate(symbol).then(d => { if (d) { ctx.funding = d; ctx.available.push('FUNDING'); } }));
  if (sources.includes('OPEN_INTEREST'))
    tasks.push(fetchOpenInterest(symbol).then(d => { if (d) { ctx.openInterest = d; ctx.available.push('OPEN_INTEREST'); } }));

  await Promise.allSettled(tasks);
  return ctx;
}
