import React from 'react';
import { View, Text, ScrollView, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';

const ITEMS = [
  { route: 'OptionsStrategy', icon: '🎯', title: 'Options Strategy Builder', desc: 'Multi-leg payoffs, live Greeks' },
  { route: 'Portfolio', icon: '📁', title: 'Portfolio', desc: 'Real holdings from Angel One' },
  { route: 'Correlation', icon: '🔗', title: 'Correlation Matrix', desc: 'Spot hidden concentration risk' },
  { route: 'Calendar', icon: '📅', title: 'Economic Calendar', desc: 'Upcoming macro events' },
  { route: 'MultiChart', icon: '🗂️', title: 'Multi-Chart Layout', desc: 'Watch 4 markets at once' },
  { route: 'Screener', icon: '🔍', title: 'Strategy Screener', desc: 'Scan for setups + voice summary' },
  { route: 'Backtest', icon: '📉', title: 'Backtesting', desc: 'Prove whether the strategy has an edge' },
  { route: 'Verification', icon: '🔬', title: 'Verification & Stress Test', desc: 'Benchmarks, Monte Carlo, regime & stability checks' },
  { route: 'ProductionEval', icon: '📡', title: 'Production Model Evaluation', desc: 'Real BTC/ETH/SOL/BNB data — honest edge check' },
  { route: 'PaperTrading', icon: '🧪', title: 'Paper Trading', desc: 'Practice with live prices, zero real money' },
  { route: 'ScannerDashboard', icon: '📡', title: 'Scanner Dashboard', desc: 'Auto-scan your whole watchlist, not just one chart' },
  { route: 'Settings', icon: '⚙️', title: 'Settings', desc: 'API keys, theme, connections' },
];

export default function MoreMenuScreen({ navigation }: any) {
  const { theme: T } = useTheme();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        <Text style={{ color: T.text, fontSize: 22, fontWeight: '800', marginBottom: 4 }}>More</Text>
        <Text style={{ color: T.textDim, fontSize: 11, marginBottom: 16 }}>Advanced tools and configuration</Text>

        {ITEMS.map(item => (
          <TouchableOpacity
            key={item.route}
            onPress={() => navigation.navigate(item.route)}
            style={{
              flexDirection: 'row', alignItems: 'center', backgroundColor: T.card, borderWidth: 1, borderColor: T.cardBorder,
              borderRadius: 10, padding: 14, marginBottom: 10,
            }}
          >
            <Text style={{ fontSize: 26, marginRight: 14 }}>{item.icon}</Text>
            <View style={{ flex: 1 }}>
              <Text style={{ color: T.text, fontWeight: '700', fontSize: 14 }}>{item.title}</Text>
              <Text style={{ color: T.textDim, fontSize: 11, marginTop: 2 }}>{item.desc}</Text>
            </View>
            <Text style={{ color: T.textDim, fontSize: 16 }}>›</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}
