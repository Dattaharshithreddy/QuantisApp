// ─────────────────────────────────────────────────────────────────────────────
// APP LOCK SERVICE
//
// Supports two lock methods:
//   1. Biometric (fingerprint / face) via expo-local-authentication
//   2. MPIN (4-6 digit PIN) stored encrypted in SecureStore
//
// Flow:
//   App start → if lock enabled → show LockScreen → authenticate → app opens
//   Background → foreground after 30s → show lock again
// ─────────────────────────────────────────────────────────────────────────────
import { getLiveTradingCredential, setLiveTradingCredential, deleteLiveTradingCredential } from '../utils/secureCredentials';

const MPIN_KEY         = 'appLockMpin';
const LOCK_ENABLED_KEY = 'appLockEnabled';
const LOCK_TYPE_KEY    = 'appLockType'; // 'biometric' | 'mpin' | 'both'

// ── MPIN ─────────────────────────────────────────────────────────────────────
export async function setMpin(pin: string): Promise<void> {
  if (pin.length < 4 || pin.length > 6 || !/^\d+$/.test(pin)) {
    throw new Error('MPIN must be 4-6 digits');
  }
  await setLiveTradingCredential(MPIN_KEY, pin);
}

export async function verifyMpin(pin: string): Promise<boolean> {
  const stored = await getLiveTradingCredential(MPIN_KEY);
  return stored === pin;
}

export async function hasMpin(): Promise<boolean> {
  const p = await getLiveTradingCredential(MPIN_KEY);
  return !!p;
}

export async function removeMpin(): Promise<void> {
  await deleteLiveTradingCredential(MPIN_KEY);
}

// ── Lock settings ─────────────────────────────────────────────────────────────
export async function getLockSettings(): Promise<{
  enabled: boolean;
  type: 'biometric' | 'mpin' | 'both';
}> {
  try {
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    const [enabled, type] = await Promise.all([
      AsyncStorage.getItem(LOCK_ENABLED_KEY),
      AsyncStorage.getItem(LOCK_TYPE_KEY),
    ]);
    return {
      enabled: enabled === 'true',
      type: (type as any) || 'mpin',
    };
  } catch {
    return { enabled: false, type: 'mpin' };
  }
}

export async function setLockSettings(enabled: boolean, type: 'biometric' | 'mpin' | 'both'): Promise<void> {
  const AsyncStorage = require('@react-native-async-storage/async-storage').default;
  await Promise.all([
    AsyncStorage.setItem(LOCK_ENABLED_KEY, String(enabled)),
    AsyncStorage.setItem(LOCK_TYPE_KEY, type),
  ]);
}

// ── Biometric — uses Android KeyguardManager (no extra native packages) ─────────
export async function isBiometricAvailable(): Promise<boolean> {
  // KeyguardManager NativeModules not available in current build
  // Fingerprint requires expo-local-authentication which breaks Gradle AGP 8
  // Returns false — PIN is the primary lock method
  return false;
}

export async function authenticateWithBiometric(): Promise<boolean> {
  return false;
}
