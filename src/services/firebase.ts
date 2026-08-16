// ─────────────────────────────────────────────────────────────────────────────
// FIREBASE SINGLETON  (Phase 1)
//
// Single initialisation point for the entire app.
// Import { db, auth, storage } from here — never call initializeApp() elsewhere.
// ─────────────────────────────────────────────────────────────────────────────
import { initializeApp, getApps, getApp, FirebaseApp } from 'firebase/app';
import { getFirestore, Firestore } from 'firebase/firestore';
import { getAuth, Auth } from 'firebase/auth';
import { getStorage, FirebaseStorage } from 'firebase/storage';
console.log('[QUANTIS_DIAG] firebase: module loaded');


const firebaseConfig = {
  apiKey:            'AIzaSyDWbdiTn83IHPBaqwc5iAKm6Y71JnGYqWs',
  authDomain:        'quantis-trading.firebaseapp.com',
  projectId:         'quantis-trading',
  storageBucket:     'quantis-trading.firebasestorage.app',
  messagingSenderId: '758343320732',
  appId:             '1:758343320732:web:b451e5ec9f5f792ba1d959',
  measurementId:     'G-W46TZ5FKVH',
};

// Lazy initialization — only runs when first accessed
// This prevents Hermes/Metro from crashing on module load
let _app:     FirebaseApp     | null = null;
let _db:      Firestore       | null = null;
let _auth:    Auth            | null = null;
let _storage: FirebaseStorage | null = null;

function getFirebaseApp(): FirebaseApp {
  if (!_app) {
    _app = getApps().length ? getApp() : initializeApp(firebaseConfig);
  }
  return _app;
}

export function getDb(): Firestore {
  if (!_db) _db = getFirestore(getFirebaseApp());
  return _db;
}

export function getFirebaseAuth(): Auth {
  if (!_auth) _auth = getAuth(getFirebaseApp());
  return _auth;
}

export function getFirebaseStorage(): FirebaseStorage {
  if (!_storage) _storage = getStorage(getFirebaseApp());
  return _storage;
}

// Convenience accessors (lazy — safe to import at module level)
export const db      = new Proxy({} as Firestore,       { get: (_, p) => (getDb()      as any)[p] });
export const auth    = new Proxy({} as Auth,            { get: (_, p) => (getFirebaseAuth() as any)[p] });
export const storage = new Proxy({} as FirebaseStorage, { get: (_, p) => (getFirebaseStorage() as any)[p] });
export default getFirebaseApp;
