// Firebase loaded lazily via require() — never crashes on import
// ─────────────────────────────────────────────────────────────────────────────
// AUTH SERVICE  (Phase 8)
//
// Strategy:
//   1. Auto sign-in anonymously on first launch (no friction)
//   2. Optional Google Sign-In via expo-auth-session
//   3. Anonymous → Google account link (data preserved)
//
// Web Client ID: 758343320732-vlcqo5qov5qukd3je8gm0jgsj7r6kp5a.apps.googleusercontent.com
// ─────────────────────────────────────────────────────────────────────────────
import { logger } from '../utils/logger';
console.log('[QUANTIS_DIAG] auth: module loaded');

// Type-only definition (firebase/auth loaded lazily via require)
export type User = {
  uid: string;
  email: string | null;
  displayName: string | null;
  isAnonymous: boolean;
  providerData: any[];
};


const WEB_CLIENT_ID = '758343320732-vlcqo5qov5qukd3je8gm0jgsj7r6kp5a.apps.googleusercontent.com';

// ── Anonymous sign-in ─────────────────────────────────────────────────────────
export async function signInAnon(): Promise<User | null> {
  try {
    const { getFirebaseAuth } = require('./firebase');
    const _auth = getFirebaseAuth();
    if (_auth?.currentUser) return _auth.currentUser as User;
    const { signInAnonymously } = require('firebase/auth');
    const cred = await signInAnonymously(_auth);
    logger.info('auth', `Signed in anonymously: ${cred.user.uid}`);
    return cred.user;
  } catch (e: any) {
    logger.error('auth', `Anonymous sign-in failed: ${e.message}`);
    return null;
  }
}

// ── Google Sign-In via React Native Linking (zero native deps) ───────────────
// Opens system browser → user signs in → browser redirects to app URL
// App reads the token from the URL via Linking event listener
export async function signInWithGoogle(): Promise<User | null> {
  try {
    const { Linking } = await import('react-native');
    const { GoogleAuthProvider, linkWithCredential, signInWithCredential } = require('firebase/auth');
    const { getFirebaseAuth } = require('./firebase');
    const _auth = getFirebaseAuth();

    const redirectUri = 'quantis://auth';
    const authUrl =
      `https://accounts.google.com/o/oauth2/v2/auth` +
      `?client_id=${WEB_CLIENT_ID}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&response_type=token` +
      `&scope=${encodeURIComponent('profile email')}`;

    // Open browser for OAuth
    await Linking.openURL(authUrl);

    // Listen for the redirect back to the app
    const url = await new Promise<string | null>((resolve) => {
      const timeout = setTimeout(() => { sub.remove(); resolve(null); }, 120_000); // 2 min timeout
      const sub = Linking.addEventListener('url', ({ url: u }) => {
        if (u.startsWith('quantis://auth')) {
          clearTimeout(timeout);
          sub.remove();
          resolve(u);
        }
      });
    });

    if (!url) {
      logger.info('auth', 'Google sign-in timed out or cancelled');
      return null;
    }

    // Extract access_token from redirect URL fragment
    const match = url.match(/[#&]access_token=([^&]+)/);
    if (!match) {
      logger.warn('auth', 'No access_token in redirect URL');
      return null;
    }

    const access_token = decodeURIComponent(match[1]);
    const credential = GoogleAuthProvider.credential(null, access_token);

    let user: User;
    if (_auth?.currentUser?.isAnonymous) {
      const linked = await linkWithCredential(_auth.currentUser, credential);
      user = linked.user as User;
      logger.info('auth', `Anonymous → Google linked: ${user.email}`);
    } else {
      const signed = await signInWithCredential(_auth, credential);
      user = signed.user as User;
      logger.info('auth', `Signed in with Google: ${user.email}`);
    }
    return user;
  } catch (e: any) {
    logger.error('auth', `Google sign-in failed: ${e.message}`);
    return null;
  }
}

// ── Sign out ──────────────────────────────────────────────────────────────────
export async function signOut(): Promise<void> {
  try {
    const { getFirebaseAuth } = require('./firebase');
    await getFirebaseAuth()?.signOut();
    await signInAnon(); // re-sign anonymously so app keeps working
  } catch (e: any) {
    logger.error('auth', `Sign out failed: ${e.message}`);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
export function getCurrentUid(): string | null {
  const { getFirebaseAuth } = require('./firebase');
  return getFirebaseAuth()?.currentUser?.uid ?? null;
}

export function subscribeToAuthState(callback: (user: User | null) => void): () => void {
  try {
    const { onAuthStateChanged } = require('firebase/auth');
    const { getFirebaseAuth } = require('./firebase');
    const _auth = getFirebaseAuth();
    if (!_auth) { callback(null); return () => {}; }
    return onAuthStateChanged(_auth, (u: any) => callback(u as User | null));
  } catch (e: any) {
    logger.warn('auth', `subscribeToAuthState failed: ${e.message}`);
    callback(null);
    return () => {};
  }
}

// User type exported above
