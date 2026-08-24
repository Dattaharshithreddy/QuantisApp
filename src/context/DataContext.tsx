import React, { createContext, useContext, useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { KVStore } from '../services/storage';
import { relayPrice } from '../services/priceRelay';
import { getSecureCredential, setSecureCredential, deleteSecureCredential } from '../utils/secureCredentials';
import { ASSETS, Asset, LogicalAsset } from '../api/assets';
import { openBinanceStream, fetchBinanceDepth, fetchBnSpotSnapshot } from '../api/binance';
import { fetchCdxSnapshot, openCdxPriceStream } from '../api/coindcx';
import { variantsForExchange } from '../utils/assetResolver';
import { getAllExchangePreferences, setExchangePreference, clearExchangePreferencesCache } from '../utils/exchangePreferences';
import { bnFuturesGetTicker } from '../api/binanceFuturesApi';
import { fetchForexRates, fxPrice } from '../api/forex';
import { fetchAVQuote, fetchAVNews, NewsItem } from '../api/alphaVantage';
import { fetchCryptoNews, CryptoNewsItem } from '../api/cryptoNews';
import { aoLTP, AOSession, openAOMarketFeed } from '../api/angelOne';
import { DepthLevel } from '../utils/orderBook';
import { checkAlerts } from '../utils/alerts';
import { logger } from '../utils/logger';
import { getCustomAssets, addCustomAsset, removeCustomAsset, getHiddenBuiltins, hideBuiltinAsset, restoreAllBuiltins } from '../utils/watchlist';

// Phase 1: price cache key — persisted across sessions
const PRICE_CACHE_KEY = 'quantis_price_cache_v1';

// Phase 1: seed from base prices immediately, then overlay cached real prices
// (loaded async below). Base prices show in <1ms; cached real prices load in ~50ms.
function buildSeedPrices(): Record<string, PriceInfo> {
  const seed: Record<string, PriceInfo> = {};
  // Iterate all exchange variants — keyed by variant.symbol (the internal price key).
  // This seeds prices for every exchange variant of every asset so the Markets
  // screen has a base price to display before live feeds arrive.
  (ASSETS as any[]).forEach(a => {
    if (a.exchanges) {
      // New LogicalAsset shape
      Object.values(a.exchanges as Record<string, any>).forEach(v => {
        if (v.base) seed[v.symbol] = { price: v.base, chg: 0, status: 'stale', source: 'base', lastUpdated: 0 };
      });
    } else if (a.base) {
      // Fallback for any legacy flat Asset that might be in customAssets
      seed[a.symbol] = { price: a.base, chg: 0, status: 'stale', source: 'base', lastUpdated: 0 };
    }
  });
  return seed;
}

// Price data source — tracks the freshness hierarchy so updates never overwrite
// newer data with older data (e.g. a late REST response can't clobber a WS tick):
//   base      → hardcoded approximate value from assets.ts (shown < 1ms)
//   cache     → real price from last session, loaded from AsyncStorage (~50ms)
//   snapshot  → REST /ticker/24hr response (~500ms), current but not streaming
//   websocket → live streaming tick (most authoritative)
//
export type PriceSource = 'base' | 'cache' | 'snapshot' | 'websocket';
// SOURCE_RANK[a] > SOURCE_RANK[b] means a is more authoritative than b.
// An incoming update is only applied if its source rank ≥ the current rank
// OR if its timestamp is newer than the current lastUpdated.
const SOURCE_RANK: Record<PriceSource, number> = {
  base: 0, cache: 1, snapshot: 2, websocket: 3,
};

// PriceStatus (existing field — drives dot colour in UI):
//   live  → price is from a live source (snapshot or websocket), fresh
//   stale → price is from cache or base — shown but clearly not live
//   none  → no price ever received
type PriceStatus = 'live' | 'stale' | 'none';
type PriceInfo = {
  price: number;
  chg: number;
  status: PriceStatus;
  source: PriceSource;
  lastUpdated: number;
  depth?: { buy: DepthLevel[]; sell: DepthLevel[] } | null;
  totBuyQty?: number;
  totSellQty?: number;
  volume?: number;
  open24h?: number;  // Day open price — used by SmartAPI WS to compute chg% without REST
};

// canUpdate: decides whether an incoming price should overwrite the current one.
//
// Rules (in order of priority):
//   1. No existing price        → always accept.
//   2. Incoming timestamp is meaningfully NEWER (>2s gap) → always accept.
//      Handles: WebSocket disconnects, late-arriving REST snapshots that are
//      genuinely fresher than the last streaming tick.
//   3. Timestamps are approximately equal (within 2s) → prefer higher source rank.
//      Handles: startup races where cache, snapshot and WS all arrive within
//      the same second — source rank breaks the tie (websocket > snapshot > cache > base).
//   4. Incoming timestamp is OLDER → reject.
//      Handles: delayed REST response arriving after a fresher WebSocket tick.
//
// The 2-second window for "approximately equal" is a deliberate choice:
//   - REST snapshots timestamp themselves with Date.now() at parse time, which
//     may be 1-2s after the data was actually captured by Binance.
//   - WebSocket ticks timestamp themselves on receipt, which is near-realtime.
//   - Without a tolerance window, a snapshot captured at T+0 but received at T+1.5
//     would be incorrectly rejected even though it's genuinely newer market data.
// 500ms compromise: lets every miniTicker tick through (~1000ms cadence) while
// still protecting against late REST snapshots overwriting fresh WS prices.
// The original 2000ms was too conservative — it rejected every other WS tick.
// 200ms is too aggressive — REST snapshots can legitimately arrive 300-400ms late.
const TIMESTAMP_TOLERANCE_MS = 500;

function canUpdate(current: PriceInfo | undefined, incomingSource: PriceSource, incomingTs: number): boolean {
  if (!current || !current.lastUpdated) return true; // no existing price — always accept

  const ageDiff = incomingTs - current.lastUpdated;

  // Rule 2: incoming is meaningfully newer — accept regardless of source rank
  if (ageDiff > TIMESTAMP_TOLERANCE_MS) return true;

  // Rule 3: approximately same timestamp — use source rank as tie-breaker
  if (Math.abs(ageDiff) <= TIMESTAMP_TOLERANCE_MS) {
    return SOURCE_RANK[incomingSource] >= SOURCE_RANK[current.source];
  }

  // Rule 4: incoming is older — reject
  return false;
}

type DataCtx = {
  prices: Record<string, PriceInfo>;
  nftTokenVersion: number; // bumped when NFO aoTokens are resolved; consumers use as dep
  nftTokenError: string | null;  // null=ok/pending, string=error message from failed token fetch
  retryNFOTokens: () => void;    // manually retry scrip master fetch after failure
  // ── Dual asset model ──────────────────────────────────────────────────────
  // logicalAssets: new production model — one LogicalAsset per instrument,
  //   each with an exchanges map of ExchangeVariant objects. Used by:
  //   MarketsScreen (one row per instrument), ChartScreen (ExchangeSelector).
  logicalAssets: LogicalAsset[];
  // allAssets: compatibility shim — flat Asset[] derived from LogicalAsset.exchanges.
  //   One entry per exchange variant. Shape is identical to the old Asset type.
  //   Used by every other screen (Journal, Alerts, Scanner, Backtest, etc.).
  //   These 18+ consumers continue to work without any changes.
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
  updateSpotPrice: (symbol: string, price: number) => void;
  // Exchange preferences — loaded once in DataContext, available synchronously to all screens
  exchangePrefs:        Record<string, string>;
  updateExchangePreference: (name: string, src: string) => Promise<void>;
};

const CTX_DEFAULT: DataCtx = {
  prices: {}, logicalAssets: [], allAssets: [], exchangePrefs: {},
  nftTokenVersion: 0, nftTokenError: null, liveCount: 0,
  wsStatus: 'disconnected', news: [], avKey: '', anthropicKey: '',
  aoSession: null, hiddenCount: 0, customAssets: [],
  retryNFOTokens: () => {}, addAsset: async () => {},
  removeAsset: async () => {}, hideAsset: async () => {},
  restoreBuiltins: async () => {}, updateSpotPrice: () => {},
  setAvKey: () => {}, setAnthropicKey: () => {}, setAoSession: () => {},
  updateExchangePreference: async () => {},
} as unknown as DataCtx;
const Ctx = createContext<DataCtx>(CTX_DEFAULT);
const STALE_MS = 3 * 60 * 1000;
console.log('[QUANTIS_DIAG] M-DataContext: DataContext.tsx module loaded');

export function DataProvider({ children }: { children: React.ReactNode }) {
  const [customAssets, setCustomAssets] = useState<Asset[]>([]);
  const [hiddenKeys, setHiddenKeys] = useState<string[]>([]);
  const [exchangePrefs, setExchangePrefs] = useState<Record<string, string>>({});

  // Load exchange preferences synchronously from cache or AsyncStorage on mount
  useEffect(() => {
    getAllExchangePreferences().then(prefs => setExchangePrefs(prefs)).catch(() => {});
  }, []);

  // ── Dual asset model ─────────────────────────────────────────────────────
  //
  // logicalAssets: LogicalAsset[] — one entry per instrument, filtered by
  //   hiddenKeys (keyed by asset.id). Used by MarketsScreen + ExchangeSelector.
  //
  // allAssets: Asset[] — flat compatibility shim. Each LogicalAsset.exchanges
  //   variant is expanded into one flat Asset entry with the same shape as
  //   the old Asset type. Used by Journal, Alerts, Scanner, Backtest, etc.
  //   These consumers are completely unaware of LogicalAsset — zero changes.
  //
  // The hidden list for built-in LogicalAssets uses asset.id as the key.
  // Custom assets (added via SymbolSearch) use the legacy symbol+'|'+src key.

  // FIX REGRESSION: allAssets and logicalAssets wrapped in useMemo so they
  // only rebuild when hiddenKeys or customAssets actually change.
  // Previously these were computed inline on every render — every setPrices()
  // call (from price ticks every 5s) caused allAssets to be a new array
  // reference, which caused every useCallback dep on allAssets to rebuild,
  // causing loadCandles to rebuild, causing candles to reload on every tick.
  const logicalAssets = useMemo(() => {
    const builtins = (ASSETS as LogicalAsset[]).filter(a => !hiddenKeys.includes(a.id));
    // Custom assets (added via Symbol Search) are stored as flat Asset[] and
    // were never wrapped into LogicalAsset shape here, so MarketsScreen (which
    // renders logicalAssets, not allAssets) never showed newly-added symbols.
    // Wrap each into a single-exchange LogicalAsset so it appears in the list
    // and long-press remove resolves the correct symbol+src (see MarketsScreen).
    const customLogical: LogicalAsset[] = customAssets
      .filter(a => !hiddenKeys.includes(a.symbol + '|' + a.src))
      .map(a => ({
        id: a.symbol + '|' + a.src,
        name: a.name ?? a.symbol,
        type: a.type,
        defaultExchange: a.src,
        exchanges: { [a.src]: { ...a } as any },
        custom: true,
      }));
    return [...builtins, ...customLogical];
  }, [hiddenKeys, customAssets]);

  const allAssets = useMemo((): Asset[] => {
    const builtinFlatAssets: Asset[] = logicalAssets.flatMap(la =>
      Object.entries(la.exchanges).map(([, variant]) => ({
        symbol:     variant.symbol,
        name:       la.name,
        type:       la.type,
        src:        variant.src as Asset['src'],
        base:       variant.base,
        vol:        variant.vol,
        bnSym:      variant.bnSym,
        cdxSym:     variant.cdxSym,
        cdxMkt:     (variant as any).cdxMkt,
        avSym:      variant.avSym,
        fxKey:      variant.fxKey,
        fxInv:      variant.fxInv,
        aoToken:    variant.aoToken,
        aoEx:       variant.aoEx,
        lotSize:    (variant as any).lotSize,
        underlying: (variant as any).underlying,
        assetId:    la.id,
      } as Asset))
    );
    const builtinKeys = new Set(builtinFlatAssets.map(a => a.symbol + '|' + a.src));
    return [
      ...builtinFlatAssets,
      ...customAssets.filter(a => !builtinKeys.has(a.symbol + '|' + a.src)),
    ];
  }, [logicalAssets, customAssets]);

  // Phase 1: seed from base prices instantly, overlay cached real prices async
  const [prices, setPrices] = useState<Record<string, PriceInfo>>(buildSeedPrices);

  // Phase 1: load cached prices from last session on mount (~50ms)
  useEffect(() => {
    KVStore.get(PRICE_CACHE_KEY).then(raw => {
      if (!raw) return;
      try {
        const cached: Record<string, PriceInfo> = JSON.parse(raw);
        // Overlay cached real prices (status:'stale', source:'cache')
        // canUpdate guard prevents overwriting if a faster source already arrived
        setPrices(p => {
          const merged = { ...p };
          Object.entries(cached).forEach(([sym, info]) => {
            const ts = info.lastUpdated ?? 0;
            if (info.price > 0 && canUpdate(merged[sym], 'cache', ts)) {
              merged[sym] = { ...info, status: 'stale', source: 'cache', lastUpdated: ts };
            }
          });
          return merged;
        });
      } catch { /* ignore corrupt cache */ }
    }).catch(() => {});
  }, []);

  // Phase 1: write prices to cache — debounced to every 10s max
  // Avoids thrashing AsyncStorage on every WebSocket tick (can be 10+/sec).
  const savePricesCacheRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const schedulePricesCacheSave = useCallback((latestPrices: Record<string, PriceInfo>) => {
    if (savePricesCacheRef.current) return; // already scheduled
    savePricesCacheRef.current = setTimeout(() => {
      savePricesCacheRef.current = null;
      // Only cache live prices — don't persist stale/base values
      const toSave: Record<string, PriceInfo> = {};
      Object.entries(latestPrices).forEach(([sym, info]) => {
        if (info.status === 'live' && info.price > 0) toSave[sym] = info;
      });
      if (Object.keys(toSave).length > 0) {
        KVStore.set(PRICE_CACHE_KEY, JSON.stringify(toSave)).catch(() => {});
      }
    }, 10_000); // write at most once every 10 seconds
  }, []);
  // Bumped after resolveFuturesTokensIntoAssets completes (success OR failure)
  // so useChartData re-runs loadCandles and can show the right error message.
  const [nftTokenVersion, setNftTokenVersion] = useState(0);
  // null = not yet resolved, false = resolved ok, string = error message
  const [nftTokenError, setNftTokenError] = useState<string | null>(null);
  const [avKey, setAvKeyState] = useState('');
  const [anthropicKey, setAnthropicKeyState] = useState('');
  const [aoSession, setAoSessionState] = useState<AOSession | null>(null);
  const [wsStatus, setWsStatus] = useState<'live' | 'connecting' | 'reconnecting' | 'error'>('connecting');
  const [news, setNews] = useState<NewsItem[]>([]);
  const aoPollRef = useRef<any>(null);
  const aoWSRef   = useRef<(() => void) | null>(null);  // SmartAPI WebSocket cleanup
  const bnDepthPollRef = useRef<any>(null);
  const avPollRef = useRef<any>(null);
  const newsPollRef = useRef<any>(null);
  const bnUnsubRef  = useRef<(() => void) | null>(null);
  const cdxUnsubRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    // TASK 1 (Secure Storage) — these now read through SecureStore, with
    // automatic, lazy, one-time migration from the old plaintext
    // AsyncStorage values built into getSecureCredential itself.
    getSecureCredential('avKey').then(k => k && setAvKeyState(k));
    getSecureCredential('anthropicKey').then(k => k && setAnthropicKeyState(k));
    getSecureCredential('aoSession').then(s => {
      if (!s) return;
      try {
        const session = JSON.parse(s);
        setAoSessionState(session);
        // Resolve NFO tokens for ao_futures assets on app startup
        import('../utils/futures/futuresContracts').then(({ resolveFuturesTokensIntoAssets }) => {
          resolveFuturesTokensIntoAssets(allAssets)
          .then(() => {
            setNftTokenError(null);
            setNftTokenVersion(v => v + 1);
            // Seed futures prices from corresponding equity so Markets shows
            // something immediately. Futures trade close to the underlying.
            // Marked 'stale' so it's clearly not a live futures quote.
            setPrices(p => {
              const n = { ...p };
              allAssets.filter(a => a.src === 'ao_futures' && a.underlying).forEach(fut => {
                if (n[fut.symbol]) return; // already has a price
                const equityPrice = p[fut.underlying as string] ?? p[(fut.underlying as string) + '50'];
                if (equityPrice?.price) {
                  n[fut.symbol] = { price: equityPrice.price, chg: equityPrice.chg, status: 'stale', source: 'cache' as PriceSource, lastUpdated: Date.now() };
                } else if (fut.base) {
                  n[fut.symbol] = { price: fut.base, chg: 0, status: 'stale', source: 'base' as PriceSource, lastUpdated: Date.now() };
                }
              });
              return n;
            });
          })
          .catch((e: any) => {
            setNftTokenError(e?.message ?? 'Token fetch failed');
            setNftTokenVersion(v => v + 1); // still bump so UI re-renders with error
          });
        });
      } catch { /* corrupted — ignore */ }
    });
    getCustomAssets().then(setCustomAssets);
    getHiddenBuiltins().then(setHiddenKeys);
  }, []);

  function setAvKey(k: string) { setAvKeyState(k); setSecureCredential('avKey', k); }
  function setAnthropicKey(k: string) { setAnthropicKeyState(k); setSecureCredential('anthropicKey', k); }
  function setAoSession(s: AOSession | null) {
    setAoSessionState(s);
    if (s) {
      setSecureCredential('aoSession', JSON.stringify(s));
      // Resolve NFO instrument tokens for ao_futures assets once session is active.
      // Tokens are not in assets.ts (they roll monthly) — fetched from AO scrip master.
      import('../utils/futures/futuresContracts').then(({ resolveFuturesTokensIntoAssets }) => {
        resolveFuturesTokensIntoAssets(allAssets)
          .then(() => {
            setNftTokenError(null);
            setNftTokenVersion(v => v + 1);
            // Seed futures prices from equity so Markets shows data immediately
            setPrices(p => {
              const n = { ...p };
              allAssets.filter(a => a.src === 'ao_futures' && a.underlying).forEach(fut => {
                if (n[fut.symbol]) return;
                const equityPrice = p[fut.underlying as string] ?? p[(fut.underlying as string) + '50'];
                if (equityPrice?.price) {
                  n[fut.symbol] = { price: equityPrice.price, chg: equityPrice.chg, status: 'stale', source: 'cache' as PriceSource, lastUpdated: Date.now() };
                } else if (fut.base) {
                  n[fut.symbol] = { price: fut.base, chg: 0, status: 'stale', source: 'base' as PriceSource, lastUpdated: Date.now() };
                }
              });
              return n;
            });
          })
          .catch((e: any) => {
            setNftTokenError(e?.message ?? 'Token fetch failed');
            setNftTokenVersion(v => v + 1); // still bump so UI re-renders with error
          });
      });
    }
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
    // Built-in LogicalAssets are keyed by asset.id in hiddenKeys.
    // Find the LogicalAsset whose variant matches this symbol+src combo,
    // then hide by asset.id. Custom assets fall back to symbol+'|'+src.
    const la = (ASSETS as LogicalAsset[]).find(a =>
      Object.values(a.exchanges).some(v => v.symbol === symbol && v.src === src)
    );
    const updated = la
      ? await hideBuiltinAsset(la.id, '')   // hide by LogicalAsset.id
      : await hideBuiltinAsset(symbol, src); // legacy: custom asset
    setHiddenKeys(updated);
  }, []);
  const updateExchangePreference = useCallback(async (name: string, src: string) => {
    await setExchangePreference(name, src);
    setExchangePrefs(p => {
      const slug = name.toLowerCase().replace(/\s+/g, '');
      return { ...p, [slug]: src };
    });
  }, []);

  const restoreBuiltins = useCallback(async () => {
    const updated = await restoreAllBuiltins();
    setHiddenKeys(updated);
  }, []);

  // Phase 2: REST snapshot — fires immediately on mount, fills prices before WebSocket connects
  // Also fires when app comes to foreground (AppState 'active') after being backgrounded.
  const runBnSnapshot = useCallback(async () => {
    const bnVariants = variantsForExchange('binance');
    if (!bnVariants.length) return;
    const snapshot = await fetchBnSpotSnapshot(bnVariants.map(({ variant }) => variant.bnSym!).filter(Boolean));
    if (!Object.keys(snapshot).length) return;
    setPrices(p => {
      const n = { ...p };
      bnVariants.forEach(({ variant }) => {
        if (!variant.bnSym) return;
        const s = snapshot[variant.bnSym];
        const ts = Date.now();
        if (s && s.price > 0 && canUpdate(n[variant.symbol], 'snapshot', ts)) {
          n[variant.symbol] = { ...n[variant.symbol], price: s.price, chg: s.chg, status: 'live', source: 'snapshot', lastUpdated: ts };
          checkAlerts(variant.symbol, s.price);
        }
      });
      schedulePricesCacheSave(n);
      return n;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schedulePricesCacheSave]); // allAssets intentionally omitted — variantsForExchange() uses stable ASSETS constant

  // Fire REST snapshot on mount and on foreground
  useEffect(() => { runBnSnapshot(); }, [runBnSnapshot]);
  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') runBnSnapshot();
    });
    return () => sub.remove();
  }, [runBnSnapshot]);

  // Binance WS
  useEffect(() => {
    bnUnsubRef.current?.();
    const bnVariants = variantsForExchange('binance');
    if (!bnVariants.length) return;
    const close = openBinanceStream(
      bnVariants.map(({ variant }) => variant.bnSym!).filter(Boolean),
      (bnSym, price, chg) => {
        const entry = bnVariants.find(({ variant }) => variant.bnSym === bnSym);
        if (!entry) return;
        const sym = entry.variant.symbol;
        setPrices(p => {
          const ts = Date.now();
          if (!canUpdate(p[sym], 'websocket', ts)) return p;
          const n = { ...p, [sym]: { ...p[sym], price, chg, status: 'live', source: 'websocket', lastUpdated: ts } };
          schedulePricesCacheSave(n);
          return n;
        });
        checkAlerts(sym, price);
        relayPrice(sym, price, chg); // relay to Firestore for background notifications
      },
      setWsStatus
    );
    bnUnsubRef.current = close;
    return () => close();
  }, [hiddenKeys.join(','), schedulePricesCacheSave]);

  // Binance Futures price poll — every 5s via public fapi/v1/ticker/24hr
  // No auth required. Covers src:'binance_futures' perp assets (BTC-PERP etc.)
  // which are NOT covered by the spot WebSocket above.
  useEffect(() => {
    const bnfRef = { current: 0 as any };
    const bnfAssets = allAssets.filter(a => a.src === 'binance_futures' && a.bnSym);
    if (!bnfAssets.length) return;
    async function pollBnFutures() {
      try {
        const results = await Promise.allSettled(
          bnfAssets.map(a => bnFuturesGetTicker(a.bnSym!))
        );
        setPrices(p => {
          const n = { ...p };
          results.forEach((r, i) => {
            if (r.status === 'fulfilled') {
              const a = bnfAssets[i];
              n[a.symbol] = { price: r.value.price, chg: r.value.priceChangePct, status: 'live', source: 'snapshot' as PriceSource, lastUpdated: Date.now() };
              checkAlerts(a.symbol, r.value.price);
            }
          });
          return n;
        });
      } catch { /* non-fatal */ }
    }
    pollBnFutures();
    bnfRef.current = setInterval(pollBnFutures, 5000);
    return () => clearInterval(bnfRef.current);
  }, [allAssets.filter(a => a.src === 'binance_futures').map(a => a.bnSym).join(','), hiddenKeys.join(',')]);
  // ── CoinDCX price snapshot + stream ──────────────────────────────────────────
  // REST snapshot fires on mount to seed prices before the poll loop starts.
  // openCdxPriceStream polls /exchange/ticker every 2s (all tickers in one call).
  // Uses cdxMkt (e.g. 'BTCUSDT') as both the lookup key and the asset.symbol
  // for the prices map, so it integrates cleanly with the existing PriceInfo system.
  // FIX OOM: removed `allAssets` from deps — variantsForExchange() reads from
  // module-level ASSETS constant which never changes, so no dep is needed.
  // Previously: allAssets in deps → allAssets rebuilt on every setPrices call →
  // runCdxSnapshot rebuilt → useEffect fired → another snapshot → infinite loop.
  const runCdxSnapshot = useCallback(async () => {
    const cdxSpotSnap    = variantsForExchange('coindcx');
    const cdxFutSnap     = variantsForExchange('coindcx_futures');
    const cdxVariants    = [...cdxSpotSnap, ...cdxFutSnap];
    if (!cdxVariants.length) return;
    const uniqueSnapMkts = [...new Set(cdxVariants.map(({ variant }) => variant.cdxMkt).filter(Boolean) as string[])];
    const snapshot = await fetchCdxSnapshot(uniqueSnapMkts);
    if (!Object.keys(snapshot).length) return;
    setPrices(p => {
      const n = { ...p };
      cdxVariants.forEach(({ variant }) => {
        if (!variant.cdxMkt) return;
        const s = snapshot[variant.cdxMkt];
        const ts = Date.now();
        if (s && s.price > 0 && canUpdate(n[variant.symbol], 'snapshot', ts)) {
          n[variant.symbol] = { ...n[variant.symbol], price: s.price, chg: s.chg, status: 'live', source: 'snapshot', lastUpdated: ts };
          checkAlerts(variant.symbol, s.price);
        }
      });
      schedulePricesCacheSave(n);
      return n;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schedulePricesCacheSave]); // intentionally omits allAssets — see comment above

  useEffect(() => { runCdxSnapshot(); }, [runCdxSnapshot]);

  // CoinDCX poll stream — opens when CoinDCX assets are present
  useEffect(() => {
    cdxUnsubRef.current?.();
    // Include both spot and futures variants — futures prices come from same ticker
    const cdxSpot    = variantsForExchange('coindcx');
    const cdxFutures = variantsForExchange('coindcx_futures');
    const cdxVariants = [...cdxSpot, ...cdxFutures];
    if (!cdxVariants.length) return;
    // Deduplicate cdxMkt keys (spot ETHUSDT and futures ETHUSDT are same feed)
    const uniqueMarkets = [...new Set(cdxVariants.map(({ variant }) => variant.cdxMkt).filter(Boolean) as string[])];
    const close = openCdxPriceStream(
      uniqueMarkets,
      (market, price, chg) => {
        const entry = cdxVariants.find(({ variant }) => variant.cdxMkt === market);
        if (!entry) return;
        const sym = entry.variant.symbol;
        setPrices(p => {
          const ts = Date.now();
          if (!canUpdate(p[sym], 'websocket', ts)) return p;
          const n = { ...p, [sym]: { ...p[sym], price, chg, status: 'live', source: 'websocket', lastUpdated: ts } };
          schedulePricesCacheSave(n);
          return n;
        });
        checkAlerts(sym, price);
      },
      () => {},
    );
    cdxUnsubRef.current = close;
    return () => close();
  }, [hiddenKeys.join(','), schedulePricesCacheSave]);


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
            n[a.symbol] = { price: pr, chg: ((pr - a.base) / a.base) * 100, status: 'live', source: 'snapshot' as PriceSource, lastUpdated: Date.now() };
          });
          return n;
        });
      } catch (_) {}
    }
    load();
    const t = setInterval(load, 60000);
    return () => { alive = false; clearInterval(t); };
  }, [customAssets.map(a => a.fxKey).join(','), hiddenKeys.join(',')]);

  // ── Angel One price feed ─────────────────────────────────────────────────
  // Strategy: SmartAPI WebSocket (tick-by-tick) as primary.
  //           REST LTP poll (every 5s) as fallback when WS is unavailable.
  // The WebSocket uses feedToken from aoLogin — already stored in AOSession.
  // Poll runs regardless to catch edge cases (circuit breakers, WS gaps).
  useEffect(() => {
    clearInterval(aoPollRef.current);
    aoWSRef.current?.();
    aoWSRef.current = null;
    if (!aoSession?.jwtToken) return;

    const items = allAssets
      .filter(a => (a.src === 'ao' || a.src === 'ao_futures') && a.aoToken && a.aoEx)
      .map(a => ({ symbol: a.symbol, token: a.aoToken!, aoEx: a.aoEx! }));
    if (!items.length) return;

    // ── WebSocket: tick-by-tick LTP via SmartAPI Market Feed ──────────────
    if (aoSession.feedToken) {
      aoWSRef.current = openAOMarketFeed(
        items,
        aoSession,
        (symbol, ltp, ohlcv) => {
          setPrices(p => {
            const ts = Date.now();
            if (!canUpdate(p[symbol], 'websocket', ts)) return p;
            const prev = p[symbol] ?? {};
            const chg  = prev.open24h ? ((ltp - prev.open24h) / prev.open24h) * 100 : (prev.chg ?? 0);
            const safeChg = isNaN(chg) ? (prev.chg ?? 0) : chg;
            return {
              ...p,
              [symbol]: {
                ...prev,
                price: ltp,
                chg: safeChg,
                // Preserve open24h so chg stays consistent across ticks
                open24h: prev.open24h ?? (ohlcv?.open ?? ltp),
                status: 'live',
                source: 'websocket',
                lastUpdated: ts,
                // Update depth volume from OHLCV ticks if available
                ...(ohlcv ? { volume: ohlcv.volume } : {}),
              },
            };
          });
          checkAlerts(symbol, ltp);
        },
        (status) => {
          logger.info('DataContext', `AO SmartAPI WS: ${status}`);
        },
        1, // LTP_MODE — fastest, lowest bandwidth
      );
    }

    // ── Poll fallback: every 5s for depth + circuit limits ────────────────
    // Also acts as safety net when WebSocket is reconnecting.
    // FULL mode gives us order book depth which WS LTP_MODE doesn't provide.
    const ltpItems = items.map(i => ({
      symbol: i.symbol, token: i.token, ex: i.aoEx,
    }));
    async function poll() {
      try {
        const ltps = await aoLTP(ltpItems, aoSession!);
        const fetchedCount = Object.keys(ltps).length;
        if (fetchedCount === 0) {
          console.warn('[AO Poll] LTP returned 0 quotes — tokens may be invalid or market API unavailable');
        }
        setPrices(p => {
          const n = { ...p };
          Object.entries(ltps).forEach(([sym, q]) => {
            // Only overwrite price from poll if WebSocket hasn't sent a fresher tick
            const existing = p[sym];
            const ts = Date.now();
            const wsIsActive = existing?.source === 'websocket' &&
              existing.lastUpdated != null &&
              (ts - existing.lastUpdated) < 10_000; // WS active in last 10s
            n[sym] = {
              ...existing,
              // Keep WS price if active; use poll price otherwise
              price:        wsIsActive ? existing!.price : q.price,
              chg:          wsIsActive ? existing!.chg   : q.chg,
              open24h:      existing?.open24h ?? q.price,
              status:       'live',
              source:       wsIsActive ? 'websocket' : 'snapshot',
              lastUpdated:  wsIsActive ? existing!.lastUpdated : ts,
              // Always update depth from FULL mode poll
              depth:        q.depth,
              totBuyQty:    q.totBuyQty,
              totSellQty:   q.totSellQty,
              volume:       q.volume,
            } as any;
            checkAlerts(sym, wsIsActive ? existing!.price : q.price);
          });
          return n;
        });
      } catch (e: any) {
        console.warn('[AO Poll] LTP error:', e?.message);
        if (e.message?.includes('401')) setAoSession(null);
      }
    }
    poll();
    aoPollRef.current = setInterval(poll, 5000);
    return () => {
      clearInterval(aoPollRef.current);
      aoWSRef.current?.();
      aoWSRef.current = null;
    };
  }, [aoSession?.jwtToken, aoSession?.feedToken,
      allAssets.filter(a => a.src === 'ao' || a.src === 'ao_futures').map(a => a.aoToken).join(','),
      hiddenKeys.join(',')
  ]);

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
              setPrices(p => ({ ...p, [a.symbol]: { price: q.price, chg: q.chg, status: 'live', source: 'snapshot' as PriceSource, lastUpdated: Date.now() } }));
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
      // Try CryptoPanic first (no API key, crypto-specific, reliable)
      const cryptoItems = await fetchCryptoNews(
        logicalAssets.filter(a => a.type === 'CRYPTO').map(a => a.id).slice(0, 3)
      );
      if (cryptoItems.length) {
        // Map CryptoNewsItem to NewsItem shape for compatibility
        setNews(cryptoItems.map(n => ({
          headline: n.headline,
          source: n.source,
          url: n.url,
          time: n.publishedAt,
          summary: `${n.sentiment === 'positive' ? '📈' : n.sentiment === 'negative' ? '📉' : '📰'} ${n.currencies?.join(', ') ?? ''}`,
        } as any)));
      } else if (avKey) {
        // Fallback: Alpha Vantage (only if API key set, to avoid quota burn)
        const items = await fetchAVNews(avKey, 'blockchain,financial_markets');
        if (items?.length) setNews(items);
      }
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
            n[sym] = { ...info, status: 'stale', source: (info.source ?? 'cache') as PriceSource };
            changed = true;
          }
        });
        return changed ? n : p;
      });
    }, 5000);
    return () => clearInterval(t);
  }, []);

  const liveCount = Object.values(prices).filter(p => p.status === 'live').length;

  // Manual retry — clears cache first so a fresh scrip master fetch is forced.
  const retryNFOTokens = useCallback(() => {
    if (!aoSession?.jwtToken) return;
    setNftTokenError(null);
    import('../utils/futures/futuresContracts').then(({ clearContractCache, resolveFuturesTokensIntoAssets }) => {
      clearContractCache().then(() =>
        resolveFuturesTokensIntoAssets(allAssets)
          .then(() => { setNftTokenError(null); setNftTokenVersion(v => v + 1); })
          .catch((e: any) => { setNftTokenError(e?.message ?? 'Token fetch failed'); setNftTokenVersion(v => v + 1); })
      );
    });
  }, [aoSession, allAssets]);

  // updateSpotPrice: called by useChartData's aggTrade stream to push trade-level
  // prices into DataContext without waiting for the next miniTicker tick (1s).
  // Only updates if incoming is from 'websocket' source and passes canUpdate guard.
  const updateSpotPrice = useCallback((symbol: string, price: number) => {
    setPrices(p => {
      const ts = Date.now();
      if (!canUpdate(p[symbol], 'websocket', ts)) return p;
      return { ...p, [symbol]: { ...p[symbol], price, source: 'websocket', lastUpdated: ts } };
    });
  }, []);

  return (
    <Ctx.Provider value={{
      prices, logicalAssets, allAssets, nftTokenVersion, nftTokenError, retryNFOTokens, addAsset, removeAsset, hideAsset, restoreBuiltins, hiddenCount: hiddenKeys.length, exchangePrefs, updateExchangePreference,
      avKey, setAvKey, anthropicKey, setAnthropicKey, aoSession, setAoSession, wsStatus, news, liveCount, updateSpotPrice}}>
      {children}
    </Ctx.Provider>
  );
}

export const useData = () => useContext(Ctx);
