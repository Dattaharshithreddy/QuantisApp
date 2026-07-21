// LivePnLScreen — real money P&L summary (daily, weekly, all-time)
import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { getLivePortfolio } from '../utils/livePortfolio';
import { getOrderHistory } from './OrderHistoryScreen';
import { SPACING } from '../theme/colors';

function StatBox({ label, value, color, T }: any) {
  return (
    <View style={{ flex: 1, backgroundColor: T.card, borderRadius: 8, padding: 12,
      borderWidth: 1, borderColor: T.border, margin: 3, alignItems: 'center' }}>
      <Text style={{ color: T.textDim, fontSize: 8, fontWeight: '700', letterSpacing: 0.5, marginBottom: 4 }}>{label}</Text>
      <Text style={{ color: color ?? T.text, fontSize: 16, fontWeight: '800' }}>{value}</Text>
    </View>
  );
}

export default function LivePnLScreen() {
  const { theme: T } = useTheme();
  const [orders,    setOrders]    = useState<any[]>([]);
  const [portfolio, setPortfolio] = useState<any>(null);
  const [loading,   setLoading]   = useState(true);
  const [period,    setPeriod]    = useState<'today' | 'week' | 'all'>('today');

  const load = useCallback(async () => {
    setLoading(true);
    const [o, p] = await Promise.all([getOrderHistory(), getLivePortfolio()]);
    setOrders(o);
    setPortfolio(p);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const now = Date.now();
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const weekStart  = new Date(now - 7 * 24 * 3600 * 1000);

  const filterOrders = (o: any[]) => {
    if (period === 'today') return o.filter(x => x.placedAt >= todayStart.getTime());
    if (period === 'week')  return o.filter(x => x.placedAt >= weekStart.getTime());
    return o;
  };

  const filtered = filterOrders(orders.filter(o => o.status === 'FILLED' && o.pnl != null));
  const netPnL    = filtered.reduce((s,o) => s + o.pnl, 0);
  const wins      = filtered.filter(o => o.pnl > 0).length;
  const losses    = filtered.filter(o => o.pnl <= 0).length;
  const winRate   = filtered.length ? (wins / filtered.length) * 100 : 0;
  const grossWin  = filtered.filter(o => o.pnl > 0).reduce((s,o) => s + o.pnl, 0);
  const grossLoss = Math.abs(filtered.filter(o => o.pnl <= 0).reduce((s,o) => s + o.pnl, 0));
  const pf        = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  const totalFees = filtered.reduce((s,o) => s + (o.fees ?? 0), 0);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      <ScrollView contentContainerStyle={{ padding: SPACING.md, paddingBottom: 40 }}
>

        <Text style={{ color: T.text, fontSize: 22, fontWeight: '800', marginBottom: 16 }}>Live P&L</Text>

        {/* Period selector */}
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 16 }}>
          {(['today', 'week', 'all'] as const).map(p => (
            <TouchableOpacity key={p} onPress={() => setPeriod(p)}
              style={{ flex: 1, backgroundColor: period === p ? T.accent : T.bg3,
                borderRadius: 8, padding: 8, alignItems: 'center' }}>
              <Text style={{ color: period === p ? '#fff' : T.textDim, fontSize: 11, fontWeight: '700' }}>
                {p === 'today' ? 'Today' : p === 'week' ? '7 Days' : 'All Time'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Net P&L hero */}
        <View style={{ backgroundColor: T.card, borderRadius: 12, padding: 20,
          borderWidth: 1.5, borderColor: netPnL >= 0 ? T.green : T.red, marginBottom: 16, alignItems: 'center' }}>
          <Text style={{ color: T.textDim, fontSize: 10, fontWeight: '700', letterSpacing: 0.8, marginBottom: 4 }}>
            NET P&L ({period.toUpperCase()})
          </Text>
          <Text style={{ color: netPnL >= 0 ? T.green : T.red, fontSize: 32, fontWeight: '800' }}>
            {netPnL >= 0 ? '+' : ''}{netPnL.toFixed(2)}
          </Text>
          <Text style={{ color: T.textDim, fontSize: 10, marginTop: 4 }}>
            After estimated fees of {totalFees.toFixed(2)}
          </Text>
        </View>

        {/* Stats grid */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
          <StatBox label="TRADES"     value={filtered.length}                              T={T} />
          <StatBox label="WIN RATE"   value={`${winRate.toFixed(1)}%`}
            color={winRate >= 55 ? T.green : winRate >= 45 ? T.textSub : T.red} T={T} />
          <StatBox label="WINS"       value={wins}    color={T.green}  T={T} />
          <StatBox label="LOSSES"     value={losses}  color={T.red}    T={T} />
          <StatBox label="PROFIT FACTOR" value={pf === Infinity ? '∞' : pf.toFixed(2)}
            color={pf > 1.5 ? T.green : pf >= 1 ? T.textSub : T.red} T={T} />
          <StatBox label="TOTAL FEES" value={totalFees.toFixed(2)} color={T.textDim} T={T} />
        </View>

        {/* Open positions unrealised */}
        {portfolio?.openPositions?.length > 0 && (
          <View style={{ backgroundColor: T.card, borderRadius: 10, padding: 14,
            borderWidth: 1, borderColor: T.border, marginTop: 16 }}>
            <Text style={{ color: T.textDim, fontSize: 10, fontWeight: '700', marginBottom: 8 }}>
              OPEN POSITIONS (unrealised)
            </Text>
            <Text style={{ color: T.text, fontSize: 13 }}>
              {portfolio.openPositions.length} position(s) — check Live Positions for P&L
            </Text>
          </View>
        )}

        {filtered.length === 0 && (
          <View style={{ alignItems: 'center', paddingTop: 30 }}>
            <Text style={{ color: T.textDim, fontSize: 12 }}>No completed trades in this period</Text>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
