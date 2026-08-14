import React from 'react';
import { View, Text, ScrollView, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';

type MenuItem = { route: string; icon: string; title: string; desc: string };
type Section  = { heading: string; items: MenuItem[] };

const SECTIONS: Section[] = [
  {
    heading: 'TRADING',
    items: [
      { route: 'PaperTrading',      icon: '🧪', title: 'Paper Trading',         desc: 'Practice with live prices, zero risk' },
      { route: 'LivePositions',     icon: '🔴', title: 'Live Positions',         desc: 'Open real positions with live P&L' },
      { route: 'FuturesContract',   icon: '📋', title: 'NSE Futures',            desc: 'F&O — lot sizing, margin, daily MTM' },
      { route: 'BnFutures',         icon: '⚡', title: 'Crypto Futures',          desc: 'Perpetuals — leverage, funding rate, liquidation' },
      { route: 'OptionsStrategy',   icon: '🎯', title: 'Options Strategy',        desc: 'Multi-leg payoffs and Greeks' },
    ]},
  {
    heading: 'REVIEW & ANALYTICS',
    items: [
      { route: 'PortfolioRisk', icon: '🛡️', title: 'Portfolio Risk Manager', desc: 'Unified risk across all accounts — exposure, leverage, VaR, concentration' },
      { route: 'TradingCoach',          icon: '🧠', title: 'AI Trading Coach',        desc: 'What your trade history says about you' },
      { route: 'ShadowJournal',         icon: '🌑', title: 'Shadow Journal',          desc: 'Blocked trades — was the AI right?' },
      { route: 'GateAnalytics',         icon: '📊', title: 'Gate Analytics',          desc: 'Which gates help vs hurt your trading' },
      { route: 'MarketContextAnalytics',icon: '🌐', title: 'Context Analytics',       desc: 'Win rate by Fear & Greed, VIX, Sentiment' },
      { route: 'FuturesPositions',      icon: '📈', title: 'NSE Futures Positions',   desc: 'Open positions with live P&L and MTM' },
      { route: 'BnFuturesPositions',    icon: '📈', title: 'Crypto Futures Positions',desc: 'Perpetual positions with liquidation tracking' },
      { route: 'LivePnL',               icon: '💰', title: 'Live P&L',               desc: 'Real money performance — daily, weekly, all-time' },
      { route: 'OrderHistory',          icon: '📋', title: 'Order History',           desc: 'Every real order — fills, cancellations, P&L' },
    ]},
  {
    heading: 'RESEARCH TOOLS',
    items: [
      { route: 'Backtest',        icon: '📉', title: 'Backtesting',              desc: 'Prove whether the strategy has an edge' },
      { route: 'Verification',    icon: '🔬', title: 'Verification & Stress',    desc: 'Benchmarks, Monte Carlo, regime checks' },
      { route: 'ProductionEval',  icon: '📡', title: 'Production Evaluation',    desc: 'Real data — honest 5-step edge check' },
      { route: 'Screener',        icon: '🔍', title: 'Strategy Screener',        desc: 'Scan for setups + voice summary' },
      { route: 'ScannerDashboard',icon: '📡', title: 'Scanner Dashboard',        desc: 'Auto-scan your whole watchlist' },
    ]},
  {
    heading: 'MARKET TOOLS',
    items: [
      { route: 'MultiChart',   icon: '🗂️', title: 'Multi-Chart Layout',       desc: 'Watch 4 markets at once' },
      { route: 'Correlation',  icon: '🔗', title: 'Correlation Matrix',        desc: 'Spot hidden concentration risk' },
      { route: 'Calendar',     icon: '📅', title: 'Economic Calendar',         desc: 'Upcoming macro events' },
      { route: 'Portfolio',    icon: '📁', title: 'Portfolio',                 desc: 'Real holdings from Angel One' },
    ]},
  {
    heading: 'SYSTEM',
    items: [
      { route: 'HealthDashboard',     icon: '🩺', title: 'Health Dashboard',      desc: 'Broker status, WebSocket, reconciliation' },
      { route: 'PerformanceDashboard',icon: '⚡', title: 'System Performance',     desc: 'Prediction, order, and fill latency' },
      { route: 'OrderAudit',          icon: '🔍', title: 'Audit Trail',            desc: 'Full event timeline for every live order' },
      { route: 'Account',              icon: '👤', title: 'Account & Sync',         desc: 'Sign in with Google to sync data' },
      { route: 'BrokerConnection',    icon: '🔌', title: 'Broker Connection',      desc: 'Connect Angel One & Binance' },
      { route: 'LiveTradeSettings',   icon: '⚙️', title: 'Live Trade Settings',    desc: 'MANUAL/AUTO mode, limits, notifications' },
      { route: 'FuturesSettings',     icon: '⚙️', title: 'Futures Settings',       desc: 'Paper capital, account reset for F&O + crypto' },
      { route: 'FAQ',                 icon: '❓', title: 'Help & FAQ',             desc: 'How QUANTIS works — common questions answered' },
      { route: 'Settings',            icon: '⚙️', title: 'Settings',              desc: 'API keys, theme, connections' },
    ]},
];

export default function MoreMenuScreen({ navigation }: any) {
  const { theme: T } = useTheme();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 50 }}>
        <Text style={{ color: T.text, fontSize: 22, fontWeight: '800', marginBottom: 20 }}>
          More
        </Text>

        {SECTIONS.map(section => (
          <View key={section.heading} style={{ marginBottom: 24 }}>
            <Text style={{ color: T.textDim, fontSize: 10, fontWeight: '800',
              letterSpacing: 1.2, marginBottom: 10 }}>
              {section.heading}
            </Text>
            {section.items.map(item => (
              <TouchableOpacity
                key={item.route}
                onPress={() => navigation.navigate(item.route)}
                style={{ flexDirection: 'row', alignItems: 'center',
                  backgroundColor: T.card, borderWidth: 1, borderColor: T.cardBorder ?? T.border,
                  borderRadius: 10, padding: 14, marginBottom: 8 }}>
                <Text style={{ fontSize: 24, marginRight: 14 }}>{item.icon}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: T.text, fontWeight: '700', fontSize: 13 }}>
                    {item.title}
                  </Text>
                  <Text style={{ color: T.textDim, fontSize: 10, marginTop: 2 }}>
                    {item.desc}
                  </Text>
                </View>
                <Text style={{ color: T.textDim, fontSize: 16 }}>›</Text>
              </TouchableOpacity>
            ))}
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}
