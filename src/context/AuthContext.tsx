// ─────────────────────────────────────────────────────────────────────────────
// AUTH CONTEXT  (Phase 3)
//
// Wraps the app with Firebase Auth state.
// Automatically signs in anonymously on first launch.
// Exposes: user, isAnonymous, isLoading, signInWithGoogle, signOut
// ─────────────────────────────────────────────────────────────────────────────
import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { signInAnon, signInWithGoogle as _signInWithGoogle, signOut as _signOut,

         subscribeToAuthState, User } from '../services/auth';
import { useModelRepair } from '../hooks/useModelRepair';
console.log('[QUANTIS_DIAG] AuthContext: module loaded');

type AuthContextValue = {
  user:             User | null;
  uid:              string | null;
  isAnonymous:      boolean;
  isLoading:        boolean;
  isGoogleLinked:   boolean;
  signInWithGoogle: () => Promise<boolean>;
  signOut:          () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue>({
  user: null, uid: null, isAnonymous: true, isLoading: true,
  isGoogleLinked: false,
  signInWithGoogle: async () => false,
  signOut: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser]         = useState<User | null>(null);
  const [isLoading, setLoading] = useState(true);

  // Champion integrity check — runs once after auth is available, in background
  useModelRepair(user?.uid ?? null);

  useEffect(() => {
    // Subscribe to auth state changes
    const unsub = subscribeToAuthState(u => {
      setUser(u);
      setLoading(false);
    });

    // Sign in anonymously on first launch if no user
    signInAnon().catch(() => setLoading(false));

    return unsub;
  }, []);

  const signInWithGoogle = useCallback(async (): Promise<boolean> => {
    const u = await _signInWithGoogle();
    return !!u;
  }, []);

  const signOut = useCallback(async () => {
    await _signOut();
  }, []);

  const isGoogleLinked = !!(user && !user.isAnonymous);

  return (
    <AuthContext.Provider value={{
      user,
      uid:          user?.uid ?? null,
      isAnonymous:  user?.isAnonymous ?? true,
      isLoading,
      isGoogleLinked,
      signInWithGoogle,
      signOut,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}
