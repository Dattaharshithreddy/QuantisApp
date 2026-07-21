// ─────────────────────────────────────────────────────────────────────────────
// LiveTradeSettingsScreen  (v1.0.0)
// Live-trading-specific settings: MANUAL/AUTO mode, order type default,
// per-day limits, and notification preferences.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Switch, TextInput, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTheme } from '../context/ThemeContext';
import { Card, SectionLabel } from '../components/Common';
import { SPACING, RADIUS } from '../theme/colors';

const KEY = 'liveTradeSettings_v1';

export type LiveTradeSettings = {
  executionMode:      'MANUAL' | 'AUTO';
  defaultOrderType:   'MARKET' | 'LIMIT';
  maxTradesPerDay:    number;
  maxPositionValue:   number;
  pauseAfterLosses:   number;
  notifyOnFill:       boolean;
  notifyOnSLHit:      boolean;
  notifyOnTPHit:      boolean;
  notifyOnAutoTrade:  boolean;
};

const DEFAULTS: LiveTradeSettings = {
  executionMode:     'MANUAL',
  defaultOrderType:  'LIMIT',
  maxTradesPerDay:   5,
  maxPositionValue:  50000,
  pauseAfterLosses:  3,
  notifyOnFill:      true,
  notifyOnSLHit:     true,
  notifyOnTPHit:     true,
  notifyOnAutoTrade: true,
};

export async function getLiveTradeSettings(): Promise<LiveTradeSettings> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
  } catch { return { ...DEFAULTS }; }
}

export async function saveLiveTradeSettings(s: LiveTradeSettings): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(s));
}

function SettingRow({ label, sub, children, T }: any) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
      paddingVertical: 10, borderBottomWidth: 0.5, borderBottomColor: T.border + '40' }}>
      <View style={{ flex: 1, marginRight: 12 }}>
        <Text style={{ color: T.text, fontSize: 12 }}>{label}</Text>
        {sub && <Text style={{ color: T.textDim, fontSize: 9, marginTop: 2, lineHeight: 13 }}>{sub}</Text>}
      </View>
      {children}
    </View>
  );
}

export default function LiveTradeSettingsScreen() {
  const { theme: T } = useTheme();
  const [s, setS] = useState<LiveTradeSettings>(DEFAULTS);

  useEffect(() => { getLiveTradeSettings().then(setS); }, []);

  const update = useCallback(<K extends keyof LiveTradeSettings>(key: K, val: LiveTradeSettings[K]) => {
    setS(prev => {
      const next = { ...prev, [key]: val };
      saveLiveTradeSettings(next).catch(() => {});
      return next;
    });
  }, []);

  const ModeButton = ({ mode, label, sub }: { mode: 'MANUAL' | 'AUTO'; label: string; sub: string }) => (
    <TouchableOpacity onPress={() => {
      if (mode === 'AUTO') {
        Alert.alert('Enable AUTO Mode?',
          'In AUTO mode, QUANTIS will place real orders automatically when the scanner detects a signal — without you tapping a button.\n\nStart with MANUAL mode until you are confident in the signal quality.',
          [
            { text: 'Keep MANUAL', style: 'cancel' },
            { text: 'Enable AUTO', onPress: () => update('executionMode', 'AUTO') },
          ]);
      } else {
        update('executionMode', 'MANUAL');
      }
    }}
      style={{ flex: 1, backgroundColor: s.executionMode === mode ? T.accent : T.bg3,
        borderRadius: RADIUS.sm, padding: 10, marginHorizontal: 3, alignItems: 'center',
        borderWidth: 1, borderColor: s.executionMode === mode ? T.accent : T.border }}>
      <Text style={{ color: s.executionMode === mode ? '#fff' : T.textDim, fontSize: 11, fontWeight: '700' }}>{label}</Text>
      <Text style={{ color: s.executionMode === mode ? '#ffffffaa' : T.textDim, fontSize: 9, marginTop: 2, textAlign: 'center' }}>{sub}</Text>
    </TouchableOpacity>
  );

  const numInput = (key: keyof LiveTradeSettings, label: string, prefix?: string) => (
    <SettingRow label={label} T={T}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        {prefix && <Text style={{ color: T.textDim, fontSize: 11 }}>{prefix}</Text>}
        <TextInput
          value={String(s[key])}
          onChangeText={v => { const n = parseInt(v); if (!isNaN(n) && n > 0) update(key as any, n as any); }}
          keyboardType="number-pad"
          style={{ backgroundColor: T.bg3, color: T.text, borderRadius: 6,
            paddingHorizontal: 10, paddingVertical: 6, fontSize: 12, minWidth: 70,
            borderWidth: 1, borderColor: T.border, textAlign: 'right' }}
        />
      </View>
    </SettingRow>
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      <ScrollView contentContainerStyle={{ padding: SPACING.md, paddingBottom: 40 }}>
        <Text style={{ color: T.text, fontSize: 22, fontWeight: '800', marginBottom: 4 }}>Live Trade Settings</Text>
        <Text style={{ color: T.textDim, fontSize: 11, marginBottom: 20 }}>
          These settings apply only to live trading with real money.
        </Text>

        {/* Execution mode */}
        <Card theme={T} style={{ marginBottom: 16 }}>
          <SectionLabel theme={T}>EXECUTION MODE</SectionLabel>
          <View style={{ flexDirection: 'row', marginTop: 8 }}>
            <ModeButton mode="MANUAL" label="MANUAL" sub="You confirm every trade" />
            <ModeButton mode="AUTO"   label="AUTO"   sub="Scanner places trades automatically" />
          </View>
          {s.executionMode === 'AUTO' && (
            <View style={{ backgroundColor: T.amber + '15', borderRadius: 6, padding: 8, marginTop: 10,
              borderWidth: 1, borderColor: T.amber + '40' }}>
              <Text style={{ color: T.amber, fontSize: 9, fontWeight: '700' }}>
                ⚠️ AUTO mode places real orders without confirmation. Only use while actively monitoring the app.
              </Text>
            </View>
          )}
        </Card>

        {/* Order type */}
        <Card theme={T} style={{ marginBottom: 16 }}>
          <SectionLabel theme={T}>DEFAULT ORDER TYPE</SectionLabel>
          <View style={{ flexDirection: 'row', marginTop: 8, gap: 8 }}>
            {(['LIMIT', 'MARKET'] as const).map(t => (
              <TouchableOpacity key={t} onPress={() => update('defaultOrderType', t)}
                style={{ flex: 1, backgroundColor: s.defaultOrderType === t ? T.accent : T.bg3,
                  borderRadius: RADIUS.sm, padding: 10, alignItems: 'center',
                  borderWidth: 1, borderColor: s.defaultOrderType === t ? T.accent : T.border }}>
                <Text style={{ color: s.defaultOrderType === t ? '#fff' : T.textDim, fontSize: 11, fontWeight: '700' }}>{t}</Text>
                <Text style={{ color: s.defaultOrderType === t ? '#ffffffaa' : T.textDim, fontSize: 9, marginTop: 2, textAlign: 'center' }}>
                  {t === 'LIMIT' ? 'Better price, may not fill' : 'Always fills, may slip'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </Card>

        {/* Safety limits */}
        <Card theme={T} style={{ marginBottom: 16 }}>
          <SectionLabel theme={T}>SAFETY LIMITS</SectionLabel>
          {numInput('maxTradesPerDay', 'Max trades per day')}
          {numInput('maxPositionValue', 'Max position value', '₹')}
          {numInput('pauseAfterLosses', 'Pause after consecutive losses')}
        </Card>

        {/* Notifications */}
        <Card theme={T} style={{ marginBottom: 16 }}>
          <SectionLabel theme={T}>NOTIFICATIONS</SectionLabel>
          {([
            ['notifyOnFill',       'Order filled',          'When a placed order executes'],
            ['notifyOnSLHit',      'Stop loss hit',         'When a position hits stop loss'],
            ['notifyOnTPHit',      'Take profit hit',       'When a position hits take profit'],
            ['notifyOnAutoTrade',  'AUTO trade opened',     'When AUTO mode places a trade'],
          ] as [keyof LiveTradeSettings, string, string][]).map(([key, label, sub]) => (
            <SettingRow key={key} label={label} sub={sub} T={T}>
              <Switch
                value={!!s[key]}
                onValueChange={v => update(key, v as any)}
                trackColor={{ false: T.border, true: T.accent }}
                thumbColor="#fff"
              />
            </SettingRow>
          ))}
        </Card>

        <Text style={{ color: T.textDim, fontSize: 9, textAlign: 'center', lineHeight: 13 }}>
          Settings are saved automatically.{'\n'}
          MANUAL mode is always recommended for new live traders.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}
