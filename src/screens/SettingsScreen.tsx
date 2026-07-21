import React, { useState } from 'react';
import { View, Text, TextInput, ScrollView, TouchableOpacity, ActivityIndicator, Linking, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useData } from '../context/DataContext';
import { Card, PrimaryButton, Skeleton } from '../components/Common';
import { resetOnboarding } from '../utils/onboarding';
import { LinearGradient } from 'expo-linear-gradient';
import { QuantisLogo, QUANTIS_TAGLINE } from '../components/QuantisLogo';
import { aoLogin } from '../api/angelOne';
import { BUILD_VERSION } from '../buildInfo';
import { RADIUS, SPACING } from '../theme/colors';
import { STRATEGY_ORDER } from '../utils/strategy/strategyProfiles';
import { getActiveStrategyId, setActiveStrategyId } from '../utils/strategy/strategyStorage';
import type { StrategyId } from '../utils/strategy/strategyTypes';

// Reusable connection card header - eliminates 3 identical status-dot+title patterns
function ConnHeader({ color, label, connected, T }: { color: string; label: string; connected: boolean; T: any }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: connected ? color : T.textDim }} />
      <Text style={{ color, fontWeight: '800', fontSize: 13, letterSpacing: 0.5, flex: 1 }}>{label}</Text>
      {connected && (
        <View style={{ backgroundColor: color + '18', borderRadius: RADIUS.sm, paddingHorizontal: 8, paddingVertical: 3 }}>
          <Text style={{ color, fontSize: 9, fontWeight: '800' }}>CONNECTED</Text>
        </View>
      )}
    </View>
  );
}

// Reusable input label
function FieldLabel({ label, T }: { label: string; T: any }) {
  return <Text style={{ color: T.textDim, fontSize: 10, fontWeight: '700', letterSpacing: 0.4, marginBottom: 5, marginTop: 12 }}>{label}</Text>;
}

export default function SettingsScreen() {
  const { theme: T, themeName, toggleTheme } = useTheme();
  const { aoSession, setAoSession, avKey, setAvKey, anthropicKey, setAnthropicKey } = useData();

  const [aoKey, setAoKey] = useState(aoSession?.apiKey || '');
  const [aoClient, setAoClient] = useState(aoSession?.clientCode || '');
  const [aoPass, setAoPass] = useState('');
  const [aoTotp, setAoTotp] = useState('');
  const [aoLoading, setAoLoading] = useState(false);
  const [aoErr, setAoErr] = useState('');
  const [avDraft, setAvDraft] = useState(avKey);
  const [anthropicDraft, setAnthropicDraft] = useState(anthropicKey);

  // Strategy selection
  const [activeStrategy, setActiveStrategy] = useState<StrategyId | null>(null);
  React.useEffect(() => {
    getActiveStrategyId().then(id => setActiveStrategy(id));
  }, []);

  async function handleStrategySelect(id: StrategyId | null) {
    setActiveStrategy(id);
    await setActiveStrategyId(id);
  }

  async function connectAO() {
    if (!aoKey || !aoClient || !aoPass || !aoTotp) { setAoErr('All fields required'); return; }
    setAoLoading(true); setAoErr('');
    try {
      const session = await aoLogin(aoKey, aoClient, aoPass, aoTotp);
      setAoSession(session);
    } catch (e: any) { setAoErr(e.message); }
    setAoLoading(false);
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>

        {/* About / Developer card */}
        <View style={{ marginBottom: 20 }}>
          <LinearGradient
            colors={[T.card, T.bg1]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
            style={{ borderRadius: RADIUS.lg, borderWidth: 1, borderColor: T.cardBorder, padding: SPACING.xl, ...T.elev2 }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 14 }}>
              <View style={{ borderRadius: RADIUS.md, overflow: 'hidden' }}>
                <QuantisLogo size={56} withBackground theme={themeName === 'light' ? 'light' : 'dark'} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: T.text, fontSize: 22, fontWeight: '800', letterSpacing: -0.3 }}>Quantis</Text>
                <Text style={{ color: T.textSub, fontSize: 12, fontWeight: '600', marginTop: 2 }}>{QUANTIS_TAGLINE}</Text>
              </View>
            </View>
            <View style={{ height: 1, backgroundColor: T.border, marginVertical: 4 }} />
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 14 }}>
              <View>
                <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', letterSpacing: 1 }}>CREATED BY</Text>
                <Text style={{ color: T.text, fontSize: 14, fontWeight: '700', marginTop: 3 }}>Datta Harshith Reddy</Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', letterSpacing: 1 }}>VERSION</Text>
                <Text style={{ color: T.accent, fontSize: 14, fontWeight: '800', marginTop: 3 }}>v{BUILD_VERSION}</Text>
              </View>
            </View>
            <Text style={{ color: T.textDim, fontSize: 10, lineHeight: 15, marginTop: 12, fontStyle: 'italic' }}>
              Building intelligent trading tools for everyone.
            </Text>
          </LinearGradient>
        </View>

        {/* Trading Strategy */}
        <Text style={{ color: T.textDim, fontSize: 10, fontWeight: '700', letterSpacing: 1.2, marginBottom: 8 }}>TRADING STRATEGY</Text>
        <Card theme={T} style={{ marginBottom: 20 }}>
          <Text style={{ color: T.text, fontSize: 13, fontWeight: '700', marginBottom: 4 }}>Strategy Mode</Text>
          <Text style={{ color: T.textDim, fontSize: 11, lineHeight: 16, marginBottom: 14 }}>
            Select your trading style. Trade Readiness, risk parameters, and confirmations
            will adapt to match. Selecting None uses the current default behaviour.
          </Text>

          {/* None option */}
          <TouchableOpacity
            onPress={() => handleStrategySelect(null)}
            activeOpacity={0.75}
            style={{
              flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
              paddingVertical: 11, paddingHorizontal: 12,
              backgroundColor: activeStrategy === null ? T.blue + '18' : T.bg3,
              borderRadius: RADIUS.sm, marginBottom: 8,
              borderWidth: 1,
              borderColor: activeStrategy === null ? T.blue + '60' : T.textDim + '20',
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Text style={{ fontSize: 16 }}>⚙️</Text>
              <View>
                <Text style={{ color: T.text, fontSize: 13, fontWeight: '700' }}>None</Text>
                <Text style={{ color: T.textDim, fontSize: 10, marginTop: 1 }}>
                  Default — all signals, current behaviour
                </Text>
              </View>
            </View>
            {activeStrategy === null && (
              <View style={{ width: 18, height: 18, borderRadius: 9,
                backgroundColor: T.blue, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ color: '#fff', fontSize: 10, fontWeight: '800' }}>✓</Text>
              </View>
            )}
          </TouchableOpacity>

          {/* Strategy pills */}
          {STRATEGY_ORDER.map(profile => {
            const isActive = activeStrategy === profile.id;
            return (
              <TouchableOpacity
                key={profile.id}
                onPress={() => handleStrategySelect(profile.id)}
                activeOpacity={0.75}
                style={{
                  flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                  paddingVertical: 11, paddingHorizontal: 12,
                  backgroundColor: isActive ? T.accent + '18' : T.bg3,
                  borderRadius: RADIUS.sm, marginBottom: 8,
                  borderWidth: 1,
                  borderColor: isActive ? T.accent + '60' : T.textDim + '20',
                }}
              >
                {/* Left: icon + name + description — flex:1 constrains description width */}
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 }}>
                  <Text style={{ fontSize: 16 }}>{profile.icon}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: T.text, fontSize: 13, fontWeight: '700' }}>{profile.name}</Text>
                    <Text style={{ color: T.textDim, fontSize: 10, marginTop: 1 }} numberOfLines={2}>
                      {profile.description}
                    </Text>
                  </View>
                </View>
                {/* Right: active tick + horizon/confidence badge — fixed width, never clips */}
                <View style={{ alignItems: 'flex-end', gap: 3, marginLeft: 8, minWidth: 72 }}>
                  {isActive && (
                    <View style={{ width: 18, height: 18, borderRadius: 9,
                      backgroundColor: T.accent, alignItems: 'center', justifyContent: 'center' }}>
                      <Text style={{ color: '#fff', fontSize: 10, fontWeight: '800' }}>✓</Text>
                    </View>
                  )}
                  <Text style={{ color: T.textDim, fontSize: 9, textAlign: 'right' }}>
                    h={profile.primaryHorizon} · conf≥{profile.minConfidence}
                  </Text>
                </View>
              </TouchableOpacity>
            );
          })}

          {activeStrategy && (
            <View style={{ marginTop: 4, padding: 10, backgroundColor: T.bg0,
              borderRadius: RADIUS.sm, borderWidth: 1, borderColor: T.textDim + '20' }}>
              <Text style={{ color: T.textDim, fontSize: 10, lineHeight: 15 }}>
                ⓘ  Strategy affects: Trade Readiness display, confidence threshold, stop/target
                multipliers, timeframe preference. It does not change how the ML engine or
                any indicator is calculated.
              </Text>
            </View>
          )}
        </Card>

        {/* Appearance */}
        <Text style={{ color: T.textDim, fontSize: 10, fontWeight: '700', letterSpacing: 1.2, marginBottom: 8 }}>APPEARANCE</Text>
        <Card theme={T} style={{ marginBottom: 20 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 44 }}>
            <View>
              <Text style={{ color: T.text, fontWeight: '700', fontSize: 13 }}>Theme</Text>
              <Text style={{ color: T.textDim, fontSize: 10, marginTop: 1 }}>{themeName === 'dark' ? 'Dark mode active' : 'Light mode active'}</Text>
            </View>
            <TouchableOpacity onPress={toggleTheme} activeOpacity={0.75} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: T.bg3, paddingHorizontal: 14, paddingVertical: 7, borderRadius: RADIUS.pill, minHeight: 36 }}>
              <Text>{themeName === 'dark' ? '☀️' : '🌙'}</Text>
              <Text style={{ color: T.textSub, fontSize: 11, fontWeight: '600' }}>{themeName === 'dark' ? 'Light Mode' : 'Dark Mode'}</Text>
            </TouchableOpacity>
          </View>
        </Card>

        {/* Connections */}
        <Text style={{ color: T.textDim, fontSize: 10, fontWeight: '700', letterSpacing: 1.2, marginBottom: 8 }}>CONNECTIONS</Text>

        {/* Anthropic */}
        <Card theme={T} style={{ marginBottom: 14, borderColor: anthropicKey ? T.cardBorder : T.amber + '50' }}>
          <ConnHeader color="#cc785c" label="ANTHROPIC — AI COPILOT" connected={!!anthropicKey} T={T} />
          <Text style={{ color: T.textSub, fontSize: 11, lineHeight: 17, marginBottom: 12 }}>
            Required for the 🧠 AI Copilot on the Chart screen. Get a key at{' '}
            <Text onPress={() => Linking.openURL('https://console.anthropic.com/settings/keys')} style={{ color: '#cc785c', textDecorationLine: 'underline' }}>
              console.anthropic.com
            </Text>
            {' '}— paid, usage-billed key (separate from a claude.ai subscription).
          </Text>
          <TextInput value={anthropicDraft} onChangeText={setAnthropicDraft} secureTextEntry style={inputStyle(T)} placeholder="sk-ant-..." placeholderTextColor={T.textDim} />
          <View style={{ marginTop: 12 }}>
            <PrimaryButton theme={T} label="Save Key" color="#cc785c" onPress={() => setAnthropicKey(anthropicDraft)} />
          </View>
          {!anthropicKey && <Text style={{ color: T.amber, fontSize: 10, marginTop: 10 }}>⚠ Without this key, the AI Copilot "Analyze" button will not work.</Text>}
        </Card>

        {/* Angel One */}
        <Card theme={T} style={{ marginBottom: 14 }}>
          <ConnHeader color={T.orange} label="ANGEL ONE — SmartAPI" connected={!!aoSession?.jwtToken} T={T} />
          <Text style={{ color: T.textSub, fontSize: 11, lineHeight: 17, marginBottom: 12 }}>
            Live NSE data — Nifty, Bank Nifty, and Indian stocks. No proxy needed on Android.
          </Text>
          <FieldLabel label="API KEY" T={T} />
          <TextInput value={aoKey} onChangeText={setAoKey} style={inputStyle(T)} placeholder="SmartAPI key" placeholderTextColor={T.textDim} />
          <FieldLabel label="CLIENT CODE" T={T} />
          <TextInput value={aoClient} onChangeText={setAoClient} style={inputStyle(T)} placeholder="Angel One client ID" placeholderTextColor={T.textDim} />
          <FieldLabel label="PASSWORD (PIN)" T={T} />
          <TextInput value={aoPass} onChangeText={setAoPass} secureTextEntry style={inputStyle(T)} placeholder="4-digit PIN" placeholderTextColor={T.textDim} />
          <FieldLabel label="TOTP (fresh code)" T={T} />
          <TextInput value={aoTotp} onChangeText={setAoTotp} keyboardType="numeric" maxLength={6} style={inputStyle(T)} placeholder="6-digit TOTP" placeholderTextColor={T.textDim} />
          {aoErr && <Text style={{ color: T.red, fontSize: 11, marginTop: 10 }}>⚠ {aoErr}</Text>}
          <View style={{ marginTop: 14 }}>
            {aoLoading
              ? <View style={{ alignItems: 'center', paddingVertical: 8 }}><ActivityIndicator color={T.orange} /></View>
              : <PrimaryButton theme={T} label={aoSession?.jwtToken ? 'Reconnect Angel One' : 'Connect Angel One'} color={T.orange} onPress={connectAO} />}
          </View>
        </Card>

        {/* Alpha Vantage */}
        <Card theme={T} style={{ marginBottom: 14 }}>
          <ConnHeader color={T.blue} label="ALPHA VANTAGE" connected={!!avKey} T={T} />
          <Text style={{ color: T.textSub, fontSize: 11, lineHeight: 17, marginBottom: 8 }}>
            US stocks (AAPL, NVDA, TSLA, MSFT) + real-time market news with sentiment analysis.
          </Text>
          <View style={{ backgroundColor: T.amber + '12', borderRadius: RADIUS.sm, padding: 10, marginBottom: 12 }}>
            <Text style={{ color: T.amber, fontSize: 10, lineHeight: 15 }}>
              ⚠ Free tier: 25 requests/day. Prices for affected stocks pause and revert to labeled simulated data until the next day — this is expected behavior, not a bug.
            </Text>
          </View>
          <TextInput value={avDraft} onChangeText={setAvDraft} style={inputStyle(T)} placeholder="Alpha Vantage API key" placeholderTextColor={T.textDim} />
          <View style={{ marginTop: 12 }}>
            <PrimaryButton theme={T} label="Save Key" onPress={() => setAvKey(avDraft)} />
          </View>
        </Card>

        {/* Auto-connected info */}
        <Card theme={T}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
            <Text style={{ fontSize: 14, marginTop: 1 }}>ℹ️</Text>
            <Text style={{ color: T.textDim, fontSize: 10, lineHeight: 16, flex: 1 }}>
              Auto-connected with no key needed: Binance WebSocket (crypto, real-time) and ExchangeRate API (forex, every 60s).
            </Text>
          </View>
        </Card>

        {/* ── Onboarding ── */}
        <View style={{ marginTop: 20 }}>
          <Text style={{ color: T.textDim, fontSize: 10, fontWeight: '700',
            letterSpacing: 0.8, marginBottom: 10 }}>TUTORIAL</Text>
          <TouchableOpacity
            onPress={async () => {
              await resetOnboarding();
              Alert.alert('Tutorial Reset',
                'The onboarding tutorial will appear the next time you restart the app.');
            }}
            style={{ backgroundColor: T.bg3, borderRadius: RADIUS.sm, padding: 14,
              borderWidth: 1, borderColor: T.border, flexDirection: 'row',
              alignItems: 'center', justifyContent: 'space-between' }}>
            <View>
              <Text style={{ color: T.text, fontWeight: '700', fontSize: 13 }}>
                Restart Tutorial
              </Text>
              <Text style={{ color: T.textDim, fontSize: 11, marginTop: 2 }}>
                Replay the onboarding walkthrough
              </Text>
            </View>
            <Text style={{ color: T.accent, fontSize: 18 }}>↺</Text>
          </TouchableOpacity>
        </View>

      </ScrollView>
    </SafeAreaView>
  );
}


function inputStyle(T: any) {
  return { backgroundColor: T.bg0, borderWidth: 1, borderColor: T.border, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 11, color: T.text, fontSize: 13, minHeight: 44 };
}
