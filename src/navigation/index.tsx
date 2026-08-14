import React from 'react';
import { Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useTheme } from '../context/ThemeContext';
import ErrorBoundary from '../components/ErrorBoundary';
import MarketsScreen from '../screens/MarketsScreen';
import ChartScreen from '../screens/ChartScreen';
import RiskManagerScreen from '../screens/RiskManagerScreen';
import JournalScreen from '../screens/JournalScreen';
import AlertsScreen from '../screens/AlertsScreen';
import SettingsScreen from '../screens/SettingsScreen';
import MoreMenuScreen from '../screens/MoreMenuScreen';
import ShadowJournalScreen from '../screens/ShadowJournalScreen';
import GateAnalyticsScreen from '../screens/GateAnalyticsScreen';
import OptionsStrategyScreen from '../screens/OptionsStrategyScreen';
import PortfolioScreen from '../screens/PortfolioScreen';
import CorrelationScreen from '../screens/CorrelationScreen';
import CalendarScreen from '../screens/CalendarScreen';
import MultiChartScreen from '../screens/MultiChartScreen';
import ScreenerScreen from '../screens/ScreenerScreen';
import BacktestScreen from '../screens/BacktestScreen';
import VerificationScreen from '../screens/VerificationScreen';
import ProductionEvaluationScreen from '../screens/ProductionEvaluationScreen';
import PaperTradingScreen from '../screens/PaperTradingScreen';
import PaperJournalScreen from '../screens/PaperJournalScreen';
import PaperAnalyticsScreen from '../screens/PaperAnalyticsScreen';
import MarketContextAnalyticsScreen from '../screens/MarketContextAnalyticsScreen';
import PaperReplayScreen from '../screens/PaperReplayScreen';
import ScannerDashboardScreen from '../screens/ScannerDashboardScreen';
import SymbolSearchScreen from '../screens/SymbolSearchScreen';
import AIChatScreen from '../screens/AIChatScreen';
import BrokerConnectionScreen from '../screens/BrokerConnectionScreen';
import OrderConfirmationScreen from '../screens/OrderConfirmationScreen';
import LivePositionsScreen from '../screens/LivePositionsScreen';
import KillSwitchScreen from '../screens/KillSwitchScreen';
import LiveTradeSettingsScreen from '../screens/LiveTradeSettingsScreen';
import OrderHistoryScreen from '../screens/OrderHistoryScreen';
import LivePnLScreen from '../screens/LivePnLScreen';
import OrderAuditScreen from '../screens/OrderAuditScreen';
import HealthDashboardScreen from '../screens/HealthDashboardScreen';
import TradingCoachScreen from '../screens/TradingCoachScreen';
import PerformanceDashboardScreen from '../screens/PerformanceDashboardScreen';
import FuturesContractScreen  from '../screens/FuturesContractScreen';
import FuturesPositionsScreen from '../screens/FuturesPositionsScreen';
import FuturesMtmLogScreen    from '../screens/FuturesMtmLogScreen';
import BnFuturesScreen         from '../screens/BnFuturesScreen';
import BnFuturesPositionsScreen from '../screens/BnFuturesPositionsScreen';
import FuturesSettingsScreen    from '../screens/FuturesSettingsScreen';
import PortfolioRiskScreen      from '../screens/PortfolioRiskScreen';
import FAQScreen                 from '../screens/FAQScreen';
import DeveloperSupportScreen   from '../screens/DeveloperSupportScreen';

console.log('[QUANTIS_DIAG] M-nav-A: navigation/index.tsx top-level starting — all screen imports completed');
const Tab = createBottomTabNavigator();
const MoreStack = createNativeStackNavigator();
const RootStack = createNativeStackNavigator();
console.log('[QUANTIS_DIAG] M-nav-B: navigators created successfully');

const ICONS: Record<string, { active: keyof typeof Ionicons.glyphMap; inactive: keyof typeof Ionicons.glyphMap }> = {
  Markets: { active: 'stats-chart',        inactive: 'stats-chart-outline' },
  Chart:   { active: 'trending-up',        inactive: 'trending-up-outline' },
  Risk:    { active: 'shield-checkmark',   inactive: 'shield-checkmark-outline' },
  Journal: { active: 'book',              inactive: 'book-outline' },
  Alerts:  { active: 'notifications',     inactive: 'notifications-outline' },
  MoreTab: { active: 'grid',             inactive: 'grid-outline' },
};

// ROOT CAUSE FIX: wrap() was called inline in JSX — component={wrap(Foo, 'Foo')}
// — meaning every render of MainTabs/MoreStackNavigator produced a brand-new
// arrow function as the component prop. React Navigation (and React itself)
// uses referential equality to decide whether to remount a screen; a different
// function reference = unmount old screen + mount new screen. DataContext
// calls setPrices on every WebSocket message (every ~1s), which re-renders
// MainTabs, which called wrap() fresh, which gave each Tab.Screen a new
// component identity, which caused every visible tab screen to unmount and
// remount on every price tick. This is what felt like "slowness" — it wasn't
// just visual lag, the screens were literally tearing down and rebuilding on
// every second.
// Fix: hoist all wrapped components to stable module-level constants.
// These are created ONCE when the module loads and never recreated.
function makeWrapped(Component: React.ComponentType<any>, label: string) {
  const Wrapped = (props: any) => (
    <ErrorBoundary fallbackLabel={`Error on ${label} screen`}>
      <Component {...props} />
    </ErrorBoundary>
  );
  Wrapped.displayName = `Wrapped(${label})`;
  return Wrapped;
}

console.log('[QUANTIS_DIAG] M-nav-C: starting makeWrapped for all screens');
const WrappedMarkets = makeWrapped(MarketsScreen, 'Markets');
console.log('[QUANTIS_DIAG] M-nav-C1: Markets OK');
const WrappedChart = makeWrapped(ChartScreen, 'Chart');
console.log('[QUANTIS_DIAG] M-nav-C2: Chart OK');
const WrappedRisk = makeWrapped(RiskManagerScreen, 'Risk');
const WrappedJournal = makeWrapped(JournalScreen, 'Journal');
const WrappedAlerts = makeWrapped(AlertsScreen, 'Alerts');
const WrappedSettings = makeWrapped(SettingsScreen, 'Settings');
const WrappedMoreMenu = makeWrapped(MoreMenuScreen, 'More');
const WrappedOptionsStrategy = makeWrapped(OptionsStrategyScreen, 'Options Strategy');
const WrappedPortfolio = makeWrapped(PortfolioScreen, 'Portfolio');
const WrappedCorrelation = makeWrapped(CorrelationScreen, 'Correlation Matrix');
const WrappedCalendar = makeWrapped(CalendarScreen, 'Economic Calendar');
const WrappedMultiChart = makeWrapped(MultiChartScreen, 'Multi-Chart');
const WrappedScreener = makeWrapped(ScreenerScreen, 'Strategy Screener');
const WrappedBacktest = makeWrapped(BacktestScreen, 'Backtesting');
const WrappedVerification = makeWrapped(VerificationScreen, 'Verification & Stress Test');
const WrappedProductionEval = makeWrapped(ProductionEvaluationScreen, 'Production Model Evaluation');
console.log('[QUANTIS_DIAG] M-nav-C3: ProductionEval OK');
const WrappedPaperTrading = makeWrapped(PaperTradingScreen, 'Paper Trading');
const WrappedPaperJournal = makeWrapped(PaperJournalScreen, 'Paper Journal');
console.log('[QUANTIS_DIAG] M-nav-C4: PaperJournal OK');
const WrappedPaperAnalytics = makeWrapped(PaperAnalyticsScreen, 'Paper Analytics');
const WrappedPaperReplay = makeWrapped(PaperReplayScreen, 'Paper Replay');
const WrappedScannerDashboard = makeWrapped(ScannerDashboardScreen, 'Scanner Dashboard');
const WrappedSymbolSearch = makeWrapped(SymbolSearchScreen, 'Symbol Search');
const WrappedAIChat = makeWrapped(AIChatScreen, 'AI Chat');

function MoreStackNavigator() {
  const { theme: T } = useTheme();
  return (
    <MoreStack.Navigator screenOptions={{
      headerStyle: { backgroundColor: T.bg1 },
      headerTitleStyle: { fontSize: 17, fontWeight: '800', color: T.text },
      headerTintColor: T.accent,
      headerShadowVisible: false}}>
      <MoreStack.Screen name="MoreMenu" component={WrappedMoreMenu} options={{ title: 'More' }} />
      <MoreStack.Screen name="ShadowJournal" component={ShadowJournalScreen} options={{ title: 'Shadow Journal', headerShown: true }} />
      <MoreStack.Screen name="GateAnalytics" component={GateAnalyticsScreen} options={{ title: 'Gate Analytics', headerShown: true }} />
      <MoreStack.Screen name="MarketContextAnalytics" component={MarketContextAnalyticsScreen} options={{ title: 'Context Analytics', headerShown: true }} />
      {/* ── Live Trading Screens ── */}
      <MoreStack.Screen name="BrokerConnection"    component={BrokerConnectionScreen}    options={{ title: 'Broker Connection',    headerShown: true }} />
      <MoreStack.Screen name="LivePositions"       component={LivePositionsScreen}       options={{ title: 'Live Positions',       headerShown: true }} />
      <MoreStack.Screen name="KillSwitch"          component={KillSwitchScreen}          options={{ title: '⛔ Kill Switch',        headerShown: true }} />
      <MoreStack.Screen name="LiveTradeSettings"   component={LiveTradeSettingsScreen}   options={{ title: 'Live Trade Settings',  headerShown: true }} />
      <MoreStack.Screen name="OrderHistory"        component={OrderHistoryScreen}        options={{ title: 'Order History',        headerShown: true }} />
      <MoreStack.Screen name="LivePnL"             component={LivePnLScreen}             options={{ title: 'Live P&L',             headerShown: true }} />
      <MoreStack.Screen name="OrderAudit"          component={OrderAuditScreen}          options={{ title: 'Audit Trail',          headerShown: true }} />
      <MoreStack.Screen name="HealthDashboard"     component={HealthDashboardScreen}     options={{ title: 'Health Dashboard',     headerShown: true }} />
      <MoreStack.Screen name="TradingCoach"        component={TradingCoachScreen}        options={{ title: 'AI Trading Coach',     headerShown: true }} />
      <MoreStack.Screen name="PerformanceDashboard" component={PerformanceDashboardScreen} options={{ title: 'Performance',         headerShown: true }} />
      {/* ── Futures ── */}
      <MoreStack.Screen name="FuturesContract"  component={FuturesContractScreen}  options={{ title: 'Futures — Contract',   headerShown: true }} />
      <MoreStack.Screen name="FuturesPositions" component={FuturesPositionsScreen} options={{ title: 'Futures — Positions',  headerShown: true }} />
      <MoreStack.Screen name="FuturesMtmLog"    component={FuturesMtmLogScreen}    options={{ title: 'MTM Settlement Log',         headerShown: true }} />
      {/* ── Binance (Crypto) Futures ── */}
      <MoreStack.Screen name="BnFutures"          component={BnFuturesScreen}          options={{ title: 'Crypto Futures',             headerShown: true }} />
      <MoreStack.Screen name="BnFuturesPositions" component={BnFuturesPositionsScreen} options={{ title: 'Crypto Futures Positions',   headerShown: true }} />
      <MoreStack.Screen name="FuturesSettings"     component={FuturesSettingsScreen}     options={{ title: 'Futures Settings',           headerShown: true }} />
      <MoreStack.Screen name="PortfolioRisk"       component={PortfolioRiskScreen}       options={{ title: 'Portfolio Risk',             headerShown: true }} />
      <MoreStack.Screen name="FAQ"                  component={FAQScreen}                  options={{ title: 'Help & FAQ',                 headerShown: true }} />
      <MoreStack.Screen name="DeveloperSupport"    component={DeveloperSupportScreen}    options={{ title: 'Support & Diagnostics',       headerShown: true }} />
      <MoreStack.Screen name="OrderConfirmation"   component={OrderConfirmationScreen}   options={{ title: 'Confirm Order', headerShown: true, presentation: 'modal' }} />
      <MoreStack.Screen name="OptionsStrategy" component={WrappedOptionsStrategy} options={{ title: 'Options Strategy' }} />
      <MoreStack.Screen name="Portfolio" component={WrappedPortfolio} options={{ title: 'Portfolio' }} />
      <MoreStack.Screen name="Correlation" component={WrappedCorrelation} options={{ title: 'Correlation Matrix' }} />
      <MoreStack.Screen name="Calendar" component={WrappedCalendar} options={{ title: 'Economic Calendar' }} />
      <MoreStack.Screen name="MultiChart" component={WrappedMultiChart} options={{ title: 'Multi-Chart' }} />
      <MoreStack.Screen name="Screener" component={WrappedScreener} options={{ title: 'Strategy Screener' }} />
      <MoreStack.Screen name="Backtest" component={WrappedBacktest} options={{ title: 'Backtesting' }} />
      <MoreStack.Screen name="Verification" component={WrappedVerification} options={{ title: 'Verification & Stress Test' }} />
      <MoreStack.Screen name="ProductionEval" component={WrappedProductionEval} options={{ title: 'Production Model Evaluation' }} />
      <MoreStack.Screen name="Settings" component={WrappedSettings} options={{ title: 'Settings' }} />
    </MoreStack.Navigator>
  );
}

// Tab haptic: iOS only — a genuine subtle selection tick.
// Android skips vibration entirely for tab navigation because even
// selectionAsync/CLOCK_TICK produces a noticeable buzz on most Android
// devices. The visual active-tab highlight is sufficient feedback there.
// This matches how Coinbase, Binance, and Zerodha handle it on Android.
function triggerTabHaptic() {
  if (Platform.OS !== 'ios') return;
  setTimeout(() => {
    Haptics.selectionAsync().catch(() => {});
  }, 0);
}

// Also stable module-level — Tab.Navigator's screenListeners prop is
// compared by reference; an inline object literal creates a new object
// on every render, which React Navigation would re-subscribe on every tick.
const TAB_LISTENERS = { tabPress: triggerTabHaptic };
console.log('[QUANTIS_DIAG] M-nav-D: navigation/index.tsx module fully loaded — all makeWrapped done');

function MainTabs() {
  const { theme: T } = useTheme();
  return (
    <Tab.Navigator
      detachInactiveScreens={false}
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: T.accent,
        tabBarInactiveTintColor: T.textDim,
        tabBarStyle: {
          backgroundColor: T.bg1, borderTopWidth: 1, borderTopColor: T.border,
          height: 62, paddingBottom: 8, paddingTop: 8,
          ...T.elev2},
        tabBarLabelStyle: { fontSize: 10, fontWeight: '700', letterSpacing: 0.2 },
        tabBarIcon: ({ focused, color }) => (
          <Ionicons name={focused ? ICONS[route.name].active : ICONS[route.name].inactive} size={22} color={color} />
        )})}
      screenListeners={TAB_LISTENERS}
    >
      <Tab.Screen name="Markets" component={WrappedMarkets} />
      <Tab.Screen name="Chart" component={WrappedChart} />
      <Tab.Screen name="Risk" component={WrappedRisk} options={{ title: 'Risk' }} />
      <Tab.Screen name="Journal" component={WrappedJournal} />
      <Tab.Screen name="Alerts" component={WrappedAlerts} />
      <Tab.Screen name="MoreTab" component={MoreStackNavigator} options={{ title: 'More' }} />
    </Tab.Navigator>
  );
}

// Root stack wraps the tab navigator so Symbol Search can be presented as a
// modal reachable from ANY tab (Chart, MultiChart, Correlation, Screener all
// link into it), then hands the picked symbol back to whichever tab asked.
export default function RootNavigator({ navigationRef }: { navigationRef?: any }) {
  return (
    <NavigationContainer ref={navigationRef}>
      <RootStack.Navigator screenOptions={{ headerShown: false }}>
        <RootStack.Screen name="MainTabs" component={MainTabs} />
        <RootStack.Screen
          name="SymbolSearch"
          component={WrappedSymbolSearch}
          options={{ presentation: 'modal' }}
        />
        <RootStack.Screen
          name="AIChat"
          component={WrappedAIChat}
          options={{ presentation: 'modal' }}
        />
        <RootStack.Screen name="PaperTrading" component={WrappedPaperTrading} options={{ presentation: 'modal' }} />
        <RootStack.Screen name="PaperJournal" component={WrappedPaperJournal} />
        <RootStack.Screen name="PaperAnalytics" component={WrappedPaperAnalytics} />
        <RootStack.Screen name="PaperReplay" component={WrappedPaperReplay} />
        <RootStack.Screen name="ScannerDashboard" component={WrappedScannerDashboard} />
        <RootStack.Screen
          name="OrderConfirmation"
          component={OrderConfirmationScreen}
          options={{ presentation: 'modal', headerShown: true, title: 'Confirm Order' }}
        />
      </RootStack.Navigator>
    </NavigationContainer>
  );
}
