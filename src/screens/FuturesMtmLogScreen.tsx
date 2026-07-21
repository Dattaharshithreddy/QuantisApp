// FuturesMtmLogScreen — daily MTM settlement history and realised P&L
import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { getMtmLog, getFuturesPortfolio } from '../utils/futures/futuresPortfolio';
import { MtmSettlement } from '../utils/futures/futuresTypes';
import { SPACING } from '../theme/colors';

function fmt(ts: number): string {
  const d = new Date(ts);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
}

export default function FuturesMtmLogScreen() {
  const { theme: T } = useTheme();
  const [log,       setLog]       = useState<MtmSettlement[]>([]);
  const [portfolio, setPortfolio] = useState<any>(null);
  const [loading,   setLoading]   = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const [l, p] = await Promise.all([getMtmLog(), getFuturesPortfolio()]);
    setLog(l);
    setPortfolio(p);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const totalMtm = log.reduce((s, e) => s + e.pnlForDay, 0);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      <ScrollView contentContainerStyle={{ padding: SPACING.md, paddingBottom: 40 }}
>

        <Text style={{ color: T.text, fontSize: 22, fontWeight: '800', marginBottom: 4 }}>
          MTM Settlement Log
        </Text>
        <Text style={{ color: T.textDim, fontSize: 11, marginBottom: 16, lineHeight: 16 }}>
          NSE futures P&L is settled daily at 3:30pm. Each day's gain or loss is credited/debited to
          your margin account regardless of whether you close the position.
        </Text>

        {/* Summary */}
        <View style={{ backgroundColor: T.card, borderRadius: 10, padding: 14,
          borderWidth: 1, borderColor: T.border, marginBottom: 16 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-around' }}>
            <View style={{ alignItems: 'center' }}>
              <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700' }}>TOTAL MTM SETTLED</Text>
              <Text style={{ color: totalMtm >= 0 ? T.green : T.red, fontSize: 16, fontWeight: '800', marginTop: 4 }}>
                {totalMtm >= 0 ? '+' : ''}₹{totalMtm.toFixed(0)}
              </Text>
            </View>
            <View style={{ width: 1, backgroundColor: T.border }} />
            <View style={{ alignItems: 'center' }}>
              <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700' }}>REALISED P&L</Text>
              <Text style={{ color: (portfolio?.totalRealizedPnL ?? 0) >= 0 ? T.green : T.red,
                fontSize: 16, fontWeight: '800', marginTop: 4 }}>
                {(portfolio?.totalRealizedPnL ?? 0) >= 0 ? '+' : ''}₹{(portfolio?.totalRealizedPnL ?? 0).toFixed(0)}
              </Text>
            </View>
            <View style={{ width: 1, backgroundColor: T.border }} />
            <View style={{ alignItems: 'center' }}>
              <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700' }}>SETTLEMENTS</Text>
              <Text style={{ color: T.text, fontSize: 16, fontWeight: '800', marginTop: 4 }}>{log.length}</Text>
            </View>
          </View>
        </View>

        {/* Explainer */}
        <View style={{ backgroundColor: T.bg3, borderRadius: 8, padding: 12, marginBottom: 16 }}>
          <Text style={{ color: T.textDim, fontSize: 9, lineHeight: 14 }}>
            <Text style={{ fontWeight: '700', color: T.text }}>How MTM works: </Text>
            Every trading day, NSE computes the settlement price (usually the weighted average price
            in the last 30 minutes). If the price moved in your favour, the difference is credited
            to your account. If it moved against you, it is debited. The next day's P&L is computed
            from this settlement price, not your original entry.
          </Text>
        </View>

        {log.length === 0 && !loading && (
          <View style={{ alignItems: 'center', paddingTop: 30 }}>
            <Text style={{ color: T.textDim, fontSize: 13 }}>No MTM settlements yet</Text>
            <Text style={{ color: T.textDim, fontSize: 11, marginTop: 4, textAlign: 'center' }}>
              Open a futures position and hold it past 3:30pm to see daily MTM entries here.
            </Text>
          </View>
        )}

        {log.map((entry, i) => (
          <View key={i} style={{ backgroundColor: T.card, borderRadius: 8, padding: 12,
            marginBottom: 8, borderWidth: 1, borderColor: T.border,
            borderLeftWidth: 3, borderLeftColor: entry.pnlForDay >= 0 ? T.green : T.red }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
              <Text style={{ color: T.textDim, fontSize: 9 }}>{fmt(entry.settledAt)}</Text>
              <Text style={{ color: entry.pnlForDay >= 0 ? T.green : T.red,
                fontSize: 13, fontWeight: '800' }}>
                {entry.pnlForDay >= 0 ? '+' : ''}₹{entry.pnlForDay.toFixed(0)}
              </Text>
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text style={{ color: T.textDim, fontSize: 9 }}>
                Settle price: ₹{entry.settlePrice.toFixed(2)}
              </Text>
              <Text style={{ color: T.textDim, fontSize: 9 }}>
                Cumulative: ₹{entry.cumulativeMtm.toFixed(0)}
              </Text>
            </View>
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}
