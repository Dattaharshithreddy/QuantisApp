// ─────────────────────────────────────────────────────────────────────────────
// ML MODEL STORAGE SERVICE  (Phase 4 — fixed lazy Firebase imports)
//
// All Firebase symbols obtained via lazy require() inside each function body.
// Matches the project-wide Hermes/RN safe pattern from firebase.ts.
// Never crashes at module load time regardless of Firebase availability.
//
// Two-tier storage:
//   L1: AsyncStorage (instant, used for every prediction)
//   L2: Firebase Storage (cloud backup, restored on reinstall)
//
// Path in Firebase Storage: /users/{uid}/models/{key}
// ─────────────────────────────────────────────────────────────────────────────
import AsyncStorage from '@react-native-async-storage/async-storage';
import { logger } from '../utils/logger';
console.log('[QUANTIS_DIAG] mlStorage: module loaded');

// ── Firebase lazy helpers ─────────────────────────────────────────────────────
function _getAuth(): any {
  try { const { getFirebaseAuth } = require('./firebase'); return getFirebaseAuth(); }
  catch { return null; }
}
function _getStorage(): any {
  try { const { getFirebaseStorage } = require('./firebase'); return getFirebaseStorage(); }
  catch { return null; }
}
function _getUid(): string | null {
  try { return _getAuth()?.currentUser?.uid ?? null; }
  catch { return null; }
}

// ── Path helpers ─────────────────────────────────────────────────────────────
function modelPath(key: string): string {
  const uid = _getUid() ?? 'anonymous';
  const safeKey = key.replace(/[#\[\]*/]/g, '_');
  return `users/${uid}/models/${safeKey}`;
}

// ── Save model weights ────────────────────────────────────────────────────────
export async function saveModel(key: string, data: string): Promise<void> {
  await AsyncStorage.setItem(key, data);
  uploadModelToCloud(key, data).catch(e =>
    logger.warn('mlStorage', `Cloud upload failed for ${key}: ${e?.message ?? e}`)
  );
}

async function uploadModelToCloud(key: string, data: string): Promise<void> {
  const uid = _getUid();
  if (!uid) return;
  const storage = _getStorage();
  if (!storage) return;
  try {
    const { ref, uploadString } = require('firebase/storage');
    await uploadString(ref(storage, modelPath(key)), data);
    logger.info('mlStorage', `Uploaded ${key} to Firebase Storage (${Math.round(data.length / 1024)}KB)`);
  } catch (e: any) {
    logger.warn('mlStorage', `Cloud upload error for ${key}: ${e?.message ?? e}`);
  }
}

// ── Load model weights ────────────────────────────────────────────────────────
export async function loadModel(key: string): Promise<string | null> {
  const local = await AsyncStorage.getItem(key);
  if (local) return local;
  return downloadModelFromCloud(key);
}

async function downloadModelFromCloud(key: string): Promise<string | null> {
  const uid = _getUid();
  if (!uid) return null;
  const storage = _getStorage();
  if (!storage) return null;
  try {
    const { ref, getDownloadURL } = require('firebase/storage');
    const url = await getDownloadURL(ref(storage, modelPath(key)));
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data = await resp.text();
    await AsyncStorage.setItem(key, data);
    logger.info('mlStorage', `Restored ${key} from Firebase Storage (${Math.round(data.length / 1024)}KB)`);
    return data;
  } catch { return null; }
}

// ── Delete model ─────────────────────────────────────────────────────────────
export async function deleteModel(key: string): Promise<void> {
  await AsyncStorage.removeItem(key);
  const uid = _getUid();
  if (!uid) return;
  const storage = _getStorage();
  if (!storage) return;
  try {
    const { ref, deleteObject } = require('firebase/storage');
    await deleteObject(ref(storage, modelPath(key)));
  } catch { /* ignore if doesn't exist */ }
}

// ── Check if model exists (local or cloud) ────────────────────────────────────
export async function modelExists(key: string): Promise<boolean> {
  const local = await AsyncStorage.getItem(key);
  if (local) return true;
  const uid = _getUid();
  if (!uid) return false;
  const storage = _getStorage();
  if (!storage) return false;
  try {
    const { ref, getDownloadURL } = require('firebase/storage');
    await getDownloadURL(ref(storage, modelPath(key)));
    return true;
  } catch { return false; }
}

// ── List all backed-up models for this user ───────────────────────────────────
export async function getCloudModelCount(): Promise<number> {
  return -1;
}
