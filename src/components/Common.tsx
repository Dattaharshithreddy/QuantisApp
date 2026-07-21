import React, { useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Animated, Easing } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Theme, RADIUS, SPACING } from '../theme/colors';
import { pFmt } from '../utils/indicators';

export function PriceChip({ price, chg, live, theme: T }: { price: number; chg: number; live?: boolean; theme: Theme }) {
  const pos = chg >= 0;
  const color = pos ? T.green : T.red;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <Text style={{ color, fontWeight: '700', fontSize: 15 }}>{pFmt(price)}</Text>
      <Text style={{ color, fontSize: 11 }}>{pos ? '▲' : '▼'} {Math.abs(chg).toFixed(2)}%</Text>
      {live && <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: T.green }} />}
    </View>
  );
}

// Card now carries real elevation by default (subtle, level 1 - a card
// shouldn't shout) instead of a flat border-only box. `elevated={false}`
// opts back out to the old flat style for places that sit on a colored
// background where a shadow would look wrong. Signature unchanged -
// {theme, children, style} - so every existing call site works as-is.
export function Card({ theme: T, children, style, elevated = true }: { theme: Theme; children: React.ReactNode; style?: any; elevated?: boolean }) {
  return (
    <View style={[
      { backgroundColor: T.card, borderRadius: RADIUS.md, borderWidth: 1, borderColor: T.cardBorder, padding: SPACING.lg },
      elevated && T.elev1,
      style,
    ]}>
      {children}
    </View>
  );
}

export function SectionLabel({ theme: T, children }: { theme: Theme; children: React.ReactNode }) {
  return <Text style={{ color: T.textDim, fontSize: 10, fontWeight: '700', letterSpacing: 1.5, marginBottom: 8 }}>{children}</Text>;
}

export function StatBox({ label, value, color, theme: T }: { label: string; value: string; color?: string; theme: Theme }) {
  return (
    <View style={{ flex: 1, alignItems: 'center', paddingVertical: 10 }}>
      <Text style={{ color: color || T.text, fontSize: 17, fontWeight: '800' }}>{value}</Text>
      <Text style={{ color: T.textDim, fontSize: 9, marginTop: 3, letterSpacing: 0.5 }}>{label}</Text>
    </View>
  );
}

export function Pill({ label, color, active, onPress }: { label: string; color: string; active?: boolean; onPress?: () => void }) {
  return (
    <TouchableOpacity onPress={onPress} style={{
      paddingHorizontal: 12, paddingVertical: 9, borderRadius: 14, minHeight: 32,
      backgroundColor: active ? color + '22' : 'transparent',
      borderWidth: 1, borderColor: active ? color + '60' : color + '30',
      justifyContent: 'center',
    }}>
      <Text style={{ color, fontSize: 10, fontWeight: '700' }}>{label}</Text>
    </TouchableOpacity>
  );
}

// Original flat PrimaryButton - UNCHANGED behavior/signature, every
// existing call site keeps working exactly as before. New GradientButton
// below is what new/redesigned screens should reach for instead.
export function PrimaryButton({ label, onPress, color, disabled, theme: T }: { label: string; onPress: () => void; color?: string; disabled?: boolean; theme: Theme }) {
  return (
    <TouchableOpacity onPress={onPress} disabled={disabled} style={{
      backgroundColor: disabled ? T.bg3 : (color || T.accent), paddingVertical: 12, borderRadius: 8,
      alignItems: 'center', opacity: disabled ? 0.6 : 1,
    }}>
      <Text style={{ color: '#fff', fontWeight: '700', fontSize: 13, letterSpacing: 0.5 }}>{label}</Text>
    </TouchableOpacity>
  );
}

// Premium gradient CTA button - the app's signature "important action"
// button (e.g. Train & Predict, Open Position). Uses the theme's
// accentGradient pair so dark/light both get a tasteful two-tone fill
// rather than a flat block of color.
export function GradientButton({ label, onPress, disabled, theme: T, icon }: { label: string; onPress: () => void; disabled?: boolean; theme: Theme; icon?: string }) {
  if (disabled) {
    return (
      <View style={{ backgroundColor: T.bg3, paddingVertical: 14, borderRadius: RADIUS.md, alignItems: 'center', opacity: 0.5 }}>
        <Text style={{ color: T.textDim, fontWeight: '700', fontSize: 14 }}>{label}</Text>
      </View>
    );
  }
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.85}>
      <LinearGradient colors={T.accentGradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ paddingVertical: 14, borderRadius: RADIUS.md, alignItems: 'center', ...T.elev2 }}>
        <Text style={{ color: '#fff', fontWeight: '700', fontSize: 14, letterSpacing: 0.3 }}>{icon ? `${icon}  ${label}` : label}</Text>
      </LinearGradient>
    </TouchableOpacity>
  );
}

// Professional empty state - replaces ad-hoc "No data" text scattered
// across screens with a consistent, designed pattern: icon, headline,
// optional subtext, optional action.
export function EmptyState({ icon = '📭', title, subtitle, theme: T, action }: { icon?: string; title: string; subtitle?: string; theme: Theme; action?: React.ReactNode }) {
  return (
    <View style={{ alignItems: 'center', paddingVertical: SPACING.xxl, paddingHorizontal: SPACING.xl }}>
      <Text style={{ fontSize: 40, marginBottom: 12 }}>{icon}</Text>
      <Text style={{ color: T.text, fontSize: 15, fontWeight: '700', textAlign: 'center', marginBottom: subtitle ? 6 : 0 }}>{title}</Text>
      {subtitle && <Text style={{ color: T.textDim, fontSize: 12, textAlign: 'center', lineHeight: 18, marginBottom: action ? 16 : 0 }}>{subtitle}</Text>}
      {action}
    </View>
  );
}

// Skeleton loader - a softly pulsing placeholder block, replacing blank
// space or a spinner while real data loads. Pure RN Animated, no new
// dependency. `width`/`height`/`radius` let callers shape it to match
// whatever it's standing in for (a price, a row, a chart).
export function Skeleton({ width = '100%', height = 16, radius = RADIUS.sm, theme: T, style }: { width?: number | string; height?: number; radius?: number; theme: Theme; style?: any }) {
  const opacity = useRef(new Animated.Value(0.4)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(opacity, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 0.4, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, []);
  return <Animated.View style={[{ width, height, borderRadius: radius, backgroundColor: T.bg3, opacity }, style]} />;
}

// A few skeleton rows stacked - the common case of "a card's worth of
// content is loading", used in place of a blank Card or a bare spinner.
export function SkeletonRows({ theme: T, rows = 3 }: { theme: Theme; rows?: number }) {
  return (
    <View style={{ gap: 10 }}>
      {Array.from({ length: rows }).map((_, i) => (
        <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Skeleton width={90} height={11} theme={T} />
          <Skeleton width={60} height={11} theme={T} />
        </View>
      ))}
    </View>
  );
}

export function Divider({ theme: T, style }: { theme: Theme; style?: any }) {
  return <View style={[{ height: StyleSheet.hairlineWidth, backgroundColor: T.border }, style]} />;
}

export function Gauge({ value, max = 100, color, label, theme: T, size = 'md' }: { value: number; max?: number; color: string; label: string; theme: Theme; size?: 'sm' | 'md' }) {
  const widthAnim = useRef(new Animated.Value(0)).current;
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  useEffect(() => {
    Animated.timing(widthAnim, { toValue: pct, duration: 500, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
  }, [pct]);
  const valueFontSize = size === 'sm' ? 15 : 18;
  return (
    <View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 5 }}>
        <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', letterSpacing: 0.4 }}>{label}</Text>
        <Text style={{ color, fontSize: valueFontSize, fontWeight: '800' }}>{value.toFixed(0)}</Text>
      </View>
      <View style={{ height: 5, borderRadius: 3, backgroundColor: T.bg3, overflow: 'hidden' }}>
        <Animated.View style={{ height: '100%', borderRadius: 3, backgroundColor: color, width: widthAnim.interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'] }) }} />
      </View>
    </View>
  );
}

// Reusable expand/collapse affordance - animated rotating chevron instead
// of swapping ▼/▶ text glyphs (which was the previous pattern, duplicated
// at 2+ call sites in ChartScreen.tsx). Caller owns the boolean state and
// onPress; this only renders the tappable label + animated icon.
export function ExpandableToggle({ expanded, label, onPress, color, theme: T }: { expanded: boolean; label: string; onPress: () => void; color?: string; theme: Theme }) {
  const rotate = useRef(new Animated.Value(expanded ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(rotate, { toValue: expanded ? 1 : 0, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [expanded]);
  const spin = rotate.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '90deg'] });
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.7} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 36, paddingVertical: 6 }}>
      <Animated.Text style={{ color: color ?? T.accent, fontSize: 11, fontWeight: '800', transform: [{ rotate: spin }] }}>▶</Animated.Text>
      <Text style={{ color: color ?? T.accent, fontSize: 11, fontWeight: '700' }}>{label}</Text>
    </TouchableOpacity>
  );
}

// Fade+scale entrance for content revealed by an ExpandableToggle (or any
// conditional reveal) - subtle, per the "no flashy animations" guidance.
// Caller still controls mounting (only renders this when visible=true);
// this just animates the entrance once it mounts.
export function AnimatedReveal({ children }: { children: React.ReactNode }) {
  const opacity = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(0.97)).current;
  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }),
      Animated.timing(scale, { toValue: 1, duration: 200, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
    ]).start();
  }, []);
  return <Animated.View style={{ opacity, transform: [{ scale }] }}>{children}</Animated.View>;
}

export function MetricBox({ label, value, valueColor, bg, sub, theme: T }: { label: string; value: string; valueColor?: string; bg?: string; sub?: string; theme: Theme }) {
  return (
    <View style={{ flex: 1, backgroundColor: bg ?? T.bg3, borderRadius: RADIUS.sm, padding: 9 }}>
      <Text style={{ color: T.textDim, fontSize: 8, fontWeight: '700', letterSpacing: 0.3 }}>{label}</Text>
      <Text style={{ color: valueColor ?? T.text, fontSize: 12, fontWeight: '800', marginTop: 3 }} numberOfLines={1}>{value}</Text>
      {sub && <Text style={{ color: T.textDim, fontSize: 9, marginTop: 1 }}>{sub}</Text>}
    </View>
  );
}

export function IconChip({ icon, text, color, bg, theme: T }: { icon: string; text: string; color: string; bg?: string; theme: Theme }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 7, backgroundColor: bg, borderRadius: bg ? RADIUS.sm : 0, paddingVertical: bg ? 7 : 0, paddingHorizontal: bg ? 10 : 0 }}>
      <Text style={{ color, fontSize: 11, fontWeight: '800' }}>{icon}</Text>
      <Text style={{ color: T.text, fontSize: 11, flex: 1, lineHeight: 15 }}>{text}</Text>
    </View>
  );
}

export const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
});
