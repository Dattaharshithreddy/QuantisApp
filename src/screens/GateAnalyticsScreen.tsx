import React, { useState, useCallback, useEffect } from 'react';
import { View, Text, ScrollView, RefreshControl, TouchableOpacity, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useIsFocused } from '@react-navigation/native';
import { useTheme } from '../context/ThemeContext';
import { loadShadowTrades, dedupExistingShadowTrades, clearAllShadowTrades, computeGateAnalytics, GateStats, GateType } from '../utils/shadowTradeJournal';

const GATE_LABELS: Record<GateType, string> = {
  CONFIDENCE:         'Confidence Gate',
  REGIME:             'Regime Gate',
  PORTFOLIO_RISK:     'Portfolio Risk Gate',
  POSITION_SIZING:    'Position Sizing',      // risk budget too small for ATR stop
  DUPLICATE_POSITION: 'Duplicate Position',   // symbol already has an open position
  DUPLICATE:          'Duplicate Block',      // legacy — kept for old stored records
  CASH:               'Cash Gate',
  FILTER:             'Strategy Filter',
  OTHER:              'Other',
};
const GATE_COLORS: Record<GateType, string> = {
  CONFIDENCE:         '#F59E0B',
  REGIME:             '#8B5CF6',
  PORTFOLIO_RISK:     '#EF4444',
  POSITION_SIZING:    '#F97316',  // orange — sizing issue, not an AI decision
  DUPLICATE_POSITION: '#6B7280',
  DUPLICATE:          '#6B7280',  // legacy
  CASH:               '#EF4444',
  FILTER:             '#3B82F6',
  OTHER:              '#6B7280',
};

function BarRow({ label, value, max, color }: { label:string; value:number; max:number; color:string }) {
  const { theme: T } = useTheme();
  const pct = max > 0 ? value / max : 0;
  return (
    <View style={{ flexDirection:'row', alignItems:'center', marginBottom: 6, gap: 8 }}>
      <Text style={{ color: T.textDim, fontSize: 10, width: 90 }}>{label}</Text>
      <View style={{ flex:1, height: 8, backgroundColor: T.bg3, borderRadius: 4, overflow:'hidden' }}>
        <View style={{ width: `${pct*100}%`, height: 8, backgroundColor: color, borderRadius: 4 }} />
      </View>
      <Text style={{ color: T.text, fontSize: 10, fontWeight:'700', width: 36, textAlign:'right' }}>{value}</Text>
    </View>
  );
}

export default function GateAnalyticsScreen() {
  const { theme: T } = useTheme();
  const isFocused = useIsFocused();
  const [stats, setStats] = useState<GateStats[]>([]);
  const [totalTrades, setTotalTrades] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    await dedupExistingShadowTrades(); // idempotent pre-v6.3.36 duplicate cleanup
    const trades = await loadShadowTrades();
    setTotalTrades(trades.length);
    setStats(computeGateAnalytics(trades));
  }, []);

  useEffect(() => { load(); }, [load]);
  const onRefresh = useCallback(async () => {
    // Guard against iOS back-navigation overscroll triggering refresh
    if (!isFocused) return;
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load, isFocused]);

  const clearAnalytics = useCallback(() => {
    Alert.alert(
      'Reset Gate Analytics',
      'This will clear all shadow trade history and reset Gate Analytics to zero. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Reset', style: 'destructive', onPress: async () => {
          await clearAllShadowTrades();
          setStats([]); setTotalTrades(0);
        }},
      ]
    );
  }, []);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={T.accent} />}>
        <Text style={{ color: T.text, fontSize: 20, fontWeight: '800', marginBottom: 4 }}>Gate Analytics</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <Text style={{ color: T.textDim, fontSize: 11, flex: 1 }}>
            {totalTrades} blocked trades tracked · Which gates are helping vs hurting?
          </Text>
          <TouchableOpacity onPress={clearAnalytics}
            style={{ backgroundColor: T.red + '18', borderRadius: 6,
              paddingHorizontal: 10, paddingVertical: 5, marginLeft: 8,
              borderWidth: 1, borderColor: T.red + '44' }}>
            <Text style={{ color: T.red, fontSize: 10, fontWeight: '700' }}>🗑 Reset</Text>
          </TouchableOpacity>
        </View>
        {stats.length === 0 && (
          <View style={{ alignItems: 'center', paddingTop: 60 }}>
            <Text style={{ color: T.textDim, fontSize: 14 }}>No data yet</Text>
            <Text style={{ color: T.textDim, fontSize: 11, marginTop: 6, textAlign: 'center' }}>
              Shadow trades will appear here after gates block entries
            </Text>
          </View>
        )}
        {stats.map(s => {
          const col = GATE_COLORS[s.gate];
          const MIN_SAMPLE = 20; // minimum resolved trades for meaningful statistics
          const resolved = s.tpHit + s.slHit;
          const gateUseful = s.winRate < 50;
          const verdict = resolved < MIN_SAMPLE
            ? `⏳ Need ${MIN_SAMPLE - resolved} more resolved trades (${resolved}/${MIN_SAMPLE})`
            : gateUseful
              ? `✓ Gate is useful — blocked ${(100-s.winRate).toFixed(0)}% losers`
              : `⚠ Gate may be too strict — blocked ${s.winRate.toFixed(0)}% winners`;
          const verdictColor = resolved < MIN_SAMPLE ? T.textDim : gateUseful ? T.green : '#F59E0B';
          return (
            <View key={s.gate} style={{ backgroundColor: T.bg2, borderRadius: 12, padding: 14, marginBottom: 12, borderLeftWidth: 3, borderLeftColor: col }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <Text style={{ color: col, fontSize: 13, fontWeight: '800' }}>{GATE_LABELS[s.gate]}</Text>
                <Text style={{ color: T.textDim, fontSize: 11 }}>{s.blocked} blocked</Text>
              </View>
              <BarRow label="TP Hit (AI right)" value={s.tpHit} max={s.blocked} color={T.red} />
              <BarRow label="SL Hit (gate right)" value={s.slHit} max={s.blocked} color={T.green} />
              <BarRow label="Expired" value={s.expired} max={s.blocked} color={T.textDim} />
              <BarRow label="Still Open" value={s.stillOpen} max={s.blocked} color={T.accent} />
              <View style={{ flexDirection: 'row', gap: 12, marginTop: 8, marginBottom: 8 }}>
                <View style={{ flex:1, backgroundColor: T.bg3, borderRadius: 8, padding: 8, alignItems: 'center' }}>
                  <Text style={{ color: T.textDim, fontSize: 9 }}>Win Rate (if opened)</Text>
                  <Text style={{ color: resolved < MIN_SAMPLE ? T.textDim : s.winRate >= 50 ? T.red : T.green, fontSize: 14, fontWeight: '800' }}>{resolved < MIN_SAMPLE ? '?' : `${s.winRate}%`}</Text>
                  <Text style={{ color: T.textDim, fontSize: 8 }}>of resolved trades</Text>
                </View>
                <View style={{ flex:1, backgroundColor: T.bg3, borderRadius: 8, padding: 8, alignItems: 'center' }}>
                  <Text style={{ color: T.textDim, fontSize: 9 }}>Profit Factor</Text>
                  <Text style={{ color: resolved < MIN_SAMPLE ? T.textDim : T.text, fontSize: 14, fontWeight: '800' }}>{resolved < MIN_SAMPLE ? '?' : s.profitFactor === Infinity ? '∞' : s.profitFactor}</Text>
                  <Text style={{ color: T.textDim, fontSize: 8 }}>if gate disabled</Text>
                </View>
                <View style={{ flex:1, backgroundColor: T.bg3, borderRadius: 8, padding: 8, alignItems: 'center' }}>
                  <Text style={{ color: T.textDim, fontSize: 9 }}>Avg P&L</Text>
                  <Text style={{ color: resolved < MIN_SAMPLE ? T.textDim : s.avgPnlPct >= 0 ? T.green : T.red, fontSize: 14, fontWeight: '800' }}>{resolved < MIN_SAMPLE ? '?' : `${s.avgPnlPct >= 0 ? '+' : ''}${s.avgPnlPct}%`}</Text>
                  <Text style={{ color: T.textDim, fontSize: 8 }}>per blocked trade</Text>
                </View>
              </View>
              <View style={{ backgroundColor: verdictColor+'18', borderRadius: 8, padding: 8 }}>
                <Text style={{ color: verdictColor, fontSize: 10, fontWeight: '700' }}>{verdict}</Text>
              </View>
            </View>
          );
        })}
        {stats.length > 0 && (
          <View style={{ backgroundColor: T.bg3, borderRadius: 10, padding: 12, marginTop: 4 }}>
            <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', letterSpacing: 0.5, marginBottom: 6 }}>HOW TO READ THIS</Text>
            <Text style={{ color: T.textDim, fontSize: 10, lineHeight: 16 }}>
              {'Win Rate = % of blocked trades that would have hit TP. If > 50%: gate blocked winners — consider relaxing. If < 50%: gate blocked losers — keep it. Profit Factor > 1 (if gate disabled) means gate costs you more than it saves.'}
            </Text>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
