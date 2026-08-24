import AsyncStorage from '@react-native-async-storage/async-storage';
import { KVStore } from '../services/storage';
import { Asset } from './assets';
import { fetchAOScripMaster, ScripEntry } from './angelOne';

// ─────────────────────────────────────────────────
// BINANCE — search any of the ~2000+ live trading pairs
// ─────────────────────────────────────────────────
let bnSymbolCache: { symbol: string; baseAsset: string; quoteAsset: string }[] | null = null;

export async function fetchBinanceSymbolList(): Promise<typeof bnSymbolCache> {
  if (bnSymbolCache) return bnSymbolCache;
  const r = await fetch('https://api.binance.com/api/v3/exchangeInfo');
  if (!r.ok) throw new Error('Binance symbol list error');
  const json = await r.json();
  bnSymbolCache = (json.symbols || [])
    .filter((s: any) => s.status === 'TRADING' && s.quoteAsset === 'USDT')
    .map((s: any) => ({ symbol: s.symbol, baseAsset: s.baseAsset, quoteAsset: s.quoteAsset }));
  return bnSymbolCache;
}

export async function searchBinance(query: string): Promise<Asset[]> {
  const list = await fetchBinanceSymbolList();
  if (!list) return [];
  const q = query.toUpperCase();
  return list
    .filter(s => s.baseAsset.includes(q) || s.symbol.includes(q))
    .slice(0, 25)
    .map(s => ({
      symbol: s.baseAsset + 'USD', name: s.baseAsset, type: 'CRYPTO' as const, src: 'binance' as const,
      bnSym: s.symbol, base: 1, vol: 0.03, custom: true}));
}

// ─────────────────────────────────────────────────
// ANGEL ONE — search any NSE stock or index (cached weekly)
// ─────────────────────────────────────────────────
const SCRIP_CACHE_KEY = 'aoScripMasterCache';
const SCRIP_CACHE_MS = 7 * 24 * 60 * 60 * 1000; // 1 week

// Pre-load scrip master in background — call this on app start
export async function warmScripMaster(): Promise<void> {
  try {
    const cached = await KVStore.get(SCRIP_CACHE_KEY);
    if (cached) {
      const { fetchedAt } = JSON.parse(cached);
      if (Date.now() - fetchedAt < SCRIP_CACHE_MS) return; // already warm
    }
    await fetchAOScripMaster().then(fresh =>
      KVStore.set(SCRIP_CACHE_KEY, JSON.stringify({ data: fresh, fetchedAt: Date.now() }))
    ).catch(() => {});
  } catch {}
}

async function getScripMaster(): Promise<ScripEntry[]> {
  try {
    const cached = await KVStore.get(SCRIP_CACHE_KEY);
    if (cached) {
      const { data, fetchedAt } = JSON.parse(cached);
      if (Date.now() - fetchedAt < SCRIP_CACHE_MS) return data;
      // Stale cache — return stale data immediately, refresh in background
      if (data?.length) {
        fetchAOScripMaster().then(fresh =>
          KVStore.set(SCRIP_CACHE_KEY, JSON.stringify({ data: fresh, fetchedAt: Date.now() }))
        ).catch(() => {});
        return data; // instant response with stale data
      }
    }
  } catch (_) {}
  const fresh = await fetchAOScripMaster();
  try {
    await KVStore.set(SCRIP_CACHE_KEY, JSON.stringify({ data: fresh, fetchedAt: Date.now() }));
  } catch (_) {} // if storage is full, just don't cache — search still works this session
  return fresh;
}

export async function searchNSE(query: string): Promise<Asset[]> {
  const scrips = await getScripMaster();
  const q = query.toUpperCase();
  return scrips
    .filter(s => s.symbol.toUpperCase().includes(q) || s.name.toUpperCase().includes(q))
    .slice(0, 25)
    .map(s => ({
      symbol: s.symbol, name: s.name, type: (s.symbol.includes('NIFTY') ? 'INDEX' : 'STOCK') as 'INDEX' | 'STOCK',
      src: 'ao' as const, aoToken: s.token, aoEx: s.exch_seg, base: 100, vol: 0.015, custom: true}));
}

// ─────────────────────────────────────────────────
// ALPHA VANTAGE — search any global listed stock (needs your AV key)
// ─────────────────────────────────────────────────
export async function searchAlphaVantage(query: string, key: string): Promise<Asset[]> {
  if (!key) return [];
  const r = await fetch(`https://www.alphavantage.co/query?function=SYMBOL_SEARCH&keywords=${encodeURIComponent(query)}&apikey=${key}`);
  if (!r.ok) throw new Error('AV search error');
  const json = await r.json();
  if (json.Note || json.Information) throw new Error('Alpha Vantage rate limit — wait a minute');
  return (json.bestMatches || []).slice(0, 15).map((m: any) => ({
    symbol: m['1. symbol'], name: m['2. name'], type: 'STOCK' as const, src: 'av' as const,
    avSym: m['1. symbol'], base: 100, vol: 0.02, custom: true}));
}

// ─────────────────────────────────────────────────
// FOREX — any currency pair available from the live rates feed
// ─────────────────────────────────────────────────
const CURRENCY_NAMES: Record<string, string> = {
  EUR: 'Euro', GBP: 'British Pound', JPY: 'Japanese Yen', INR: 'Indian Rupee', AUD: 'Australian Dollar',
  CAD: 'Canadian Dollar', CHF: 'Swiss Franc', CNY: 'Chinese Yuan', SGD: 'Singapore Dollar', AED: 'UAE Dirham',
  NZD: 'New Zealand Dollar', ZAR: 'South African Rand', HKD: 'Hong Kong Dollar', SEK: 'Swedish Krona',
};

export function searchForex(query: string, rates: Record<string, number> | null): Asset[] {
  if (!rates) return [];
  const q = query.toUpperCase();
  return Object.keys(rates)
    .filter(code => code.includes(q) || (CURRENCY_NAMES[code] || '').toUpperCase().includes(q))
    .slice(0, 20)
    .map(code => ({
      symbol: 'USD' + code, name: `USD / ${CURRENCY_NAMES[code] || code}`, type: 'FOREX' as const, src: 'forex' as const,
      fxKey: code, fxInv: true, base: rates[code], vol: 0.003, custom: true}));
}
