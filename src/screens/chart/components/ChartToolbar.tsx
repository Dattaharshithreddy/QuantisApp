// ── ChartToolbar — timeframe tabs + overlay toggle pills ──────────────────────
import React from 'react';
import { View, ScrollView, Pressable, Text } from 'react-native';
import { Pill } from '../../../components/Common';
import { RADIUS } from '../../../theme/colors';
import { TIMEFRAMES } from '../hooks/useChartData';
type OverlayKey = 'bollinger' | 'donchian' | 'keltner' | 'fib' | 'pivots';

type Props = {
  tf:              string;
  setTf:           (t: string) => void;
  showMA:          boolean;
  setShowMA:       (v: boolean | ((p: boolean) => boolean)) => void;
  showVP:          boolean;
  setShowVP:       (v: boolean | ((p: boolean) => boolean)) => void;
  overlayToggles:  Record<OverlayKey, boolean>;
  toggleOverlay:   (k: OverlayKey) => void;
  T: any;
};

export const ChartToolbar = React.memo(function ChartToolbar({ tf, setTf, showMA, setShowMA, showVP, setShowVP, overlayToggles, toggleOverlay, T }: Props) {
  return (
    <>
      {/* Timeframe row */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 10 }} contentContainerStyle={{ paddingRight: 20 }}>
        <View style={{ flexDirection: 'row', gap: 6 }}>
          {TIMEFRAMES.map(t => (
            <Pressable key={t} onPress={() => setTf(t)} hitSlop={6}
              android_ripple={{ color: 'rgba(255,255,255,0.15)' }}
              style={({ pressed }) => ({
              paddingHorizontal: 14, paddingVertical: 7, borderRadius: RADIUS.sm,
              backgroundColor: tf === t ? T.accent : T.bg3,
              borderWidth: 1, borderColor: tf === t ? T.accent : T.border, opacity: pressed ? 0.75 : 1})}>
              <Text style={{ color: tf === t ? '#fff' : T.textSub, fontSize: 11, fontWeight: '700' }}>{t}</Text>
            </Pressable>
          ))}
        </View>
      </ScrollView>

      {/* Overlay toggle pills */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 10 }} contentContainerStyle={{ paddingRight: 20 }}>
        <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
          <Pill label="MA"        color={T.blue}   active={showMA}                     onPress={() => setShowMA(v => !v)} />
          <Pill label="VP"        color={T.amber}  active={showVP}                     onPress={() => setShowVP(v => !v)} />
          <Pill label="Bollinger" color={T.blue}   active={overlayToggles.bollinger}   onPress={() => toggleOverlay('bollinger')} />
          <Pill label="Donchian"  color={T.amber}  active={overlayToggles.donchian}    onPress={() => toggleOverlay('donchian')} />
          <Pill label="Keltner"   color={T.purple} active={overlayToggles.keltner}     onPress={() => toggleOverlay('keltner')} />
          <Pill label="Fib"       color={T.amber}  active={overlayToggles.fib}         onPress={() => toggleOverlay('fib')} />
          <Pill label="Pivots"    color={T.purple} active={overlayToggles.pivots}      onPress={() => toggleOverlay('pivots')} />
        </View>
      </ScrollView>
    </>
  );
});
