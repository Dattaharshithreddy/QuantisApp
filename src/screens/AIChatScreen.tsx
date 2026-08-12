// ─────────────────────────────────────────────────────────────────────────────
// AI COPILOT CHAT SCREEN  (v3.0.0 — streaming + beautiful UX)
//
// Feels like Claude.ai / ChatGPT — tokens appear as they stream, not after
// a multi-second wait. Markdown-aware message renderer with:
//   • Bold, italic, code spans, bullet lists, numbered lists
//   • Section headers (## style)
//   • Price/number highlighting in accent colour
//   • Animated typing indicator (3-dot bounce)
//   • Auto-scroll to bottom as tokens arrive
//   • Haptic feedback on send
//   • Suggested quick prompts when chat is empty
// ─────────────────────────────────────────────────────────────────────────────
import React, {
  useEffect, useState, useRef, useCallback, memo,
} from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList,
  KeyboardAvoidingView, Platform, ActivityIndicator,
  Animated, Easing, unstable_batchedUpdates,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTheme } from '../context/ThemeContext';
import { useData } from '../context/DataContext';
import { fetchCdxCandles } from '../api/coindcx';
import { fetchBnKlines } from '../api/binance';
import { fetchAVKlines } from '../api/alphaVantage';
import { aoCandles } from '../api/angelOne';
import { chatWithClaudeStream, buildChatContext, ChatMessage } from '../api/claude';
import { fetchCandlesWithCache } from '../utils/candleCache';
import { fetchCryptoContextPartial } from '../utils/cryptoMarketContext/cryptoMarketContextFetch';
const SRC_LABEL: Record<string, string> = {
  ao: 'Angel One', ao_futures: 'Angel One NFO', av: 'Alpha Vantage',
  binance: 'Binance', binance_futures: 'Binance Futures',
  coindcx: 'CoinDCX', coindcx_futures: 'CoinDCX Futures', forex: 'Forex',
};
import { calcRSI, calcMA } from '../utils/indicators';

const HISTORY_KEY = (sym: string) => `aichat_v1_${sym}`;
const MAX_STORED   = 50;

// ── Markdown-aware inline renderer ───────────────────────────────────────────
// Renders **bold**, *italic*, `code`, and plain text inline.
function InlineText({ text, baseStyle }: { text: string; baseStyle: any }) {
  const parts: React.ReactNode[] = [];
  // Split on bold, italic, and code spans
  const regex = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let last = 0, key = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) parts.push(<Text key={key++} style={baseStyle}>{text.slice(last, m.index)}</Text>);
    const raw = m[0];
    if (raw.startsWith('**'))
      parts.push(<Text key={key++} style={[baseStyle, { fontWeight: '700' }]}>{raw.slice(2,-2)}</Text>);
    else if (raw.startsWith('`'))
      parts.push(<Text key={key++} style={[baseStyle, { fontFamily: 'monospace', backgroundColor: '#ffffff18', borderRadius: 3, paddingHorizontal: 3 }]}>{raw.slice(1,-1)}</Text>);
    else
      parts.push(<Text key={key++} style={[baseStyle, { fontStyle: 'italic' }]}>{raw.slice(1,-1)}</Text>);
    last = m.index + raw.length;
  }
  if (last < text.length) parts.push(<Text key={key++} style={baseStyle}>{text.slice(last)}</Text>);
  return <Text>{parts}</Text>;
}

// ── Message content renderer — parses markdown blocks ────────────────────────
const MessageContent = memo(({ text, isUser, T }: { text: string; isUser: boolean; T: any }) => {
  const baseColor   = isUser ? '#fff' : T.text;
  const dimColor    = isUser ? 'rgba(255,255,255,0.75)' : T.textDim;
  const accentColor = isUser ? '#ffffffcc' : T.accent;
  const baseStyle   = { color: baseColor, fontSize: 14.5, lineHeight: 22 };

  const lines = text.split('\n');
  const nodes: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Blank line
    if (!line.trim()) { nodes.push(<View key={i} style={{ height: 6 }} />); i++; continue; }

    // ## Header
    if (line.startsWith('## ')) {
      nodes.push(
        <Text key={i} style={{ color: baseColor, fontSize: 13, fontWeight: '800',
          letterSpacing: 0.5, marginTop: 10, marginBottom: 4, opacity: 0.9 }}>
          {line.slice(3).toUpperCase()}
        </Text>
      );
      i++; continue;
    }

    // # Header
    if (line.startsWith('# ')) {
      nodes.push(
        <Text key={i} style={{ color: accentColor, fontSize: 15, fontWeight: '800',
          marginTop: 8, marginBottom: 4 }}>
          {line.slice(2)}
        </Text>
      );
      i++; continue;
    }

    // Bullet: - or •
    if (/^[-•*]\s/.test(line)) {
      nodes.push(
        <View key={i} style={{ flexDirection: 'row', marginBottom: 3, paddingLeft: 4 }}>
          <Text style={{ color: accentColor, fontSize: 14, marginRight: 8, marginTop: 1 }}>•</Text>
          <View style={{ flex: 1 }}>
            <InlineText text={line.replace(/^[-•*]\s/, '')} baseStyle={baseStyle} />
          </View>
        </View>
      );
      i++; continue;
    }

    // Numbered list
    const numMatch = line.match(/^(\d+)\.\s(.*)/);
    if (numMatch) {
      nodes.push(
        <View key={i} style={{ flexDirection: 'row', marginBottom: 3, paddingLeft: 4 }}>
          <Text style={{ color: accentColor, fontSize: 13, fontWeight: '700',
            marginRight: 8, minWidth: 20 }}>{numMatch[1]}.</Text>
          <View style={{ flex: 1 }}>
            <InlineText text={numMatch[2]} baseStyle={baseStyle} />
          </View>
        </View>
      );
      i++; continue;
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) {
      nodes.push(<View key={i} style={{ height: 1, backgroundColor: isUser ? 'rgba(255,255,255,0.2)' : T.border, marginVertical: 8 }} />);
      i++; continue;
    }

    // > Blockquote
    if (line.startsWith('> ')) {
      nodes.push(
        <View key={i} style={{ borderLeftWidth: 2, borderLeftColor: accentColor,
          paddingLeft: 10, marginVertical: 2 }}>
          <Text style={{ color: dimColor, fontSize: 13.5, lineHeight: 20, fontStyle: 'italic' }}>
            {line.slice(2)}
          </Text>
        </View>
      );
      i++; continue;
    }

    // Plain paragraph
    nodes.push(
      <View key={i} style={{ marginBottom: 2 }}>
        <InlineText text={line} baseStyle={baseStyle} />
      </View>
    );
    i++;
  }

  return <View>{nodes}</View>;
});

// ── Typing indicator — 3 bouncing dots ───────────────────────────────────────
const TypingIndicator = memo(({ T }: { T: any }) => {
  const dots = [useRef(new Animated.Value(0)).current,
                useRef(new Animated.Value(0)).current,
                useRef(new Animated.Value(0)).current];

  useEffect(() => {
    const anims = dots.map((dot, i) =>
      Animated.loop(Animated.sequence([
        Animated.delay(i * 150),
        Animated.timing(dot, { toValue: -6, duration: 300, useNativeDriver: true, easing: Easing.out(Easing.quad) }),
        Animated.timing(dot, { toValue: 0,  duration: 300, useNativeDriver: true, easing: Easing.in(Easing.quad) }),
        Animated.delay(600),
      ]))
    );
    anims.forEach(a => a.start());
    return () => anims.forEach(a => a.stop());
  }, []);

  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 5, paddingVertical: 4 }}>
      {dots.map((dot, i) => (
        <Animated.View key={i}
          style={{ width: 7, height: 7, borderRadius: 3.5,
            backgroundColor: T.accent, transform: [{ translateY: dot }] }} />
      ))}
    </View>
  );
});

// ── Single message bubble ─────────────────────────────────────────────────────
const MessageBubble = memo(({ msg, T }: { msg: ChatMessage & { streaming?: boolean; stopped?: boolean }; T: any }) => {
  const isUser = msg.role === 'user';
  const wasStopped = (msg as any).stopped === true;
  return (
    <View style={{
      alignSelf:    isUser ? 'flex-end' : 'flex-start',
      maxWidth:     '88%',
      marginBottom: 12,
      marginLeft:   isUser ? 40 : 0,
      marginRight:  isUser ? 0 : 40,
    }}>
      {/* Avatar row for assistant */}
      {!isUser && (
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
          <View style={{ width: 20, height: 20, borderRadius: 10,
            backgroundColor: T.accent, alignItems: 'center', justifyContent: 'center',
            marginRight: 6 }}>
            <Text style={{ fontSize: 10 }}>✦</Text>
          </View>
          <Text style={{ color: T.textDim, fontSize: 10, fontWeight: '700', letterSpacing: 0.3 }}>
            QUANTIS AI
          </Text>
        </View>
      )}

      <View style={{
        backgroundColor: isUser ? T.accent : T.bg2,
        borderRadius:    isUser ? 18 : 16,
        borderTopRightRadius: isUser ? 4 : 16,
        borderTopLeftRadius:  isUser ? 16 : 4,
        paddingHorizontal: 14,
        paddingVertical:   10,
        shadowColor: isUser ? T.accent : '#000',
        shadowOpacity: isUser ? 0.25 : 0.08,
        shadowRadius: 8,
        shadowOffset: { width: 0, height: 2 },
        elevation: 3,
      }}>
        {msg.streaming && !msg.content
          ? <TypingIndicator T={T} />
          : msg.content
            ? <MessageContent text={msg.content} isUser={isUser} T={T} />
            : null
        }
        {msg.streaming && !!msg.content && (
          <View style={{ flexDirection: 'row', gap: 3, marginTop: 4 }}>
            {[0,1,2].map(i => (
              <View key={i} style={{ width: 4, height: 4, borderRadius: 2,
                backgroundColor: T.textDim, opacity: 0.5 }} />
            ))}
          </View>
        )}
        {/* Clean stopped badge — only shows when user tapped stop */}
        {wasStopped && (
          <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: msg.content ? 8 : 0,
            paddingTop: msg.content ? 8 : 0,
            borderTopWidth: msg.content ? 0.5 : 0,
            borderTopColor: T.border + '60' }}>
            <View style={{ width: 6, height: 6, borderRadius: 3,
              backgroundColor: T.textDim, marginRight: 6, opacity: 0.5 }} />
            <Text style={{ color: T.textDim, fontSize: 10, opacity: 0.7 }}>Stopped</Text>
          </View>
        )}
      </View>
    </View>
  );
});

// ── Quick suggestion chips ────────────────────────────────────────────────────
const SUGGESTIONS = [
  { icon: '📊', text: 'What\'s the current trend?' },
  { icon: '🎯', text: 'Give me entry and target levels' },
  { icon: '⚠️', text: 'What are the key risks right now?' },
  { icon: '🔮', text: 'What does the ML model say?' },
  { icon: '📰', text: 'How is news affecting price?' },
  { icon: '💡', text: 'Best trade setup right now?' },
];

// ── Main screen ───────────────────────────────────────────────────────────────
export default function AIChatScreen({ route }: any) {
  const { theme: T } = useTheme();
  const { prices, aoSession, avKey, anthropicKey, allAssets, news } = useData();

  // Resolve asset from route: prefer explicit asset param, then find by symbol
  const routeAsset  = route?.params?.asset;
  const routeSymbol = route?.params?.symbol;
  const asset = routeAsset
    ?? (routeSymbol ? allAssets.find((a: any) => a.symbol === routeSymbol) : null)
    ?? allAssets[0];
  const symbol = asset?.symbol ?? routeSymbol ?? 'NIFTY50';
  const cp       = prices[symbol];
  const srcLabel = SRC_LABEL[asset?.src] ?? asset?.src ?? 'Unknown';

  const [messages,      setMessages]      = useState<(ChatMessage & { streaming?: boolean })[]>([]);
  const [input,         setInput]         = useState('');
  const [sending,       setSending]       = useState(false);
  const [contextReady,  setContextReady]  = useState(false);
  const [contextErr,    setContextErr]    = useState('');
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const contextRef = useRef('');
  const listRef    = useRef<FlatList>(null);
  const abortRef   = useRef<AbortController | null>(null);
  const inputRef   = useRef<TextInput>(null);

  // ── Persist / restore history ──────────────────────────────────────────────
  // Debounce ref — avoids AsyncStorage write on every streaming chunk
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persist = useCallback((msgs: ChatMessage[]) => {
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      AsyncStorage.setItem(HISTORY_KEY(symbol), JSON.stringify(msgs.slice(-MAX_STORED)));
    }, 500);
  }, [symbol]);

  // ── Build market context ───────────────────────────────────────────────────
  const buildContext = useCallback(async () => {
    setContextErr('');
    const tf = '15m'; // declared here so it's in scope for buildChatContext below
    try {
      // Load history AND candles in parallel
      const [historyRaw, candles] = await Promise.all([
        AsyncStorage.getItem(HISTORY_KEY(symbol)).catch(() => null),
        (async () => {
          if (asset?.src === 'binance' && asset?.bnSym) {
            return fetchCandlesWithCache(symbol, tf,
              async () => fetchBnKlines(asset.bnSym!, tf, 50), { maxCandles: 50 });
          }
          if (asset?.src === 'coindcx' && (asset as any).cdxSym) {
            return fetchCdxCandles((asset as any).cdxSym, tf, 50);
          }
          if (asset?.src === 'av' && asset?.avSym) {
            return fetchCandlesWithCache(symbol, tf,
              async () => fetchAVKlines(asset.avSym!, tf, avKey), { maxCandles: 50 });
          }
          if ((asset?.src === 'ao' || asset?.src === 'ao_futures') &&
              asset?.aoToken && asset?.aoEx && aoSession?.jwtToken) {
            return fetchCandlesWithCache(symbol, tf,
              async () => aoCandles(asset.aoToken!, asset.aoEx!, tf, aoSession!),
              { maxCandles: 50 });
          }
          // Use cached data if available (e.g. chart already loaded candles)
          return fetchCandlesWithCache(symbol, tf, async () => [], { maxCandles: 50 });
        })(),
      ]);

      // Restore history if present (parallel with candle fetch)
      if (historyRaw) {
        try { setMessages(JSON.parse(historyRaw).slice(-MAX_STORED)); } catch {}
      }
      setHistoryLoaded(true);

      const last = candles[candles.length - 1];
      // If no candles fetched, use current price as minimal context rather than erroring
      const fallbackPrice = cp?.price ?? (asset as any)?.base ?? 0;
      if (!last && !fallbackPrice) throw new Error('No price data available for this asset.');
      if (!last) {
        // Build minimal context from live price alone
        contextRef.current = buildChatContext({
          assetName: asset?.name ?? symbol, symbol,
          type: asset?.type ?? 'CRYPTO', tf, srcLabel,
          price: fallbackPrice, chgPct: cp?.chg ?? 0,
          rsi: null, ma20: null, ma50: null, ohlc: 'No candle data — using live price only.',
          mlSignal:     (route?.params as any)?.mlSignal ?? null,
          vpSnap:       (route?.params as any)?.vpSnap ?? null,
          regimeSnap:   (route?.params as any)?.regimeSnap ?? null,
          mtfSnap:      (route?.params as any)?.mtfSnap ?? null,
          techSummary:  (route?.params as any)?.techSummary ?? null,
          openPosition: (route?.params as any)?.openPosition ?? null,
        });
        setContextReady(true);
        return;
      }

      const rsi  = calcRSI(candles, 14);
      const ma20Arr = calcMA(candles, 20);
      const ma50Arr = calcMA(candles, 50);
      const ma20 = ma20Arr[ma20Arr.length - 1] ?? null;
      const ma50 = ma50Arr[ma50Arr.length - 1] ?? null;

      const recent = candles.slice(-8);
      const ohlc = recent.map((c: any) =>
        `${new Date(c.time).toLocaleTimeString('en',{hour:'2-digit',minute:'2-digit'})} O:${c.open.toFixed(2)} H:${c.high.toFixed(2)} L:${c.low.toFixed(2)} C:${c.close.toFixed(2)}`
      ).join('\n');

      const newsSummary = news?.slice(0, 3).map((n: any) => n.headline).join(' | ') ?? '';
      let fearGreedSummary = '';
      if (asset?.src === 'binance' || asset?.src === 'coindcx') {
        try {
          const ctx = await fetchCryptoContextPartial(symbol, ['FEAR_GREED', 'MARKET_CAP']);
          if (ctx?.fearGreed?.value) fearGreedSummary = `Fear&Greed: ${ctx.fearGreed.value} (${ctx.fearGreed.classification})`;
        } catch {}
      }

      contextRef.current = buildChatContext({
        assetName: asset.name, symbol, type: asset.type, tf, srcLabel,
        price: last.close, chgPct: cp?.chg ?? 0,
        rsi, ma20, ma50, ohlc,
        newsSummary: [newsSummary, fearGreedSummary].filter(Boolean).join(' | ') || undefined,
        mlSignal:     (route?.params as any)?.mlSignal ?? null,
        vpSnap:       (route?.params as any)?.vpSnap ?? null,
        regimeSnap:   (route?.params as any)?.regimeSnap ?? null,
        mtfSnap:      (route?.params as any)?.mtfSnap ?? null,
        techSummary:  (route?.params as any)?.techSummary ?? null,
        openPosition: (route?.params as any)?.openPosition ?? null,
      });
      setContextReady(true);
    } catch (e: any) {
      setContextErr(e?.message ?? 'Could not load market data. Tap retry.');
    }
  }, [asset, symbol, aoSession, avKey, news, cp]);

  // Reset messages when symbol changes (navigated from a different chart)
  useEffect(() => {
    setMessages([]);
    setContextReady(false);
    setContextErr('');
    buildContext();
  }, [symbol]);

  // ── Send message with streaming ────────────────────────────────────────────
  // Use refs for values accessed inside the streaming callback to avoid
  // stale closure captures and dep array rebuilds on every message.
  const sendingRef      = useRef(false);
  const messagesRef     = useRef<(ChatMessage & { streaming?: boolean })[]>([]);
  const inputRef2       = useRef('');
  const throttleRef     = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep refs in sync with state
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { inputRef2.current = input; }, [input]);

  const send = useCallback(async (text?: string) => {
    const content = (text ?? inputRef2.current).trim();
    if (!content || sendingRef.current) return;
    if (!contextReady) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      return; // still loading context — haptic feedback so user knows
    }

    // Fire haptic FIRST — before any state update (most instant possible)
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    sendingRef.current = true;

    const userMsg: ChatMessage = { role: 'user', content };
    const withUser = [...messagesRef.current, userMsg];
    const withTyping = [...withUser, { role: 'assistant' as const, content: '', streaming: true }];

    // Batch ALL state updates into a single render pass
    unstable_batchedUpdates(() => {
      setInput('');
      setSending(true);
      setMessages(withTyping);
    });
    messagesRef.current = withTyping;
    persist(withUser);

    requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));

    abortRef.current = new AbortController();
    let accumulated = '';
    let pendingUpdate = false;

    // Throttled UI update — batches chunks into 50ms windows
    // Prevents excessive re-renders competing with the JS thread
    function flushUpdate() {
      pendingUpdate = false;
      setMessages(prev => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last?.streaming) next[next.length - 1] = { ...last, content: accumulated };
        return next;
      });
      listRef.current?.scrollToEnd({ animated: false });
    }

    try {
      await chatWithClaudeStream(
        withUser,
        anthropicKey,
        contextRef.current,
        (chunk) => {
          accumulated += chunk;
          // Throttle: schedule one update per 50ms window, not per chunk
          if (!pendingUpdate) {
            pendingUpdate = true;
            throttleRef.current = setTimeout(flushUpdate, 30);
          }
        },
        abortRef.current.signal,
      );
      // Flush any remaining buffered content
      if (throttleRef.current) { clearTimeout(throttleRef.current); throttleRef.current = null; }

      // Finalise — remove streaming flag
      const final = [...withUser, { role: 'assistant' as const, content: accumulated }];
      setMessages(final);
      persist(final);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        // Keep partial response clean — no ugly text appended
        // The stopped badge is rendered by MessageBubble via the stopped flag
        const partial = [...withUser, {
          role: 'assistant' as const,
          content: accumulated || '',
          stopped: true,
        } as any];
        setMessages(partial);
        persist(partial);
      } else {
        const rawMsg = e?.message ?? 'Something went wrong.';
        const msg = e?.message?.includes('401')
          ? '**API key invalid**\n\nPlease check your Anthropic API key in More → Settings.'
          : e?.message?.includes('429')
          ? '**Rate limited**\n\nYou sent too many messages. Wait a moment and try again.'
          : e?.message?.includes('network') || e?.message?.includes('fetch') || e?.message?.includes('Network')
          ? '**Connection failed**\n\nCheck your internet connection and try again.'
          : e?.message?.includes('503') || e?.message?.includes('overloaded')
          ? '**Claude is busy**\n\nHigh demand right now. Try again in a few seconds.'
          : `**Error**\n\n${rawMsg}`;
        setMessages(prev => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last?.streaming) next[next.length - 1] = { role: 'assistant', content: msg };
          return next;
        });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
    } finally {
      sendingRef.current = false;
      setSending(false);
      abortRef.current = null;
      if (throttleRef.current) { clearTimeout(throttleRef.current); throttleRef.current = null; }
    }
  // Minimal deps — values accessed via refs to avoid stale closures and rebuilds
  }, [contextReady, anthropicKey, persist]);

  const clearHistory = useCallback(() => {
    AsyncStorage.removeItem(HISTORY_KEY(symbol));
    setMessages([]);
  }, [symbol]);

  const stopStreaming = useCallback(() => {
    if (!abortRef.current) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    abortRef.current.abort();
    abortRef.current = null;
    // Immediately show stopped state without waiting for the catch block
    setSending(false);
    sendingRef.current = false;
  }, []);

  // ── Render ─────────────────────────────────────────────────────────────────
  const showSuggestions = messages.length === 0 && contextReady;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }} edges={['bottom']}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={90}>

        {/* ── Message list ─────────────────────────────────────────── */}
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(_, i) => String(i)}
          renderItem={({ item }) => <MessageBubble msg={item} T={T} />}
          contentContainerStyle={{ padding: 16, paddingBottom: 8, flexGrow: 1 }}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
          keyboardShouldPersistTaps="handled"
          removeClippedSubviews={false}
          ListHeaderComponent={showSuggestions ? null : undefined}
          ListEmptyComponent={
            contextReady ? (
              <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingVertical: 40 }}>
                <Text style={{ fontSize: 32, marginBottom: 12 }}>✦</Text>
                <Text style={{ color: T.text, fontSize: 18, fontWeight: '700', marginBottom: 6 }}>
                  Quantis AI
                </Text>
                <Text style={{ color: T.textDim, fontSize: 13, textAlign: 'center', maxWidth: 260 }}>
                  Ask me anything about {asset?.name ?? symbol} — price action, trade setups, risk levels, or market context.
                </Text>
              </View>
            ) : contextErr ? (
              <View style={{ padding: 20, alignItems: 'center' }}>
                <Text style={{ color: T.textDim, fontSize: 13, textAlign: 'center', marginBottom: 12 }}>{contextErr}</Text>
                <TouchableOpacity onPress={buildContext}
                  style={{ backgroundColor: T.accent, borderRadius: 20, paddingHorizontal: 20, paddingVertical: 8 }}>
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

        {/* ── Quick suggestions ─────────────────────────────────────── */}
        {showSuggestions && (
          <View style={{ paddingHorizontal: 12, paddingBottom: 8 }}>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {SUGGESTIONS.map(s => (
                <TouchableOpacity key={s.text} onPress={() => send(s.text)}
                  style={{ flexDirection: 'row', alignItems: 'center',
                    backgroundColor: T.bg2, borderRadius: 20, borderWidth: 1,
                    borderColor: T.border, paddingHorizontal: 12, paddingVertical: 7 }}>
                  <Text style={{ fontSize: 13, marginRight: 5 }}>{s.icon}</Text>
                  <Text style={{ color: T.text, fontSize: 12, fontWeight: '500' }}>{s.text}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}

        {/* ── Input bar ─────────────────────────────────────────────── */}
        <View style={{
          flexDirection:    'row',
          alignItems:       'flex-end',
          paddingHorizontal: 12,
          paddingVertical:   10,
          borderTopWidth:    1,
          borderTopColor:    T.border,
          backgroundColor:   T.bg1,
          gap:               8,
        }}>
          {/* Clear button */}
          {messages.length > 0 && !sending && (
            <TouchableOpacity onPress={clearHistory}
              style={{ paddingHorizontal: 8, paddingVertical: 8 }}>
              <Text style={{ color: T.textDim, fontSize: 18 }}>🗑</Text>
            </TouchableOpacity>
          )}

          <TextInput
            ref={inputRef}
            value={input}
            onChangeText={setInput}
            placeholder={contextReady ? `Ask about ${asset?.name ?? symbol}…` : 'Loading context…'}
            placeholderTextColor={T.textDim}
            style={{
              flex:            1,
              backgroundColor: T.bg2,
              borderRadius:    22,
              paddingHorizontal: 16,
              paddingVertical:   10,
              color:           T.text,
              fontSize:        15,
              maxHeight:       120,
              lineHeight:      20,
            }}
            multiline
            editable={contextReady && !sending}
            onSubmitEditing={() => send()}
            blurOnSubmit={false}
            returnKeyType="send"
          />

          {/* Send / Stop button */}
          <TouchableOpacity
            onPress={sending ? stopStreaming : () => send()}
            onPressIn={!sending && input.trim() && contextReady ? () => {
              // Fire haptic on press-in (before onPress) for instant feel
              Haptics.selectionAsync();
            } : undefined}
            disabled={!sending && (!input.trim() || !contextReady)}
            style={{
              width:           42,
              height:          42,
              borderRadius:    21,
              backgroundColor: sending ? T.red : (input.trim() && contextReady ? T.accent : T.bg3),
              alignItems:      'center',
              justifyContent:  'center',
            }}>
            {sending
              ? <Text style={{ fontSize: 16 }}>■</Text>
              : <Text style={{ fontSize: 18, color: '#fff' }}>↑</Text>
            }
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
