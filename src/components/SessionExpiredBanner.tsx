// ─────────────────────────────────────────────────────────────────────────────
// SESSION EXPIRED BANNER  (v1.0.0)
//
// Shown when aoSession is null (cleared on 401) AND credentials exist
// (apiKey + clientCode stored in session mean the user has previously connected).
//
// The banner appears on the Chart screen bottom area and on any live trading
// action (OrderConfirmationScreen validates session before sending).
//
// The user must re-enter PIN + TOTP to renew the session. PIN is never stored
// (security). TOTP is a 30-second one-time code — must be entered fresh.
//
// Design: compact dismissible banner at bottom of screen, not a full modal,
// so it doesn't block the chart or analysis workflow.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState } from 'react';
import { View, Text, TouchableOpacity, TextInput, ActivityIndicator, Alert } from 'react-native';
import { useData } from '../context/DataContext';
import { aoLogin } from '../api/angelOne';
import { isAOSessionExpiringSoon } from '../utils/aoSessionManager';
import { useTheme } from '../context/ThemeContext';
import { RADIUS } from '../theme/colors';

export function SessionExpiredBanner() {
  const { aoSession, setAoSession } = useData();
  const { theme: T } = useTheme();

  // Only show if session is null AND we have apiKey (user had connected before)
  // OR if session is expiring soon
  const hadSession  = aoSession === null;   // set to null on 401
  const expiringSoon = isAOSessionExpiringSoon(aoSession);

  const [expanded, setExpanded]   = useState(false);
  const [pin,      setPin]        = useState('');
  const [totp,     setTotp]       = useState('');
  const [loading,  setLoading]    = useState(false);
  const [dismissed,setDismissed]  = useState(false);

  if (dismissed) return null;
  if (!hadSession && !expiringSoon) return null;

  const apiKey    = aoSession?.apiKey     ?? '';
  const clientCode = aoSession?.clientCode ?? '';

  // If session is null, both are empty — show a "go to Settings" prompt instead
  const canRelogin = hadSession
    ? false   // session null means we lost apiKey/clientCode too — send to Settings
    : !!(apiKey && clientCode);

  async function handleRelogin() {
    if (!pin || !totp) {
      Alert.alert('Required', 'Please enter your Angel One PIN and current TOTP code.');
      return;
    }
    setLoading(true);
    try {
      const session = await aoLogin(apiKey, clientCode, pin, totp);
      setAoSession({ ...session, loginAt: Date.now() } as any);
      setExpanded(false);
      setPin('');
      setTotp('');
    } catch (e: any) {
      Alert.alert('Re-login Failed', e.message ?? 'Please check your PIN and TOTP.');
    } finally {
      setLoading(false);
    }
  }

  const bgColor  = hadSession ? T.red + '18'  : T.amber + '18';
  const bdColor  = hadSession ? T.red + '60'  : T.amber + '60';
  const txColor  = hadSession ? T.red         : T.amber;
  const title    = hadSession
    ? '🔴 Angel One session expired'
    : '⚠️ Angel One session expiring soon';
  const subtitle = hadSession
    ? 'Your session has expired. Live trading and AO data are unavailable.'
    : 'Your session expires in under 1 hour. Re-login to avoid interruption.';

  return (
    <View style={{
      marginHorizontal: 12, marginVertical: 6,
      backgroundColor: bgColor,
      borderRadius: RADIUS.md,
      borderWidth: 1, borderColor: bdColor,
      padding: 12}}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: txColor, fontWeight: '700', fontSize: 13 }}>{title}</Text>
          <Text style={{ color: T.textDim, fontSize: 11, marginTop: 3 }}>{subtitle}</Text>
        </View>
        <TouchableOpacity onPress={() => setDismissed(true)} style={{ paddingLeft: 12, paddingTop: 2 }}>
          <Text style={{ color: T.textDim, fontSize: 16 }}>✕</Text>
        </TouchableOpacity>
      </View>

      {canRelogin && !expanded && (
        <TouchableOpacity
          onPress={() => setExpanded(true)}
          style={{ marginTop: 10, backgroundColor: txColor + '20', borderRadius: RADIUS.sm,
            paddingVertical: 8, paddingHorizontal: 14, alignSelf: 'flex-start' }}>
          <Text style={{ color: txColor, fontWeight: '700', fontSize: 12 }}>Re-login Now</Text>
        </TouchableOpacity>
      )}

      {!canRelogin && hadSession && (
        <Text style={{ color: T.textDim, fontSize: 11, marginTop: 8 }}>
          Go to Settings → Angel One to reconnect.
        </Text>
      )}

      {canRelogin && expanded && (
        <View style={{ marginTop: 12, gap: 8 }}>
          <TextInput
            value={pin}
            onChangeText={setPin}
            secureTextEntry
            placeholder="4-digit PIN"
            placeholderTextColor={T.textDim}
            keyboardType="numeric"
            maxLength={6}
            style={{ backgroundColor: T.bg3, borderRadius: RADIUS.sm, padding: 10,
              color: T.text, fontSize: 13, borderWidth: 1, borderColor: T.border }}
          />
          <TextInput
            value={totp}
            onChangeText={setTotp}
            placeholder="6-digit TOTP"
            placeholderTextColor={T.textDim}
            keyboardType="numeric"
            maxLength={6}
            style={{ backgroundColor: T.bg3, borderRadius: RADIUS.sm, padding: 10,
              color: T.text, fontSize: 13, borderWidth: 1, borderColor: T.border }}
          />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TouchableOpacity
              onPress={handleRelogin}
              disabled={loading}
              style={{ flex: 1, backgroundColor: txColor, borderRadius: RADIUS.sm,
                paddingVertical: 10, alignItems: 'center' }}>
              {loading
                ? <ActivityIndicator size="small" color="#fff" />
                : <Text style={{ color: '#fff', fontWeight: '700', fontSize: 13 }}>Confirm Re-login</Text>}
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => { setExpanded(false); setPin(''); setTotp(''); }}
              style={{ paddingHorizontal: 16, paddingVertical: 10, borderRadius: RADIUS.sm,
                backgroundColor: T.bg3, alignItems: 'center' }}>
              <Text style={{ color: T.textDim, fontSize: 13 }}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
}
