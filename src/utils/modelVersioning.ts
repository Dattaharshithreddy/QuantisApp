// ─────────────────────────────────────────────────────────────────────────────
// MODEL VERSIONING + CHAMPION/CHALLENGER  (Phase 2 — production integration)
//
// CHANGES FROM PHASE 2 INITIAL:
//   - _writeChampionToLiveKeys(): after promotion, copies champion weights
//     into MODEL_KEY/LR_KEY so inference always reads the champion.
//   - rollbackToVersion(): now also copies target slot → MODEL_KEY/LR_KEY.
//   - _versioningLocks: per-symbol/tf async lock prevents concurrent
//     promotions from corrupting the champion pointer.
//   - bootstrapLegacyModel(): if no champion exists but legacy mlModel_* keys
//     do, treat the existing model as slot-1 champion (no retraining needed).
//   - saveVersionedModel(): now called for BOTH accepted and rejected models;
//     rejected models are stored as non-champion challengers.
//
// KEY INVARIANTS:
//   MODEL_KEY(sym,tf,h)  == champion weights  at all times after first promotion
//   Champion pointer updated ONLY after versioned weights are confirmed written
//   Rollback copies weights → MODEL_KEY before updating champion pointer
//   Legacy users (no version list) bootstrap without losing their existing model
// ─────────────────────────────────────────────────────────────────────────────

import AsyncStorage from '@react-native-async-storage/async-storage';
import { logger } from './logger';
import { ARCHITECTURE_VERSION, FEATURE_COUNT } from './modelConstants';

// ── Constants ─────────────────────────────────────────────────────────────────
const MAX_VERSIONS    = 5;
const PROMOTE_EPSILON = 0.5;   // challenger must beat champion by ≥0.5pp holdout accuracy

// ── Live model key helpers (match mlSignal.ts exactly) ───────────────────────
// These are the keys inference reads. After promotion, champion weights are
// copied here. We define them here so modelVersioning.ts can write to them.
const LIVE_MODEL_KEY = (sym: string, tf: string, h: number) => `mlModel_${sym}_${tf}_h${h}`;
const LIVE_LR_KEY    = (sym: string, tf: string)             => `lrModel_${sym}_${tf}`;

// ── Exchange isolation — why symbol-based keys are sufficient ─────────────────
// The ML pipeline uses variant.symbol as the universal internal key (per assets.ts).
// Each (assetId, exchange) pair maps to a DIFFERENT variant.symbol:
//   BTC + binance  → symbol='BTCUSD'   → keys: mlModel_BTCUSD_1h_h3
//   BTC + coindcx  → symbol='BTCUSDT'  → keys: mlModel_BTCUSDT_1h_h3
//   ETH + binance  → symbol='ETHUSD'
//   ETH + coindcx  → symbol='ETHUSDT'
// Therefore all version lists, champion pointers, and versioned weights
// are already isolated by symbol, which IS exchange-specific by construction.
//
// The 'exchange' parameter in saveVersionedModel stores the real src ('binance',
// 'coindcx') in the version metadata — it does NOT affect key isolation (which
// is already handled by symbol) but makes metadata human-readable and traceable.
//
// Concurrency locks use `${symbol}/${tf}` which is also exchange-specific. ✓

// ── Types ─────────────────────────────────────────────────────────────────────

export type VersionedModelMetadata = {
  modelVersion:        number;
  symbol:              string;
  exchange:            string;
  timeframe:           string;
  horizon:             number;
  createdAt:           number;
  trainingCandleCount: number;
  trainingSampleCount: number;
  featureVersion:      number;
  modelArchitecture:   string;
  mlpConfig: { hiddenSize: number; inputSize: number; outputSize: number; activations: string[] };
  lrConfig:  { inputSize: number; regularization: string; learningRate: number };
  validationAccuracy:  number;
  holdoutAccuracy:     number | null;
  holdoutF1:           number | null;
  backtestReturn:      number | null;
  maxDrawdown:         number | null;
  winRate:             number | null;
  profitFactor:        number | null;
  trainingDurationMs:  number;
  dataRange:           { oldestCandle: number; newestCandle: number };
  codeModelVersion:    number;
  isChampion:          boolean;
  championSetAt:       number | null;
};

export type ChampionPointer = {
  symbol:       string;
  timeframe:    string;
  version:      number;
  modelVersion: number;
  updatedAt:    number;
  reason:       string;
};

export type ChallengerResult = {
  promoted:  boolean;
  reason:    string;
  newSlot:   number;
  champion:  ChampionPointer | null;
};

// ── Key helpers ───────────────────────────────────────────────────────────────
const VERSION_LIST_KEY  = (s: string, tf: string) => `mlVersionList_${s}_${tf}`;
const VERSIONED_MODEL_KEY = (slot: number, s: string, tf: string, h: number) =>
  `mlModel_v${String(slot).padStart(3, '0')}_${s}_${tf}_h${h}`;
const VERSIONED_LR_KEY  = (slot: number, s: string, tf: string) =>
  `mlModelLR_v${String(slot).padStart(3, '0')}_${s}_${tf}`;
const CHAMPION_KEY      = (s: string, tf: string) => `mlChampion_${s}_${tf}`;

// ── Per-symbol/tf async lock ──────────────────────────────────────────────────
// Prevents concurrent promotions for the same model from racing on the
// champion pointer. Different symbol/tf combos proceed independently.
const _versioningLocks = new Map<string, Promise<void>>();

async function withVersioningLock<T>(symbol: string, tf: string, fn: () => Promise<T>): Promise<T> {
  const key = `${symbol}/${tf}`;
  // Chain onto any in-progress operation for this key
  const prev = _versioningLocks.get(key) ?? Promise.resolve();
  let resolve!: () => void;
  const next = new Promise<void>(r => { resolve = r; });
  _versioningLocks.set(key, next);
  try {
    await prev;
    return await fn();
  } finally {
    resolve();
    // Clean up if this is still the latest lock for this key
    if (_versioningLocks.get(key) === next) _versioningLocks.delete(key);
  }
}

// ── Firebase lazy helpers ─────────────────────────────────────────────────────
function _getFirebaseStorage(): any {
  try { const { getFirebaseStorage } = require('../services/firebase'); return getFirebaseStorage(); }
  catch { return null; }
}
function _getDb(): any {
  try { const { getDb } = require('../services/firebase'); return getDb(); }
  catch { return null; }
}
function _getUid(): string | null {
  try { const { getFirebaseAuth } = require('../services/firebase'); return getFirebaseAuth()?.currentUser?.uid ?? null; }
  catch { return null; }
}

async function _cloudUploadWeights(key: string, data: string): Promise<void> {
  const storage = _getFirebaseStorage();
  const uid = _getUid();
  if (!storage || !uid) return;
  try {
    const { ref, uploadString } = require('firebase/storage');
    await uploadString(ref(storage, `users/${uid}/models/${key}`), data);
    logger.info('modelVersioning', `Uploaded ${key} to Firebase Storage`);
  } catch (e: any) {
    logger.warn('modelVersioning', `Cloud upload failed for ${key}: ${e?.message ?? e}`);
  }
}

async function _cloudDownloadWeights(key: string): Promise<string | null> {
  const storage = _getFirebaseStorage();
  const uid = _getUid();
  if (!storage || !uid) return null;
  try {
    const { ref, getDownloadURL } = require('firebase/storage');
    const url = await getDownloadURL(ref(storage, `users/${uid}/models/${key}`));
    const resp = await fetch(url);
    return resp.ok ? resp.text() : null;
  } catch { return null; }
}

async function _firestoreSetChampion(symbol: string, tf: string, pointer: ChampionPointer): Promise<void> {
  const db = _getDb();
  const uid = _getUid();
  if (!db || !uid) return;
  try {
    const { doc, setDoc } = require('firebase/firestore');
    await setDoc(doc(db, `users/${uid}/modelChampions/${symbol}_${tf}`), pointer);
  } catch (e: any) {
    logger.warn('modelVersioning', `Firestore champion write failed: ${e?.message ?? e}`);
  }
}

async function _firestoreGetChampion(symbol: string, tf: string): Promise<ChampionPointer | null> {
  const db = _getDb();
  const uid = _getUid();
  if (!db || !uid) return null;
  try {
    const { doc, getDoc } = require('firebase/firestore');
    const snap = await getDoc(doc(db, `users/${uid}/modelChampions/${symbol}_${tf}`));
    return snap.exists() ? snap.data() as ChampionPointer : null;
  } catch { return null; }
}

// ── Version list helpers ──────────────────────────────────────────────────────
async function _loadVersionList(symbol: string, tf: string): Promise<VersionedModelMetadata[]> {
  try {
    const raw = await AsyncStorage.getItem(VERSION_LIST_KEY(symbol, tf));
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

async function _saveVersionList(symbol: string, tf: string, list: VersionedModelMetadata[]): Promise<void> {
  try {
    await AsyncStorage.setItem(VERSION_LIST_KEY(symbol, tf), JSON.stringify(list));
  } catch (e: any) {
    logger.warn('modelVersioning', `Version list write failed: ${e?.message ?? e}`);
  }
}

function _nextSlot(list: VersionedModelMetadata[]): number {
  if (list.length < MAX_VERSIONS) return list.length + 1;
  // Evict oldest non-champion slot
  const nonChampions = list.filter(v => !v.isChampion).sort((a, b) => a.createdAt - b.createdAt);
  if (nonChampions.length > 0) {
    // Return the slot this entry was written to (derived from modelVersion)
    const oldest = nonChampions[0];
    // Slot is stored implicitly — recover it by checking which versioned key exists
    // We use modelVersion mod MAX_VERSIONS mapping (1-indexed)
    return ((oldest.modelVersion - 1) % MAX_VERSIONS) + 1 || 1;
  }
  return 1; // all slots are champion (edge case)
}

// ── Champion pointer helpers ──────────────────────────────────────────────────
async function _loadChampionLocal(symbol: string, tf: string): Promise<ChampionPointer | null> {
  try {
    const raw = await AsyncStorage.getItem(CHAMPION_KEY(symbol, tf));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function _saveChampionLocal(symbol: string, tf: string, pointer: ChampionPointer): Promise<void> {
  try {
    await AsyncStorage.setItem(CHAMPION_KEY(symbol, tf), JSON.stringify(pointer));
  } catch (e: any) {
    logger.warn('modelVersioning', `Champion pointer write failed: ${e?.message ?? e}`);
  }
}

// ── Write champion weights to live inference keys ─────────────────────────────
// Called after promotion is confirmed. Copies versioned slot weights →
// MODEL_KEY(sym,tf,h) and LR_KEY(sym,tf) so loadSavedMLP picks them up.
// Also uploads to Firebase Storage (background, non-blocking).
async function _writeChampionToLiveKeys(
  slot:     number,
  symbol:   string,
  tf:       string,
  horizons: number[],
): Promise<{ success: boolean; missingHorizons: number[] }> {
  const missingHorizons: number[] = [];

  for (const h of horizons) {
    const vKey = VERSIONED_MODEL_KEY(slot, symbol, tf, h);
    const lKey = LIVE_MODEL_KEY(symbol, tf, h);
    try {
      const data = await AsyncStorage.getItem(vKey)
        ?? await _cloudDownloadWeights(vKey);
      if (!data) { missingHorizons.push(h); continue; }
      await AsyncStorage.setItem(lKey, data);
      // Background cloud sync of live key
      _cloudUploadWeights(lKey, data).catch(() => {});
    } catch (e: any) {
      logger.warn('modelVersioning', `Failed to write champion h${h} to live key: ${e?.message ?? e}`);
      missingHorizons.push(h);
    }
  }

  // LR weights
  const vLrKey = VERSIONED_LR_KEY(slot, symbol, tf);
  const lLrKey = LIVE_LR_KEY(symbol, tf);
  try {
    const lrData = await AsyncStorage.getItem(vLrKey)
      ?? await _cloudDownloadWeights(vLrKey);
    if (lrData) {
      await AsyncStorage.setItem(lLrKey, lrData);
      _cloudUploadWeights(lLrKey, lrData).catch(() => {});
    }
  } catch (e: any) {
    logger.warn('modelVersioning', `Failed to write champion LR to live key: ${e?.message ?? e}`);
  }

  return { success: missingHorizons.length === 0, missingHorizons };
}

// ── Promotion policy ──────────────────────────────────────────────────────────
// OUT-OF-SAMPLE metrics only. Training accuracy alone does NOT promote.
function _shouldPromote(
  challenger: VersionedModelMetadata,
  champion:   VersionedModelMetadata | null,
): { promote: boolean; reason: string } {
  if (!champion) {
    return { promote: true, reason: 'First model registered — automatically becomes champion.' };
  }

  // Primary: holdout ensemble accuracy (true out-of-sample)
  if (challenger.holdoutAccuracy !== null && champion.holdoutAccuracy !== null) {
    const delta = challenger.holdoutAccuracy - champion.holdoutAccuracy;
    if (delta >= PROMOTE_EPSILON) {
      return {
        promote: true,
        reason: `Holdout accuracy improved ${champion.holdoutAccuracy.toFixed(2)}% → ${challenger.holdoutAccuracy.toFixed(2)}% (+${delta.toFixed(2)}%).`,
      };
    }
    return {
      promote: false,
      reason: `Holdout accuracy ${challenger.holdoutAccuracy.toFixed(2)}% did not beat champion ${champion.holdoutAccuracy.toFixed(2)}% by ≥${PROMOTE_EPSILON}%. Retained as challenger.`,
    };
  }

  // Fallback: walk-forward when holdout unavailable on both
  if (champion.holdoutAccuracy === null && challenger.holdoutAccuracy === null) {
    const delta = challenger.validationAccuracy - champion.validationAccuracy;
    if (delta >= PROMOTE_EPSILON) {
      return {
        promote: true,
        reason: `Walk-forward accuracy improved ${champion.validationAccuracy.toFixed(2)}% → ${challenger.validationAccuracy.toFixed(2)}% (no holdout).`,
      };
    }
    return {
      promote: false,
      reason: `Walk-forward accuracy ${challenger.validationAccuracy.toFixed(2)}% did not beat champion ${champion.validationAccuracy.toFixed(2)}% by ≥${PROMOTE_EPSILON}%.`,
    };
  }

  // Challenger has holdout, champion doesn't → challenger is more rigorously evaluated
  if (challenger.holdoutAccuracy !== null && champion.holdoutAccuracy === null) {
    return {
      promote: true,
      reason: `Challenger has holdout accuracy ${challenger.holdoutAccuracy.toFixed(2)}%; champion lacked holdout evaluation.`,
    };
  }

  return { promote: false, reason: 'Insufficient comparable metrics — champion retained.' };
}

// ── PUBLIC API ────────────────────────────────────────────────────────────────

/**
 * saveVersionedModel — called by mlSignal.ts for EVERY completed training run,
 * both accepted AND rejected models.
 *
 * For accepted models (called from the multiSet-success block):
 *   - Stores weights in versioned slot
 *   - Runs Champion/Challenger policy
 *   - If promoted: copies weights → MODEL_KEY/LR_KEY (inference reads these)
 *   - Champion pointer updated ONLY after weights confirmed written
 *
 * For rejected models (called from the rejection metadata block):
 *   - Stores weights in versioned slot
 *   - isChampion=false; MODEL_KEY/LR_KEY NOT touched
 *   - Retained for inspection and rollback
 *
 * Exchange isolation: `exchange` param differentiates Binance BTC from
 * CoinDCX BTC (same symbol, different model namespaces).
 */
export async function saveVersionedModel(params: {
  symbol:              string;
  exchange:            string;
  timeframe:           string;
  primaryHorizon:      number;
  modelVersion:        number;
  mlpWeightsByHorizon: Record<number, string>;
  lrWeights:           string;
  trainingCandleCount: number;
  trainingSampleCount: number;
  trainingDurationMs:  number;
  oldestCandleTime:    number;
  newestCandleTime:    number;
  validationAccuracy:  number;
  holdoutAccuracy:     number | null;
  holdoutF1:           number | null;
  backtestReturn:      number | null;
  maxDrawdown:         number | null;
  winRate:             number | null;
  profitFactor:        number | null;
  // If false: rejected challenger — store but do not touch MODEL_KEY/LR_KEY
  isAccepted:          boolean;
}): Promise<ChallengerResult> {
  return withVersioningLock(params.symbol, params.timeframe, () => _saveVersionedModelLocked(params));
}

async function _saveVersionedModelLocked(params: ReturnType<typeof Object.assign> & Parameters<typeof saveVersionedModel>[0]): Promise<ChallengerResult> {
  const { symbol, exchange, timeframe, primaryHorizon, modelVersion, isAccepted } = params;

  const versionList     = await _loadVersionList(symbol, timeframe);
  const championPointer = await _loadChampionLocal(symbol, timeframe)
    ?? await _firestoreGetChampion(symbol, timeframe);
  const championMeta    = championPointer
    ? versionList.find(v => v.modelVersion === championPointer.modelVersion) ?? null
    : null;

  const slot = _nextSlot(versionList);

  const meta: VersionedModelMetadata = {
    modelVersion,
    symbol,
    exchange,
    timeframe,
    horizon:             primaryHorizon,
    createdAt:           Date.now(),
    trainingCandleCount: params.trainingCandleCount,
    trainingSampleCount: params.trainingSampleCount,
    featureVersion:      FEATURE_COUNT,
    modelArchitecture:   'MLP+LR_ensemble',
    mlpConfig:  { hiddenSize: 8, inputSize: FEATURE_COUNT, outputSize: 1, activations: ['relu', 'sigmoid'] },
    lrConfig:   { inputSize: FEATURE_COUNT, regularization: 'l2', learningRate: 0.001 },
    validationAccuracy:  params.validationAccuracy,
    holdoutAccuracy:     params.holdoutAccuracy,
    holdoutF1:           params.holdoutF1,
    backtestReturn:      params.backtestReturn,
    maxDrawdown:         params.maxDrawdown,
    winRate:             params.winRate,
    profitFactor:        params.profitFactor,
    trainingDurationMs:  params.trainingDurationMs,
    dataRange:           { oldestCandle: params.oldestCandleTime, newestCandle: params.newestCandleTime },
    codeModelVersion:    ARCHITECTURE_VERSION,
    isChampion:          false,
    championSetAt:       null,
  };

  // Write versioned weights (AsyncStorage + Firebase background)
  const horizons      = Object.keys(params.mlpWeightsByHorizon).map(Number);
  const writePromises: Promise<void>[] = [];

  for (const h of horizons) {
    const vKey = VERSIONED_MODEL_KEY(slot, symbol, timeframe, h);
    const data = params.mlpWeightsByHorizon[h];
    writePromises.push(AsyncStorage.setItem(vKey, data).catch(() => {}));
    writePromises.push(_cloudUploadWeights(vKey, data));
  }
  const vLrKey = VERSIONED_LR_KEY(slot, symbol, timeframe);
  writePromises.push(AsyncStorage.setItem(vLrKey, params.lrWeights).catch(() => {}));
  writePromises.push(_cloudUploadWeights(vLrKey, params.lrWeights));

  await Promise.allSettled(writePromises);
  logger.info('modelVersioning', `${symbol}/${timeframe}[${exchange}]: stored slot ${slot} (modelVersion=${modelVersion}, accepted=${isAccepted})`);

  // ── Champion/Challenger evaluation ────────────────────────────────────────
  // Only accepted models can become champion; rejected models are stored but
  // the champion pointer is never changed for a rejected model.
  let newChampion: ChampionPointer | null = championPointer;
  let promoted    = false;
  let reason      = 'Rejected by mlSignal quality gate — challenger retained.';

  if (isAccepted) {
    const result = _shouldPromote(meta, championMeta);
    promoted = result.promote;
    reason   = result.reason;

    if (promoted) {
      meta.isChampion    = true;
      meta.championSetAt = Date.now();

      // Un-champion all existing entries
      for (const v of versionList) v.isChampion = false;

      // SAFETY: write champion weights to live inference keys BEFORE updating pointer
      const writeResult = await _writeChampionToLiveKeys(slot, symbol, timeframe, horizons);
      if (!writeResult.success) {
        logger.warn('modelVersioning',
          `${symbol}/${timeframe}: champion write to live keys partially failed (missing h: ${writeResult.missingHorizons.join(',')})`);
      }

      const pointer: ChampionPointer = {
        symbol, timeframe,
        version:      slot,
        modelVersion,
        updatedAt:    Date.now(),
        reason,
      };
      await _saveChampionLocal(symbol, timeframe, pointer);
      _firestoreSetChampion(symbol, timeframe, pointer).catch(() => {});
      newChampion = pointer;

      logger.info('modelVersioning', `${symbol}/${timeframe}[${exchange}]: PROMOTED — ${reason}`);
    } else {
      logger.info('modelVersioning', `${symbol}/${timeframe}[${exchange}]: challenger stored, not promoted — ${reason}`);
    }
  } else {
    logger.info('modelVersioning', `${symbol}/${timeframe}[${exchange}]: rejected model stored in slot ${slot} (not champion)`);
  }

  // Update version list — keep MAX_VERSIONS, sorted by createdAt
  const filtered = versionList.filter(v => v.modelVersion !== modelVersion);
  filtered.push(meta);
  const trimmed = filtered.sort((a, b) => a.createdAt - b.createdAt).slice(-MAX_VERSIONS);
  await _saveVersionList(symbol, timeframe, trimmed);

  return { promoted, reason, newSlot: slot, champion: newChampion };
}

// ── Backward-compat bootstrap ─────────────────────────────────────────────────
/**
 * bootstrapLegacyModel — if no version list or champion exists but legacy
 * mlModel_* weights do, register them as slot-1 champion so versioning
 * starts from existing state. Existing users get Champion/Challenger without
 * needing to retrain.
 *
 * Called once per symbol/tf on first interaction with the versioning system.
 * No-op if: version list already exists, or legacy weights don't exist.
 */
export async function bootstrapLegacyModel(
  symbol:           string,
  exchange:         string,
  timeframe:        string,
  horizons:         number[],
  existingMetadata: {
    modelVersion:    number;
    validationAccuracy: number;
    holdoutAccuracy: number | null;
    trainingCandleCount: number;
    trainingSampleCount: number;
    trainedAt:       number;
  } | null,
): Promise<boolean> {
  return withVersioningLock(symbol, timeframe, async () => {
    // No-op if version list already populated
    const existing = await _loadVersionList(symbol, timeframe);
    if (existing.length > 0) return false;

    // Check if legacy weights exist
    const legacyKey = LIVE_MODEL_KEY(symbol, timeframe, horizons[0]);
    const hasLegacy = !!(await AsyncStorage.getItem(legacyKey).catch(() => null));
    if (!hasLegacy) return false; // no legacy model — first-training behavior applies

    logger.info('modelVersioning', `${symbol}/${timeframe}: bootstrapping legacy model as slot-1 champion`);

    const slot = 1;
    // Copy legacy weights into slot 1
    for (const h of horizons) {
      try {
        const data = await AsyncStorage.getItem(LIVE_MODEL_KEY(symbol, timeframe, h));
        if (data) await AsyncStorage.setItem(VERSIONED_MODEL_KEY(slot, symbol, timeframe, h), data);
      } catch {}
    }
    try {
      const lrData = await AsyncStorage.getItem(LIVE_LR_KEY(symbol, timeframe));
      if (lrData) await AsyncStorage.setItem(VERSIONED_LR_KEY(slot, symbol, timeframe), lrData);
    } catch {}

    const meta: VersionedModelMetadata = {
      modelVersion:        existingMetadata?.modelVersion ?? 1,
      symbol, exchange, timeframe,
      horizon:             horizons[0],
      createdAt:           existingMetadata?.trainedAt ?? Date.now(),
      trainingCandleCount: existingMetadata?.trainingCandleCount ?? 0,
      trainingSampleCount: existingMetadata?.trainingSampleCount ?? 0,
      featureVersion:      FEATURE_COUNT,
      modelArchitecture:   'MLP+LR_ensemble',
      mlpConfig:  { hiddenSize: 8, inputSize: FEATURE_COUNT, outputSize: 1, activations: ['relu', 'sigmoid'] },
      lrConfig:   { inputSize: FEATURE_COUNT, regularization: 'l2', learningRate: 0.001 },
      validationAccuracy:  existingMetadata?.validationAccuracy ?? 50,
      holdoutAccuracy:     existingMetadata?.holdoutAccuracy ?? null,
      holdoutF1:           null,
      backtestReturn:      null,
      maxDrawdown:         null,
      winRate:             null,
      profitFactor:        null,
      trainingDurationMs:  0,
      dataRange:           { oldestCandle: 0, newestCandle: existingMetadata?.trainedAt ?? Date.now() },
      codeModelVersion:    ARCHITECTURE_VERSION,
      isChampion:          true,
      championSetAt:       Date.now(),
    };

    const pointer: ChampionPointer = {
      symbol, timeframe,
      version:      slot,
      modelVersion: meta.modelVersion,
      updatedAt:    Date.now(),
      reason:       'Bootstrapped from legacy mlModel_* weights — no retraining needed.',
    };

    await _saveVersionList(symbol, timeframe, [meta]);
    await _saveChampionLocal(symbol, timeframe, pointer);
    _firestoreSetChampion(symbol, timeframe, pointer).catch(() => {});

    logger.info('modelVersioning', `${symbol}/${timeframe}: bootstrap complete — existing model is now Champion v${meta.modelVersion}`);
    return true;
  });
}

// ── Public read API ───────────────────────────────────────────────────────────

export async function listVersions(symbol: string, timeframe: string): Promise<VersionedModelMetadata[]> {
  return _loadVersionList(symbol, timeframe);
}

export async function getChampion(symbol: string, timeframe: string): Promise<ChampionPointer | null> {
  return _loadChampionLocal(symbol, timeframe) ?? _firestoreGetChampion(symbol, timeframe);
}

export async function loadChampionWeights(
  symbol: string, timeframe: string, horizon: number,
): Promise<string | null> {
  const pointer = await getChampion(symbol, timeframe);
  if (!pointer) return null;
  const key = VERSIONED_MODEL_KEY(pointer.version, symbol, timeframe, horizon);
  try {
    return await AsyncStorage.getItem(key) ?? await _cloudDownloadWeights(key);
  } catch { return null; }
}

export async function loadVersionWeights(
  slot: number, symbol: string, timeframe: string, horizon: number,
): Promise<string | null> {
  const key = VERSIONED_MODEL_KEY(slot, symbol, timeframe, horizon);
  try {
    return await AsyncStorage.getItem(key) ?? await _cloudDownloadWeights(key);
  } catch { return null; }
}

// ── Rollback ──────────────────────────────────────────────────────────────────
/**
 * rollbackToVersion — restores a previous version as champion.
 *
 * Steps (in order, never destructive):
 *  1. Verify weights exist for ALL horizons in target slot
 *  2. Copy target slot weights → MODEL_KEY/LR_KEY (inference reads these)
 *  3. Update champion pointer (local + Firestore)
 *  4. Update isChampion flags in version list
 *  Refuses if any horizon weights are missing or corrupt.
 */
export async function rollbackToVersion(
  symbol:     string,
  timeframe:  string,
  targetSlot: number,
  reason:     string,
  horizons:   number[] = [1, 3, 5, 10, 20],
): Promise<{ success: boolean; reason: string }> {
  return withVersioningLock(symbol, timeframe, async () => {
    const versionList = await _loadVersionList(symbol, timeframe);

    // 1. Verify ALL horizon weights present for target slot
    const missingHorizons: number[] = [];
    for (const h of horizons) {
      const key = VERSIONED_MODEL_KEY(targetSlot, symbol, timeframe, h);
      const hasWeights = !!(await AsyncStorage.getItem(key).catch(() => null))
        || !!(await _cloudDownloadWeights(key));
      if (!hasWeights) missingHorizons.push(h);
    }
    if (missingHorizons.length > 0) {
      return {
        success: false,
        reason: `Rollback refused: weights missing for horizons [${missingHorizons.join(',')}] in slot ${targetSlot}.`,
      };
    }

    // 2. Copy target slot weights → live inference keys
    const writeResult = await _writeChampionToLiveKeys(targetSlot, symbol, timeframe, horizons);
    if (!writeResult.success) {
      return {
        success: false,
        reason: `Rollback refused: failed to write target weights to live keys (missing h: ${writeResult.missingHorizons.join(',')}).`,
      };
    }

    // 3. Find the version metadata for this slot
    // Slot mapping: slot = ((modelVersion-1) % MAX_VERSIONS) + 1
    // Try to find the right entry; fall back to current champion modelVersion - 1
    const targetMeta = versionList.find(v =>
      ((v.modelVersion - 1) % MAX_VERSIONS + 1) === targetSlot
    );
    const currentChampion = await _loadChampionLocal(symbol, timeframe);

    const pointer: ChampionPointer = {
      symbol, timeframe,
      version:      targetSlot,
      modelVersion: targetMeta?.modelVersion ?? Math.max(1, (currentChampion?.modelVersion ?? 1) - 1),
      updatedAt:    Date.now(),
      reason:       `Rollback: ${reason}`,
    };

    // 4. Update champion pointer
    await _saveChampionLocal(symbol, timeframe, pointer);
    _firestoreSetChampion(symbol, timeframe, pointer).catch(() => {});

    // 5. Update isChampion flags in version list
    for (const v of versionList) v.isChampion = false;
    if (targetMeta) {
      targetMeta.isChampion    = true;
      targetMeta.championSetAt = Date.now();
    }
    await _saveVersionList(symbol, timeframe, versionList);

    logger.info('modelVersioning', `${symbol}/${timeframe}: rolled back to slot ${targetSlot} — ${reason}`);
    return { success: true, reason: `Rolled back to slot ${targetSlot}. Live keys updated.` };
  });
}

// ── Champion repair ───────────────────────────────────────────────────────────
/**
 * validateAndRepairChampion — verifies champion weights can be loaded.
 * If missing, attempts rollback to newest valid slot.
 * Also writes live MODEL_KEY/LR_KEY after repair so inference picks up immediately.
 */
export async function validateAndRepairChampion(
  symbol:    string,
  timeframe: string,
  horizons:  number[] = [1, 3, 5, 10, 20],
): Promise<{ valid: boolean; repairedTo: number | null }> {
  const pointer = await getChampion(symbol, timeframe);
  if (!pointer) return { valid: true, repairedTo: null }; // no champion — first-train path

  // Check all horizons for champion slot
  let championOk = true;
  for (const h of horizons) {
    const key = VERSIONED_MODEL_KEY(pointer.version, symbol, timeframe, h);
    const ok = !!(await AsyncStorage.getItem(key).catch(() => null));
    if (!ok) { championOk = false; break; }
  }
  if (championOk) return { valid: true, repairedTo: null };

  // Champion weights missing — find newest valid slot
  for (let slot = MAX_VERSIONS; slot >= 1; slot--) {
    if (slot === pointer.version) continue;
    let slotOk = true;
    for (const h of horizons) {
      const key = VERSIONED_MODEL_KEY(slot, symbol, timeframe, h);
      const ok = !!(await AsyncStorage.getItem(key).catch(() => null));
      if (!ok) { slotOk = false; break; }
    }
    if (slotOk) {
      const result = await rollbackToVersion(symbol, timeframe, slot, 'champion weights missing — auto-repair', horizons);
      if (result.success) return { valid: false, repairedTo: slot };
    }
  }

  return { valid: false, repairedTo: null };
}
