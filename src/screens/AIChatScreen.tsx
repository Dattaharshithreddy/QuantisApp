import React, { useEffect, useState, useRef, useCallback } from 'react';
import { View, Text, TextInput, TouchableOpacity, FlatList, ActivityIndicator, KeyboardAvoidingView, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useData } from '../context/DataContext';
import { Candle, calcMA, calcRSI, pFmt } from '../utils/indicators';
import { fetchBnKlines } from '../api/binance';
import { fetchAVKlines } from '../api/alphaVantage';
import { aoCandles } from '../api/angelOne';
import { chatWithClaude, buildChatContext, ChatMessage } from '../api/claude';
import { trainAndPredict } from '../utils/mlSignal';
import { getOptimalConfig } from '../utils/modelOptimization';
import { fetchCandlesWithCache } from '../utils/candleCache';

const SUGGESTED_PROMPTS = [
  'Predict where this is headed next',
  'Give me entry, target, and stop-loss',
  'What does the order book say right now?',
  'Should I wait or act on this now?',
];

export default function AIChatScreen({ route, navigation }: any) {
  const { theme: T } = useTheme();
  const { prices, aoSession, avKey, anthropicKey, allAssets, news } = useData();
  const symbol = route?.params?.symbol || 'NIFTY50';
  const asset = allAssets.find(a => a.symbol === symbol) || allAssets[0];

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [contextReady, setContextReady] = useState(false);
  const [contextErr, setContextErr] = useState('');
  const contextRef = useRef<string>('');
  const listRef = useRef<FlatList>(null);

  const buildContext = useCallback(async () => {
    setContextReady(false); setContextErr('');
    try {
      let candles: Candle[] = [];
      let srcLabel = 'No live source';
      if (asset.src === 'binance' && asset.bnSym) {
        const bnSym = asset.bnSym;
        candles = await fetchCandlesWithCache(asset.symbol, '15m',
          async () => fetchBnKlines(bnSym, '15m'), { skipApiIfFresh: true }); srcLabel = 'Cached Binance';
      } else if (asset.src === 'ao' && aoSession?.jwtToken && asset.aoToken && asset.aoEx) {
        const { aoToken, aoEx } = asset; const sess = aoSession;
        candles = await fetchCandlesWithCache(asset.symbol, '15m',
          async () => aoCandles(aoToken, aoEx, '15m', sess), { skipApiIfFresh: true }); srcLabel = 'Cached Angel One';
      } else if (asset.src === 'av' && asset.avSym && avKey) {
        const avSym = asset.avSym; const key = avKey;
        candles = await fetchCandlesWithCache(asset.symbol, '15m',
          async () => fetchAVKlines(avSym, '15m', key), { skipApiIfFresh: true }); srcLabel = 'Cached Alpha Vantage';
      }

      if (!candles.length) {
        setContextErr(`No live data source connected for ${symbol} — connect one in Settings before chatting about it.`);
        return;
      }

      const last = candles[candles.length - 1];
      const ma20 = calcMA(candles, 20)[candles.length - 1];
      const ma50 = calcMA(candles, 50)[candles.length - 1];
      const rsi = calcRSI(candles);
      const cp = prices[symbol];
      const ohlc = candles.slice(-10).map(c => `O:${pFmt(c.open)} H:${pFmt(c.high)} L:${pFmt(c.low)} C:${pFmt(c.close)} V:${(c.volume / 1000).toFixed(0)}K`).join('\n');

      // Pull a quick ML read for grounding, if there's enough data — non-fatal if it fails
      let mlSummary: string | undefined;
      try {
        const optimalConfig = await getOptimalConfig(symbol, '15m');
        const ml = await trainAndPredict(symbol, '15m', candles, optimalConfig?.bestHorizon, optimalConfig?.bestThreshold, false, asset.type);
        if (ml) mlSummary = `Ensemble suggests ${ml.action}, P(up)=${(ml.ensembleProbUp * 100).toFixed(1)}%, models ${ml.ensembleAgree ? 'agree' : 'disagree'}, walk-forward accuracy ${ml.walkForwardAccuracy >= 0 ? ml.walkForwardAccuracy.toFixed(0) + '%' : 'n/a'} on ${ml.sampleCount} bars (small sample — treat as minor input). ATR levels: entry ${ml.suggestedEntry.toFixed(2)}, SL ${ml.suggestedStopLoss.toFixed(2)}, TP ${ml.suggestedTakeProfit.toFixed(2)}.`;
      } catch (_) {}

      let obSummary: string | undefined;
      if (cp?.depth) {
        const buyQ = cp.depth.buy.reduce((s, d) => s + d.qty, 0);
        const sellQ = cp.depth.sell.reduce((s, d) => s + d.qty, 0);
        const total = buyQ + sellQ || 1;
        obSummary = `Buy-side ${((buyQ / total) * 100).toFixed(1)}% vs sell-side ${((sellQ / total) * 100).toFixed(1)}% of visible depth.`;
      }

      const newsSummary = news.slice(0, 3).map(n => `${n.txt} (${n.imp})`).join(' | ') || undefined;

      contextRef.current = buildChatContext({
        assetName: asset.name, symbol, type: asset.type, tf: '15m', srcLabel,
        price: last.close, chgPct: cp?.chg ?? 0, rsi, ma20, ma50, ohlc, mlSummary, obSummary, newsSummary,
      });
      setContextReady(true);
    } catch (e: any) {
      setContextErr(e.message);
    }
  }, [asset, symbol, aoSession, avKey, news]);

  useEffect(() => { buildContext(); }, []);

  async function send(text?: string) {
    const content = (text ?? input).trim();
    if (!content || sending || !contextReady) return;
    const next: ChatMessage[] = [...messages, { role: 'user', content }];
    setMessages(next);
    setInput('');
    setSending(true);
    try {
      const reply = await chatWithClaude(next, anthropicKey, contextRef.current);
      setMessages([...next, { role: 'assistant', content: reply }]);
    } catch (e: any) {
      setMessages([...next, { role: 'assistant', content: `⚠ ${e.message}` }]);
    } finally {
      setSending(false);
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      <View style={{ padding: 14, borderBottomWidth: 1, borderBottomColor: T.border, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <View>
          <Text style={{ color: T.text, fontSize: 16, fontWeight: '800' }}>💬 Chat with AI — {symbol}</Text>
          <Text style={{ color: T.textDim, fontSize: 10, marginTop: 2 }}>
            {contextReady ? '✓ Grounded in live market data' : contextErr ? '⚠ No live data' : 'Loading market context…'}
          </Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
          <TouchableOpacity onPress={buildContext}>
            <Text style={{ color: T.accent, fontSize: 13 }}>↻ Refresh data</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => navigation.goBack()}>
            <Text style={{ color: T.textSub, fontSize: 13 }}>Close</Text>
          </TouchableOpacity>
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
      {!contextReady && !contextErr && (
        <View style={{ padding: 30, alignItems: 'center' }}>
          <ActivityIndicator color={T.blue} />
        </View>
      )}

      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(_, i) => String(i)}
        contentContainerStyle={{ padding: 14, paddingBottom: 6 }}
        renderItem={({ item }) => (
          <View style={{
            alignSelf: item.role === 'user' ? 'flex-end' : 'flex-start',
            backgroundColor: item.role === 'user' ? T.accent : T.bg3,
            borderRadius: 12, padding: 12, marginBottom: 10, maxWidth: '85%',
          }}>
            <Text style={{ color: item.role === 'user' ? '#fff' : T.text, fontSize: 13, lineHeight: 19 }}>{item.content}</Text>
          </View>
        )}
        ListEmptyComponent={
          contextReady ? (
            <View style={{ marginTop: 10 }}>
              <Text style={{ color: T.textDim, fontSize: 12, marginBottom: 12, lineHeight: 18 }}>
                Ask anything about {symbol} — a prediction, an entry/target/stop-loss plan, or what the order book is telling you. Answers are grounded in the live data loaded above, not guesses.
              </Text>
              {SUGGESTED_PROMPTS.map(p => (
                <TouchableOpacity key={p} onPress={() => send(p)} style={{ backgroundColor: T.bg3, borderRadius: 8, padding: 10, marginBottom: 8 }}>
                  <Text style={{ color: T.textSub, fontSize: 12 }}>💡 {p}</Text>
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
            placeholder={contextReady ? 'Ask about entry, target, prediction…' : 'Waiting for market data…'}
            placeholderTextColor={T.textDim}
            editable={contextReady && !sending}
            multiline
            style={{ flex: 1, backgroundColor: T.bg3, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, color: T.text, fontSize: 13, maxHeight: 100 }}
          />
          <TouchableOpacity
            onPress={() => send()}
            disabled={!contextReady || sending || !input.trim()}
            style={{ backgroundColor: T.accent, borderRadius: 10, paddingHorizontal: 16, justifyContent: 'center', opacity: (!contextReady || sending || !input.trim()) ? 0.5 : 1 }}
          >
            <Text style={{ color: '#fff', fontWeight: '700' }}>Send</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
