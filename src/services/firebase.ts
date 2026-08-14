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

const firebaseConfig = {
  apiKey:            'AIzaSyDWbdiTn83IHPBaqwc5iAKm6Y71JnGYqWs',
  authDomain:        'quantis-trading.firebaseapp.com',
  projectId:         'quantis-trading',
  storageBucket:     'quantis-trading.firebasestorage.app',
  messagingSenderId: '758343320732',
  appId:             '1:758343320732:web:b451e5ec9f5f792ba1d959',
  measurementId:     'G-W46TZ5FKVH',
};

// Guard against double-init in development hot reloads
const app: FirebaseApp = getApps().length ? getApp() : initializeApp(firebaseConfig);

export const db:      Firestore       = getFirestore(app);
export const auth:    Auth            = getAuth(app);
export const storage: FirebaseStorage = getStorage(app);
export default app;
