// ─────────────────────────────────────────────────────────────────────────────
// LOCK SCREEN — Fingerprint + MPIN authentication
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { View, Text, TouchableOpacity, Pressable, StyleSheet,
         Vibration, Animated } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { verifyMpin, authenticateWithBiometric, isBiometricAvailable } from '../services/appLock';

type Props = { onUnlock: () => void; appName?: string };

export default function LockScreen({ onUnlock, appName = 'Quantis' }: Props) {
  const [pin,          setPin]          = useState('');
  const [error,        setError]        = useState('');
  const [attempts,     setAttempts]     = useState(0);
  const [biometricOK,  setBiometricOK]  = useState(false);
  const [locked,       setLocked]       = useState(false); // locked out
  const [lockTimer,    setLockTimer]    = useState(0);
  const shakeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    isBiometricAvailable().then(setBiometricOK);
    // Auto-trigger biometric on open
    setTimeout(tryBiometric, 300);
  }, []);

  // Lockout timer countdown
  useEffect(() => {
    if (lockTimer <= 0) return;
    const t = setTimeout(() => setLockTimer(s => s - 1), 1000);
    return () => clearTimeout(t);
  }, [lockTimer]);

  useEffect(() => {
    if (lockTimer === 0 && locked) {
      setLocked(false);
      setAttempts(0);
      setPin('');
      setError('');
    }
  }, [lockTimer, locked]);

  const tryBiometric = useCallback(async () => {
    if (!biometricOK) return;
    const ok = await authenticateWithBiometric();
    if (ok) onUnlock();
  }, [biometricOK, onUnlock]);

  const shake = useCallback(() => {
    Vibration.vibrate(200);
    Animated.sequence([
      Animated.timing(shakeAnim, { toValue: 10, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -10, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 10, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 0, duration: 50, useNativeDriver: true }),
    ]).start();
  }, [shakeAnim]);

  const handleDigit = useCallback(async (d: string) => {
    if (locked) return;
    const newPin = pin + d;
    setPin(newPin);
    setError('');

    if (newPin.length >= 4) {
      const ok = await verifyMpin(newPin);
      if (ok) {
        onUnlock();
      } else {
        shake();
        const newAttempts = attempts + 1;
        setAttempts(newAttempts);
        setPin('');
        if (newAttempts >= 5) {
          setLocked(true);
          setLockTimer(30);
          setError('Too many attempts. Wait 30 seconds.');
        } else {
          setError(`Incorrect PIN. ${5 - newAttempts} attempts left.`);
        }
      }
    }
  }, [pin, locked, attempts, onUnlock, shake]);

  const handleDelete = useCallback(() => {
    setPin(p => p.slice(0, -1));
    setError('');
  }, []);

  const KEYS = [
    ['1','2','3'],
    ['4','5','6'],
    ['7','8','9'],
    [biometricOK ? '🔑' : '','0','⌫'],
  ];

  return (
    <SafeAreaView style={s.container}>
      <Text style={s.title}>🔒 {appName}</Text>
      <Text style={s.subtitle}>Enter your PIN to continue</Text>

      {/* PIN dots */}
      <Animated.View style={[s.dotsRow, { transform: [{ translateX: shakeAnim }] }]}>
        {[0,1,2,3,4,5].slice(0,4).map(i => (
          <View key={i} style={[s.dot, pin.length > i && s.dotFilled]} />
        ))}
      </Animated.View>

      {/* Error */}
      {!!error && <Text style={s.error}>{error}</Text>}
      {locked && lockTimer > 0 && (
        <Text style={s.lockTimer}>🔒 Try again in {lockTimer}s</Text>
      )}

      {/* Keypad */}
      <View style={s.keypad}>
        {KEYS.map((row, ri) => (
          <View key={ri} style={s.row}>
            {row.map((key, ki) => (
              <Pressable
                key={ki}
                onPressIn={() => {
                  if (!key) return;
                  if (key === '⌫') handleDelete();
                  else if (key === '🔑') tryBiometric();
                  else handleDigit(key);
                }}
                disabled={locked}
                android_ripple={{ color: 'rgba(255,255,255,0.15)', radius: 36, borderless: true }}
                style={({ pressed }) => [s.key, !key && s.keyEmpty, pressed && s.keyPressed]}>
                {!!key && <Text style={s.keyText}>{key}</Text>}
              </Pressable>
            ))}
          </View>
        ))}
      </View>

      {biometricOK && (
        <TouchableOpacity onPress={tryBiometric} style={s.bioBtn}>
          <Text style={s.bioText}>🔑  Use fingerprint / face</Text>
        </TouchableOpacity>
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container:  { flex:1, backgroundColor:'#0d0f17', alignItems:'center', justifyContent:'center' },
  title:      { color:'#fff', fontSize:24, fontWeight:'800', marginBottom:4 },
  subtitle:   { color:'#888', fontSize:13, marginBottom:32 },
  dotsRow:    { flexDirection:'row', gap:16, marginBottom:16 },
  dot:        { width:14, height:14, borderRadius:7, borderWidth:2, borderColor:'#444', backgroundColor:'transparent' },
  dotFilled:  { backgroundColor:'#6366f1', borderColor:'#6366f1' },
  error:      { color:'#ef4444', fontSize:12, marginBottom:8, textAlign:'center' },
  lockTimer:  { color:'#f59e0b', fontSize:13, marginBottom:8, fontWeight:'700' },
  keypad:     { marginTop:16, gap:4 },
  row:        { flexDirection:'row', gap:4 },
  key:        { width:80, height:72, borderRadius:40, alignItems:'center', justifyContent:'center',
                backgroundColor:'#1e2130' },
  keyEmpty:   { backgroundColor:'transparent' },
  keyPressed: { backgroundColor:'#2a2d3e' },
  keyText:    { color:'#fff', fontSize:22, fontWeight:'500' },
  bioBtn:     { marginTop:32, paddingVertical:12, paddingHorizontal:24 },
  bioText:    { color:'#6366f1', fontSize:14, fontWeight:'600' },
});
