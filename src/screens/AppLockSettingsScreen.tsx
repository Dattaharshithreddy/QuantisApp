// ─────────────────────────────────────────────────────────────────────────────
// APP LOCK SETTINGS SCREEN
// More → App Lock → enable/disable PIN + fingerprint
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, Switch, Alert, TextInput, TouchableOpacity,
         ScrollView, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { setMpin, removeMpin, hasMpin, getLockSettings,
         setLockSettings, isBiometricAvailable, authenticateWithBiometric } from '../services/appLock';

export default function AppLockSettingsScreen() {
  const { theme: T } = useTheme();
  const [loading,      setLoading]      = useState(true);
  const [lockEnabled,  setLockEnabled]  = useState(false);
  const [lockType,     setLockType]     = useState<'biometric'|'mpin'|'both'>('mpin');
  const [hasPIN,       setHasPIN]       = useState(false);
  const [bioAvail,     setBioAvail]     = useState(false);
  const [settingPin,   setSettingPin]   = useState(false);
  const [newPin,       setNewPin]       = useState('');
  const [confirmPin,   setConfirmPin]   = useState('');
  const [pinErr,       setPinErr]       = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const [settings, pin, bio] = await Promise.all([
      getLockSettings(),
      hasMpin(),
      isBiometricAvailable(),
    ]);
    setLockEnabled(settings.enabled);
    setLockType(settings.type);
    setHasPIN(pin);
    setBioAvail(bio);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, []);

  const toggleLock = useCallback(async (val: boolean) => {
    if (val && !hasPIN) {
      Alert.alert('Set PIN First', 'Please set a PIN before enabling the lock.');
      return;
    }
    setLockEnabled(val);
    await setLockSettings(val, lockType);
  }, [hasPIN, lockType]);

  const savePin = useCallback(async () => {
    setPinErr('');
    if (newPin.length < 4) { setPinErr('PIN must be at least 4 digits'); return; }
    if (newPin !== confirmPin) { setPinErr('PINs do not match'); return; }
    await setMpin(newPin);
    setHasPIN(true);
    setSettingPin(false);
    setNewPin(''); setConfirmPin('');
    Alert.alert('✅ PIN Set', 'Your PIN has been saved securely.');
  }, [newPin, confirmPin]);

  const removePin = useCallback(async () => {
    Alert.alert('Remove PIN', 'This will also disable the app lock.',
      [{ text: 'Cancel', style: 'cancel' },
       { text: 'Remove', style: 'destructive', onPress: async () => {
         await removeMpin();
         await setLockSettings(false, lockType);
         setHasPIN(false); setLockEnabled(false);
       }}]);
  }, [lockType]);

  const testBiometric = useCallback(async () => {
    const ok = await authenticateWithBiometric();
    Alert.alert(ok ? '✅ Success' : '❌ Failed',
      ok ? 'Biometric works correctly.' : 'Biometric authentication failed.');
  }, []);

  if (loading) return (
    <View style={{ flex:1, backgroundColor: T.bg0, alignItems:'center', justifyContent:'center' }}>
      <ActivityIndicator color={T.accent} />
    </View>
  );

  return (
    <SafeAreaView style={{ flex:1, backgroundColor: T.bg0 }}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>

        {/* Enable Lock */}
        <View style={{ backgroundColor: T.card, borderRadius: 12, padding: 16,
          borderWidth: 1, borderColor: T.border }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <View>
              <Text style={{ color: T.text, fontSize: 16, fontWeight: '700' }}>App Lock</Text>
              <Text style={{ color: T.textDim, fontSize: 12, marginTop: 2 }}>
                Require PIN or fingerprint to open
              </Text>
            </View>
            <Switch value={lockEnabled} onValueChange={toggleLock}
              thumbColor={lockEnabled ? T.accent : T.textDim}
              trackColor={{ false: T.bg3, true: T.accent + '60' }} />
          </View>
        </View>

        {/* PIN Setup */}
        <View style={{ backgroundColor: T.card, borderRadius: 12, padding: 16,
          borderWidth: 1, borderColor: T.border }}>
          <Text style={{ color: T.textDim, fontSize: 10, fontWeight: '700',
            letterSpacing: 0.8, marginBottom: 12 }}>MPIN</Text>

          {hasPIN ? (
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <TouchableOpacity onPress={() => setSettingPin(true)} style={{
                flex:1, backgroundColor: T.accent + '22', borderRadius: 8,
                padding: 12, alignItems: 'center', borderWidth: 1, borderColor: T.accent }}>
                <Text style={{ color: T.accent, fontWeight: '600', fontSize: 13 }}>Change PIN</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={removePin} style={{
                flex:1, backgroundColor: T.bg3, borderRadius: 8,
                padding: 12, alignItems: 'center' }}>
                <Text style={{ color: '#ef4444', fontWeight: '600', fontSize: 13 }}>Remove PIN</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity onPress={() => setSettingPin(true)} style={{
              backgroundColor: T.accent, borderRadius: 8, padding: 14, alignItems: 'center' }}>
              <Text style={{ color: '#fff', fontWeight: '700', fontSize: 14 }}>Set MPIN</Text>
            </TouchableOpacity>
          )}

          {settingPin && (
            <View style={{ marginTop: 16, gap: 10 }}>
              <TextInput
                placeholder="Enter new PIN (4-6 digits)"
                placeholderTextColor={T.textDim}
                value={newPin}
                onChangeText={setNewPin}
                keyboardType="numeric"
                secureTextEntry maxLength={6}
                style={{ backgroundColor: T.bg2, borderRadius: 8, padding: 12,
                  color: T.text, borderWidth: 1, borderColor: T.border,
                  fontSize: 20, letterSpacing: 8, textAlign: 'center' }} />
              <TextInput
                placeholder="Confirm PIN"
                placeholderTextColor={T.textDim}
                value={confirmPin}
                onChangeText={setConfirmPin}
                keyboardType="numeric"
                secureTextEntry maxLength={6}
                style={{ backgroundColor: T.bg2, borderRadius: 8, padding: 12,
                  color: T.text, borderWidth: 1, borderColor: T.border,
                  fontSize: 20, letterSpacing: 8, textAlign: 'center' }} />
              {!!pinErr && <Text style={{ color: '#ef4444', fontSize: 12 }}>{pinErr}</Text>}
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <TouchableOpacity onPress={() => { setSettingPin(false); setNewPin(''); setConfirmPin(''); setPinErr(''); }}
                  style={{ flex:1, backgroundColor: T.bg3, borderRadius: 8, padding: 12, alignItems: 'center' }}>
                  <Text style={{ color: T.textDim, fontWeight: '600' }}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={savePin}
                  style={{ flex:1, backgroundColor: T.accent, borderRadius: 8, padding: 12, alignItems: 'center' }}>
                  <Text style={{ color: '#fff', fontWeight: '700' }}>Save PIN</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </View>

        {/* Biometric */}
        <View style={{ backgroundColor: T.card, borderRadius: 12, padding: 16,
          borderWidth: 1, borderColor: T.border }}>
          <Text style={{ color: T.textDim, fontSize: 10, fontWeight: '700',
            letterSpacing: 0.8, marginBottom: 12 }}>BIOMETRIC (FINGERPRINT / FACE)</Text>
          {bioAvail ? (
            <View style={{ gap: 10 }}>
              <Text style={{ color: T.text, fontSize: 13 }}>
                ✅ Fingerprint / Face ID available on this device
              </Text>
              <TouchableOpacity onPress={testBiometric} style={{
                backgroundColor: T.bg2, borderRadius: 8, padding: 12,
                alignItems: 'center', borderWidth: 1, borderColor: T.border }}>
                <Text style={{ color: T.text, fontWeight: '600' }}>🔑 Test Biometric</Text>
              </TouchableOpacity>
              <Text style={{ color: T.textDim, fontSize: 11 }}>
                When app lock is enabled, fingerprint/face will be shown first.
                Fall back to PIN if biometric fails.
              </Text>
            </View>
          ) : (
            <Text style={{ color: T.textDim, fontSize: 13 }}>
              ❌ No fingerprint or face unlock enrolled on this device.
              Go to phone Settings → Security → Fingerprint to set it up.
            </Text>
          )}
        </View>

        {/* Security note */}
        <Text style={{ color: T.textDim, fontSize: 11, textAlign: 'center', lineHeight: 16 }}>
          PIN is stored in Android Keystore encryption.{'\n'}
          Lock activates after 30 seconds in background.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}
