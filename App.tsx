import 'react-native-reanimated';
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider, useTheme } from './src/context/ThemeContext';
import { DataProvider } from './src/context/DataContext';
import { ScannerServiceProvider } from './src/context/ScannerService';
import { ToastProvider } from './src/components/Toast';
import { SplashScreen } from './src/components/SplashScreen';
import RootNavigator from './src/navigation';
import { requestNotifPermission } from './src/utils/alerts';

function AppShell() {
  const { themeName } = useTheme();
  const [showSplash, setShowSplash] = useState(true);

  useEffect(() => {
    requestNotifPermission().catch(() => {});
  }, []);

  return (
    <ToastProvider>
      <StatusBar style={themeName === 'dark' ? 'light' : 'dark'} />
      <View style={{ flex: 1 }}>
        <RootNavigator />
        {/* Splash sits on top as an absolute overlay - providers and the
            navigator continue loading underneath during the ~1.4s animation.
            Removed from the tree entirely once onDone() fires, so it adds
            zero cost after startup. */}
        {showSplash && <SplashScreen onDone={() => setShowSplash(false)} />}
      </View>
    </ToastProvider>
  );
}

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <DataProvider>
            <ScannerServiceProvider>
              <AppShell />
            </ScannerServiceProvider>
          </DataProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
