import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { getSecureCredential, setSecureCredential, deleteSecureCredential } from '../utils/secureCredentials';
import { ASSETS, Asset } from '../api/assets';
import { openBinanceStream, fetchBinanceDepth } from '../api/binance';
import { fetchForexRates, fxPrice } from '../api/forex';
import { fetchAVQuote, fetchAVNews, NewsItem } from '../api/alphaVantage';
import { aoLTP, AOSession } from '../api/angelOne';
import { DepthLevel } from '../utils/orderBook';
import { checkAlerts } from '../utils/alerts';
import { logger } from '../utils/logger';
import { getCustomAssets, addCustomAsset, removeCustomAsset, getHiddenBuiltins, hideBuiltinAsset, restoreAllBuiltins } from '../utils/watchlist';

// REMOVED: this app no longer fabricates any price data. `status` replaces
// the old boolean `live` + silent-simulation-fallback design:
//  - 'live'  → a real source updated this within the last few minutes
//  - 'stale' → a real source updated it once, but has gone quiet (e.g. AV's
//              25-requests/day free tier exhausted) — last REAL price is
//              kept frozen and shown, clearly flagged, never faked further
//  - 'none'  → no real source has ever reported a price for this symbol yet
type PriceStatus = 'live' | 'stale' | 'none';
type PriceInfo = {
  price: number; chg: number; status: PriceStatus; lastUpdated?: number;
  depth?: { buy: DepthLevel[]; sell: DepthLevel[] } | null; totBuyQty?: number; totSellQty?: number; volume?: number;
};

type DataCtx = {
  prices: Record<string, PriceInfo>;
  allAssets: Asset[];
  addAsset: (a: Asset) => Promise<void>;
  removeAsset: (symbol: string, src: string) => Promise<void>;
  hideAsset: (symbol: string, src: string) => Promise<void>;
  restoreBuiltins: () => Promise<void>;
  hiddenCount: number;
  avKey: string; setAvKey: (k: string) => void;
  anthropicKey: string; setAnthropicKey: (k: string) => void;
  aoSession: AOSession | null; setAoSession: (s: AOSession | null) => void;
  wsStatus: 'live' | 'connecting' | 'reconnecting' | 'error';
  news: NewsItem[];
  liveCount: number;
};

const Ctx = createContext<DataCtx>({} as DataCtx);
const STALE_MS = 3 * 60 * 1000;

export function DataProvider({ children }: { children: React.ReactNode }) {
  const [customAssets, setCustomAssets] = useState<Asset[]>([]);
  const [hiddenKeys, setHiddenKeys] = useState<string[]>([]);
  const builtinsVisible = ASSETS.filter(a => !hiddenKeys.includes(a.symbol + '|' + a.src));
  const builtinKeys = new Set(builtinsVisible.map(a => a.symbol + '|' + a.src));
  const allAssets = [
    ...builtinsVisible,
    ...customAssets.filter(a => !builtinKeys.has(a.symbol + '|' + a.src)),
  ];

  // No seeded/fabricated starting prices — everything starts truly empty
  // until a real source reports a number.
  const [prices, setPrices] = useState<Record<string, PriceInfo>>({});
  const [avKey, setAvKeyState] = useState('');
  const [anthropicKey, setAnthropicKeyState] = useState('');
  const [aoSession, setAoSessionState] = useState<AOSession | null>(null);
  const [wsStatus, setWsStatus] = useState<'live' | 'connecting' | 'reconnecting' | 'error'>('connecting');
  const [news, setNews] = useState<NewsItem[]>([]);
  const aoPollRef = useRef<any>(null);
  const bnDepthPollRef = useRef<any>(null);
  const avPollRef = useRef<any>(null);
  const newsPollRef = useRef<any>(null);
  const bnUnsubRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    // TASK 1 (Secure Storage) — these now read through SecureStore, with
    // automatic, lazy, one-time migration from the old plaintext
    // AsyncStorage values built into getSecureCredential itself.
    getSecureCredential('avKey').then(k => k && setAvKeyState(k));
    getSecureCredential('anthropicKey').then(k => k && setAnthropicKeyState(k));
    getSecureCredential('aoSession').then(s => s && setAoSessionState(JSON.parse(s)));
    getCustomAssets().then(setCustomAssets);
    getHiddenBuiltins().then(setHiddenKeys);
  }, []);

  function setAvKey(k: string) { setAvKeyState(k); setSecureCredential('avKey', k); }
  function setAnthropicKey(k: string) { setAnthropicKeyState(k); setSecureCredential('anthropicKey', k); }
  function setAoSession(s: AOSession | null) {
    setAoSessionState(s);
    if (s) setSecureCredential('aoSession', JSON.stringify(s));
    else deleteSecureCredential('aoSession');
  }

  const addAsset = useCallback(async (a: Asset) => {
    const updated = await addCustomAsset(a);
    setCustomAssets(updated);
  }, []);
  const removeAsset = useCallback(async (symbol: string, src: string) => {
    const updated = await removeCustomAsset(symbol, src);
    setCustomAssets(updated);
  }, []);
  const hideAsset = useCallback(async (symbol: string, src: string) => {
    const updated = await hideBuiltinAsset(symbol, src);
    setHiddenKeys(updated);
  }, []);
  const restoreBuiltins = useCallback(async () => {
    const updated = await restoreAllBuiltins();
    setHiddenKeys(updated);
  }, []);

  // Binance WS
  useEffect(() => {
    bnUnsubRef.current?.();
    const cryptos = allAssets.filter(a => a.src === 'binance' && a.bnSym);
    if (!cryptos.length) return;
    const close = openBinanceStream(
      cryptos.map(a => a.bnSym!),
      (bnSym, price, chg) => {
        const a = cryptos.find(x => x.bnSym === bnSym);
        if (!a) return;
        setPrices(p => ({ ...p, [a.symbol]: { ...p[a.symbol], price, chg, status: 'live', lastUpdated: Date.now() } }));
        checkAlerts(a.symbol, price);
      },
      setWsStatus
    );
    bnUnsubRef.current = close;
    return () => close();
  }, [customAssets.map(a => a.bnSym).join(','), hiddenKeys.join(',')]);

  // Forex poll — every 60s
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const rates = await fetchForexRates();
        const fxA = allAssets.filter(a => a.src === 'forex' && a.fxKey);
        if (!alive) return;
        setPrices(p => {
          const n = { ...p };
          fxA.forEach(a => {
            const pr = fxPrice(a.fxKey!, !!a.fxInv, a.base, rates);
            n[a.symbol] = { price: pr, chg: ((pr - a.base) / a.base) * 100, status: 'live', lastUpdated: Date.now() };
          });
          return n;
        });
      } catch (_) {}
    }
    load();
    const t = setInterval(load, 60000);
    return () => { alive = false; clearInterval(t); };
  }, [customAssets.map(a => a.fxKey).join(','), hiddenKeys.join(',')]);

  // Angel One LTP poll — every 5s
  useEffect(() => {
    clearInterval(aoPollRef.current);
    if (!aoSession?.jwtToken) return;
    const items = allAssets.filter(a => a.src === 'ao' && a.aoToken && a.aoEx).map(a => ({ symbol: a.symbol, token: a.aoToken!, ex: a.aoEx! }));
    if (!items.length) return;
    async function poll() {
      try {
        const ltps = await aoLTP(items, aoSession!);
        setPrices(p => {
          const n = { ...p };
          Object.entries(ltps).forEach(([sym, q]) => {
            n[sym] = { price: q.price, chg: q.chg, status: 'live', lastUpdated: Date.now(), depth: q.depth, totBuyQty: q.totBuyQty, totSellQty: q.totSellQty, volume: q.volume };
            checkAlerts(sym, q.price);
          });
          return n;
        });
      } catch (e: any) {
        if (e.message?.includes('401')) setAoSession(null);
      }
    }
    poll();
    aoPollRef.current = setInterval(poll, 5000);
    return () => clearInterval(aoPollRef.current);
  }, [aoSession?.jwtToken, customAssets.filter(a => a.src === 'ao').map(a => a.aoToken).join(','), hiddenKeys.join(',')]);

  // GOAL 1 — Binance order book depth poll, every 5s, mirroring the AO
  // poll above exactly. The one real difference: price/chg for Binance
  // symbols already arrives live via the websocket stream, so this poll
  // MERGES depth into whatever price entry already exists rather than
  // replacing it - it must never overwrite a live price with a stale or
  // absent one just because this is a separate REST call on its own timer.
  useEffect(() => {
    clearInterval(bnDepthPollRef.current);
    const bnAssets = allAssets.filter(a => a.src === 'binance' && a.bnSym);
    if (!bnAssets.length) return;
    async function pollDepth() {
      for (const a of bnAssets) {
        try {
          const snap = await fetchBinanceDepth(a.bnSym!, 20);
          setPrices(p => {
            if (!p[a.symbol]) return p; // don't create a malformed partial entry before the websocket has set a real price for this symbol
            return { ...p, [a.symbol]: { ...p[a.symbol], depth: { buy: snap.buy, sell: snap.sell } } };
          });
        } catch (e: any) {
          logger.warn('DataContext', `Binance depth fetch failed for ${a.symbol}: ${e.message}`);
        }
      }
    }
    pollDepth();
    bnDepthPollRef.current = setInterval(pollDepth, 5000);
    return () => clearInterval(bnDepthPollRef.current);
  }, [customAssets.filter(a => a.src === 'binance').map(a => a.bnSym).join(','), hiddenKeys.join(',')]);

  // Alpha Vantage stock quotes — every 65s. Free tier = 25 requests/DAY total,
  // easily exhausted — when that happens, the staleness sweep below marks
  // these as 'stale' rather than freezing them silently as if still live.
  //
  // H1 FIX: fetchAVQuote has no timeout/AbortController, so a single slow
  // or hung connection can stall a loop iteration indefinitely - the floor
  // is 4 assets * 13000ms = 52000ms with zero margin against any real
  // latency. `isPolling` guards against the next setInterval tick starting
  // a second overlapping poll() while one is still running: it SKIPS that
  // tick entirely (does not queue it, does not touch the still-running
  // poll). `cancelled` guards against a different problem - this effect
  // re-running (e.g. avKey changes) while a poll is mid-loop; without it,
  // the old poll's setPrices calls could fire after the new effect
  // instance has already started, writing stale data over fresh state.
  useEffect(() => {
    clearInterval(avPollRef.current);
    if (!avKey) return;
    const avA = allAssets.filter(a => a.src === 'av' && a.avSym);
    if (!avA.length) return;

    let cancelled = false;
    let isPolling = false;

    async function poll() {
      if (isPolling) {
        logger.info('DataContext', 'AV poll skipped - previous cycle still in progress');
        return; // skip this tick entirely; do not queue, do not cancel the active poll
      }
      isPolling = true;
      try {
        for (const a of avA) {
          if (cancelled) return; // effect was cleaned up mid-loop - stop immediately, don't fetch or write anything further
          try {
            const q = await fetchAVQuote(a.avSym!, avKey);
            if (cancelled) return; // re-check after the await: cleanup could have happened while this fetch was in flight
            if (q.price > 0) {
              setPrices(p => ({ ...p, [a.symbol]: { price: q.price, chg: q.chg, status: 'live', lastUpdated: Date.now() } }));
              checkAlerts(a.symbol, q.price);
            }
          } catch (_) {}
          if (cancelled) return;
          await new Promise(r => setTimeout(r, 13000));
        }
      } finally {
        isPolling = false; // ALWAYS cleared, even if something above throws unexpectedly - polling can never be permanently locked out
      }
    }
    poll();
    avPollRef.current = setInterval(poll, 65000);
    return () => { cancelled = true; clearInterval(avPollRef.current); };
  }, [avKey, customAssets.filter(a => a.src === 'av').map(a => a.avSym).join(','), hiddenKeys.join(',')]);

  // Real news — every 5 min
  useEffect(() => {
    clearInterval(newsPollRef.current);
    if (!avKey) { setNews([]); return; }
    async function load() {
      const items = await fetchAVNews(avKey, 'financial_markets,earnings,economy_macro');
      if (items?.length) setNews(items);
    }
    load();
    newsPollRef.current = setInterval(load, 300000);
    return () => clearInterval(newsPollRef.current);
  }, [avKey]);

  // Staleness sweep ONLY — no simulation, no fabricated drift. Anything
  // marked 'live' that hasn't updated in STALE_MS just gets relabeled
  // 'stale' and otherwise left exactly as-is (last real price, frozen,
  // clearly flagged) until a real update arrives again.
  useEffect(() => {
    const t = setInterval(() => {
      setPrices(p => {
        let changed = false;
        const n = { ...p };
        Object.entries(n).forEach(([sym, info]) => {
          if (info.status === 'live' && info.lastUpdated && Date.now() - info.lastUpdated > STALE_MS) {
            n[sym] = { ...info, status: 'stale' };
            changed = true;
          }
        });
        return changed ? n : p;
      });
    }, 5000);
    return () => clearInterval(t);
  }, []);

  const liveCount = Object.values(prices).filter(p => p.status === 'live').length;

  return (
    <Ctx.Provider value={{
      prices, allAssets, addAsset, removeAsset, hideAsset, restoreBuiltins, hiddenCount: hiddenKeys.length,
      avKey, setAvKey, anthropicKey, setAnthropicKey, aoSession, setAoSession, wsStatus, news, liveCount,
    }}>
      {children}
    </Ctx.Provider>
  );
}

export const useData = () => useContext(Ctx);
