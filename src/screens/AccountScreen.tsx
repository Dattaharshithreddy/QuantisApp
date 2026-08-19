// ─────────────────────────────────────────────────────────────────────────────
// ACCOUNT SCREEN  (Phase 3)
//
// Shows auth status and allows Google Sign-In to sync data across devices.
// Accessible via More → Account.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, Alert, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { SPACING, RADIUS } from '../theme/colors';

export default function AccountScreen() {
  const { theme: T } = useTheme();
  const { user, uid, isAnonymous, isGoogleLinked, signInWithGoogle, signOut } = useAuth();
  const [loading, setLoading] = useState(false);

  async function handleGoogleSignIn() {
    setLoading(true);
    const success = await signInWithGoogle();
    setLoading(false);
    if (success) {
      Alert.alert('✅ Signed In', 'Your data is now syncing across devices via Google.');
    } else {
      Alert.alert('Sign-in cancelled', 'You can sign in later from More → Account.');
    }
  }

  async function handleSignOut() {
    Alert.alert(
      'Sign Out',
      'You will be signed out and switched to a local anonymous account. Your cloud data remains safe.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Sign Out', style: 'destructive', onPress: async () => {
          setLoading(true);
          await signOut();
          setLoading(false);
        }},
      ]
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      <ScrollView contentContainerStyle={{ padding: SPACING.md }}>

        {/* ── Header ─────────────────────────────────────────────────────── */}
        <Text style={{ color: T.text, fontSize: 22, fontWeight: '800', marginBottom: 4 }}>
          Account
        </Text>
        <Text style={{ color: T.textDim, fontSize: 13, marginBottom: 24 }}>
          Sign in with Google to sync your portfolio, journal and settings across devices.
        </Text>

        {/* ── Status card ────────────────────────────────────────────────── */}
        <View style={{ backgroundColor: T.card, borderRadius: RADIUS.md, padding: 16,
          borderWidth: 1, borderColor: T.border, marginBottom: 20 }}>
          
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
            <View style={{ width: 40, height: 40, borderRadius: 20,
              backgroundColor: isGoogleLinked ? T.green + '22' : T.bg3,
              alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
              <Text style={{ fontSize: 20 }}>{isGoogleLinked ? '👤' : '🔒'}</Text>
            </View>
            <View>
              <Text style={{ color: T.text, fontWeight: '700', fontSize: 15 }}>
                {isGoogleLinked ? user?.displayName ?? user?.email ?? 'Google Account' : 'Local Account'}
              </Text>
              <Text style={{ color: T.textDim, fontSize: 11, marginTop: 2 }}>
                {isGoogleLinked ? user?.email : 'Data stored on this device only'}
              </Text>
            </View>
          </View>

          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {[
              { label: 'Cloud Sync', active: isGoogleLinked },
              { label: 'Cross-device', active: isGoogleLinked },
              { label: 'Auto Backup', active: isGoogleLinked },
              { label: 'Offline', active: true },
            ].map(f => (
              <View key={f.label} style={{ flexDirection: 'row', alignItems: 'center',
                backgroundColor: f.active ? T.green + '15' : T.bg3,
                borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4 }}>
                <Text style={{ fontSize: 10, marginRight: 4 }}>{f.active ? '✓' : '○'}</Text>
                <Text style={{ color: f.active ? T.green : T.textDim, fontSize: 11, fontWeight: '600' }}>
                  {f.label}
                </Text>
              </View>
            ))}
          </View>
        </View>

        {/* ── What syncs ─────────────────────────────────────────────────── */}
        <View style={{ backgroundColor: T.card, borderRadius: RADIUS.md, padding: 16,
          borderWidth: 1, borderColor: T.border, marginBottom: 20 }}>
          <Text style={{ color: T.textDim, fontSize: 10, fontWeight: '700',
            letterSpacing: 0.8, marginBottom: 12 }}>WHAT SYNCS TO CLOUD</Text>
          {[
            '📊  Paper trading portfolio & journal',
            '💼  Live positions & order history',
            '⚠️  Risk settings & daily P&L',
            '📌  Watchlists & hidden assets',
            '🤖  AI Copilot chat history',
            '🎯  Prediction history per symbol',
            '🎨  Theme preference',
            '🧠  ML model weights (Firebase Storage)',
          ].map(item => (
            <Text key={item} style={{ color: T.text, fontSize: 13, marginBottom: 6 }}>
              {item}
            </Text>
          ))}
          <Text style={{ color: T.textDim, fontSize: 11, marginTop: 8, fontStyle: 'italic' }}>
            ML models & candle cache are local-only (large binary data).
          </Text>
        </View>

        {/* ── Action button ───────────────────────────────────────────────── */}
        {!isGoogleLinked ? (
          <TouchableOpacity
            onPress={handleGoogleSignIn}
            disabled={loading}
            style={{ backgroundColor: '#4285F4', borderRadius: RADIUS.md,
              padding: 16, alignItems: 'center', flexDirection: 'row',
              justifyContent: 'center', gap: 10 }}>
            {loading
              ? <ActivityIndicator color="#fff" />
              : <>
                  <Text style={{ fontSize: 18 }}>G</Text>
                  <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700' }}>
                    Sign in with Google
                  </Text>
                </>
            }
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            onPress={handleSignOut}
            disabled={loading}
            style={{ backgroundColor: T.bg3, borderRadius: RADIUS.md,
              padding: 14, alignItems: 'center' }}>
            {loading
              ? <ActivityIndicator color={T.textDim} />
              : <Text style={{ color: T.textDim, fontSize: 14, fontWeight: '600' }}>
                  Sign Out
                </Text>
            }
          </TouchableOpacity>
        )}

        {/* ── UID for debug ───────────────────────────────────────────────── */}
        <Text style={{ color: T.textDim, fontSize: 9, textAlign: 'center', marginTop: 20 }}>
          Device ID: {uid?.slice(0, 16) ?? '—'}…{'\n'}
          {isAnonymous ? 'Local anonymous session' : 'Google account linked'}
        </Text>

      </ScrollView>
    </SafeAreaView>
  );
}
