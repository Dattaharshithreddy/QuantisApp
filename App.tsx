import 'react-native-reanimated';
import React, { useEffect, useState } from 'react';
import { View, AppState } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as ExpoSplashScreen from 'expo-splash-screen';
import * as Notifications from 'expo-notifications';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { AuthProvider } from './src/context/AuthContext';
import LockScreen from './src/screens/LockScreen';
import { getLockSettings } from './src/services/appLock';
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
    requestPermission().catch(() => {}); // uses notifications.ts
    ExpoSplashScreen.hideAsync().catch(() => {});

    // Check onboarding completion while splash is showing
    isOnboardingComplete().then(done => {
      setOnboardingDone(done);
    }).catch(() => {
      setOnboardingDone(true); // fail safe — don't block launch
    });

    // Notification tap handler set up in App() useEffect via setupNotificationTapHandler
    const sub = { remove: () => {} }; // placeholder

    // ── Schedule market open reminders (fires at 9:15 AM IST, works when killed) ──
    import('./src/utils/paperNotifications').then(({ scheduleMarketOpenReminders }) => {
      scheduleMarketOpenReminders().catch(() => {});
    }).catch(() => {});

    return () => sub.remove();
  }, []);

  // Re-lock after 30s in background
  const bgTimer = React.useRef<any>(null);
  React.useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      if (state === 'background') {
        bgTimer.current = setTimeout(async () => {
          const { enabled } = await getLockSettings();
          if (enabled) setLocked(true);
        }, 30000);
      } else if (state === 'active') {
        if (bgTimer.current) clearTimeout(bgTimer.current);
      }
    });
    return () => { sub.remove(); if (bgTimer.current) clearTimeout(bgTimer.current); };
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
  const [locked, setLocked] = React.useState(false);

  // ALL hooks must be declared before any conditional return
  React.useEffect(() => {
    // Check lock with 2s timeout — never block app startup
    const timeout = setTimeout(() => setLocked(false), 2000);
    getLockSettings().then(({ enabled }) => {
      clearTimeout(timeout);
      setLocked(!!enabled);
    }).catch(() => {
      clearTimeout(timeout);
      setLocked(false);
    });
  }, []);

  React.useEffect(() => {
    requestPermission().catch(() => {});
    const unsub = setupNotificationTapHandler();
    // Pre-warm NSE scrip master in background so symbol search is instant
    import('./src/api/symbolSearch').then(({ warmScripMaster }) => {
      warmScripMaster().catch(() => {});
    }).catch(() => {});
    return unsub;
  }, []);

  // Re-lock after 30s in background
  const bgTimer = React.useRef<any>(null);
  React.useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      if (state === 'background') {
        bgTimer.current = setTimeout(async () => {
          const { enabled } = await getLockSettings();
          if (enabled) setLocked(true);
        }, 30000);
      } else if (state === 'active') {
        if (bgTimer.current) clearTimeout(bgTimer.current);
      }
    });
    return () => { sub.remove(); if (bgTimer.current) clearTimeout(bgTimer.current); };
  }, []);

  // Conditional is INSIDE the return — no hooks after this
  if (locked) {
    return <LockScreen onUnlock={() => setLocked(false)} />;
  }

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
