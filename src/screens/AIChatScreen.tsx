import React, { useEffect, useState, useRef, useCallback } from 'react';
import { View, Text, TextInput, TouchableOpacity, FlatList,
         ActivityIndicator, KeyboardAvoidingView, Platform, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTheme } from '../context/ThemeContext';
import { useData } from '../context/DataContext';
import { Candle, calcMA, calcRSI, pFmt } from '../utils/indicators';
import { fetchCdxCandles } from '../api/coindcx';
import { fetchBnKlines } from '../api/binance';
import { fetchAVKlines } from '../api/alphaVantage';
import { aoCandles } from '../api/angelOne';
import { chatWithClaude, buildChatContext, ChatMessage } from '../api/claude';
import { fetchCandlesWithCache } from '../utils/candleCache';
import { fetchCryptoContextPartial } from '../utils/cryptoMarketContext/cryptoMarketContextFetch';

// Per-symbol chat history persisted to AsyncStorage.
// Key: 'aichat_v1_<symbol>' — stores last 50 messages per symbol.
const CHAT_KEY = (symbol: string) => `aichat_v1_${symbol}`;
const MAX_STORED_MESSAGES = 50;  // keep last 50 per symbol (~40KB max)

const SUGGESTED_PROMPTS = [
  'Predict where this is headed next',
  'Give me entry, target, and stop-loss',
  'What does the order book say right now?',
  'Should I wait or act on this now?',
  'How has the setup changed since last time?',
];

export default function AIChatScreen({ route, navigation }: any) {
  const { theme: T } = useTheme();
  const { prices, aoSession, avKey, anthropicKey, allAssets, news } = useData();
  const symbol = route?.params?.symbol || 'NIFTY50';
  const asset = allAssets.find(a => a.symbol === symbol) || allAssets[0];

  // ML prediction passed from ChartScreen when user navigates via the chat button.
  // Used to populate mlSummary so the copilot is aware of the on-device signal.
  // May be null if: user opened chat from More menu, prediction hasn't run yet,
  // or the ML engine returned HOLD (no directional call).
  const mlSignalParam = route?.params?.mlSignal ?? null;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [contextReady, setContextReady] = useState(false);
  const [contextErr, setContextErr] = useState('');
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const contextRef = useRef<string>('');
  const listRef = useRef<FlatList>(null);

  // ── Phase 1: Load persisted history for this symbol on mount ───────────────
  useEffect(() => {
    AsyncStorage.getItem(CHAT_KEY(symbol)).then(raw => {
      if (raw) {
        try {
          const saved: ChatMessage[] = JSON.parse(raw);
          if (saved.length) setMessages(saved);
        } catch { /* ignore corrupt */ }
      }
      setHistoryLoaded(true);
    }).catch(() => setHistoryLoaded(true));
  }, [symbol]);

  // ── Phase 2: Persist messages whenever they change ─────────────────────────
  // Debounced to avoid writing on every keystroke during streaming.
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistMessages = useCallback((msgs: ChatMessage[]) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const toSave = msgs.slice(-MAX_STORED_MESSAGES); // keep last 50
      AsyncStorage.setItem(CHAT_KEY(symbol), JSON.stringify(toSave)).catch(() => {});
    }, 500);
  }, [symbol]);

  // ── Build market context (system prompt) ───────────────────────────────────
  const buildContext = useCallback(async () => {
    setContextReady(false); setContextErr('');
    try {
      let candles: Candle[] = [];
      let srcLabel = 'No live source';
      if (asset.src === 'binance' && asset.bnSym) {
        const bnSym = asset.bnSym;
        const BN_TF_MS: Record<string, number> = {
          '1m':60000,'3m':180000,'5m':300000,'15m':900000,
          '30m':1800000,'1h':3600000,'4h':14400000,'1D':86400000,
        };
        const barMs = BN_TF_MS['15m'];
        const CORRECTION_WINDOW = 10;
        candles = await fetchCandlesWithCache(asset.symbol, '15m',
          async (newestCachedTime) => {
            if (newestCachedTime) {
              const fromTime = newestCachedTime - (CORRECTION_WINDOW * barMs);
              return fetchBnKlines(bnSym, '15m', 1000, undefined, fromTime);
            }
            return fetchBnKlines(bnSym, '15m', 1000);
          },
          { skipApiIfFresh: true },
        );
        srcLabel = 'Binance (15m)';
      } else if ((asset.src === 'ao' || asset.src === 'ao_futures') && aoSession?.jwtToken && asset.aoToken && asset.aoEx) {
        const sess = aoSession;
        candles = await fetchCandlesWithCache(asset.symbol, '15m',
          async () => aoCandles(asset.aoToken!, asset.aoEx!, '15m', sess), { skipApiIfFresh: true });
        srcLabel = 'Angel One (15m)';
      } else if (asset.src === 'coindcx' && (asset as any).cdxSym) {
        candles = await fetchCdxCandles((asset as any).cdxSym, tf ?? '15m');
      } else if (asset.src === 'av' && asset.avSym && avKey) {
        candles = await fetchCandlesWithCache(asset.symbol, '15m',
          async () => fetchAVKlines(asset.avSym!, '15m', avKey), { skipApiIfFresh: true });
        srcLabel = 'Alpha Vantage (15m)';
      }

      if (!candles.length) {
        setContextErr(`No live data for ${symbol} — connect a data source in Settings.`);
        return;
      }

      const last  = candles[candles.length - 1];
      const ma20  = calcMA(candles, 20)[candles.length - 1];
      const ma50  = calcMA(candles, 50)[candles.length - 1];
      const atrRaw = candles.slice(-15).reduce((s, c, i) => i === 0 ? s : s + Math.abs(c.high - c.low), 0) / 14;
      const rsi   = calcRSI(candles);
      const cp    = prices[symbol];

      // ── Candle history strategy ───────────────────────────────────────────
      // 15m candles: 96 bars = 1 trading day, 480 = 5 days.
      // We give Claude two layers of context:
      //   • Recent: last 96 bars (24 hours) as individual OHLCV rows — fine grain
      //   • Historical: preceding bars summarised into daily OHLCV buckets
      //     (up to 14 trading days) — trend/range context without token blow-up.
      const RECENT_BARS  = 96;   // 1 day of 15m bars
      const HISTORY_DAYS = 14;   // daily summaries beyond the recent window

      const recentCandles = candles.slice(-RECENT_BARS);
      const olderCandles  = candles.slice(0, Math.max(0, candles.length - RECENT_BARS));

      // Build per-day OHLCV buckets from older candles
      const dayMap: Record<string, { o: number; h: number; l: number; c: number; v: number }> = {};
      for (const c of olderCandles) {
        const dayKey = new Date(c.time * 1000).toISOString().slice(0, 10); // YYYY-MM-DD
        if (!dayMap[dayKey]) {
          dayMap[dayKey] = { o: c.open, h: c.high, l: c.low, c: c.close, v: 0 };
        } else {
          if (c.high > dayMap[dayKey].h) dayMap[dayKey].h = c.high;
          if (c.low  < dayMap[dayKey].l) dayMap[dayKey].l = c.low;
          dayMap[dayKey].c = c.close;
        }
        dayMap[dayKey].v += c.volume;
      }
      const dailySummaryRows = Object.entries(dayMap)
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(-HISTORY_DAYS)
        .map(([day, d]) =>
          `${day} O:${pFmt(d.o)} H:${pFmt(d.h)} L:${pFmt(d.l)} C:${pFmt(d.c)} V:${(d.v / 1000).toFixed(0)}K`
        );

      // Recent bars as individual 15m rows
      const recentRows = recentCandles.map(c =>
        `O:${pFmt(c.open)} H:${pFmt(c.high)} L:${pFmt(c.low)} C:${pFmt(c.close)} V:${(c.volume / 1000).toFixed(0)}K`
      );

      // Compose the OHLC block: daily history then recent bars
      const ohlcParts: string[] = [];
      if (dailySummaryRows.length) {
        ohlcParts.push(`--- Daily history (${dailySummaryRows.length} trading days) ---`);
        ohlcParts.push(...dailySummaryRows);
        ohlcParts.push(`--- Recent 15m bars (${recentRows.length} bars / ~24 hrs) ---`);
      }
      ohlcParts.push(...recentRows);
      const ohlc = ohlcParts.join('\n');

      // Rich order book with price levels
      let obSummary: string | undefined;
      if (cp?.depth) {
        const buyQ  = cp.depth.buy.reduce((s, d) => s + d.qty, 0);
        const sellQ = cp.depth.sell.reduce((s, d) => s + d.qty, 0);
        const total = buyQ + sellQ || 1;
        const spread = cp.depth.sell[0]?.price && cp.depth.buy[0]?.price
          ? (cp.depth.sell[0].price - cp.depth.buy[0].price).toFixed(4) : 'n/a';
        const bidRows = cp.depth.buy.slice(0, 5).map(d => `BID ${pFmt(d.price)} ×${d.qty.toFixed(3)}`).join(' | ');
        const askRows = cp.depth.sell.slice(0, 5).map(d => `ASK ${pFmt(d.price)} ×${d.qty.toFixed(3)}`).join(' | ');
        obSummary = `Buy ${((buyQ/total)*100).toFixed(0)}% / Sell ${((sellQ/total)*100).toFixed(0)}% | Spread:${spread} | ATR:${atrRaw.toFixed(2)}\nBids: ${bidRows}\nAsks: ${askRows}`;
      }

      const newsSummary = news.slice(0, 4).map(n => `${n.txt} (${n.imp})`).join(' | ') || undefined;

      // ── Fear & Greed + market structure for crypto assets ─────────────────
      // Uses fetchCryptoContextPartial so we only pay for FEAR_GREED + MARKET_CAP
      // (no funding/OI fetch here — those are symbol-specific and slower).
      // The cache from the chart's usePrediction run is reused — no extra API call
      // if the chart has been opened recently.
      let fearGreedSummary: string | undefined;
      if (asset.src === 'binance' || asset.type === 'CRYPTO') {
        try {
          const cryptoCtx = await fetchCryptoContextPartial(symbol, ['FEAR_GREED', 'MARKET_CAP']);
          const fg = cryptoCtx.fearGreed;
          const mc = cryptoCtx.marketCap;
          if (fg) {
            fearGreedSummary =
              `Fear & Greed: ${fg.value} (${fg.classification}, ${fg.trend} from ${fg.previousDay} yesterday)`;
            if (mc) {
              fearGreedSummary +=
                ` | BTC Dom: ${mc.btcDominance.toFixed(1)}% | Market: ${mc.totalChange24h >= 0 ? '+' : ''}${mc.totalChange24h.toFixed(2)}% 24h | Regime: ${mc.regime}`;
            }
          }
        } catch { /* non-fatal — context still built without it */ }
      }

      // ── ML signal summary for context ─────────────────────────────────────
      // If the user navigated from the chart after running Predict, the signal
      // is already available — no re-inference needed. This is the single source
      // of truth: the same number the Predict button showed.
      let mlSummary: string | undefined;
      if (mlSignalParam && mlSignalParam.action !== 'HOLD') {
        const sig = mlSignalParam;
        const dirLabel = sig.direction === 'UP' ? '▲ BULLISH' : sig.direction === 'DOWN' ? '▼ BEARISH' : '— NEUTRAL';
        const topF = (sig.topFeatures ?? [])
          .map((f: any) => `${f.name} (${f.value?.toFixed(2) ?? '?'})`)
          .join(', ');
        mlSummary =
          `Signal: ${sig.action} | Direction: ${dirLabel} | ` +
          `P(up): ${(sig.ensembleProbUp * 100).toFixed(1)}% | ` +
          `Confidence: ${sig.confidence.toFixed(0)}% | ` +
          `Walk-forward accuracy: ${sig.walkForwardAccuracy.toFixed(1)}%` +
          (topF ? ` | Top features: ${topF}` : '');
      }

      const historyHint = messages.length > 0
        ? `\nCONVERSATION HISTORY: ${messages.length} prior messages in this session. Reference them when relevant — the user may be asking follow-up questions.`
        : '';

      contextRef.current = buildChatContext({
        assetName: asset.name, symbol, type: asset.type, tf: '15m', srcLabel,
        price: last.close, chgPct: cp?.chg ?? 0,
        rsi: rsi?.[rsi.length - 1] ?? 50,
        ma20, ma50, ohlc, obSummary, mlSummary,
        newsSummary: [newsSummary, fearGreedSummary].filter(Boolean).join(' | ') || undefined,
      }) + historyHint;

      setContextReady(true);
    } catch (e: any) {
      // Map technical errors to user-friendly messages
      const raw: string = e?.message ?? '';
      const friendly =
        raw.includes('401') || raw.includes('JWT') || raw.includes('Unauthorized')
          ? 'Your Angel One session has expired. Go to Settings → Angel One to reconnect.'
          : raw.includes('Network') || raw.includes('fetch') || raw.includes('timeout')
          ? 'Network error — check your internet connection and try again.'
          : raw.includes('API key') || raw.includes('Invalid key') || raw.includes('403')
          ? 'Invalid API key. Please check your key in Settings.'
          : raw || 'Something went wrong loading market data. Tap Retry.';
      setContextErr(friendly);
    }
  }, [asset, symbol, aoSession, avKey, news, prices, messages.length]);

  // Build context once on mount (after history loads so historyHint is accurate)
  useEffect(() => {
    if (historyLoaded) buildContext();
  }, [historyLoaded]);

  // ── Send message ───────────────────────────────────────────────────────────
  async function send(text?: string) {
    const content = (text ?? input).trim();
    if (!content || sending || !contextReady) return;
    const next: ChatMessage[] = [...messages, { role: 'user', content }];
    setMessages(next);
    persistMessages(next);
    setInput('');
    setSending(true);
    try {
      const reply = await chatWithClaude(next, anthropicKey, contextRef.current);
      const final = [...next, { role: 'assistant' as const, content: reply }];
      setMessages(final);
      persistMessages(final);
    } catch (e: any) {
      const raw2: string = e?.message ?? '';
      const friendlyChat =
        raw2.includes('401') || raw2.includes('Invalid') || raw2.includes('auth')
          ? '⚠ API key issue — check your Anthropic key in Settings.'
          : raw2.includes('Network') || raw2.includes('fetch') || raw2.includes('timeout')
          ? '⚠ Network error — check your connection and try again.'
          : '⚠ Something went wrong. Please try again.';
      const errMsg = [...next, { role: 'assistant' as const, content: friendlyChat }];
      setMessages(errMsg);
      persistMessages(errMsg);
    } finally {
      setSending(false);
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);
    }
  }

  // ── Clear history ──────────────────────────────────────────────────────────
  function clearHistory() {
    Alert.alert(
      'Clear chat history',
      `Delete all ${messages.length} messages for ${symbol}? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Clear', style: 'destructive', onPress: () => {
          setMessages([]);
          AsyncStorage.removeItem(CHAT_KEY(symbol)).catch(() => {});
        }},
      ]
    );
  }

  const msgCount = messages.length;
  const assistantCount = messages.filter(m => m.role === 'assistant').length;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      {/* Header */}
      <View style={{ padding: 14, borderBottomWidth: 1, borderBottomColor: T.border }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <View style={{ flex: 1 }}>
            <Text style={{ color: T.text, fontSize: 16, fontWeight: '800' }}>💬 {symbol}</Text>
            <Text style={{ color: T.textDim, fontSize: 10, marginTop: 2 }}>
              {contextReady
                ? `✓ Live data loaded · ${msgCount > 0 ? `${assistantCount} AI responses` : 'No messages yet'}`
                : contextErr ? '⚠ No live data' : 'Loading market data…'}
            </Text>
          </View>
          <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
            {msgCount > 0 && (
              <TouchableOpacity onPress={clearHistory}>
                <Text style={{ color: T.red, fontSize: 12 }}>Clear</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity onPress={buildContext}>
              <Text style={{ color: T.accent, fontSize: 12 }}>↻ Refresh</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => navigation.goBack()}>
              <Text style={{ color: T.textSub, fontSize: 12 }}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>

      {!anthropicKey && (
        <View style={{ backgroundColor: T.amber + '15', padding: 12, margin: 12, borderRadius: 8 }}>
          <Text style={{ color: T.amber, fontSize: 11, lineHeight: 16 }}>⚙ Add your Anthropic API key in Settings to chat.</Text>
        </View>
      )}
      {contextErr && (
        <View style={{ backgroundColor: T.red + '15', padding: 12, margin: 12, borderRadius: 8 }}>
          <Text style={{ color: T.red, fontSize: 11, lineHeight: 16 }}>{contextErr}</Text>
          <TouchableOpacity onPress={buildContext} style={{ marginTop: 8 }}>
            <Text style={{ color: T.accent, fontSize: 11, fontWeight: '700' }}>↻ Retry</Text>
          </TouchableOpacity>
        </View>
      )}
      {!historyLoaded && (
        <View style={{ padding: 30, alignItems: 'center' }}>
          <ActivityIndicator color={T.blue} />
          <Text style={{ color: T.textDim, fontSize: 11, marginTop: 8 }}>Loading chat history…</Text>
        </View>
      )}

      {/* Message list */}
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(_, i) => String(i)}
        contentContainerStyle={{ padding: 14, paddingBottom: 6 }}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
        renderItem={({ item }) => (
          <View style={{
            alignSelf: item.role === 'user' ? 'flex-end' : 'flex-start',
            backgroundColor: item.role === 'user' ? T.accent : T.bg3,
            borderRadius: 14,
            borderBottomRightRadius: item.role === 'user' ? 4 : 14,
            borderBottomLeftRadius: item.role === 'assistant' ? 4 : 14,
            padding: 12, marginBottom: 10, maxWidth: '88%',
          }}>
            <Text style={{ color: item.role === 'user' ? '#fff' : T.text, fontSize: 13, lineHeight: 20 }}>
              {item.content}
            </Text>
          </View>
        )}
        ListHeaderComponent={msgCount > 0 ? (
          <View style={{ alignItems: 'center', marginBottom: 16 }}>
            <Text style={{ color: T.textDim, fontSize: 10, backgroundColor: T.bg2, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10 }}>
              {msgCount} messages · history saved
            </Text>
          </View>
        ) : null}
        ListEmptyComponent={
          contextReady && historyLoaded ? (
            <View style={{ marginTop: 10 }}>
              <Text style={{ color: T.textDim, fontSize: 12, marginBottom: 14, lineHeight: 18 }}>
                Ask anything about {symbol}. Grounded in live price, order book, and recent news. History is saved across sessions.
              </Text>
              {SUGGESTED_PROMPTS.map(p => (
                <TouchableOpacity key={p} onPress={() => send(p)}
                  style={{ backgroundColor: T.bg3, borderRadius: 10, padding: 11, marginBottom: 8, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={{ color: T.accent, fontSize: 13 }}>💡</Text>
                  <Text style={{ color: T.textSub, fontSize: 12, flex: 1 }}>{p}</Text>
                </TouchableOpacity>
              ))}
            </View>
          ) : null
        }
      />

      {sending && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingBottom: 8 }}>
          <ActivityIndicator size="small" color={T.blue} />
          <Text style={{ color: T.textDim, fontSize: 11 }}>Thinking…</Text>
        </View>
      )}

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={{ flexDirection: 'row', gap: 8, padding: 12, borderTopWidth: 1, borderTopColor: T.border }}>
          <TextInput
            value={input}
            onChangeText={setInput}
            onSubmitEditing={() => send()}
            placeholder={contextReady ? `Ask about ${symbol}…` : 'Loading…'}
            placeholderTextColor={T.textDim}
            editable={contextReady && !sending && !!anthropicKey}
            multiline
            style={{ flex: 1, backgroundColor: T.bg3, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, color: T.text, fontSize: 13, maxHeight: 100 }}
          />
          <TouchableOpacity
            onPress={() => send()}
            disabled={!contextReady || sending || !input.trim() || !anthropicKey}
            style={{ backgroundColor: T.accent, borderRadius: 12, paddingHorizontal: 16, justifyContent: 'center', opacity: (!contextReady || sending || !input.trim() || !anthropicKey) ? 0.4 : 1 }}>
            <Text style={{ color: '#fff', fontWeight: '800', fontSize: 13 }}>↑</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
