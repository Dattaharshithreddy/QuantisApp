import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { logger } from './logger';

// TASK 1 — Secure Storage. Every sensitive credential (Anthropic key,
// Alpha Vantage key, the Angel One trading session token) previously
// lived in plain AsyncStorage — sandboxed from other apps, but not
// encrypted at rest, and recoverable via ADB backup or on a
// rooted/compromised device. The Angel One session is the highest-stakes
// one here: it represents access to a real brokerage account, not just
// API usage billing.
//
// Migration strategy: lazy and one-time per key, not a single big
// migration step on app boot. The first time any code asks for a
// credential, this checks SecureStore first; if it's empty but the OLD
// AsyncStorage value still exists, it copies it over and deletes the
// plaintext copy. After that, AsyncStorage no longer holds the secret at
// all. A user who upgrades mid-session loses nothing — the very next read
// silently migrates them.

const KNOWN_CREDENTIAL_KEYS = ['anthropicKey', 'avKey', 'aoSession'] as const;

async function migrateIfNeeded(key: string): Promise<void> {
  let secureValue: string | null = null;
  try {
    secureValue = await SecureStore.getItemAsync(key);
  } catch (e: any) {
    logger.error('secureCredentials', `SecureStore read failed for '${key}' during migration check: ${e.message}`);
    return; // don't attempt migration if we can't even confirm SecureStore is usable
  }
  if (secureValue != null) return; // already migrated, or already set directly via SecureStore

  let legacyValue: string | null = null;
  try {
    legacyValue = await AsyncStorage.getItem(key);
  } catch { /* nothing to migrate if this fails either */ }
  if (legacyValue == null) return; // genuinely nothing to migrate

  try {
    await SecureStore.setItemAsync(key, legacyValue);
    await AsyncStorage.removeItem(key);
    logger.info('secureCredentials', `Migrated '${key}' from AsyncStorage to SecureStore; plaintext copy removed.`);
  } catch (e: any) {
    // If the SecureStore write failed, deliberately do NOT remove the
    // AsyncStorage copy — better to leave the credential readable via the
    // old path than to lose it outright.
    logger.error('secureCredentials', `Migration failed for '${key}', keeping legacy AsyncStorage value: ${e.message}`);
  }
}

export async function getSecureCredential(key: typeof KNOWN_CREDENTIAL_KEYS[number]): Promise<string | null> {
  await migrateIfNeeded(key);
  try {
    return await SecureStore.getItemAsync(key);
  } catch (e: any) {
    logger.error('secureCredentials', `Failed to read '${key}': ${e.message}`);
    return null;
  }
}

export async function setSecureCredential(key: typeof KNOWN_CREDENTIAL_KEYS[number], value: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(key, value);
  } catch (e: any) {
    logger.error('secureCredentials', `Failed to write '${key}': ${e.message}`);
  }
}

export async function deleteSecureCredential(key: typeof KNOWN_CREDENTIAL_KEYS[number]): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(key);
  } catch (e: any) {
    logger.error('secureCredentials', `Failed to delete '${key}': ${e.message}`);
  }
}
