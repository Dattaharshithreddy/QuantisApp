// ─────────────────────────────────────────────────────────────────────────────
// ML MODEL STORAGE SERVICE  (Phase 4)
//
// Two-tier storage for ML model weights:
//   L1: AsyncStorage (instant read, used for every prediction)
//   L2: Firebase Storage (cloud backup, restored on reinstall)
//
// Flow:
//   SAVE:    AsyncStorage (instant) → Firebase Storage (background upload)
//   RESTORE: AsyncStorage hit → return immediately (fast path)
//            AsyncStorage miss → download from Firebase Storage → cache locally
//
// Path in Firebase Storage: /users/{uid}/models/{key}
// ─────────────────────────────────────────────────────────────────────────────
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ref, uploadString, getDownloadURL, deleteObject } from 'firebase/storage';
import { storage, auth } from './firebase';
import { logger } from '../utils/logger';
console.log('[QUANTIS_DIAG] mlStorage: module loaded');


// ── Path helpers ─────────────────────────────────────────────────────────────
function modelPath(key: string): string {
  const uid = auth.currentUser?.uid ?? 'anonymous';
  // Firebase Storage paths can't have certain chars — encode them
  const safeKey = key.replace(/[#\[\]*/]/g, '_');
  return `users/${uid}/models/${safeKey}`;
}

// ── Save model weights ────────────────────────────────────────────────────────
// Saves to AsyncStorage immediately, uploads to Firebase Storage in background.
export async function saveModel(key: string, data: string): Promise<void> {
  // L1: save locally (instant, always succeeds)
  await AsyncStorage.setItem(key, data);

  // L2: upload to Firebase Storage in background (fire-and-forget)
  uploadModelToCloud(key, data).catch(e =>
    logger.warn('mlStorage', `Cloud upload failed for ${key}: ${e.message}`)
  );
}

async function uploadModelToCloud(key: string, data: string): Promise<void> {
  if (!auth.currentUser) return; // no auth → skip cloud upload
  const storageRef = ref(storage, modelPath(key));
  await uploadString(storageRef, data);
  logger.info('mlStorage', `Uploaded ${key} to Firebase Storage (${Math.round(data.length / 1024)}KB)`);
}

// ── Load model weights ────────────────────────────────────────────────────────
// Checks AsyncStorage first (fast path). On miss, downloads from Firebase Storage.
export async function loadModel(key: string): Promise<string | null> {
  // L1: check local cache
  const local = await AsyncStorage.getItem(key);
  if (local) return local;

  // L2: try Firebase Storage (restore after reinstall)
  return downloadModelFromCloud(key);
}

async function downloadModelFromCloud(key: string): Promise<string | null> {
  if (!auth.currentUser) return null;
  try {
    const storageRef = ref(storage, modelPath(key));
    const url = await getDownloadURL(storageRef);
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data = await resp.text();
    // Cache locally so next access is instant
    await AsyncStorage.setItem(key, data);
    logger.info('mlStorage', `Restored ${key} from Firebase Storage (${Math.round(data.length / 1024)}KB)`);
    return data;
  } catch {
    return null; // model not in cloud yet — will train fresh
  }
}

// ── Delete model ─────────────────────────────────────────────────────────────
export async function deleteModel(key: string): Promise<void> {
  await AsyncStorage.removeItem(key);
  if (!auth.currentUser) return;
  try {
    await deleteObject(ref(storage, modelPath(key)));
  } catch { /* ignore if doesn't exist */ }
}

// ── Check if model exists (local or cloud) ────────────────────────────────────
export async function modelExists(key: string): Promise<boolean> {
  const local = await AsyncStorage.getItem(key);
  if (local) return true;
  if (!auth.currentUser) return false;
  try {
    await getDownloadURL(ref(storage, modelPath(key)));
    return true;
  } catch {
    return false;
  }
}

// ── List all backed-up models for this user ───────────────────────────────────
// Used in AccountScreen to show backup status.
export async function getCloudModelCount(): Promise<number> {
  // Firebase Storage v9 doesn't support listing in RN without extra setup.
  // For now return -1 (unknown) — can implement with Cloud Functions later.
  return -1;
}
