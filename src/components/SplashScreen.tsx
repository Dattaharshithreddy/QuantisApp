import React, { useEffect, useRef } from 'react';
import { View, Text, Animated, Easing, StyleSheet } from 'react-native';
import Svg, { Defs, LinearGradient, Stop, Path, Circle } from 'react-native-svg';

// QUANTIS SPLASH SCREEN — sequential candlestick bar animation
//
// The three bars from the logo appear one at a time left → middle → right,
// each 320ms apart, evoking candles forming on a real chart. After all three
// are visible the screen fades out to reveal the app (~1.4s total).
//
// Architecture notes:
// - Three separate BarLayer components each with their own Animated.Value,
//   layered with position:absolute so they share the same coordinate space.
//   This avoids trying to animate opacity inside a single SVG context
//   (react-native-svg's AnimatedSVG API is verbose and less reliable than
//   wrapping the entire Svg element in an Animated.View).
// - The outer container fades OUT rather than the individual bars, so there's
//   no jump cut back to white between "all bars visible" and "app shown".
// - Colors are hardcoded dark-theme constants — ThemeContext/AsyncStorage
//   haven't been read yet at this point in the startup sequence, same
//   pattern Expo's own native splash screen uses.

const BG = '#0d0f17';
const GRAD_FROM = '#3b7dff';
const GRAD_TO = '#7c5cff';
const TEXT = '#e8eaf0';
const SUBDIM = '#565c70';

// Each bar is its own Svg inside an Animated.View at position:absolute,
// so all three sit on top of each other in the same 120×120 space and can
// be shown/hidden independently.
function BarLayer({ opacity, children }: { opacity: Animated.Value; children: React.ReactNode }) {
  return (
    <Animated.View style={{ position: 'absolute', top: 0, left: 0, opacity }}>
      <Svg width={120} height={120} viewBox="0 0 100 100">
        <Defs>
          <LinearGradient id="g" x1="0%" y1="100%" x2="100%" y2="0%">
            <Stop offset="0%" stopColor={GRAD_FROM} />
            <Stop offset="100%" stopColor={GRAD_TO} />
          </LinearGradient>
        </Defs>
        {children}
      </Svg>
    </Animated.View>
  );
}

export function SplashScreen({ onDone }: { onDone: () => void }) {
  const bar1 = useRef(new Animated.Value(0)).current;  // short bar, left
  const bar2 = useRef(new Animated.Value(0)).current;  // medium bar, centre
  const bar3 = useRef(new Animated.Value(0)).current;  // tall bar + node, right
  const screen = useRef(new Animated.Value(1)).current; // whole screen fades out last

  const FADE = 220;  // ms per bar fade-in
  const GAP  = 320;  // ms between bar starts (overlap = GAP - FADE = 100ms)

  useEffect(() => {
    Animated.sequence([
      // Bar 1 fades in immediately
      Animated.timing(bar1, { toValue: 1, duration: FADE, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.delay(GAP - FADE),
      // Bar 2 fades in
      Animated.timing(bar2, { toValue: 1, duration: FADE, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.delay(GAP - FADE),
      // Bar 3 fades in
      Animated.timing(bar3, { toValue: 1, duration: FADE, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      // Hold all three visible briefly
      Animated.delay(280),
      // Fade the whole screen out
      Animated.timing(screen, { toValue: 0, duration: 300, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
    ]).start(() => onDone());
  }, []);

  return (
    <Animated.View
      style={[
        StyleSheet.absoluteFill,
        { backgroundColor: BG, opacity: screen, alignItems: 'center', justifyContent: 'center', zIndex: 999 },
      ]}
      pointerEvents="none" // don't block touches on the app underneath during fade-out
    >
      {/* Logo: 120×120 container with three independently-animated bar layers */}
      <View style={{ width: 120, height: 120 }}>
        {/* Bar 1 — short, left (matches QuantisLogo.tsx path exactly) */}
        <BarLayer opacity={bar1}>
          <Path d="M24 69 L24 79 L38 79 L38 69 Z" fill="url(#g)" />
        </BarLayer>

        {/* Bar 2 — medium, centre */}
        <BarLayer opacity={bar2}>
          <Path d="M43 51 L43 79 L57 79 L57 51 Z" fill="url(#g)" />
        </BarLayer>

        {/* Bar 3 — tall, right + ringed signal node */}
        <BarLayer opacity={bar3}>
          <Path d="M62 29 L62 79 L76 79 L76 29 Z" fill="url(#g)" />
          <Circle cx="69" cy="29" r="8" fill="url(#g)" />
          <Circle cx="69" cy="29" r="3" fill={BG} />
        </BarLayer>
      </View>

      <Text style={{ color: TEXT, fontSize: 22, fontWeight: '800', letterSpacing: -0.3, marginTop: 20 }}>
        Quantis
      </Text>
      <Text style={{ color: SUBDIM, fontSize: 12, fontWeight: '500', marginTop: 4, letterSpacing: 0.2 }}>
        AI-Powered Trading Assistant
      </Text>
    </Animated.View>
  );
}
