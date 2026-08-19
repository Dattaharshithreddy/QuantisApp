import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator } from 'react-native';
// RNGH ScrollView: chart inside uses GestureDetector — RN ScrollView crashes on Android
import { ScrollView } from 'react-native-gesture-handler';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useData } from '../context/DataContext';
import { Candle, pFmt } from '../utils/indicators';
import { fetchBnKlines } from '../api/binance';
import { aoCandles } from '../api/angelOne';
import CandlestickChart from '../components/chart/ChartAdapter';
import { Pill } from '../components/Common';
import { fetchCandlesWithCache } from '../utils/candleCache';

const DEFAULT_SLOTS = ['NIFTY50', 'BANKNIFTY', 'BTCUSD', 'EURUSD'];

export default function MultiChartScreen({ navigation }: any) {
  const { theme: T } = useTheme();
  const { prices, aoSession, allAssets } = useData();
  const [slots, setSlots] = useState<string[]>(DEFAULT_SLOTS);
  const [pickerSlot, setPickerSlot] = useState<number | null>(null);
  const [candleData, setCandleData] = useState<Record<string, Candle[]>>({});
  const [srcStatus, setSrcStatus] = useState<Record<string, 'live' | 'none'>>({});
  const [loading, setLoading] = useState(true);

  const loadAll = useCallback(async () => {
    setLoading(true);
    const next: Record<string, Candle[]> = {};
    const status: Record<string, 'live' | 'none'> = {};
    for (const sym of slots) {
      const asset = allAssets.find(a => a.symbol === sym);
      if (!asset) continue;
      try {
        if (asset.src === 'binance' && asset.bnSym) {
          const bnSym = asset.bnSym;
          next[sym] = await fetchCandlesWithCache(sym, '15m',
            async () => fetchBnKlines(bnSym, '15m'), { skipApiIfFresh: true }); status[sym] = 'live';
        } else if ((asset.src === 'ao' || asset.src === 'ao_futures') && aoSession?.jwtToken && asset.aoToken && asset.aoEx) {
          const { aoToken, aoEx } = asset; const sess = aoSession;
          next[sym] = await fetchCandlesWithCache(sym, '15m',
            async () => aoCandles(aoToken, aoEx, '15m', sess), { skipApiIfFresh: true }); status[sym] = 'live';
        }
        else { next[sym] = []; status[sym] = 'none'; }
      } catch (_) {
        next[sym] = [];
        status[sym] = 'none';
      }
    }
    setCandleData(next);
    setSrcStatus(status);
    setLoading(false);
  }, [slots, aoSession?.jwtToken]);

  useEffect(() => { loadAll(); }, [loadAll]);


  function selectSymbol(sym: string) {
    if (pickerSlot == null) return;
    const next = [...slots];
    next[pickerSlot] = sym;
    setSlots(next);
    setPickerSlot(null);
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      <ScrollView contentContainerStyle={{ padding: 12, paddingBottom: 40 }}>
        <Text style={{ color: T.text, fontSize: 22, fontWeight: '800', marginBottom: 4, paddingHorizontal: 4 }}>Multi-Chart</Text>
        <Text style={{ color: T.textDim, fontSize: 11, marginBottom: 14, paddingHorizontal: 4 }}>Tap a chart's symbol to swap it</Text>

        {loading && <ActivityIndicator color={T.blue} style={{ marginVertical: 30 }} />}

        {!loading && slots.map((sym, idx) => {
          const asset = allAssets.find(a => a.symbol === sym);
          const p = prices[sym];
          const pos = (p?.chg || 0) >= 0;
          return (
            <View key={idx} style={{ marginBottom: 16 }}>
              <TouchableOpacity onPress={() => setPickerSlot(idx)} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 8, marginBottom: 6 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={{ color: T.text, fontWeight: '700', fontSize: 13 }}>{sym}</Text>
                  <View style={{ paddingHorizontal: 6, paddingVertical: 1, borderRadius: 3, backgroundColor: srcStatus[sym] === 'live' ? T.green + '20' : T.textDim + '20' }}>
                    <Text style={{ color: srcStatus[sym] === 'live' ? T.green : T.textDim, fontSize: 9, fontWeight: '800' }}>{srcStatus[sym] === 'live' ? 'LIVE' : 'NO DATA'}</Text>
                  </View>
                  <Text style={{ color: T.textDim, fontSize: 9 }}>▼ tap to change</Text>
                </View>
                {p && p.chg != null && <Text style={{ color: pos ? T.green : T.red, fontWeight: '700', fontSize: 13 }}>{pFmt(p.price)} ({pos ? '+' : ''}{p.chg.toFixed(2)}%)</Text>}
              </TouchableOpacity>
              <CandlestickChart key={sym} data={candleData[sym] || []} theme={T} showMA height={190} />
            </View>
          );
        })}
      </ScrollView>

      {pickerSlot != null && (
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#00000090', justifyContent: 'center', padding: 20 }}>
          <View style={{ backgroundColor: T.bg1, borderRadius: 12, padding: 16, maxHeight: '70%' }}>
            <Text style={{ color: T.text, fontWeight: '700', fontSize: 15, marginBottom: 12 }}>Choose symbol for slot {pickerSlot + 1}</Text>
            <ScrollView>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {allAssets.map(a => <Pill key={a.symbol} label={a.symbol} color={T.blue} active={slots[pickerSlot] === a.symbol} onPress={() => selectSymbol(a.symbol)} />)}
              </View>
            </ScrollView>
            <TouchableOpacity onPress={() => setPickerSlot(null)} style={{ marginTop: 14, padding: 10, backgroundColor: T.bg3, borderRadius: 8, alignItems: 'center' }}>
              <Text style={{ color: T.textSub, fontWeight: '700' }}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </SafeAreaView>
  );
}
