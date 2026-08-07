import React, { useState, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useData } from '../context/DataContext';
import { Card, PrimaryButton } from '../components/Common';
import { Candle, pFmt } from '../utils/indicators';
import { fetchBnKlines } from '../api/binance';
import { aoCandles } from '../api/angelOne';
import { fetchAVKlines } from '../api/alphaVantage';
import { screenAssets, SIGNAL_META, ScreenResult } from '../utils/screener';
import { speakSummary, stopSpeaking, buildMarketSummarySpeech } from '../utils/voice';
import { fetchCandlesWithCache } from '../utils/candleCache';

export default function ScreenerScreen() {
  const { theme: T } = useTheme();
  const { prices, aoSession, allAssets, avKey } = useData();
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<ScreenResult[]>([]);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [skippedCount, setSkippedCount] = useState(0);
  const [totalEligible, setTotalEligible] = useState(0);
  const SCAN_CAP = 14;

  // FIXED: previously skipped a real connection check and fabricated candles
  // for anything without one, then quietly counted that as "simulated" —
  // now those assets are skipped entirely from the scan, never fed fake data.
  const runScreener = useCallback(async () => {
    setLoading(true);
    const candleMap: Record<string, Candle[]> = {};
    let skipped = 0;
    const allEligible = allAssets.filter(a => a.src === 'binance' || a.src === 'coindcx' || a.src === 'ao' || a.src === 'ao_futures' || a.src === 'av');
    setTotalEligible(allEligible.length);
    const scannable = allEligible.slice(0, SCAN_CAP);
    const scanSet: typeof scannable = [];
    for (const a of scannable) {
      try {
        if (a.src === 'binance' && a.bnSym) {
          const bnSym = a.bnSym;
          candleMap[a.symbol] = await fetchCandlesWithCache(a.symbol, '1h',
            async () => fetchBnKlines(bnSym, '1h'), { skipApiIfFresh: true }); scanSet.push(a);
        } else if ((a.src === 'ao' || a.src === 'ao_futures') && aoSession?.jwtToken && a.aoToken && a.aoEx) {
          const { aoToken, aoEx } = a; const sess = aoSession;
          candleMap[a.symbol] = await fetchCandlesWithCache(a.symbol, '1h',
            async () => aoCandles(aoToken, aoEx, '1h', sess), { skipApiIfFresh: true }); scanSet.push(a);
        } else if (a.src === 'av' && a.avSym && avKey) {
          const avSym = a.avSym; const key = avKey;
          candleMap[a.symbol] = await fetchCandlesWithCache(a.symbol, '1h',
            async () => fetchAVKlines(avSym, '1h', key), { skipApiIfFresh: true }); scanSet.push(a);
        }
        else skipped++;
      } catch (_) {
        skipped++;
      }
    }
    setResults(screenAssets(candleMap, scanSet));
    setSkippedCount(skipped);
    setLoading(false);
  }, [prices, aoSession?.jwtToken, avKey]);

  function handleSpeak(r: ScreenResult) {
    if (speakingId === r.symbol) { stopSpeaking(); setSpeakingId(null); return; }
    const trend = r.signal === 'ABOVE_MA' ? 'bullish' : r.signal === 'BELOW_MA' ? 'bearish' : 'mixed';
    const chg = prices[r.symbol]?.chg || 0;
    const text = buildMarketSummarySpeech({ symbol: r.symbol, price: r.price, chgPct: chg, rsi: r.rsi, trend });
    speakSummary(text);
    setSpeakingId(r.symbol);
    setTimeout(() => setSpeakingId(null), 8000);
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        <Text style={{ color: T.text, fontSize: 22, fontWeight: '800', marginBottom: 4 }}>Strategy Screener</Text>
        <Text style={{ color: T.textDim, fontSize: 11, marginBottom: 16 }}>Scan all watched assets for actionable technical setups · tap 🔊 for a voice summary</Text>

        <PrimaryButton theme={T} label={loading ? 'SCANNING...' : 'RUN SCREENER'} onPress={runScreener} disabled={loading} />

        {/* Always show scan scope so the user knows exactly what is covered */}
        {totalEligible > 0 && !loading && (
          <Text style={{ color: T.textDim, fontSize: 9, marginTop: 6, lineHeight: 14, textAlign: 'center' }}>
            {totalEligible > SCAN_CAP
              ? `Scanning first ${SCAN_CAP} of ${totalEligible} eligible assets`
              : `Scanning all ${totalEligible} eligible asset${totalEligible !== 1 ? 's' : ''}`}
            {skippedCount > 0 ? ` · ${skippedCount} skipped (no live connection)` : ''}
          </Text>
        )}

        {loading && <ActivityIndicator color={T.blue} style={{ marginTop: 20 }} />}

        {!loading && results.length === 0 && (
          <Text style={{ color: T.textDim, fontSize: 12, textAlign: 'center', marginTop: 30 }}>
            No setups found yet — tap "Run Screener" to scan for oversold/overbought conditions and trend breaks across your watchlist.
          </Text>
        )}

        {results.map(r => {
          const meta = SIGNAL_META[r.signal];
          return (
            <Card key={r.symbol} theme={T} style={{ marginBottom: 8 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: T.text, fontWeight: '700', fontSize: 14 }}>{r.symbol}</Text>
                  <Text style={{ color: meta.color, fontSize: 11, fontWeight: '700', marginTop: 3 }}>{meta.label}</Text>
                  <Text style={{ color: T.textDim, fontSize: 10, marginTop: 2 }}>{r.detail} · Price {pFmt(r.price)}</Text>
                </View>
                <TouchableOpacity onPress={() => handleSpeak(r)} style={{ padding: 10, backgroundColor: speakingId === r.symbol ? T.accent + '30' : T.bg3, borderRadius: 20 }}>
                  <Text style={{ fontSize: 16 }}>{speakingId === r.symbol ? '⏸' : '🔊'}</Text>
                </TouchableOpacity>
              </View>
            </Card>
          );
        })}
      </ScrollView>
    </SafeAreaView>
  );
}
