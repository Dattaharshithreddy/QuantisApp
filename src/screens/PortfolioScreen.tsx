import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, ScrollView, ActivityIndicator, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useData } from '../context/DataContext';
import { Card, SectionLabel, StatBox } from '../components/Common';
import { aoHoldings, Holding } from '../api/angelOne';

export default function PortfolioScreen() {
  const { theme: T } = useTheme();
  const { aoSession } = useData();
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!aoSession?.jwtToken) return;
    setLoading(true); setErr('');
    try {
      const h = await aoHoldings(aoSession);
      setHoldings(h);
    } catch (e: any) { setErr(e.message); }
    setLoading(false);
  }, [aoSession?.jwtToken]);

  useEffect(() => { load(); }, [load]);

  async function onRefresh() { setRefreshing(true); await load(); setRefreshing(false); }

  const totalInvested = holdings.reduce((s, h) => s + h.avgPrice * h.quantity, 0);
  const totalCurrent = holdings.reduce((s, h) => s + h.ltp * h.quantity, 0);
  const totalPnL = totalCurrent - totalInvested;
  const totalPnLPct = totalInvested ? (totalPnL / totalInvested) * 100 : 0;

  if (!aoSession?.jwtToken) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 30 }}>
          <Text style={{ fontSize: 40, marginBottom: 14 }}>📁</Text>
          <Text style={{ color: T.text, fontSize: 16, fontWeight: '700', marginBottom: 8, textAlign: 'center' }}>Connect Angel One</Text>
          <Text style={{ color: T.textDim, fontSize: 12, textAlign: 'center', lineHeight: 18 }}>
            Your real holdings and live P&L will appear here once you connect your Angel One account in Settings.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={T.accent} />}
      >
        <Text style={{ color: T.text, fontSize: 22, fontWeight: '800', marginBottom: 4 }}>Portfolio</Text>
        <Text style={{ color: T.textDim, fontSize: 11, marginBottom: 16 }}>Live holdings from Angel One</Text>

        {loading && <ActivityIndicator color={T.orange} style={{ marginVertical: 20 }} />}
        {err && <Text style={{ color: T.red, fontSize: 12, marginBottom: 12 }}>⚠ {err}</Text>}

        {!loading && holdings.length > 0 && (
          <Card theme={T} style={{ marginBottom: 14 }}>
            <SectionLabel theme={T}>PORTFOLIO SUMMARY</SectionLabel>
            <View style={{ flexDirection: 'row' }}>
              <StatBox theme={T} label="INVESTED" value={`₹${totalInvested.toFixed(0)}`} />
              <StatBox theme={T} label="CURRENT VALUE" value={`₹${totalCurrent.toFixed(0)}`} />
            </View>
            <View style={{ alignItems: 'center', paddingTop: 8 }}>
              <Text style={{ color: totalPnL >= 0 ? T.green : T.red, fontSize: 26, fontWeight: '800' }}>
                {totalPnL >= 0 ? '+' : ''}₹{totalPnL.toFixed(0)}
              </Text>
              <Text style={{ color: totalPnL >= 0 ? T.green : T.red, fontSize: 12, marginTop: 2 }}>
                {totalPnLPct >= 0 ? '+' : ''}{totalPnLPct.toFixed(2)}%
              </Text>
            </View>
          </Card>
        )}

        {!loading && holdings.length === 0 && !err && (
          <Text style={{ color: T.textDim, fontSize: 12, textAlign: 'center', marginTop: 30 }}>No holdings found in your Angel One account.</Text>
        )}

        {holdings.map(h => (
          <Card key={h.symbol} theme={T} style={{ marginBottom: 8 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <View>
                <Text style={{ color: T.text, fontWeight: '700', fontSize: 14 }}>{h.symbol}</Text>
                <Text style={{ color: T.textDim, fontSize: 10, marginTop: 2 }}>Qty {h.quantity} · Avg ₹{h.avgPrice.toFixed(2)} · LTP ₹{h.ltp.toFixed(2)}</Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={{ color: h.pnl >= 0 ? T.green : T.red, fontWeight: '800', fontSize: 14 }}>{h.pnl >= 0 ? '+' : ''}₹{h.pnl.toFixed(0)}</Text>
                <Text style={{ color: h.pnl >= 0 ? T.green : T.red, fontSize: 10 }}>{h.pnlPct >= 0 ? '+' : ''}{h.pnlPct.toFixed(2)}%</Text>
              </View>
            </View>
          </Card>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}
