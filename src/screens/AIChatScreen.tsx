// ─────────────────────────────────────────────────────────────────────────────
// AI COPILOT CHAT SCREEN  (v6.0.0 — Phase 3: streaming fully isolated)
//
// Phase 3 key change over Phase 2:
//   streamingTick has been REMOVED from AIChatScreen state.
//   StreamingBubble owns its own local tick state and update mechanism.
//
//   Pattern: forceUpdate subscription
//     flushUpdate (in send()) calls streamingForceUpdateRef.current()
//     This is a ref to StreamingBubble's own internal setLocalTick
//     StreamingBubble registers it on mount, unregisters on unmount
//
//   Result:
//     Per streaming chunk: ONLY StreamingBubble re-renders
//     AIChatScreen: re-renders only on committedMessages / isStreaming / UI state changes
//     That means: 2 AIChatScreen re-renders per send (start + end of stream)
//     vs the previous 33/sec during streaming
//
// Streaming chunk render path:
//     onChunk → streamingTextRef += chunk → setTimeout(flushUpdate, 30)
//     flushUpdate → streamingForceUpdateRef.current() → StreamingBubble.setLocalTick
//     → StreamingBubble reads streamingTextRef, renders MessageContent
//     → AIChatScreen NOT re-rendered
//     → FlatList NOT reconciled
//     → Input bar NOT evaluated
//     → All completed MessageBubble components: untouched
//
// All Phase 1 and Phase 2 changes preserved.
// ─────────────────────────────────────────────────────────────────────────────
import React, {
  useEffect, useState, useRef, useCallback, memo, useMemo,
} from 'react';
import {
  View, Text, TextInput, TouchableOpacity, Pressable, FlatList,
  KeyboardAvoidingView, Platform, ActivityIndicator, Alert,
  Animated, Easing, unstable_batchedUpdates, AppState,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { KVStore } from '../services/storage';
import { useTheme } from '../context/ThemeContext';
import { useData } from '../context/DataContext';
import { fetchCdxCandles } from '../api/coindcx';
import { fetchBnKlines } from '../api/binance';
import { fetchAVKlines } from '../api/alphaVantage';
import { aoCandles } from '../api/angelOne';
import { chatWithClaudeStream, buildChatContext, ChatMessage } from '../api/claude';
import { fetchCandlesWithCache } from '../utils/candleCache';
import { fetchCryptoContextPartial } from '../utils/cryptoMarketContext/cryptoMarketContextFetch';
import { calcRSI, calcMA } from '../utils/indicators';
import { usePriceRef, PriceRefUpdater } from '../hooks/usePriceRef';
import { useNewsRef, NewsRefUpdater } from '../hooks/useNewsRef';

const SRC_LABEL: Record<string, string> = {
  ao: 'Angel One', ao_futures: 'Angel One NFO', av: 'Alpha Vantage',
  binance: 'Binance', binance_futures: 'Binance Futures',
  coindcx: 'CoinDCX', coindcx_futures: 'CoinDCX Futures', forex: 'Forex',
};

const HISTORY_KEY           = (sym: string) => `aichat_v1_${sym}`;
const MAX_STORED            = 50;
const NEAR_BOTTOM_THRESHOLD = 120;

// ── Message ID ────────────────────────────────────────────────────────────────
let _idCounter = 0;
function createMessageId(): string {
  _idCounter = (_idCounter + 1) % 1_000_000;
  return `m${Date.now().toString(36)}${_idCounter.toString(36)}`;
}

export type LocalChatMessage = ChatMessage & {
  id:       string;
  stopped?: boolean;
};

function withId(msg: ChatMessage & { id?: string; stopped?: boolean }): LocalChatMessage {
  return msg.id ? (msg as LocalChatMessage) : { ...msg, id: createMessageId() };
}

// ── DEV perf logging ─────────────────────────────────────────────────────────
const perfLog = __DEV__
  ? (tag: string, detail?: string) => console.log(`[CHAT_PERF] ${tag}${detail ? ' ' + detail : ''}`)
  : () => {};

// ── Markdown inline renderer ──────────────────────────────────────────────────
function InlineText({ text, baseStyle }: { text: string; baseStyle: any }) {
  const parts: React.ReactNode[] = [];
  const regex = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let last = 0, key = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) parts.push(<Text key={key++} style={baseStyle}>{text.slice(last, m.index)}</Text>);
    const raw = m[0];
    if (raw.startsWith('**'))
      parts.push(<Text key={key++} style={[baseStyle, { fontWeight: '700' }]}>{raw.slice(2, -2)}</Text>);
    else if (raw.startsWith('`'))
      parts.push(<Text key={key++} style={[baseStyle, { fontFamily: 'monospace', backgroundColor: '#ffffff18', borderRadius: 3, paddingHorizontal: 3 }]}>{raw.slice(1, -1)}</Text>);
    else
      parts.push(<Text key={key++} style={[baseStyle, { fontStyle: 'italic' }]}>{raw.slice(1, -1)}</Text>);
    last = m.index + raw.length;
  }
  if (last < text.length) parts.push(<Text key={key++} style={baseStyle}>{text.slice(last)}</Text>);
  return <Text>{parts}</Text>;
}

// ── MessageContent — memoized markdown parser ─────────────────────────────────
// useMemo keyed on `text` so completed messages parse exactly once.
const MessageContent = memo(({ text, isUser }: { text: string; isUser: boolean }) => {
  const { theme: T } = useTheme();
  const baseColor   = isUser ? '#fff' : T.text;
  const dimColor    = isUser ? 'rgba(255,255,255,0.75)' : T.textDim;
  const accentColor = isUser ? '#ffffffcc' : T.accent;
  const baseStyle   = { color: baseColor, fontSize: 14.5, lineHeight: 22 };

  const nodes = useMemo<React.ReactNode[]>(() => {
    const lines  = text.split('\n');
    const result: React.ReactNode[] = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { result.push(<View key={i} style={{ height: 6 }} />); i++; continue; }
      if (line.startsWith('### ')) {
        result.push(<Text key={i} style={{ color: baseColor, fontSize: 12, fontWeight: '700', letterSpacing: 0.4, marginTop: 8, marginBottom: 3, opacity: 0.85 }}>{line.slice(4).toUpperCase()}</Text>);
        i++; continue;
      }
      if (line.startsWith('## ')) {
        result.push(<Text key={i} style={{ color: baseColor, fontSize: 13, fontWeight: '800', letterSpacing: 0.5, marginTop: 10, marginBottom: 4, opacity: 0.9 }}>{line.slice(3).toUpperCase()}</Text>);
        i++; continue;
      }
      if (line.startsWith('# ')) {
        result.push(<Text key={i} style={{ color: accentColor, fontSize: 15, fontWeight: '800', marginTop: 8, marginBottom: 4 }}>{line.slice(2)}</Text>);
        i++; continue;
      }
      if (/^[-•*]\s/.test(line)) {
        result.push(
          <View key={i} style={{ flexDirection: 'row', marginBottom: 3, paddingLeft: 4 }}>
            <Text style={{ color: accentColor, fontSize: 14, marginRight: 8, marginTop: 1 }}>•</Text>
            <View style={{ flex: 1 }}><InlineText text={line.replace(/^[-•*]\s/, '')} baseStyle={baseStyle} /></View>
          </View>
        );
        i++; continue;
      }
      const numMatch = line.match(/^(\d+)\.\s(.*)/);
      if (numMatch) {
        result.push(
          <View key={i} style={{ flexDirection: 'row', marginBottom: 3, paddingLeft: 4 }}>
            <Text style={{ color: accentColor, fontSize: 13, fontWeight: '700', marginRight: 8, minWidth: 20 }}>{numMatch[1]}.</Text>
            <View style={{ flex: 1 }}><InlineText text={numMatch[2]} baseStyle={baseStyle} /></View>
          </View>
        );
        i++; continue;
      }
      if (/^---+$/.test(line.trim())) {
        result.push(<View key={i} style={{ height: 1, backgroundColor: isUser ? 'rgba(255,255,255,0.2)' : T.border, marginVertical: 8 }} />);
        i++; continue;
      }
      if (line.startsWith('> ')) {
        result.push(
          <View key={i} style={{ borderLeftWidth: 2, borderLeftColor: accentColor, paddingLeft: 10, marginVertical: 2 }}>
            <Text style={{ color: dimColor, fontSize: 13.5, lineHeight: 20, fontStyle: 'italic' }}>{line.slice(2)}</Text>
          </View>
        );
        i++; continue;
      }
      result.push(<View key={i} style={{ marginBottom: 2 }}><InlineText text={line} baseStyle={baseStyle} /></View>);
      i++;
    }
    return result;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, baseColor, accentColor, dimColor, isUser, T.border]);

  return <View>{nodes}</View>;
});

// ── TypingIndicator ───────────────────────────────────────────────────────────
const TypingIndicator = memo(() => {
  const { theme: T } = useTheme();
  const dots = [useRef(new Animated.Value(0)).current,
                useRef(new Animated.Value(0)).current,
                useRef(new Animated.Value(0)).current];
  useEffect(() => {
    const anims = dots.map((dot, i) =>
      Animated.loop(Animated.sequence([
        Animated.delay(i * 150),
        Animated.timing(dot, { toValue: -6, duration: 300, useNativeDriver: true, easing: Easing.out(Easing.quad) }),
        Animated.timing(dot, { toValue: 0, duration: 300, useNativeDriver: true, easing: Easing.in(Easing.quad) }),
        Animated.delay(600),
      ]))
    );
    anims.forEach(a => a.start());
    return () => anims.forEach(a => a.stop());
  }, []);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 5, paddingVertical: 4 }}>
      {dots.map((dot, i) => (
        <Animated.View key={i} style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: T.accent, transform: [{ translateY: dot }] }} />
      ))}
    </View>
  );
});

// ── MessageBubble — completed message, NEVER re-renders during streaming ──────
const MessageBubble = memo(({ msg }: { msg: LocalChatMessage }) => {
  const { theme: T } = useTheme();
  const isUser     = msg.role === 'user';
  const wasStopped = msg.stopped === true;
  if (__DEV__) perfLog('message_render', `id=${msg.id.slice(-4)} role=${msg.role}`);
  return (
    <View style={{ alignSelf: isUser ? 'flex-end' : 'flex-start', maxWidth: '88%', marginBottom: 12, marginLeft: isUser ? 40 : 0, marginRight: isUser ? 0 : 40 }}>
      {!isUser && (
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
          <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: T.accent, alignItems: 'center', justifyContent: 'center', marginRight: 6 }}>
            <Text style={{ fontSize: 10 }}>✦</Text>
          </View>
          <Text style={{ color: T.textDim, fontSize: 10, fontWeight: '700', letterSpacing: 0.3 }}>QUANTIS AI</Text>
        </View>
      )}
      <View style={{ backgroundColor: isUser ? T.accent : T.bg2, borderRadius: isUser ? 18 : 16, borderTopRightRadius: isUser ? 4 : 16, borderTopLeftRadius: isUser ? 16 : 4, paddingHorizontal: 14, paddingVertical: 10, shadowColor: isUser ? T.accent : '#000', shadowOpacity: isUser ? 0.25 : 0.08, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 3 }}>
        {msg.content ? <MessageContent text={msg.content} isUser={isUser} /> : null}
        {wasStopped && (
          <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: msg.content ? 8 : 0, paddingTop: msg.content ? 8 : 0, borderTopWidth: msg.content ? 0.5 : 0, borderTopColor: T.border + '60' }}>
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: T.textDim, marginRight: 6, opacity: 0.5 }} />
            <Text style={{ color: T.textDim, fontSize: 10, opacity: 0.7 }}>Stopped</Text>
          </View>
        )}
      </View>
    </View>
  );
});

// ── StreamingBubble — Phase 3: owns its own update state ──────────────────────
//
// KEY DESIGN:
//   This component is the ONLY thing that re-renders per streaming chunk.
//   It subscribes to streaming updates via forceUpdateRef — a ref that
//   flushUpdate (in send()) calls directly. No prop change required.
//   AIChatScreen does NOT re-render when this component updates.
//
//   Mount: registers forceUpdate into streamingForceUpdateRef
//   Unmount: unregisters (sets to null)
//   Per chunk: flushUpdate calls streamingForceUpdateRef.current?.()
//             → this component's local setLocalTick(t+1)
//             → re-reads streamingTextRef.current
//             → re-renders MessageContent with new text
//
type StreamingBubbleProps = {
  textRef:           React.MutableRefObject<string>;
  forceUpdateRef:    React.MutableRefObject<(() => void) | null>;
  onScroll:          (animated: boolean) => void;  // guardedScrollToEnd
  appActiveRef:      React.MutableRefObject<boolean>;
};

const StreamingBubble = memo(({ textRef, forceUpdateRef, onScroll, appActiveRef }: StreamingBubbleProps) => {
  const { theme: T } = useTheme();
  const [localTick, setLocalTick] = useState(0);

  // Register this component's force-update function into the shared ref.
  // flushUpdate will call this ref directly — no AIChatScreen state involved.
  useEffect(() => {
    forceUpdateRef.current = () => {
      setLocalTick(t => t + 1);
      if (appActiveRef.current) onScroll(false);
      if (__DEV__) perfLog('streaming_render', `len=${textRef.current.length}`);
    };
    return () => {
      forceUpdateRef.current = null;
    };
  // forceUpdateRef and appActiveRef are stable refs — safe in empty-ish dep array
  // onScroll is a stable useCallback from AIChatScreen
  }, [forceUpdateRef, appActiveRef, onScroll, textRef]);

  const text = textRef.current;
  return (
    <View style={{ alignSelf: 'flex-start', maxWidth: '88%', marginBottom: 12, marginLeft: 0, marginRight: 40 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
        <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: T.accent, alignItems: 'center', justifyContent: 'center', marginRight: 6 }}>
          <Text style={{ fontSize: 10 }}>✦</Text>
        </View>
        <Text style={{ color: T.textDim, fontSize: 10, fontWeight: '700', letterSpacing: 0.3 }}>QUANTIS AI</Text>
      </View>
      <View style={{ backgroundColor: T.bg2, borderRadius: 16, borderTopLeftRadius: 4, paddingHorizontal: 14, paddingVertical: 10, shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 3 }}>
        {!text
          ? <TypingIndicator />
          : <MessageContent text={text} isUser={false} />
        }
        {!!text && (
          <View style={{ flexDirection: 'row', gap: 3, marginTop: 4 }}>
            {[0, 1, 2].map(i => (
              <View key={i} style={{ width: 4, height: 4, borderRadius: 2, backgroundColor: T.textDim, opacity: 0.5 }} />
            ))}
          </View>
        )}
      </View>
    </View>
  );
});

// ── Suggestion chips ──────────────────────────────────────────────────────────
// ── Asset-specific suggestions (shown for current symbol) ───────────────────
const SUGGESTIONS = [
  { icon: '📊', text: 'What\'s the current trend?' },
  { icon: '🎯', text: 'Give me entry and target levels' },
  { icon: '⚠️', text: 'What are the key risks right now?' },
  { icon: '🔮', text: 'What does the ML model say?' },
  { icon: '💡', text: 'Best trade setup right now?' },
];

// ── Daily news/events suggestions (always shown on new chat) ─────────────────
// Tapping sends as a normal user message — Claude uses cached news from context
const NEWS_SUGGESTIONS = [
  { icon: '📰', text: 'What\'s today\'s crypto news?' },
  { icon: '📈', text: 'What major market events are happening today?' },
  { icon: '🌍', text: 'What important economic events should I watch?' },
  { icon: '⚠️', text: 'What events could affect BTC and ETH today?' },
  { icon: '📅', text: 'What\'s on today\'s market calendar?' },
];

// ── Main screen ───────────────────────────────────────────────────────────────
export default function AIChatScreen({ route }: any) {
  const { theme: T } = useTheme();
  // prices + news excluded: use ref-only children to prevent re-renders
  const { aoSession, avKey, anthropicKey, allAssets } = useData();

  // Ref-only price/news access — see PriceRefUpdater/NewsRefUpdater in JSX
  const { cpRef, pricesRef, updatePrice } = usePriceRef(symbol);
  const { newsRef, updateNews } = useNewsRef();
  // cpRef comes from usePriceRef above
  // pricesRef synced by PriceRefUpdater child, not via effect
  // newsRef synced by NewsRefUpdater child, not via effect

  const routeAsset  = route?.params?.asset;
  const routeSymbol = route?.params?.symbol;
  const asset = useMemo(() =>
    routeAsset
      ?? (routeSymbol ? allAssets.find((a: any) => a.symbol === routeSymbol) : null)
      ?? allAssets[0],
    // Memoize so allAssets.find() doesn't run on every render
    [routeAsset, routeSymbol, allAssets]
  );
  const symbol   = asset?.symbol ?? routeSymbol ?? 'NIFTY50';
  // cp read via cpRef.current (no reactive subscription)
  const srcLabel = SRC_LABEL[asset?.src] ?? asset?.src ?? 'Unknown';
  // cpRef updated by PriceRefUpdater — no effect needed

  // ── State ─────────────────────────────────────────────────────────────────
  // committedMessages: FlatList data. Never changes during streaming.
  const [committedMessages, setCommitted]    = useState<LocalChatMessage[]>([]);
  const [input,             setInput]        = useState('');
  const [sending,           setSending]      = useState(false);
  const [contextReady,      setContextReady] = useState(false);
  const [contextErr,        setContextErr]   = useState('');
  const [isListening,       setIsListening]  = useState(false);
  const [showJumpToLatest,  setShowJumpToLatest] = useState(false);
  // isStreaming: controls StreamingBubble mount. Changes TWICE per send.
  const [isStreaming,       setIsStreaming]  = useState(false);

  // streamingTick has been REMOVED from AIChatScreen state.
  // StreamingBubble drives its own re-renders via streamingForceUpdateRef.

  // ── Refs ──────────────────────────────────────────────────────────────────
  const streamingTextRef       = useRef('');
  // streamingForceUpdateRef: flushUpdate calls this to trigger StreamingBubble
  // without touching AIChatScreen state
  const streamingForceUpdateRef = useRef<(() => void) | null>(null);
  const contextRef             = useRef('');
  const listRef                = useRef<FlatList>(null);
  const abortRef               = useRef<AbortController | null>(null);
  const inputRef               = useRef<TextInput>(null);
  const persistTimer           = useRef<ReturnType<typeof setTimeout> | null>(null);
  const throttleRef            = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef             = useRef(true);
  const appActiveRef           = useRef(true);
  const sendingRef             = useRef(false);
  const committedRef           = useRef<LocalChatMessage[]>([]);
  const inputRef2              = useRef('');
  const isNearBottomRef        = useRef(true);
  const showJumpRef            = useRef(false);

  // ── Scroll tracking ───────────────────────────────────────────────────────
  const updateJumpButton = useCallback((nearBottom: boolean) => {
    isNearBottomRef.current = nearBottom;
    if (showJumpRef.current === nearBottom) return;
    showJumpRef.current = !nearBottom;
    setShowJumpToLatest(!nearBottom);
  }, []);

  const handleScroll = useCallback((e: any) => {
    const { contentSize, layoutMeasurement, contentOffset } = e.nativeEvent;
    const dist = contentSize.height - layoutMeasurement.height - contentOffset.y;
    updateJumpButton(dist <= NEAR_BOTTOM_THRESHOLD);
  }, [updateJumpButton]);

  const scrollToLatest = useCallback(() => {
    listRef.current?.scrollToEnd({ animated: true });
    updateJumpButton(true);
    perfLog('scroll_to_latest');
  }, [updateJumpButton]);

  const guardedScrollToEnd = useCallback((animated: boolean, force = false) => {
    if (!force && !isNearBottomRef.current) return;
    listRef.current?.scrollToEnd({ animated });
  }, []);

  // ── Persistence ───────────────────────────────────────────────────────────
  const persist = useCallback((msgs: LocalChatMessage[]) => {
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      KVStore.set(HISTORY_KEY(symbol), JSON.stringify(msgs.slice(-MAX_STORED)));
    }, 500);
  }, [symbol]);

  // ── Context building ──────────────────────────────────────────────────────
  const refreshContextFromCache = useCallback(async () => {
    try {
      const tf      = (route?.params as any)?.tf || '15m';
      const liveCp  = pricesRef.current[symbol];
      const livePrice = liveCp?.price ?? (asset as any)?.base ?? 0;
      const liveChg   = liveCp?.chg ?? 0;
      const { getCachedCandles } = await import('../utils/candleCache');
      const cacheResult = await getCachedCandles(symbol, tf);
      const candles = cacheResult?.candles ?? null;
      if (!candles || !livePrice) return;
      const rsi     = calcRSI(candles, 14);
      const ma20Arr = calcMA(candles, 20);
      const ma50Arr = calcMA(candles, 50);
      const ma20 = ma20Arr[ma20Arr.length - 1] ?? null;
      const ma50 = ma50Arr[ma50Arr.length - 1] ?? null;
      const recent = candles.slice(-8);
      const srcLbl = SRC_LABEL[asset?.src ?? ''] ?? asset?.src ?? 'Unknown';
      const ohlc   = recent.map((c: any) =>
        `${new Date(c.time * 1000 > 1e12 ? c.time : c.time * 1000)
          .toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })} O:${c.open.toFixed(2)} H:${c.high.toFixed(2)} L:${c.low.toFixed(2)} C:${c.close.toFixed(2)}`
      ).join('\n');
      contextRef.current = buildChatContext({
        assetName: asset?.name ?? symbol, symbol, type: asset?.type ?? 'CRYPTO', tf, srcLabel: srcLbl,
        price: livePrice, chgPct: liveChg, rsi, ma20, ma50, ohlc,
        mlSignal: (route?.params as any)?.mlSignal ?? null, vpSnap: (route?.params as any)?.vpSnap ?? null,
        regimeSnap: (route?.params as any)?.regimeSnap ?? null, mtfSnap: (route?.params as any)?.mtfSnap ?? null,
        techSummary: (route?.params as any)?.techSummary ?? null, openPosition: (route?.params as any)?.openPosition ?? null,
      });
    } catch {}
  }, [asset, symbol, route?.params]);

  const buildContext = useCallback(async () => {
    setContextErr('');
    const tf = (route?.params as any)?.tf || '15m';
    const params = route?.params as any;

    // ── PHASE 0: Use pre-built context if ChartScreen already built it ────────
    // This is the fastest path — context built while user was on chart
    const preBuilt = params?.preBuiltContext;
    if (preBuilt && typeof preBuilt === 'string' && preBuilt.length > 100) {
      contextRef.current = preBuilt;
      setContextReady(true);
      // Still load history in background
      KVStore.get(HISTORY_KEY(symbol)).then(raw => {
        if (!raw) return;
        try {
          const msgs = JSON.parse(raw).slice(-MAX_STORED).map((m: any) => withId(m));
          setCommitted(msgs);
          committedRef.current = msgs;
        } catch {}
      }).catch(() => {});
      return; // Done — no network calls needed
    }

    // ── PHASE 1: INSTANT context (0ms) ──────────────────────────────────────
    // Always fire setContextReady immediately — never block chat
    const liveCp0 = cpRef.current;
    // Use params price (from ChartScreen last candle) as most reliable source
    // cpRef may be null or from different symbol on first open
    const paramsPrice = params?.lastCandleClose ?? 0;
    const instantPrice = paramsPrice || liveCp0?.price || (asset as any)?.base || 0;
    const quickContext = buildChatContext({
      assetName: asset?.name ?? symbol, symbol,
      type: asset?.type ?? 'CRYPTO', tf, srcLabel,
      price: instantPrice, chgPct: liveCp0?.chg ?? params?.lastCandleChg ?? 0,
      rsi: null, ma20: null, ma50: null,
      ohlc: instantPrice > 0 ? `Current price: ${instantPrice}` : 'Loading...',
      mlSignal: params?.mlSignal ?? null,
      vpSnap: params?.vpSnap ?? null,
      regimeSnap: params?.regimeSnap ?? null,
      mtfSnap: params?.mtfSnap ?? null,
      techSummary: params?.techSummary ?? null,
      openPosition: params?.openPosition ?? null,
    });
    contextRef.current = quickContext;
    setContextReady(true); // ← ALWAYS fires immediately, no conditions

    try {
      const [historyRaw, candles] = await Promise.all([
        KVStore.get(HISTORY_KEY(symbol)).catch(() => null),
        // ── PHASE 2: Try cache first (50ms AsyncStorage, no network) ──────────
        (async () => {
          try {
            const { getCachedCandles } = await import('../utils/candleCache');
            const cached = await getCachedCandles(symbol, tf);
            if (cached?.candles?.length) return cached.candles;
          } catch {}
          // ── PHASE 3: Fetch from network (background, doesn't block UI) ──────
          if (asset?.src === 'binance' && asset?.bnSym)
            return fetchCandlesWithCache(symbol, tf, async () => fetchBnKlines(asset.bnSym!, tf, 200), { maxCandles: 200 }).catch(() => [] as any[]);
          if (asset?.src === 'coindcx' && (asset as any).cdxSym)
            return fetchCdxCandles((asset as any).cdxSym, tf, 200).catch(() => []);
          if (asset?.src === 'av' && asset?.avSym)
            return fetchCandlesWithCache(symbol, tf, async () => fetchAVKlines(asset.avSym!, tf, avKey), { maxCandles: 200 });
          if ((asset?.src === 'ao' || asset?.src === 'ao_futures') && asset?.aoToken && asset?.aoEx && aoSession?.jwtToken)
            return fetchCandlesWithCache(symbol, tf, async () => aoCandles(asset.aoToken!, asset.aoEx!, tf, aoSession!), { maxCandles: 200 });
          return [];
        })(),
      ]);
      if (historyRaw) {
        try {
          const migrated: LocalChatMessage[] = JSON.parse(historyRaw).slice(-MAX_STORED).map((m: any) => withId(m));
          setCommitted(migrated);
          committedRef.current = migrated;
          perfLog('conversation_load', `${migrated.length} messages`);
        } catch {}
      }
      const liveCp        = cpRef.current;
      const fallbackPrice = liveCp?.price ?? (asset as any)?.base ?? 0;
      const last          = candles?.[candles.length - 1];
      if (!last && !fallbackPrice) throw new Error('No price data available for this asset.');
      if (!last) {
        contextRef.current = buildChatContext({
          assetName: asset?.name ?? symbol, symbol, type: asset?.type ?? 'CRYPTO', tf, srcLabel,
          price: fallbackPrice, chgPct: liveCp?.chg ?? 0, rsi: null, ma20: null, ma50: null,
          ohlc: 'No candle data — using live price only.',
          mlSignal: (route?.params as any)?.mlSignal ?? null, vpSnap: (route?.params as any)?.vpSnap ?? null,
          regimeSnap: (route?.params as any)?.regimeSnap ?? null, mtfSnap: (route?.params as any)?.mtfSnap ?? null,
          techSummary: (route?.params as any)?.techSummary ?? null, openPosition: (route?.params as any)?.openPosition ?? null,
        });
        setContextReady(true);
        return;
      }
      const rsi     = calcRSI(candles, 14);
      const ma20Arr = calcMA(candles, 20);
      const ma50Arr = calcMA(candles, 50);
      const ma20    = ma20Arr[ma20Arr.length - 1] ?? null;
      const ma50    = ma50Arr[ma50Arr.length - 1] ?? null;
      const recent  = candles.slice(-8);
      const ohlc    = recent.map((c: any) =>
        `${new Date(c.time).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })} O:${c.open.toFixed(2)} H:${c.high.toFixed(2)} L:${c.low.toFixed(2)} C:${c.close.toFixed(2)}`
      ).join('\n');
      const liveNews    = newsRef.current;
      const newsSummary = liveNews?.slice(0, 3).map((n: any) => n.headline).join(' | ') ?? '';
      let fearGreedSummary = '';
      // Fetch Fear&Greed in true background — NEVER blocks contextReady
      let fundamentalsSummary = '';
      if (asset?.src === 'binance' || asset?.src === 'coindcx') {
        // Fire-and-forget — updates context for NEXT message only
        fetchCryptoContextPartial(symbol, ['FEAR_GREED']).then((ctx: any) => {
          if (ctx?.fearGreed?.value && contextRef.current) {
            fearGreedSummary = `Fear&Greed: ${ctx.fearGreed.value} (${ctx.fearGreed.classification})`;
          }
        }).catch(() => {});
        // Calculate support/resistance from candle history
        try {
          if (candles && candles.length >= 50) {
            const highs = candles.map((c: any) => c.high).sort((a: number, b: number) => b - a);
            const lows  = candles.map((c: any) => c.low).sort((a: number, b: number) => a - b);
            const allTimeHigh = highs[0]?.toFixed(2);
            const allTimeLow  = lows[0]?.toFixed(2);
            // Pivot point support/resistance
            const recentHigh = Math.max(...candles.slice(-20).map((c: any) => c.high));
            const recentLow  = Math.min(...candles.slice(-20).map((c: any) => c.low));
            const pivot      = ((recentHigh + recentLow + candles[candles.length-1].close) / 3).toFixed(2);
            const r1         = (2 * Number(pivot) - recentLow).toFixed(2);
            const s1         = (2 * Number(pivot) - recentHigh).toFixed(2);
            fundamentalsSummary = `Range high: ${allTimeHigh} | Range low: ${allTimeLow} | Pivot: ${pivot} | R1: ${r1} | S1: ${s1}`;
          }
        } catch {}
      }
      contextRef.current = buildChatContext({
        assetName: asset.name, symbol, type: asset.type, tf, srcLabel,
        price: last.close, chgPct: liveCp?.chg ?? 0, rsi, ma20, ma50, ohlc,
        newsSummary: [newsSummary, fearGreedSummary, fundamentalsSummary].filter(Boolean).join(' | ') || undefined,
        mlSignal: (route?.params as any)?.mlSignal ?? null, vpSnap: (route?.params as any)?.vpSnap ?? null,
        regimeSnap: (route?.params as any)?.regimeSnap ?? null, mtfSnap: (route?.params as any)?.mtfSnap ?? null,
        techSummary: (route?.params as any)?.techSummary ?? null, openPosition: (route?.params as any)?.openPosition ?? null,
      });
      setContextReady(true);
    } catch (e: any) {
      setContextErr(e?.message ?? 'Could not load market data. Tap retry.');
    }
  }, [asset, symbol, aoSession, avKey]);

  // Symbol reset
  useEffect(() => {
    setCommitted([]);
    committedRef.current = [];
    setContextReady(false);
    setContextErr('');
    buildContext();
  }, [symbol]);

  // Unmount cleanup
  useEffect(() => {
    mountedRef.current = true;
    const sub = AppState.addEventListener('change', s => { appActiveRef.current = s === 'active'; });
    return () => {
      mountedRef.current = false;
      sub.remove();
      abortRef.current?.abort();
      abortRef.current = null;
      streamingForceUpdateRef.current = null;
      if (throttleRef.current) { clearTimeout(throttleRef.current); throttleRef.current = null; }
      if (persistTimer.current) { clearTimeout(persistTimer.current); persistTimer.current = null; }
      perfLog('unmount', 'cleanup complete');
    };
  }, []);

  // Keep refs in sync
  useEffect(() => { committedRef.current = committedMessages; }, [committedMessages]);
  useEffect(() => { inputRef2.current = input; }, [input]);

  // ── Send ──────────────────────────────────────────────────────────────────
  const send = useCallback(async (text?: string) => {
    const content = (text ?? inputRef2.current).trim();
    if (!content || sendingRef.current) return;
    if (!contextReady) { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning); return; }

    perfLog('send', 'triggered');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    sendingRef.current = true;

    refreshContextFromCache().catch(() => {});

    const userMsg: LocalChatMessage = withId({ role: 'user', content });
    const committedWithUser = [...committedRef.current, userMsg];

    streamingTextRef.current = '';
    unstable_batchedUpdates(() => {
      setInput('');
      setSending(true);
      setCommitted(committedWithUser);
      setIsStreaming(true);   // mounts StreamingBubble
    });
    committedRef.current = committedWithUser;
    persist(committedWithUser);

    requestAnimationFrame(() => {
      guardedScrollToEnd(true, true);
      updateJumpButton(true);
      perfLog('scroll_to_latest', 'post-send');
    });

    abortRef.current = new AbortController();
    let pendingUpdate = false;

    // flushUpdate: called by the 30ms throttle timer.
    // Phase 3: calls streamingForceUpdateRef.current() instead of setStreamingTick.
    // streamingForceUpdateRef.current is StreamingBubble's own setLocalTick.
    // AIChatScreen is NOT re-rendered by this call.
    function flushUpdate() {
      pendingUpdate = false;
      if (!mountedRef.current) return;
      // Directly invoke StreamingBubble's own state update
      streamingForceUpdateRef.current?.();
      perfLog('stream_batch', `len=${streamingTextRef.current.length}`);
    }

    try {
      await chatWithClaudeStream(
        committedWithUser,
        anthropicKey,
        contextRef.current,
        (chunk) => {
          streamingTextRef.current += chunk;
          if (!pendingUpdate) {
            pendingUpdate = true;
            throttleRef.current = setTimeout(flushUpdate, 30);
          }
        },
        abortRef.current.signal,
      );
      if (throttleRef.current) { clearTimeout(throttleRef.current); throttleRef.current = null; }

      const finalMsg: LocalChatMessage = { id: createMessageId(), role: 'assistant', content: streamingTextRef.current };
      const finalCommitted = [...committedWithUser, finalMsg];
      streamingTextRef.current = '';
      unstable_batchedUpdates(() => {
        setCommitted(finalCommitted);
        setIsStreaming(false);   // unmounts StreamingBubble (unregisters forceUpdate)
        setSending(false);
      });
      committedRef.current = finalCommitted;
      persist(finalCommitted);
      guardedScrollToEnd(true);
      perfLog('stream_complete', `total_len=${finalMsg.content.length}`);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      if (throttleRef.current) { clearTimeout(throttleRef.current); throttleRef.current = null; }
      if (e?.name === 'AbortError') {
        const partial: LocalChatMessage = { id: createMessageId(), role: 'assistant', content: streamingTextRef.current || '', stopped: true };
        const partialCommitted = [...committedWithUser, partial];
        streamingTextRef.current = '';
        unstable_batchedUpdates(() => {
          setCommitted(partialCommitted);
          setIsStreaming(false);
          setSending(false);
        });
        committedRef.current = partialCommitted;
        persist(partialCommitted);
      } else {
        const rawMsg = e?.message ?? 'Something went wrong.';
        const msg = e?.message?.includes('401') ? '**API key invalid**\n\nPlease check your Anthropic API key in More → Settings.'
          : e?.message?.includes('429') ? '**Rate limited**\n\nYou sent too many messages. Wait a moment and try again.'
          : e?.message?.includes('network') || e?.message?.includes('fetch') || e?.message?.includes('Network') ? '**Connection failed**\n\nCheck your internet connection and try again.'
          : e?.message?.includes('503') || e?.message?.includes('overloaded') ? '**Claude is busy**\n\nHigh demand right now. Try again in a few seconds.'
          : `**Error**\n\n${rawMsg}`;
        const errMsg: LocalChatMessage = { id: createMessageId(), role: 'assistant', content: msg };
        const errCommitted = [...committedWithUser, errMsg];
        streamingTextRef.current = '';
        unstable_batchedUpdates(() => {
          setCommitted(errCommitted);
          setIsStreaming(false);
          setSending(false);
        });
        committedRef.current = errCommitted;
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
    } finally {
      sendingRef.current = false;
      if (throttleRef.current) { clearTimeout(throttleRef.current); throttleRef.current = null; }
    }
  }, [contextReady, anthropicKey, persist, guardedScrollToEnd, updateJumpButton]);

  const clearHistory = useCallback(() => {
    KVStore.remove(HISTORY_KEY(symbol));
    setCommitted([]);
    committedRef.current = [];
  }, [symbol]);

  const stopStreaming = useCallback(() => {
    if (!abortRef.current) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    abortRef.current.abort();
    abortRef.current = null;
    setSending(false);
    sendingRef.current = false;
  }, []);

  const startVoice = useCallback(async () => {
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      setIsListening(true);
      setIsListening(false);
      inputRef.current?.focus();
    } catch { setIsListening(false); }
  }, []);

  const startNewConversation = useCallback(() => {
    Alert.alert('New Conversation', 'Start a fresh conversation? Current chat will be saved.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'New Chat', onPress: async () => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        if (committedRef.current.length > 0) persist(committedRef.current);
        streamingTextRef.current = '';
        unstable_batchedUpdates(() => {
          setCommitted([]); setInput(''); setSending(false); setIsStreaming(false);
        });
        committedRef.current  = [];
        sendingRef.current    = false;
        abortRef.current?.abort();
        abortRef.current = null;
        streamingForceUpdateRef.current = null;
        setContextReady(false);
        buildContext();
      }},
    ]);
  }, [persist, buildContext]);

  // Stable FlatList callbacks
  const renderMessage = useCallback(({ item }: { item: LocalChatMessage }) => <MessageBubble msg={item} />, []);
  const keyExtractor  = useCallback((item: LocalChatMessage) => item.id, []);

  const showSuggestions = committedMessages.length === 0 && !isStreaming && contextReady;

  return (
    <>
      {/* Zero-render ref updaters — PriceRefUpdater/NewsRefUpdater render null */}
      {/* They keep cpRef and newsRef current WITHOUT causing AIChatScreen re-renders */}
      <PriceRefUpdater symbol={symbol} onPrice={updatePrice} />
      <NewsRefUpdater onNews={updateNews} />
      <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }} edges={['bottom']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
        <View style={{ flex: 1 }}>
          <FlatList
            ref={listRef}
            data={committedMessages}
            keyExtractor={keyExtractor}
            renderItem={renderMessage}
            contentContainerStyle={{ padding: 16, paddingBottom: 4, flexGrow: 1 }}
            onScroll={handleScroll}
            scrollEventThrottle={100}
            keyboardShouldPersistTaps="handled"
            removeClippedSubviews={true}
            maxToRenderPerBatch={8}
            windowSize={5}
            initialNumToRender={15}
            // maintainVisibleContentPosition removed — causes Android hangs
            ListEmptyComponent={
              isStreaming ? null :
              contextReady ? (
                <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingVertical: 24 }}>
                  <Text style={{ fontSize: 32, marginBottom: 8 }}>✦</Text>
                  <Text style={{ color: T.text, fontSize: 18, fontWeight: '700', marginBottom: 4 }}>Quantis AI</Text>
                  <Text style={{ color: T.textDim, fontSize: 12, textAlign: 'center', maxWidth: 260, marginBottom: 20 }}>
                    Ask me anything about {asset?.name ?? symbol} — price action, trade setups, risk levels, or market context.
                  </Text>
                  {/* Daily news/events section */}
                  <View style={{ width: '100%', paddingHorizontal: 16, marginBottom: 12 }}>
                    <Text style={{ color: T.textDim, fontSize: 10, fontWeight: '700', letterSpacing: 0.8, marginBottom: 10 }}>TODAY'S MARKET</Text>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                      {NEWS_SUGGESTIONS.map(s => (
                        <Pressable key={s.text}
                          onPressIn={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); send(s.text); }}
                          android_ripple={{ color: T.accent + '30', borderless: false }}
                          style={({ pressed }: { pressed: boolean }) => ({
                            flexDirection: 'row', alignItems: 'center', gap: 5,
                            backgroundColor: pressed ? T.bg3 : T.bg2,
                            borderRadius: 16, paddingHorizontal: 10, paddingVertical: 6,
                            borderWidth: 1, borderColor: pressed ? T.accent : T.border + '80',
                          })}>
                          <Text style={{ fontSize: 12 }}>{s.icon}</Text>
                          <Text style={{ color: T.textDim, fontSize: 11, fontWeight: '600' }}>{s.text}</Text>
                        </Pressable>
                      ))}
                    </View>
                  </View>
                </View>
              ) : contextErr ? (
                <View style={{ padding: 20, alignItems: 'center' }}>
                  <Text style={{ color: T.textDim, fontSize: 13, textAlign: 'center', marginBottom: 12 }}>{contextErr}</Text>
                  <TouchableOpacity onPress={buildContext} style={{ backgroundColor: T.accent, borderRadius: 20, paddingHorizontal: 20, paddingVertical: 8 }}>
                    <Text style={{ color: '#fff', fontWeight: '700' }}>Retry</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <View style={{ padding: 30, alignItems: 'center' }}>
                  <ActivityIndicator color={T.accent} />
                  <Text style={{ color: T.textDim, fontSize: 12, marginTop: 8 }}>Loading market context…</Text>
                </View>
              )
            }
          />

          {/* StreamingBubble: mounts/unmounts per send cycle. Owns its own updates. */}
          {isStreaming && (
            <View style={{ paddingHorizontal: 16, paddingBottom: 4 }}>
              <StreamingBubble
                textRef={streamingTextRef}
                forceUpdateRef={streamingForceUpdateRef}
                onScroll={guardedScrollToEnd}
                appActiveRef={appActiveRef}
              />
            </View>
          )}

          {showJumpToLatest && (
            <Pressable
              onPress={scrollToLatest}
              android_ripple={{ color: T.accent + '40', borderless: false }}
              style={{ position: 'absolute', bottom: 12, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: T.bg2, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 7, borderWidth: 1, borderColor: T.accent + '60', shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 4 }}>
              <Text style={{ fontSize: 11 }}>↓</Text>
              <Text style={{ color: T.accent, fontSize: 12, fontWeight: '700' }}>Latest</Text>
            </Pressable>
          )}
        </View>

        {showSuggestions && (
          <View style={{ paddingHorizontal: 12, paddingBottom: 8 }}>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {SUGGESTIONS.map(s => (
                <Pressable key={s.text} onPressIn={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); send(s.text); }}
                  android_ripple={{ color: T.accent + '40', borderless: false }}
                  style={({ pressed }: { pressed: boolean }) => ({ flexDirection: 'row', alignItems: 'center', backgroundColor: pressed ? T.bg3 : T.bg2, borderRadius: 20, borderWidth: 1, borderColor: pressed ? T.accent : T.border, paddingHorizontal: 12, paddingVertical: 7 })}>
                  <Text style={{ fontSize: 13, marginRight: 5 }}>{s.icon}</Text>
                  <Text style={{ color: T.text, fontSize: 12, fontWeight: '500' }}>{s.text}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        )}

        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 5, borderTopWidth: 0.5, borderTopColor: T.border + '60', backgroundColor: T.bg1, gap: 8 }}>
          <Pressable onPressIn={startNewConversation} android_ripple={{ color: T.accent + '30', borderless: false }}
            style={({ pressed }: { pressed: boolean }) => ({ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: pressed ? T.bg3 : T.bg2, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4, borderWidth: 1, borderColor: T.border })}>
            <Text style={{ fontSize: 10 }}>✦</Text>
            <Text style={{ color: T.textDim, fontSize: 11, fontWeight: '600' }}>New Chat</Text>
          </Pressable>
          {isListening && <Text style={{ color: T.accent, fontSize: 11, fontWeight: '600' }}>🎤 Tap mic on keyboard...</Text>}
        </View>

        <View style={{ flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: 12, paddingVertical: 10, borderTopWidth: 0, backgroundColor: T.bg1, gap: 8 }}>
          {committedMessages.length > 0 && !sending && (
            <Pressable onPressIn={clearHistory} android_ripple={{ color: T.textDim + '30', borderless: true }} style={{ paddingHorizontal: 6, paddingVertical: 8 }}>
              <Text style={{ color: T.textDim, fontSize: 18 }}>🗑</Text>
            </Pressable>
          )}
          <TextInput
            ref={inputRef}
            value={input}
            onChangeText={setInput}
            placeholder={contextReady ? `Ask about ${asset?.name ?? symbol}…` : 'Loading context…'}
            placeholderTextColor={T.textDim}
            style={{ flex: 1, backgroundColor: T.bg2, borderRadius: 22, paddingHorizontal: 16, paddingVertical: 10, color: T.text, fontSize: 15, maxHeight: 120, lineHeight: 20 }}
            multiline
            editable={contextReady && !sending}
            onSubmitEditing={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); send(); }}
            blurOnSubmit={false}
            returnKeyType="send"
          />
          <Pressable onPressIn={startVoice} android_ripple={{ color: T.accent + '40', radius: 19, borderless: true }}
            style={({ pressed }: { pressed: boolean }) => ({ width: 38, height: 38, borderRadius: 19, backgroundColor: isListening ? T.accent + '22' : T.bg2, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: isListening ? T.accent : T.border, opacity: pressed ? 0.7 : 1 })}>
            <Text style={{ fontSize: 15 }}>🎤</Text>
          </Pressable>
          <Pressable
            onPressIn={() => {
              if (sending) { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); stopStreaming(); }
              else if (input.trim() && contextReady && !sendingRef.current) { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); send(); }
            }}
            disabled={!sending && (!input.trim() || !contextReady)}
            android_ripple={{ color: 'rgba(255,255,255,0.3)', radius: 21, borderless: true }}
            style={({ pressed }: { pressed: boolean }) => ({ width: 42, height: 42, borderRadius: 21, backgroundColor: sending ? T.red : (input.trim() && contextReady ? T.accent : T.bg3), alignItems: 'center' as const, justifyContent: 'center' as const, opacity: pressed ? 0.75 : 1 })}>
            {sending ? <Text style={{ fontSize: 16 }}>■</Text> : <Text style={{ fontSize: 18, color: '#fff' }}>↑</Text>}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
    </>
  );
}
