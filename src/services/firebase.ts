// ─────────────────────────────────────────────────────────────────────────────
// FIREBASE SINGLETON — safe wrapper, never crashes app on load
// ─────────────────────────────────────────────────────────────────────────────
console.log('[QUANTIS_DIAG] firebase: module loaded');

let _app: any = null;
let _db:  any = null;
let _auth: any = null;
let _storage: any = null;

const firebaseConfig = {
  apiKey:            'AIzaSyDWbdiTn83IHPBaqwc5iAKm6Y71JnGYqWs',
  authDomain:        'quantis-trading.firebaseapp.com',
  projectId:         'quantis-trading',
  storageBucket:     'quantis-trading.firebasestorage.app',
  messagingSenderId: '758343320732',
  appId:             '1:758343320732:web:b451e5ec9f5f792ba1d959',
};

function initFirebase() {
  if (_app) return _app;
  try {
    const { initializeApp, getApps, getApp } = require('firebase/app');
    _app = getApps().length ? getApp() : initializeApp(firebaseConfig);
    console.log('[QUANTIS_DIAG] firebase: initialized OK');
  } catch (e: any) {
    console.warn('[QUANTIS_DIAG] firebase: init failed:', e?.message);
    _app = null;
  }
  return _app;
}

export function getDb() {
  if (!_db) {
    try {
      const { getFirestore } = require('firebase/firestore');
      _db = getFirestore(initFirebase());
    } catch (e) { _db = null; }
  }
  return _db;
}

export function getFirebaseAuth() {
  if (!_auth) {
    try {
      const { getAuth } = require('firebase/auth');
      _auth = getAuth(initFirebase());
    } catch (e) { _auth = null; }
  }
  return _auth;
}

export function getFirebaseStorage() {
  if (!_storage) {
    try {
      const { getStorage } = require('firebase/storage');
      _storage = getStorage(initFirebase());
    } catch (e) { _storage = null; }
  }
  return _storage;
}

// Proxy objects — safe to use even if Firebase fails
// All operations are no-ops if Firebase is unavailable
export const db      = new Proxy({} as any, { get: (_, p) => { const d = getDb();      return d ? d[p as string] : () => Promise.resolve(); } });
export const auth    = new Proxy({} as any, { get: (_, p) => { const a = getFirebaseAuth(); return a ? a[p as string] : () => Promise.resolve(); } });
export const storage = new Proxy({} as any, { get: (_, p) => { const s = getFirebaseStorage(); return s ? s[p as string] : () => Promise.resolve(); } });

export default initFirebase;
