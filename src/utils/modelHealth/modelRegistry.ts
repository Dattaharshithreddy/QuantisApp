// ─────────────────────────────────────────────────────────────────────────────
// MODEL REGISTRY  (v6.1.0)
// Extends the existing checkpoint rotation (PREV_MODEL_KEY) with a full
// version history, rich metadata, and rollback support.
//
// Design: does NOT rewrite the existing MODEL_KEY / PREV_MODEL_KEY rotation.
// It adds a registry record alongside every checkpoint write. The registry
// is a simple append-only list stored under one AsyncStorage key per
// symbol+timeframe. Queries are O(versions) — always small (<100).
// ─────────────────────────────────────────────────────────────────────────────
import AsyncStorage from '@react-native-async-storage/async-storage';
import { KVStore } from '../../services/storage';
import { ARCHITECTURE_VERSION } from '../modelConstants';

// ── Registry record — one per accepted training run ──────────────────────────
export type ModelRegistryEntry = {
  modelVersion:           number;
  trainingDate:           number;   // Unix ms
  trainingSamples:        number;
  walkForwardAccuracy:    number;   // 0–100
  holdoutAccuracy:        number | null;  // null before Fix 1
  holdoutF1:              number | null;
  featureVersion:         number;   // FEATURE_NAMES.length at time of training
  engineVersion:          number;   // ARCHITECTURE_VERSION from modelConstants
  reasonForReplacement:   string;   // why the PREVIOUS model was replaced
  // Drift state snapshot at time of acceptance
  driftScoreAtTraining:   number;   // mean |z-score| from the prediction before training
  // Weight keys for rollback (stored at time of write; PREV_KEY holds weights)
  symbol:                 string;   // stored for direct key construction in rollbackModel
  timeframe:              string;
};

const REGISTRY_KEY = (symbol: string, tf: string) => `mlRegistry_${symbol}_${tf}`;
const MAX_REGISTRY_ENTRIES = 50;  // prevent unbounded growth

// ── Read ──────────────────────────────────────────────────────────────────────
export async function listModels(symbol: string, timeframe: string): Promise<ModelRegistryEntry[]> {
  try {
    const raw = await KVStore.get(REGISTRY_KEY(symbol, timeframe));
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

export async function latestModel(symbol: string, timeframe: string): Promise<ModelRegistryEntry | null> {
  const all = await listModels(symbol, timeframe);
  return all.length > 0 ? all[all.length - 1] : null;
}

// ── Write — appends to registry, trims to MAX_REGISTRY_ENTRIES ───────────────
export async function registerModel(
  symbol:    string,
  timeframe: string,
  entry:     ModelRegistryEntry,
): Promise<void> {
  try {
    const all = await listModels(symbol, timeframe);
    all.push(entry);
    const trimmed = all.slice(-MAX_REGISTRY_ENTRIES);
    await KVStore.set(REGISTRY_KEY(symbol, timeframe), JSON.stringify(trimmed));
  } catch (e: any) {
    console.warn('[ModelRegistry] Failed to write:', e.message);
  }
}

// ── Rollback — restores the previous model from PREV_MODEL_KEY ───────────────
// DOES NOT change the registry — the rollback is recorded as a new entry.
// Reuses the existing PREV_MODEL_KEY rotation: no new key is introduced.
export async function rollbackModel(
  symbol:    string,
  timeframe: string,
  HORIZONS:  number[],
): Promise<{ success: boolean; reason: string }> {
  const all = await listModels(symbol, timeframe);
  if (all.length < 2) {
    return { success: false, reason: 'No previous checkpoint available (need at least 2 registry entries).' };
  }

  const current  = all[all.length - 1];
  const previous = all[all.length - 2];

  // Swap PREV→current for each horizon: read the prev key, write to live key
  for (const h of HORIZONS) {
    const prevKey = `mlModel_prev_${previous.symbol}_${previous.timeframe}_h${h}`;
    const liveKey = `mlModel_${previous.symbol}_${previous.timeframe}_h${h}`;
    try {
      const raw = await KVStore.get(prevKey);
      if (raw) await KVStore.set(liveKey, raw);
    } catch { /* best-effort per horizon */ }
  }

  // Append a rollback entry to the registry
  const rollbackEntry: ModelRegistryEntry = {
    ...previous,
    trainingDate:        Date.now(),
    reasonForReplacement:`Rollback from v${current.modelVersion} to v${previous.modelVersion}`,
    modelVersion:        previous.modelVersion};
  await registerModel(symbol, timeframe, rollbackEntry);

  return {
    success: true,
    reason: `Rolled back from v${current.modelVersion} to v${previous.modelVersion}.`};
}

// ── Build a registry entry from a completed training run ─────────────────────
// Called by mlSignal.ts after a model is accepted.
export function buildRegistryEntry(params: {
  symbol:              string;
  timeframe:           string;
  modelVersion:        number;
  trainingSamples:     number;
  walkForwardAccuracy: number;
  holdoutAccuracy:     number | null;
  holdoutF1:           number | null;
  featureCount:        number;
  driftScore:          number;
  previousVersion:     number | null;
  // symbol and timeframe already present at top of params
}): ModelRegistryEntry {
  return {
    modelVersion:         params.modelVersion,
    trainingDate:         Date.now(),
    trainingSamples:      params.trainingSamples,
    walkForwardAccuracy:  params.walkForwardAccuracy,
    holdoutAccuracy:      params.holdoutAccuracy,
    holdoutF1:            params.holdoutF1,
    featureVersion:       params.featureCount,
    engineVersion:        ARCHITECTURE_VERSION,
    reasonForReplacement: params.previousVersion != null
      ? `Replaced v${params.previousVersion}: new model accepted (accuracy improved or first run).`
      : 'Initial model registration.',
    driftScoreAtTraining: params.driftScore,
    symbol:               params.symbol,
    timeframe:            params.timeframe};
}
