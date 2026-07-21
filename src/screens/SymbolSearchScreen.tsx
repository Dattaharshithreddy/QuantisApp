import React, { useState, useCallback } from 'react';
import { View, Text, TextInput, ScrollView, TouchableOpacity, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useData } from '../context/DataContext';
import { Pill } from '../components/Common';
import { Asset, TYPE_COLORS } from '../api/assets';
import { searchBinance, searchNSE, searchAlphaVantage, searchForex } from '../api/symbolSearch';
import { fetchForexRates } from '../api/forex';

const MARKETS = [
  { key: 'crypto', label: '🪙 Crypto', color: '#9c27b0' },
  { key: 'nse', label: '🇮🇳 NSE Stocks/Index', color: '#089981' },
  { key: 'us', label: '🇺🇸 US Stocks', color: '#2962ff' },
  { key: 'forex', label: '💱 Forex', color: '#ff9800' },
] as const;

export default function SymbolSearchScreen({ navigation, route }: any) {
  const { theme: T } = useTheme();
  const { addAsset, avKey } = useData();
  const returnTo = route?.params?.returnTo || 'Chart';
  const [market, setMarket] = useState<typeof MARKETS[number]['key']>('crypto');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const runSearch = useCallback(async (q: string, m: typeof market) => {
    if (q.trim().length < 1) { setResults([]); return; }
    setLoading(true); setErr('');
    try {
      let r: Asset[] = [];
      if (m === 'crypto') r = await searchBinance(q);
      else if (m === 'nse') r = await searchNSE(q);
      else if (m === 'us') {
        if (!avKey) { setErr('Add an Alpha Vantage key in Settings to search US stocks.'); setLoading(false); return; }
        r = await searchAlphaVantage(q, avKey);
      } else if (m === 'forex') {
        const rates = await fetchForexRates();
        r = searchForex(q, rates);
      }
      setResults(r);
      if (!r.length) setErr('No matches found.');
    } catch (e: any) {
      setErr(e.message);
      setResults([]);
    }
    setLoading(false);
  }, [avKey]);

  function handleQueryChange(text: string) {
    setQuery(text);
    runSearch(text, market);
  }
  function handleMarketChange(m: typeof market) {
    setMarket(m);
    setResults([]);
    if (query.trim()) runSearch(query, m);
  }

  async function handlePick(asset: Asset) {
    await addAsset(asset);
    navigation.navigate('MainTabs', { screen: returnTo, params: { symbol: asset.symbol } });
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      <View style={{ padding: 16, borderBottomWidth: 1, borderBottomColor: T.border }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <Text style={{ color: T.text, fontSize: 18, fontWeight: '800' }}>Search Any Symbol</Text>
          <TouchableOpacity onPress={() => navigation.goBack()}>
            <Text style={{ color: T.textSub, fontSize: 14 }}>Close</Text>
          </TouchableOpacity>
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {MARKETS.map(m => (
              <Pill key={m.key} label={m.label} color={m.color} active={market === m.key} onPress={() => handleMarketChange(m.key)} />
            ))}
          </View>
        </ScrollView>

        <TextInput
          value={query}
          onChangeText={handleQueryChange}
          placeholder={
            market === 'crypto' ? 'e.g. SOL, DOGE, AVAX...' :
            market === 'nse' ? 'e.g. ITC, ADANIENT, HDFC...' :
            market === 'us' ? 'e.g. AMZN, META, GOOG...' : 'e.g. AED, SGD, CNY...'
          }
          placeholderTextColor={T.textDim}
          autoFocus
          style={{ backgroundColor: T.bg3, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 12, color: T.text, fontSize: 15 }}
        />
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        {loading && <ActivityIndicator color={T.blue} style={{ marginTop: 20 }} />}
        {!loading && err && <Text style={{ color: T.amber, fontSize: 12, textAlign: 'center', marginTop: 20 }}>{err}</Text>}
        {!loading && !err && query.length === 0 && (
          <Text style={{ color: T.textDim, fontSize: 12, textAlign: 'center', marginTop: 30, lineHeight: 18 }}>
            Search any of 2000+ crypto pairs, every NSE-listed stock and index, any global stock (with an Alpha Vantage key), or any currency pair.{'\n\n'}
            Tap a result to add it to your watchlist and open its chart — live data starts immediately if a connection exists for that source.
          </Text>
        )}

        {results.map((a, i) => (
          <TouchableOpacity key={a.symbol + i} onPress={() => handlePick(a)} style={{
            flexDirection: 'row', alignItems: 'center', backgroundColor: T.card, borderWidth: 1, borderColor: T.cardBorder,
            borderRadius: 8, padding: 12, marginBottom: 8,
          }}>
            <View style={{ width: 4, height: 32, borderRadius: 2, backgroundColor: TYPE_COLORS[a.type], marginRight: 12 }} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: T.text, fontWeight: '700', fontSize: 14 }}>{a.symbol}</Text>
              <Text style={{ color: T.textDim, fontSize: 11, marginTop: 2 }}>{a.name}</Text>
            </View>
            <Text style={{ color: T.textDim, fontSize: 16 }}>+</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}
