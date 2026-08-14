// ─────────────────────────────────────────────────────────────────────────────
// AUTH SERVICE  (Phase 3)
//
// Strategy:
//   1. On first launch: sign in anonymously (instant, no friction, no UI)
//   2. User can optionally sign in with Google to sync across devices
//   3. On Google sign-in: link anonymous account → Google (data preserved)
//
// Auth state is exposed via useAuth() hook (AuthContext).
// All Firestore data is scoped under /users/{uid}/ so data is per-user.
// ─────────────────────────────────────────────────────────────────────────────
import {
  signInAnonymously,
  signInWithCredential,
  linkWithCredential,
  GoogleAuthProvider,
  onAuthStateChanged,
  User,
  UserCredential,
} from 'firebase/auth';
import { auth } from './firebase';
import { logger } from '../utils/logger';

// ── Anonymous sign-in (called on app start) ───────────────────────────────────
export async function signInAnon(): Promise<User | null> {
  try {
    if (auth.currentUser) return auth.currentUser;
    const cred: UserCredential = await signInAnonymously(auth);
    logger.info('auth', `Signed in anonymously: ${cred.user.uid}`);
    return cred.user;
  } catch (e: any) {
    logger.error('auth', `Anonymous sign-in failed: ${e.message}`);
    return null;
  }
}

// ── Google Sign-In using expo-auth-session ────────────────────────────────────
// Returns the signed-in user or null on failure/cancel.
export async function signInWithGoogle(): Promise<User | null> {
  try {
    const { makeRedirectUri, startAsync } = await import('expo-auth-session');

    const redirectUri = makeRedirectUri({ scheme: 'quantis' });
    const clientId    = '758343320732-web-client-id.apps.googleusercontent.com'; // replace with real web client ID

    const result = await startAsync({
      authUrl:
        `https://accounts.google.com/o/oauth2/v2/auth?` +
        `client_id=${clientId}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&response_type=token` +
        `&scope=profile%20email`,
    });

    if (result.type !== 'success') {
      logger.info('auth', `Google sign-in ${result.type}`);
      return null;
    }

    const { access_token } = result.params as { access_token: string };
    const credential = GoogleAuthProvider.credential(null, access_token);

    let user: User;
    if (auth.currentUser?.isAnonymous) {
      // Link anonymous account to Google (preserves all data)
      const linked = await linkWithCredential(auth.currentUser, credential);
      user = linked.user;
      logger.info('auth', `Anonymous account linked to Google: ${user.email}`);
    } else {
      const signed = await signInWithCredential(auth, credential);
      user = signed.user;
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
    await auth.signOut();
    // Re-sign in anonymously so app still works without account
    await signInAnon();
  } catch (e: any) {
    logger.error('auth', `Sign out failed: ${e.message}`);
  }
}

// ── Get current user UID (for Firestore path scoping) ─────────────────────────
export function getCurrentUid(): string | null {
  return auth.currentUser?.uid ?? null;
}

// ── Subscribe to auth state changes ──────────────────────────────────────────
export function subscribeToAuthState(callback: (user: User | null) => void): () => void {
  return onAuthStateChanged(auth, callback);
}

export type { User };
