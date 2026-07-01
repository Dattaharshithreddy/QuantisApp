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
import PaperReplayScreen from '../screens/PaperReplayScreen';
import ScannerDashboardScreen from '../screens/ScannerDashboardScreen';
import SymbolSearchScreen from '../screens/SymbolSearchScreen';
import AIChatScreen from '../screens/AIChatScreen';

const Tab = createBottomTabNavigator();
const MoreStack = createNativeStackNavigator();
const RootStack = createNativeStackNavigator();

const ICONS: Record<string, { active: keyof typeof Ionicons.glyphMap; inactive: keyof typeof Ionicons.glyphMap }> = {
  Markets: { active: 'stats-chart', inactive: 'stats-chart-outline' },
  Chart: { active: 'trending-up', inactive: 'trending-up-outline' },
  Risk: { active: 'shield-checkmark', inactive: 'shield-checkmark-outline' },
  Journal: { active: 'book', inactive: 'book-outline' },
  Alerts: { active: 'notifications', inactive: 'notifications-outline' },
  MoreTab: { active: 'grid', inactive: 'grid-outline' },
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

const WrappedMarkets = makeWrapped(MarketsScreen, 'Markets');
const WrappedChart = makeWrapped(ChartScreen, 'Chart');
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
const WrappedPaperTrading = makeWrapped(PaperTradingScreen, 'Paper Trading');
const WrappedPaperJournal = makeWrapped(PaperJournalScreen, 'Paper Journal');
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
      headerShadowVisible: false,
    }}>
      <MoreStack.Screen name="MoreMenu" component={WrappedMoreMenu} options={{ title: 'More' }} />
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

// Stable haptic handler — module-level so it never changes identity,
// preventing unnecessary re-subscription of the screenListeners on each render.
// FIX: haptic now fires via setTimeout(0), completely outside the navigation
// event pipeline. Navigation commits immediately; vibration follows in the
// next JS event-loop tick. The previous inline arrow called
// Haptics.selectionAsync() synchronously in the tabPress event, which
// blocked navigation dispatch while the haptics subsystem initialized.
function triggerTabHaptic() {
  setTimeout(() => {
    if (Platform.OS === 'ios') {
      Haptics.selectionAsync().catch(() => {});
    } else {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    }
  }, 0);
}

// Also stable module-level — Tab.Navigator's screenListeners prop is
// compared by reference; an inline object literal creates a new object
// on every render, which React Navigation would re-subscribe on every tick.
const TAB_LISTENERS = { tabPress: triggerTabHaptic };

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
          ...T.elev2,
        },
        tabBarLabelStyle: { fontSize: 10, fontWeight: '700', letterSpacing: 0.2 },
        tabBarIcon: ({ focused, color }) => (
          <Ionicons name={focused ? ICONS[route.name].active : ICONS[route.name].inactive} size={22} color={color} />
        ),
      })}
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
export default function RootNavigator() {
  return (
    <NavigationContainer>
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
      </RootStack.Navigator>
    </NavigationContainer>
  );
}
