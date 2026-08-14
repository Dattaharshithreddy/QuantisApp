// ─────────────────────────────────────────────────────────────────────────────
// STORAGE ABSTRACTION LAYER  (Phase 1)
//
// Drop-in replacement for AsyncStorage that writes to BOTH AsyncStorage (fast,
// offline) AND Firestore (cloud sync). During Phase 1, Firestore writes are
// fire-and-forget — the app never waits for them and always reads from
// AsyncStorage first (the local L1 cache).
//
// Migration strategy per key:
//   ASYNC_ONLY  — stays in AsyncStorage (caches, temp data, large blobs)
//   DUAL_WRITE  — writes to both, reads from AsyncStorage (Phase 2 targets)
//   FIRESTORE   — reads/writes Firestore only (Phase 3+ fully migrated keys)
//
// Usage: import { KVStore } from '../services/storage';
//   await KVStore.get('myKey')
//   await KVStore.set('myKey', value)
//   await KVStore.remove('myKey')
// ─────────────────────────────────────────────────────────────────────────────
import AsyncStorage from '@react-native-async-storage/async-storage';
import { db } from './firebase';
import {
  doc, getDoc, setDoc, deleteDoc, serverTimestamp,
} from 'firebase/firestore';

type MigrationMode = 'ASYNC_ONLY' | 'DUAL_WRITE' | 'FIRESTORE';

// Phase 1: everything is ASYNC_ONLY — no behaviour change whatsoever.
// Phase 2 will flip specific keys to DUAL_WRITE.
const KEY_MODES: Record<string, MigrationMode> = {
  // Will be flipped to DUAL_WRITE in Phase 2:
  // 'riskSettings':        'DUAL_WRITE',
  // 'themeName':           'DUAL_WRITE',
  // 'paperPortfolio_v1':   'DUAL_WRITE',
  // 'livePortfolio_v1':    'DUAL_WRITE',
  // 'liveOrderHistory_v1': 'DUAL_WRITE',
};

const DEFAULT_MODE: MigrationMode = 'ASYNC_ONLY';

function modeFor(key: string): MigrationMode {
  // Support dynamic keys like 'aichat_v1_BTCUSD'
  for (const prefix of Object.keys(KEY_MODES)) {
    if (key === prefix || key.startsWith(prefix)) return KEY_MODES[prefix];
  }
  return DEFAULT_MODE;
}

// ── Firestore helpers ─────────────────────────────────────────────────────────
const COLLECTION = 'kvstore';

async function fsGet(key: string): Promise<string | null> {
  try {
    const snap = await getDoc(doc(db, COLLECTION, encodeKey(key)));
    if (!snap.exists()) return null;
    return snap.data()?.value ?? null;
  } catch {
    return null;
  }
}

async function fsSet(key: string, value: string): Promise<void> {
  try {
    await setDoc(doc(db, COLLECTION, encodeKey(key)), {
      value,
      updatedAt: serverTimestamp(),
    });
  } catch { /* fire-and-forget — never throw */ }
}

async function fsDelete(key: string): Promise<void> {
  try {
    await deleteDoc(doc(db, COLLECTION, encodeKey(key)));
  } catch {}
}

// Firestore doc IDs can't contain '/' — encode the key
function encodeKey(key: string): string {
  return key.replace(/\//g, '__SLASH__').replace(/\./g, '__DOT__');
}

// ── Public API ────────────────────────────────────────────────────────────────
export const KVStore = {
  async get(key: string): Promise<string | null> {
    const mode = modeFor(key);
    if (mode === 'FIRESTORE') {
      return fsGet(key);
    }
    // ASYNC_ONLY or DUAL_WRITE: always read from AsyncStorage (fast + offline)
    return AsyncStorage.getItem(key);
  },

  async set(key: string, value: string): Promise<void> {
    const mode = modeFor(key);
    await AsyncStorage.setItem(key, value);
    if (mode === 'DUAL_WRITE' || mode === 'FIRESTORE') {
      fsSet(key, value); // fire-and-forget — don't await
    }
  },

  async remove(key: string): Promise<void> {
    const mode = modeFor(key);
    await AsyncStorage.removeItem(key);
    if (mode === 'DUAL_WRITE' || mode === 'FIRESTORE') {
      fsDelete(key); // fire-and-forget
    }
  },

  // Promote a key to DUAL_WRITE (called during Phase 2 migration)
  promote(key: string, mode: MigrationMode = 'DUAL_WRITE'): void {
    KEY_MODES[key] = mode;
  },
};

export default KVStore;
