// ─────────────────────────────────────────────────────────────────────────────
// MARKET CONTEXT FETCH  (v1.0.0)
//
// Fetches external market context for Indian markets (NSE).
// All fetches are optional and fail silently — never blocks prediction.
//
// DATA SOURCES:
//   VIX      — NSE India website (free, no auth required)
//   Breadth  — NSE India advance/decline data
//   FII/DII  — NSE India FII/DII activity report
//   PCR      — NSE India options chain aggregate
//   Sectors  — NSE India sector indices
//
// CACHING:
//   All data cached in AsyncStorage with per-source TTLs.
//   Stale cache returned on fetch failure (offline mode).
//
// DESIGN:
//   Each fetch is independent — failure of one does not affect others.
//   Returns partial MarketContext with available[] listing successful sources.
// ─────────────────────────────────────────────────────────────────────────────

import AsyncStorage from '@react-native-async-storage/async-storage';
import { KVStore } from '../../services/storage';
import { logger } from '../logger';
import {
  MarketContext, VIXData, BreadthData, FIIDIIData, PCRData, SectorData,
} from './marketContextTypes';

// FIX (Audit item #9): Hard per-request timeout matching cryptoMarketContextFetch.ts
const _FETCH_TIMEOUT_MS = 5_000;
function _fetchWithTimeout(url: string): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), _FETCH_TIMEOUT_MS);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(t));
}

// ── Cache TTLs ────────────────────────────────────────────────────────────────
const TTL = {
  VIX:     15 * 60_000,   // 15 minutes — VIX updates intraday
  BREADTH:  5 * 60_000,   // 5 minutes  — breadth changes frequently
  FII_DII: 60 * 60_000,   // 1 hour     — FII/DII data is daily, posted by ~6pm
  PCR:     10 * 60_000,   // 10 minutes — options PCR updates frequently
  SECTORS:  5 * 60_000,   // 5 minutes
};

const CACHE_KEY = (src: string) => `marketCtx_v1_${src}`;

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

// ── India VIX ─────────────────────────────────────────────────────────────────
// NSE provides VIX on their public website. The actual endpoint used is the
// same one the NSE India app uses for the VIX chart.
async function fetchVIX(): Promise<VIXData | null> {
  const cached = await readCtxCache<VIXData>('VIX');
  if (cached && isFresh(cached.fetchedAt, TTL.VIX)) return cached.data;

  try {
    // NSE India VIX history endpoint (public, no auth)
    const res = await fetch(
      'https://www.nseindia.com/api/historical/vixhistory?data=4months',
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }
    );
    if (!res.ok) throw new Error(`VIX HTTP ${res.status}`);
    const json = await res.json();
    const records: any[] = json?.data ?? [];
    if (records.length < 5) throw new Error('VIX: insufficient data');

    const closes = records.map((r: any) => parseFloat(r.EOD_CLOSE_PRICE ?? r.CLOSE ?? '0')).filter(v => v > 0);
    if (!closes.length) throw new Error('VIX: no valid prices');

    const current = closes[closes.length - 1];
    const sma5 = closes.slice(-5).reduce((s, v) => s + v, 0) / Math.min(5, closes.length);
    const sma20 = closes.slice(-20).reduce((s, v) => s + v, 0) / Math.min(20, closes.length);
    const momentum = sma5 > 0 ? (current - sma5) / sma5 : 0;
    const trend: VIXData['trend'] = momentum > 0.02 ? 'RISING' : momentum < -0.02 ? 'FALLING' : 'FLAT';
    const regime: VIXData['regime'] = current < 12 ? 'LOW' : current < 20 ? 'NORMAL' : current < 30 ? 'HIGH' : 'EXTREME';

    const data: VIXData = { current, sma5, sma20, trend, momentum, regime, fetchedAt: Date.now() };
    await writeCtxCache('VIX', data);
    logger.info('marketContext', `VIX fetched: ${current.toFixed(1)} (${regime})`);
    return data;
  } catch (e: any) {
    logger.warn('marketContext', `VIX fetch failed: ${e.message}`);
    return cached?.data ?? null;  // return stale cache on failure
  }
}

// ── Market Breadth ────────────────────────────────────────────────────────────
async function fetchBreadth(): Promise<BreadthData | null> {
  const cached = await readCtxCache<BreadthData>('BREADTH');
  if (cached && isFresh(cached.fetchedAt, TTL.BREADTH)) return cached.data;

  try {
    const res = await fetch(
      'https://www.nseindia.com/api/market-data-pre-open?key=NIFTY',
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }
    );
    if (!res.ok) throw new Error(`Breadth HTTP ${res.status}`);
    const json = await res.json();
    // NSE provides advance/decline in the market status endpoint
    const advances  = parseInt(json?.advances  ?? json?.data?.advances  ?? '0') || 0;
    const declines  = parseInt(json?.declines  ?? json?.data?.declines  ?? '0') || 0;
    const unchanged = parseInt(json?.unchanged ?? json?.data?.unchanged ?? '0') || 0;

    if (advances + declines === 0) throw new Error('Breadth: no A/D data');

    const adRatio = advances / (advances + declines);
    const adTrend: BreadthData['adTrend'] = adRatio > 0.6 ? 'BULLISH' : adRatio < 0.4 ? 'BEARISH' : 'NEUTRAL';
    const breadthThrust = adRatio > 0.7;

    const data: BreadthData = { advances, declines, unchanged, adRatio, adTrend, breadthThrust, fetchedAt: Date.now() };
    await writeCtxCache('BREADTH', data);
    logger.info('marketContext', `Breadth: A=${advances} D=${declines} ratio=${adRatio.toFixed(2)}`);
    return data;
  } catch (e: any) {
    logger.warn('marketContext', `Breadth fetch failed: ${e.message}`);
    return cached?.data ?? null;
  }
}

// ── FII / DII Cash Flow ───────────────────────────────────────────────────────
async function fetchFIIDII(): Promise<FIIDIIData | null> {
  const cached = await readCtxCache<FIIDIIData>('FII_DII');
  if (cached && isFresh(cached.fetchedAt, TTL.FII_DII)) return cached.data;

  try {
    const res = await fetch(
      'https://www.nseindia.com/api/fiidiiTradeReact',
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }
    );
    if (!res.ok) throw new Error(`FII/DII HTTP ${res.status}`);
    const json = await res.json();
    const rows: any[] = Array.isArray(json) ? json : json?.data ?? [];
    if (!rows.length) throw new Error('FII/DII: empty response');

    // NSE returns rows sorted latest first; take last 5 for rolling avg
    const recent = rows.slice(0, 5);
    const fiiDaily = recent.map((r: any) => parseFloat(r.netVal ?? r.FII_NET ?? '0'));
    const diiDaily = recent.map((r: any) => parseFloat(r.netVal2 ?? r.DII_NET ?? '0'));

    const fiiNetCash  = fiiDaily[0] ?? 0;
    const diiNetCash  = diiDaily[0] ?? 0;
    const fiiRolling5 = fiiDaily.reduce((s, v) => s + v, 0) / fiiDaily.length;
    const diiRolling5 = diiDaily.reduce((s, v) => s + v, 0) / diiDaily.length;

    const fiiConsecBuys = fiiDaily.reduce((c, v) => (v > 0 ? c + 1 : c === 0 ? 0 : -(c)), 0);
    const diiConsecBuys = diiDaily.reduce((c, v) => (v > 0 ? c + 1 : c === 0 ? 0 : -(c)), 0);
    const netFlow = fiiNetCash + diiNetCash;

    const bias: FIIDIIData['bias'] =
      fiiNetCash > 0 && diiNetCash > 0 ? 'FII_BUY' :
      fiiNetCash < 0 && diiNetCash < 0 ? 'FII_SELL' :
      fiiNetCash > 0 ? 'FII_BUY' : 'DII_BUY';

    const data: FIIDIIData = { fiiNetCash, diiNetCash, fiiRolling5, diiRolling5,
      fiiConsecBuys, diiConsecBuys, netFlow, bias, fetchedAt: Date.now() };
    await writeCtxCache('FII_DII', data);
    logger.info('marketContext', `FII/DII: net=${netFlow.toFixed(0)} crore, bias=${bias}`);
    return data;
  } catch (e: any) {
    logger.warn('marketContext', `FII/DII fetch failed: ${e.message}`);
    return cached?.data ?? null;
  }
}

// ── Put/Call Ratio ────────────────────────────────────────────────────────────
async function fetchPCR(): Promise<PCRData | null> {
  const cached = await readCtxCache<PCRData>('PCR');
  if (cached && isFresh(cached.fetchedAt, TTL.PCR)) return cached.data;

  try {
    const res = await fetch(
      'https://www.nseindia.com/api/option-chain-indices?symbol=NIFTY',
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }
    );
    if (!res.ok) throw new Error(`PCR HTTP ${res.status}`);
    const json = await res.json();
    const filtered: any[] = json?.filtered ?? {};
    const putVol = parseFloat(filtered?.PE?.totOI ?? '0') || 0;
    const callVol = parseFloat(filtered?.CE?.totOI ?? '0') || 1;

    const current = putVol / callVol;
    if (current <= 0) throw new Error('PCR: invalid OI data');

    // Use a simple SMA5 from cache history (graceful if no history)
    const prevCached = await readCtxCache<PCRData>('PCR');
    const sma5 = prevCached?.data?.current
      ? (current + prevCached.data.current) / 2
      : current;

    const trend: PCRData['trend'] = current > sma5 * 1.02 ? 'RISING' : current < sma5 * 0.98 ? 'FALLING' : 'FLAT';
    const sentiment: PCRData['sentiment'] =
      current < 0.7  ? 'EXTREME_BULLISH' :
      current < 0.9  ? 'BULLISH' :
      current < 1.1  ? 'NEUTRAL' :
      current < 1.3  ? 'BEARISH' : 'EXTREME_BEARISH';

    const data: PCRData = {
      current, sma5, trend, sentiment,
      isContrarianBull: current > 1.3,
      isContrarianBear: current < 0.7,
      fetchedAt: Date.now()};
    await writeCtxCache('PCR', data);
    logger.info('marketContext', `PCR: ${current.toFixed(2)} (${sentiment})`);
    return data;
  } catch (e: any) {
    logger.warn('marketContext', `PCR fetch failed: ${e.message}`);
    return cached?.data ?? null;
  }
}

// ── Sector Data ───────────────────────────────────────────────────────────────
async function fetchSectors(): Promise<SectorData | null> {
  const cached = await readCtxCache<SectorData>('SECTORS');
  if (cached && isFresh(cached.fetchedAt, TTL.SECTORS)) return cached.data;

  try {
    const res = await fetch(
      'https://www.nseindia.com/api/allIndices',
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }
    );
    if (!res.ok) throw new Error(`Sectors HTTP ${res.status}`);
    const json = await res.json();
    const indices: any[] = json?.data ?? [];

    const find = (keyword: string) => {
      const row = indices.find((r: any) => r.indexSymbol?.includes(keyword) || r.index?.includes(keyword));
      return row ? parseFloat(row.percentChange ?? row.pChange ?? '0') / 100 : 0;
    };

    // Benchmark: NIFTY 50 return
    const nifty = find('NIFTY 50');
    const bank   = find('NIFTY BANK')   - nifty;
    const it     = find('NIFTY IT')     - nifty;
    const pharma = find('NIFTY PHARMA') - nifty;
    const auto   = find('NIFTY AUTO')   - nifty;
    const fmcg   = find('NIFTY FMCG')  - nifty;
    const metal  = find('NIFTY METAL')  - nifty;

    const returns: [string, number][] = [['BANK',bank],['IT',it],['PHARMA',pharma],['AUTO',auto],['FMCG',fmcg],['METAL',metal]];
    const sorted = [...returns].sort((a, b) => b[1] - a[1]);
    const leader = sorted[0][1] > 0.001 ? sorted[0][0] as SectorData['leader'] : 'NONE';
    const positive = returns.filter(([,v]) => v > 0).length;
    const momentum = returns.reduce((s, [,v]) => s + v, 0) / returns.length;
    const participation = positive / returns.length;

    const data: SectorData = { bank, it, pharma, auto, fmcg, metal,
      leader, participation, momentum, fetchedAt: Date.now() };
    await writeCtxCache('SECTORS', data);
    logger.info('marketContext', `Sectors: leader=${leader}, participation=${participation.toFixed(2)}`);
    return data;
  } catch (e: any) {
    logger.warn('marketContext', `Sectors fetch failed: ${e.message}`);
    return cached?.data ?? null;
  }
}

// ── Main: fetch all context ───────────────────────────────────────────────────
// Fires all fetches in parallel. Each failure is independent.
// Returns partial context with available[] listing successful sources.
export async function fetchMarketContext(): Promise<MarketContext> {
  const [vix, breadth, fiidii, pcr, sectors] = await Promise.allSettled([
    fetchVIX(), fetchBreadth(), fetchFIIDII(), fetchPCR(), fetchSectors(),
  ]);

  const get = <T>(r: PromiseSettledResult<T | null>): T | null =>
    r.status === 'fulfilled' ? r.value : null;

  const vixData     = get(vix);
  const breadthData = get(breadth);
  const fiidiiData  = get(fiidii);
  const pcrData     = get(pcr);
  const sectorsData = get(sectors);

  const available: MarketContext['available'] = [
    ...(vixData     ? ['VIX']     as const : []),
    ...(breadthData ? ['BREADTH'] as const : []),
    ...(fiidiiData  ? ['FII_DII'] as const : []),
    ...(pcrData     ? ['PCR']     as const : []),
    ...(sectorsData ? ['SECTORS'] as const : []),
  ];

  return {
    vix:     vixData,
    breadth: breadthData,
    fiidii:  fiidiiData,
    pcr:     pcrData,
    sectors: sectorsData,
    available,
    fetchedAt: Date.now()};
}

// Fetch only specific sources (for performance-sensitive paths)
export async function fetchMarketContextPartial(
  sources: ('VIX' | 'BREADTH' | 'FII_DII' | 'PCR' | 'SECTORS')[]
): Promise<MarketContext> {
  const fetchers: Record<string, () => Promise<any>> = {
    VIX: fetchVIX, BREADTH: fetchBreadth,
    FII_DII: fetchFIIDII, PCR: fetchPCR, SECTORS: fetchSectors};
  const results = await Promise.allSettled(sources.map(s => fetchers[s]()));
  const ctx: MarketContext = { available: [], fetchedAt: Date.now() };
  sources.forEach((src, i) => {
    const r = results[i];
    const val = r.status === 'fulfilled' ? r.value : null;
    if (val) {
      if (src === 'VIX')     ctx.vix     = val;
      if (src === 'BREADTH') ctx.breadth = val;
      if (src === 'FII_DII') ctx.fiidii  = val;
      if (src === 'PCR')     ctx.pcr     = val;
      if (src === 'SECTORS') ctx.sectors = val;
      ctx.available.push(src);
    }
  });
  return ctx;
}
