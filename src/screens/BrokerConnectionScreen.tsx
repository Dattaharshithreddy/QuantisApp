// ─────────────────────────────────────────────────────────────────────────────
// BrokerConnectionScreen  (v1.0.0)
//
// Where users connect trading accounts for live order placement.
// Same credential pattern as SettingsScreen (expo-secure-store).
// Angel One uses existing aoSession from DataContext.
// Binance adds apiKey + apiSecret specifically for trading.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, TextInput, TouchableOpacity, Alert, Linking } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useData } from '../context/DataContext';
import { Card, SectionLabel } from '../components/Common';
import { getLiveTradingCredential, setLiveTradingCredential, deleteLiveTradingCredential } from '../utils/secureCredentials';
import { testCdxCredentials } from '../utils/execution/CoinDCXExecutor';
import { testCdxFuturesCredentials } from '../utils/execution/CoinDCXFuturesExecutor';
import { SPACING, RADIUS } from '../theme/colors';

function StatusBadge({ connected, T }: { connected: boolean; T: any }) {
  return (
    <View style={{ backgroundColor: connected ? T.green + '20' : T.red + '15', borderRadius: 4,
      paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1, borderColor: connected ? T.green : T.red + '50' }}>
      <Text style={{ color: connected ? T.green : T.red, fontSize: 9, fontWeight: '700' }}>
        {connected ? '● CONNECTED' : '○ NOT CONNECTED'}
      </Text>
    </View>
  );
}

function SecureInput({ label, value, onChange, placeholder, T }: any) {
  return (
    <View style={{ marginBottom: 10 }}>
      <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', marginBottom: 4 }}>{label}</Text>
      <TextInput
        value={value} onChangeText={onChange}
        placeholder={placeholder} placeholderTextColor={T.textDim}
        secureTextEntry autoCorrect={false} autoCapitalize="none"
        style={{ backgroundColor: T.bg3, color: T.text, borderRadius: RADIUS.sm,
          paddingHorizontal: 12, paddingVertical: 10, fontSize: 12,
          borderWidth: 1, borderColor: T.border, fontFamily: 'monospace' }}
      />
    </View>
  );
}

export default function BrokerConnectionScreen() {
  const { theme: T } = useTheme();
  const { aoSession } = useData();

  const [bnKey,    setBnKey]    = useState('');
  const [bnSecret, setBnSecret] = useState('');
  const [bnConnected, setBnConnected] = useState(false);
  const [saving, setSaving] = useState(false);

  // ── CoinDCX state ─────────────────────────────────────────────────────────
  const [cdxKey,       setCdxKey]       = useState('');
  const [cdxSecret,    setCdxSecret]    = useState('');
  const [cdxConnected, setCdxConnected] = useState(false);
  const [cdxTesting,   setCdxTesting]   = useState(false);

  useEffect(() => {
    getLiveTradingCredential('binanceApiKey').then(k => {
      if (k) { setBnKey(k); setBnConnected(true); }
    });
    getLiveTradingCredential('cdxApiKey').then(k => {
      if (k) { setCdxKey(k); setCdxConnected(true); }
    });
  }, []);

  const saveBinance = useCallback(async () => {
    if (!bnKey.trim() || !bnSecret.trim()) {
      Alert.alert('Missing Fields', 'Both API Key and API Secret are required.');
      return;
    }
    setSaving(true);
    try {
      await setLiveTradingCredential('binanceApiKey',    bnKey.trim());
      await setLiveTradingCredential('binanceApiSecret', bnSecret.trim());
      setBnConnected(true);
      Alert.alert('Binance Connected', 'Trading API keys saved securely.');
    } finally { setSaving(false); }
  }, [bnKey, bnSecret]);

  const disconnectBinance = useCallback(async () => {
    Alert.alert('Disconnect Binance', 'Remove trading API keys?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: async () => {
        await deleteLiveTradingCredential('binanceApiKey');
        await deleteLiveTradingCredential('binanceApiSecret');
        setBnKey(''); setBnSecret(''); setBnConnected(false);
      }},
    ]);
  }, []);

  // ── CoinDCX actions ────────────────────────────────────────────────────────
  const saveCoinDCX = useCallback(async () => {
    if (!cdxKey.trim() || !cdxSecret.trim()) {
      Alert.alert('Missing Fields', 'Both API Key and API Secret are required.');
      return;
    }
    setSaving(true);
    try {
      // Test credentials before saving — prevents storing wrong keys
      setCdxTesting(true);
      const err = await testCdxCredentials(cdxKey.trim(), cdxSecret.trim());
      setCdxTesting(false);
      if (err) {
        Alert.alert('Connection Failed', `Could not connect to CoinDCX:\n${err}\n\nCheck your API key and secret.`);
        return;
      }
      await setLiveTradingCredential('cdxApiKey',    cdxKey.trim());
      await setLiveTradingCredential('cdxApiSecret', cdxSecret.trim());
      setCdxConnected(true);
      Alert.alert('CoinDCX Connected', 'Trading API keys saved and verified.');
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally {
      setSaving(false);
      setCdxTesting(false);
    }
  }, [cdxKey, cdxSecret]);

  const disconnectCoinDCX = useCallback(async () => {
    Alert.alert('Disconnect CoinDCX', 'Remove CoinDCX trading API keys?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: async () => {
        await deleteLiveTradingCredential('cdxApiKey');
        await deleteLiveTradingCredential('cdxApiSecret');
        setCdxKey(''); setCdxSecret(''); setCdxConnected(false);
      }},
    ]);
  }, []);

  const inputStyle = { backgroundColor: T.bg3, color: T.text, borderRadius: RADIUS.sm,
    paddingHorizontal: 12, paddingVertical: 10, fontSize: 12,
    borderWidth: 1, borderColor: T.border, marginBottom: 10, fontFamily: 'monospace' };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      <ScrollView contentContainerStyle={{ padding: SPACING.md, paddingBottom: 40 }}>
        <Text style={{ color: T.text, fontSize: 22, fontWeight: '800', marginBottom: 4 }}>Broker Connection</Text>
        <Text style={{ color: T.textDim, fontSize: 11, marginBottom: 20, lineHeight: 16 }}>
          Connect your trading accounts for live order placement. Credentials are stored
          encrypted on your device. QUANTIS never holds or transfers funds.
        </Text>

        {/* ── Warning banner ── */}
        <View style={{ backgroundColor: T.amber + '15', borderRadius: 8, padding: 12, marginBottom: 16,
          borderWidth: 1, borderColor: T.amber + '40' }}>
          <Text style={{ color: T.amber, fontSize: 10, fontWeight: '700', marginBottom: 4 }}>
            ⚠️ LIVE TRADING — REAL MONEY
          </Text>
          <Text style={{ color: T.textDim, fontSize: 9, lineHeight: 14 }}>
            Orders placed in LIVE mode use real funds. Start with small positions.
            For Binance API keys: NEVER enable withdrawal permissions.
          </Text>
        </View>

        {/* ── Angel One ── */}
        <Card theme={T} style={{ marginBottom: 16 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <View>
              <SectionLabel theme={T}>🟠 ANGEL ONE — NSE/BSE</SectionLabel>
              <Text style={{ color: T.textDim, fontSize: 9, marginTop: 2 }}>Uses your existing SmartAPI session</Text>
            </View>
            <StatusBadge connected={!!aoSession?.jwtToken} T={T} />
          </View>
          {aoSession?.jwtToken ? (
            <View>
              <Text style={{ color: T.textDim, fontSize: 9 }}>
                Client: {aoSession.clientCode} · Session active
              </Text>
              <Text style={{ color: T.textDim, fontSize: 9, marginTop: 4 }}>
                To reconnect or change account, go to Settings → Angel One.
              </Text>
            </View>
          ) : (
            <Text style={{ color: T.red, fontSize: 10 }}>
              Not connected. Go to Settings → Angel One to connect your account first.
            </Text>
          )}
        </Card>

        {/* ── Binance ── */}
        <Card theme={T} style={{ marginBottom: 16 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <View>
              <SectionLabel theme={T}>🟡 BINANCE — CRYPTO SPOT</SectionLabel>
              <Text style={{ color: T.textDim, fontSize: 9, marginTop: 2 }}>Separate trading API key required</Text>
            </View>
            <StatusBadge connected={bnConnected} T={T} />
          </View>

          <TouchableOpacity onPress={() => Linking.openURL('https://www.binance.com/en/my/settings/api-management')}
            style={{ marginBottom: 12 }}>
            <Text style={{ color: T.accent, fontSize: 9, textDecorationLine: 'underline' }}>
              Create API key at binance.com → API Management
            </Text>
          </TouchableOpacity>

          <View style={{ backgroundColor: T.red + '10', borderRadius: 6, padding: 8, marginBottom: 12,
            borderWidth: 1, borderColor: T.red + '30' }}>
            <Text style={{ color: T.red, fontSize: 9, fontWeight: '700' }}>
              REQUIRED: Disable "Enable Withdrawals" on your Binance API key.
            </Text>
            <Text style={{ color: T.textDim, fontSize: 9, marginTop: 2 }}>
              Enable only: Enable Reading + Enable Spot & Margin Trading
            </Text>
          </View>

          <SecureInput label="API KEY" value={bnKey} onChange={setBnKey}
            placeholder="Enter Binance API Key" T={T} />
          <SecureInput label="API SECRET" value={bnSecret} onChange={setBnSecret}
            placeholder="Enter Binance API Secret" T={T} />

          <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
            <TouchableOpacity onPress={saveBinance} disabled={saving}
              style={{ flex: 1, backgroundColor: T.accent, borderRadius: RADIUS.sm,
                padding: 12, alignItems: 'center', opacity: saving ? 0.6 : 1 }}>
              <Text style={{ color: '#fff', fontWeight: '700', fontSize: 12 }}>
                {saving ? 'Saving…' : bnConnected ? 'Update Keys' : 'Connect Binance'}
              </Text>
            </TouchableOpacity>
            {bnConnected && (
              <TouchableOpacity onPress={disconnectBinance}
                style={{ backgroundColor: T.red + '20', borderRadius: RADIUS.sm,
                  padding: 12, alignItems: 'center', borderWidth: 1, borderColor: T.red + '40' }}>
                <Text style={{ color: T.red, fontWeight: '700', fontSize: 12 }}>Disconnect</Text>
              </TouchableOpacity>
            )}
          </View>
        </Card>

        <Text style={{ color: T.textDim, fontSize: 9, textAlign: 'center', lineHeight: 13 }}>
          API keys are stored using Android Keystore encryption (expo-secure-store).{'\n'}
          QUANTIS never transmits your keys to external servers.{'\n'}
          Keys are used only to place orders on your behalf.
        </Text>
        {/* ── CoinDCX ─────────────────────────────────────────────────────── */}
        <Card theme={T} style={{ marginTop: 16 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <View>
              <Text style={{ color: T.text, fontWeight: '700', fontSize: 15 }}>CoinDCX</Text>
              <Text style={{ color: T.textDim, fontSize: 10, marginTop: 2 }}>Spot + Futures trading · Same API key for both</Text>
            </View>
            <StatusBadge connected={cdxConnected} T={T} />
          </View>

          {!cdxConnected ? (
            <>
              <Text style={{ color: T.textDim, fontSize: 11, marginBottom: 4, lineHeight: 16 }}>
                Create an API key at CoinDCX → Settings → API & Security.
              One key covers Spot AND Futures (perpetuals up to 100x).
              </Text>
              <Text style={{ color: T.textDim, fontSize: 11, marginBottom: 12, lineHeight: 16 }}>
                Enable: Read Info, Trade Orders. Do NOT enable Withdrawal.
              </Text>
              <SecureInput label="API KEY" value={cdxKey} onChange={setCdxKey}
                placeholder="Enter CoinDCX API key" T={T} />
              <SecureInput label="API SECRET" value={cdxSecret} onChange={setCdxSecret}
                placeholder="Enter CoinDCX API secret" T={T} />
              <TouchableOpacity
                onPress={saveCoinDCX}
                disabled={saving || cdxTesting || !cdxKey.trim() || !cdxSecret.trim()}
                style={{ backgroundColor: T.accent, borderRadius: RADIUS.sm, padding: 12,
                  alignItems: 'center', opacity: (saving || cdxTesting) ? 0.6 : 1 }}>
                <Text style={{ color: '#fff', fontWeight: '700' }}>
                  {cdxTesting ? 'Testing connection…' : saving ? 'Saving…' : 'Connect CoinDCX'}
                </Text>
              </TouchableOpacity>
            </>
          ) : (
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={{ color: T.textDim, fontSize: 12 }}>API keys saved securely on device</Text>
              <TouchableOpacity onPress={disconnectCoinDCX}
                style={{ backgroundColor: T.red + '20', borderRadius: RADIUS.sm,
                  paddingHorizontal: 12, paddingVertical: 6 }}>
                <Text style={{ color: T.red, fontWeight: '700', fontSize: 12 }}>Disconnect</Text>
              </TouchableOpacity>
            </View>
          )}
        </Card>

      </ScrollView>
    </SafeAreaView>
  );
}
