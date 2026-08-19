// ─────────────────────────────────────────────────────────────────────────────
// NOTIFICATION SETTINGS SCREEN
// More → Notifications — toggle each notification type on/off
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, Switch, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import {
  NotifType, NotifSettings, getNotifSettings, setNotifSetting, requestPermission,
} from '../services/notifications';
import { SPACING, RADIUS } from '../theme/colors';

type NotifItem = { type: NotifType; title: string; desc: string; emoji: string };

const NOTIF_ITEMS: NotifItem[] = [
  { type: 'PRICE_ALERT',    emoji: '🎯', title: 'Price Alerts',        desc: 'When price crosses your set threshold' },
  { type: 'TRADE_OPENED',   emoji: '📋', title: 'Trade Opened',        desc: 'When a paper or live position opens' },
  { type: 'TRADE_CLOSED',   emoji: '✅', title: 'Trade Closed',        desc: 'When a position closes with P&L result' },
  { type: 'SL_HIT',         emoji: '🛑', title: 'Stop Loss Hit',       desc: 'When stop loss triggers on any position' },
  { type: 'TP_HIT',         emoji: '💰', title: 'Take Profit Hit',     desc: 'When take profit level is reached' },
  { type: 'LIVE_FILL',      emoji: '🔴', title: 'Live Order Filled',   desc: 'When a live broker order is confirmed' },
  { type: 'SCANNER_SIGNAL', emoji: '🔍', title: 'Scanner Signals',     desc: 'When scanner finds high-quality setups' },
  { type: 'EVAL_COMPLETE',  emoji: '📈', title: 'Evaluation Complete', desc: 'When production model evaluation finishes' },
  { type: 'TRAIN_COMPLETE', emoji: '🧠', title: 'Training Complete',   desc: 'When ML model retrains (can be frequent)' },
  { type: 'DAILY_SUMMARY',  emoji: '📊', title: 'Daily Summary',       desc: 'End-of-day P&L summary each evening' },
];

export default function NotificationSettingsScreen() {
  const { theme: T } = useTheme();
  const [settings, setSettings] = useState<NotifSettings | null>(null);
  const [hasPermission, setHasPermission] = useState(false);

  const load = useCallback(async () => {
    const [s] = await Promise.all([getNotifSettings()]);
    setSettings(s);
    const { status } = await (await import('expo-notifications')).getPermissionsAsync();
    setHasPermission(status === 'granted');
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleRequestPermission() {
    const granted = await requestPermission();
    setHasPermission(granted);
    if (!granted) {
      Alert.alert(
        'Permission Required',
        'Enable notifications in your device Settings → Apps → Quantis → Notifications.',
      );
    }
  }

  async function toggle(type: NotifType, value: boolean) {
    await setNotifSetting(type, value);
    setSettings(prev => prev ? { ...prev, [type]: value } : prev);
  }

  if (!settings) return null;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      <ScrollView contentContainerStyle={{ padding: SPACING.md }}>

        {/* ── Permission banner ───────────────────────────────────────── */}
        {!hasPermission && (
          <TouchableOpacity onPress={handleRequestPermission}
            style={{ backgroundColor: T.accent + '18', borderRadius: RADIUS.md,
              padding: 14, borderWidth: 1, borderColor: T.accent + '40', marginBottom: 20,
              flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <Text style={{ fontSize: 24 }}>🔔</Text>
            <View style={{ flex: 1 }}>
              <Text style={{ color: T.accent, fontWeight: '700', fontSize: 13 }}>
                Enable Notifications
              </Text>
              <Text style={{ color: T.textDim, fontSize: 11, marginTop: 2 }}>
                Tap to grant permission so Quantis can send alerts
              </Text>
            </View>
          </TouchableOpacity>
        )}

        {/* ── Enable all / Disable all ────────────────────────────────── */}
        <View style={{ flexDirection: 'row', gap: 10, marginBottom: 20 }}>
          {[true, false].map(val => (
            <TouchableOpacity key={String(val)}
              onPress={async () => {
                const updated = { ...settings };
                for (const k of Object.keys(updated) as NotifType[]) {
                  updated[k] = val;
                  await setNotifSetting(k, val);
                }
                setSettings(updated);
              }}
              style={{ flex: 1, padding: 10, borderRadius: RADIUS.sm, alignItems: 'center',
                backgroundColor: val ? T.green + '18' : T.red + '18',
                borderWidth: 1, borderColor: val ? T.green + '40' : T.red + '40' }}>
              <Text style={{ color: val ? T.green : T.red, fontWeight: '700', fontSize: 12 }}>
                {val ? 'Enable All' : 'Disable All'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* ── Notification list ───────────────────────────────────────── */}
        <View style={{ backgroundColor: T.card, borderRadius: RADIUS.md,
          borderWidth: 1, borderColor: T.border, overflow: 'hidden' }}>
          {NOTIF_ITEMS.map((item, idx) => (
            <View key={item.type} style={{
              flexDirection: 'row', alignItems: 'center', padding: 14,
              borderBottomWidth: idx < NOTIF_ITEMS.length - 1 ? 0.5 : 0,
              borderBottomColor: T.border,
            }}>
              <Text style={{ fontSize: 22, marginRight: 12 }}>{item.emoji}</Text>
              <View style={{ flex: 1 }}>
                <Text style={{ color: T.text, fontWeight: '600', fontSize: 14 }}>
                  {item.title}
                </Text>
                <Text style={{ color: T.textDim, fontSize: 11, marginTop: 2 }}>
                  {item.desc}
                </Text>
              </View>
              <Switch
                value={settings[item.type]}
                onValueChange={v => toggle(item.type, v)}
                trackColor={{ false: T.bg3, true: T.accent + '80' }}
                thumbColor={settings[item.type] ? T.accent : T.textDim}
              />
            </View>
          ))}
        </View>

        <Text style={{ color: T.textDim, fontSize: 10, textAlign: 'center',
          marginTop: 20, lineHeight: 16 }}>
          Notifications are local — they appear even when app is in background.{'\n'}
          Price alerts fire on every price tick while the app is running.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}
