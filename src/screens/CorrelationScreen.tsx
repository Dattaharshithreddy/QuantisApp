import React, { useState, useCallback } from 'react';
import { View, Text, ScrollView, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useData } from '../context/DataContext';
import { Card, SectionLabel, PrimaryButton, Pill } from '../components/Common';
import { Candle } from '../utils/indicators';
import { fetchBnKlines } from '../api/binance';
import { fetchAVKlines } from '../api/alphaVantage';
import { aoCandles } from '../api/angelOne';
import { buildCorrelationMatrix, correlationColor } from '../utils/correlation';
import { fetchCandlesWithCache } from '../utils/candleCache';

const DEFAULT_SET = ['NIFTY50', 'BANKNIFTY', 'BTCUSD', 'ETHUSD', 'USDINR', 'AAPL'];

export default function CorrelationScreen() {
  const { theme: T } = useTheme();
  const { aoSession, allAssets, avKey } = useData();
  const [selected, setSelected] = useState<string[]>(DEFAULT_SET);
  const [loading, setLoading] = useState(false);
  const [matrix, setMatrix] = useState<{ symbols: string[]; matrix: number[][] } | null>(null);
  const [skippedSyms, setSkippedSyms] = useState<string[]>([]);

  function toggleSymbol(sym: string) {
    setSelected(prev => prev.includes(sym) ? prev.filter(s => s !== sym) : prev.length < 8 ? [...prev, sym] : prev);
  }

  // FIXED: previously, any symbol with no live connection got fabricated
  // candles so the matrix always "worked" — now it's skipped entirely and
  // listed honestly, since a correlation built on fake data is worse than
  // useless, it's actively misleading.
  const compute = useCallback(async () => {
    setLoading(true);
    const candleMap: Record<string, Candle[]> = {};
    const skipped: string[] = [];
    for (const sym of selected) {
      const asset = allAssets.find(a => a.symbol === sym);
      if (!asset) { skipped.push(sym); continue; }
      try {
        if (asset.src === 'binance' && asset.bnSym) {
          const bnSym = asset.bnSym;
          candleMap[sym] = await fetchCandlesWithCache(sym, '1h',
            async () => fetchBnKlines(bnSym, '1h'), { skipApiIfFresh: true });
        } else if (asset.src === 'ao' && aoSession?.jwtToken && asset.aoToken && asset.aoEx) {
          const { aoToken, aoEx } = asset; const sess = aoSession;
          candleMap[sym] = await fetchCandlesWithCache(sym, '1h',
            async () => aoCandles(aoToken, aoEx, '1h', sess), { skipApiIfFresh: true });
        }
        else if (asset.src === 'av' && asset.avSym && avKey) candleMap[sym] = await fetchAVKlines(asset.avSym, '1h', avKey);
        else { skipped.push(sym); continue; }
      } catch (_) {
        skipped.push(sym);
      }
    }
    setMatrix(Object.keys(candleMap).length >= 2 ? buildCorrelationMatrix(candleMap) : null);
    setSkippedSyms(skipped);
    setLoading(false);
  }, [selected, aoSession?.jwtToken]);

  const CELL = 44;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        <Text style={{ color: T.text, fontSize: 22, fontWeight: '800', marginBottom: 4 }}>Correlation Matrix</Text>
        <Text style={{ color: T.textDim, fontSize: 11, marginBottom: 16 }}>See how your assets move together — avoid hidden concentration risk</Text>

        <Text style={{ color: T.textDim, fontSize: 10, marginBottom: 6 }}>SELECT UP TO 8 ASSETS</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 14 }}>
          <View style={{ flexDirection: 'row', gap: 6 }}>
            {allAssets.map(a => (
              <Pill key={a.symbol} label={a.symbol} color={T.blue} active={selected.includes(a.symbol)} onPress={() => toggleSymbol(a.symbol)} />
            ))}
          </View>
        </ScrollView>

        <PrimaryButton theme={T} label={loading ? 'COMPUTING...' : 'COMPUTE CORRELATION'} onPress={compute} disabled={loading || selected.length < 2} />

        {loading && <ActivityIndicator color={T.blue} style={{ marginTop: 20 }} />}

        {!loading && skippedSyms.length > 0 && (
          <Text style={{ color: T.amber, fontSize: 10, marginTop: 12, lineHeight: 15 }}>
            ⚠ Skipped (no live connection): {skippedSyms.join(', ')} — connect Angel One or add an Alpha Vantage key in Settings to include these.
          </Text>
        )}

        {!loading && !matrix && skippedSyms.length === selected.length && selected.length > 0 && (
          <Text style={{ color: T.textDim, fontSize: 12, textAlign: 'center', marginTop: 20 }}>
            None of the selected assets have a live connection right now — nothing to correlate.
          </Text>
        )}

        {matrix && !loading && (
          <Card theme={T} style={{ marginTop: 16 }}>
            <SectionLabel theme={T}>1-HOUR RETURNS CORRELATION (last ~150 bars)</SectionLabel>
            <ScrollView horizontal>
              <View>
                {/* Header row */}
                <View style={{ flexDirection: 'row' }}>
                  <View style={{ width: CELL }} />
                  {matrix.symbols.map(s => (
                    <View key={s} style={{ width: CELL, alignItems: 'center', justifyContent: 'center' }}>
                      <Text style={{ color: T.textDim, fontSize: 9, transform: [{ rotate: '-45deg' }] }}>{s.slice(0, 6)}</Text>
                    </View>
                  ))}
                </View>
                {/* Matrix rows */}
                {matrix.symbols.map((rowSym, i) => (
                  <View key={rowSym} style={{ flexDirection: 'row' }}>
                    <View style={{ width: CELL, justifyContent: 'center' }}>
                      <Text style={{ color: T.textSub, fontSize: 8, fontWeight: '700' }}>{rowSym.slice(0, 8)}</Text>
                    </View>
                    {matrix.matrix[i].map((v, j) => (
                      <View key={j} style={{ width: CELL, height: CELL, backgroundColor: correlationColor(v), justifyContent: 'center', alignItems: 'center', borderWidth: 0.5, borderColor: T.bg0 }}>
                        <Text style={{ color: '#fff', fontSize: 9, fontWeight: '700' }}>{v.toFixed(2)}</Text>
                      </View>
                    ))}
                  </View>
                ))}
              </View>
            </ScrollView>
            <Text style={{ color: T.textDim, fontSize: 9, marginTop: 12, lineHeight: 14 }}>
              Green = move together (correlated risk). Red = move oppositely (natural hedge). Values near zero = independent.
              High correlation across your open positions means you're effectively making one big bet, not several diversified ones.
            </Text>
          </Card>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
