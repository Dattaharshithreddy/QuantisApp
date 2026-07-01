import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import { View, Text, Animated, Easing } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { RADIUS, SPACING } from '../theme/colors';

type ToastKind = 'default' | 'success' | 'error';
type ToastItem = { id: number; message: string; kind: ToastKind };

const ToastCtx = createContext<{ show: (message: string, kind?: ToastKind) => void }>({ show: () => {} });

export function useToast() {
  return useContext(ToastCtx).show;
}

// Single active toast at a time (queued, not stacked) - matches the
// platform convention (iOS/Android both show one transient message at a
// time) rather than piling up a list of banners.
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const { theme: T } = useTheme();
  const insets = useSafeAreaInsets();
  const [current, setCurrent] = useState<ToastItem | null>(null);
  const queueRef = useRef<ToastItem[]>([]);
  const idRef = useRef(0);
  const translateY = useRef(new Animated.Value(40)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  const dismiss = useCallback(() => {
    Animated.parallel([
      Animated.timing(translateY, { toValue: 40, duration: 180, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 0, duration: 180, useNativeDriver: true }),
    ]).start(() => {
      setCurrent(null);
      const next = queueRef.current.shift();
      if (next) presentNext(next);
    });
  }, []);

  const presentNext = useCallback((item: ToastItem) => {
    setCurrent(item);
    translateY.setValue(40); opacity.setValue(0);
    Animated.parallel([
      Animated.timing(translateY, { toValue: 0, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 1, duration: 220, useNativeDriver: true }),
    ]).start();
    setTimeout(dismiss, 2600);
  }, [dismiss]);

  const show = useCallback((message: string, kind: ToastKind = 'default') => {
    const item = { id: idRef.current++, message, kind };
    if (current) queueRef.current.push(item);
    else presentNext(item);
  }, [current, presentNext]);

  const kindColor = current?.kind === 'success' ? T.green : current?.kind === 'error' ? T.red : T.text;

  return (
    <ToastCtx.Provider value={{ show }}>
      {children}
      {current && (
        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute', left: SPACING.lg, right: SPACING.lg, bottom: insets.bottom + 70,
            transform: [{ translateY }], opacity,
          }}
        >
          <View style={{
            backgroundColor: T.bg2, borderRadius: RADIUS.md, borderWidth: 1, borderColor: T.cardBorder,
            paddingVertical: 12, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 8, ...T.elev2,
          }}>
            {current.kind !== 'default' && (
              <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: kindColor }} />
            )}
            <Text style={{ color: T.text, fontSize: 13, fontWeight: '600', flex: 1 }}>{current.message}</Text>
          </View>
        </Animated.View>
      )}
    </ToastCtx.Provider>
  );
}
