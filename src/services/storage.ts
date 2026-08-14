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
import { db, auth } from './firebase';
import {
  doc, getDoc, setDoc, deleteDoc, serverTimestamp,
} from 'firebase/firestore';

type MigrationMode = 'ASYNC_ONLY' | 'DUAL_WRITE' | 'FIRESTORE';

// Phase 2: user data keys now dual-write (AsyncStorage + Firestore)
// Each key is written locally first (instant), then synced to cloud fire-and-forget.
// Reads always come from AsyncStorage (fast, offline-safe).
const KEY_MODES: Record<string, MigrationMode> = {
  // ── User preferences ─────────────────────────────────────────────────────
  'riskSettings':            'DUAL_WRITE',
  'paperMode':               'DUAL_WRITE',
  'themeName':               'DUAL_WRITE',
  'exchangePreferences_v1':  'DUAL_WRITE',
  // ── Trading data ─────────────────────────────────────────────────────────
  'paperPortfolio':          'DUAL_WRITE',
  'livePortfolio_v1':        'DUAL_WRITE',
  'liveOrderHistory_v1':     'DUAL_WRITE',
  'paperTradeJournal':       'DUAL_WRITE',
  'shadowTrades_v1':         'DUAL_WRITE',
  // ── Watchlist ─────────────────────────────────────────────────────────────
  'hiddenBuiltinAssets':     'DUAL_WRITE',
  'customWatchlist':         'DUAL_WRITE',
  // ── Dynamic key prefixes ──────────────────────────────────────────────────
  'aichat_v1_':              'DUAL_WRITE',
  'predictionHistory_':      'DUAL_WRITE',
  'dailyPnL_':               'DUAL_WRITE',
  'notifDedup_':             'DUAL_WRITE',
  'perfMetrics_v1_':         'DUAL_WRITE',
  'memoryEngine_episodes_':  'DUAL_WRITE',
  // ── Phase 5: task/scanner/trading state ──────────────────────────────────
  'backgroundTaskContext__runningIds': 'DUAL_WRITE',
  'scannerEnabled':          'DUAL_WRITE',
  'scannerStatus':           'DUAL_WRITE',
  'scannerConfig':           'DUAL_WRITE',
  'liveTradeSettings_v1':    'DUAL_WRITE',
  'liveOrderLog_v1':         'DUAL_WRITE',
  'liveReconciliationLog_v1': 'DUAL_WRITE',
  'priceAlerts':             'DUAL_WRITE',
  'bnFuturesPortfolio_v1':   'DUAL_WRITE',
  'bnFundingLog_v1':         'DUAL_WRITE',
  'futuresContracts_v2':     'DUAL_WRITE',
  'futuresPortfolio_v1':     'DUAL_WRITE',
  'futuresMtmLog_v1':        'DUAL_WRITE',
  'tradeJournal':            'DUAL_WRITE',
  'namedWatchlists':         'DUAL_WRITE',
  'activeWatchlistName':     'DUAL_WRITE',
  'quantis_override_log':    'DUAL_WRITE',
  'paperRiskExtras':         'DUAL_WRITE',
  'patternOutcomes_v1':      'DUAL_WRITE',
  'regimeFilterMode':        'DUAL_WRITE',
  'securityAuditResult_v1':  'DUAL_WRITE',
  'activeStrategyId':        'DUAL_WRITE',
  'previousOpportunityRanking': 'DUAL_WRITE',
  'lastDailySummaryDate':    'DUAL_WRITE',
  'symbolSearchCache':       'DUAL_WRITE',
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
// Firestore path: /users/{uid}/kvstore/{key}
// Anonymous users get a stable UID automatically.
// Data is scoped per-user — never shared across accounts.
function getUserPath(key: string): string {
  const uid = auth.currentUser?.uid ?? 'anonymous';
  const encodedKey = encodeKey(key);
  return `users/${uid}/kvstore/${encodedKey}`;
}

async function fsGet(key: string): Promise<string | null> {
  try {
    const snap = await getDoc(doc(db, getUserPath(key)));
    if (!snap.exists()) return null;
    return snap.data()?.value ?? null;
  } catch {
    return null;
  }
}

async function fsSet(key: string, value: string): Promise<void> {
  try {
    await setDoc(doc(db, getUserPath(key)), {
      value,
      updatedAt: serverTimestamp(),
    });
  } catch { /* fire-and-forget — never throw */ }
}

async function fsDelete(key: string): Promise<void> {
  try {
    await deleteDoc(doc(db, getUserPath(key)));
  } catch {}
}

// Encode special chars for use in Firestore path segments
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
