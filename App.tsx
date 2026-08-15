import 'react-native-reanimated';
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as ExpoSplashScreen from 'expo-splash-screen';
import * as Notifications from 'expo-notifications';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { AuthProvider } from './src/context/AuthContext';
import { requestPermission, setupNotificationTapHandler } from './src/services/notifications';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider, useTheme } from './src/context/ThemeContext';
import { DataProvider } from './src/context/DataContext';
import { ScannerServiceProvider } from './src/context/ScannerService';
import { PaperTradingMonitorProvider } from './src/context/PaperTradingMonitor';
import { LiveSyncProvider } from './src/context/LiveSyncProvider';
import { EvalTaskProvider } from './src/context/EvalTaskContext';
import { ToastProvider } from './src/components/Toast';
import { SplashScreen } from './src/components/SplashScreen';
import RootNavigator from './src/navigation';
import { requestNotifPermission } from './src/utils/alerts';
import { navigationRef, navigateToProductionEval, navigateToScanner, navigateToPaperTrading, navigateToShadowJournal, navigateToLivePositions } from './src/utils/navigationRef';
import { installGlobalErrorHandlers, setCurrentScreen } from './src/utils/crashReporter';
import { runAuditIfNeeded } from './src/utils/securityAudit';
import { isOnboardingComplete } from './src/utils/onboarding';
import OnboardingScreen from './src/screens/OnboardingScreen';

ExpoSplashScreen.preventAutoHideAsync().catch(() => {});

// Install global JS error + promise rejection handlers as early as possible.
installGlobalErrorHandlers();

// Run security audit once per build version (non-blocking)
runAuditIfNeeded().catch(() => {});

function AppShell() {
  const { themeName } = useTheme();
  const [showSplash,     setShowSplash]     = useState(true);
  const [onboardingDone, setOnboardingDone] = useState<boolean | null>(null);

  useEffect(() => {
    requestNotifPermission().catch(() => {});
    ExpoSplashScreen.hideAsync().catch(() => {});

    // Check onboarding completion while splash is showing
    isOnboardingComplete().then(done => {
      setOnboardingDone(done);
    }).catch(() => {
      setOnboardingDone(true); // fail safe — don't block launch
    });

    // ── Notification tap → deep navigation ──────────────────────────────────
    // Handles all notification types. data.screen routes to the right screen.
    // data.symbol is passed for Chart navigation so the chart opens the right asset.
    const sub = Notifications.addNotificationResponseReceivedListener(response => {
      const data = response.notification.request.content.data as any;
      const screen = data?.screen ?? '';

      if (screen === 'PaperTrading')    { navigateToPaperTrading();    return; }
      if (screen === 'PaperJournal')    { navigateToPaperTrading();    return; } // PaperJournal is a sub-screen
      if (screen === 'ShadowJournal')   { navigateToShadowJournal();   return; }
      if (screen === 'LivePositions')   { navigateToLivePositions();   return; }
      if (screen === 'Scanner')         { navigateToScanner();         return; }
      if (screen === 'Chart')           { /* stay on chart or navigate to Chart tab */ return; }
      // Default: ProductionEval for scanner/task notifications
      navigateToProductionEval();
    });

    // ── Schedule market open reminders (fires at 9:15 AM IST, works when killed) ──
    import('./src/utils/paperNotifications').then(({ scheduleMarketOpenReminders }) => {
      scheduleMarketOpenReminders().catch(() => {});
    }).catch(() => {});

    return () => sub.remove();
  }, []);

  return (
    <ToastProvider>
      <StatusBar style={themeName === 'dark' ? 'light' : 'dark'} />
      <View style={{ flex: 1 }}>
        {/* Onboarding gate: null = loading (show nothing extra), false = show onboarding */}
        {onboardingDone === false ? (
          <OnboardingScreen onComplete={() => setOnboardingDone(true)} />
        ) : (
          <>
            <RootNavigator navigationRef={navigationRef} />
            {showSplash && <SplashScreen onDone={() => setShowSplash(false)} />}
          </>
        )}
      </View>
    </ToastProvider>
  );
}

export default function App() {
  React.useEffect(() => {
    // Request notification permission on first launch
    requestPermission().catch(() => {});
    // Handle notification taps → navigate to correct screen
    const unsub = setupNotificationTapHandler();
    return unsub;
  }, []);

  return (
    <AuthProvider>
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <DataProvider>
            <ScannerServiceProvider>
              <PaperTradingMonitorProvider>
                <LiveSyncProvider>
              <EvalTaskProvider>
                <AppShell />
              </EvalTaskProvider>
                </LiveSyncProvider>
              </PaperTradingMonitorProvider>
            </ScannerServiceProvider>
          </DataProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
    </AuthProvider>
  );
}
