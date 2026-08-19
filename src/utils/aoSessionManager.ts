// ─────────────────────────────────────────────────────────────────────────────
// AO SESSION MANAGER  (v1.0.0)
//
// Angel One JWT tokens expire after 24 hours. The app cannot auto-refresh
// silently because:
//   • The PIN (password) is never persisted — it's a security secret.
//   • TOTP changes every 30 seconds — can't be stored.
//
// This module provides:
//   1. checkAOSessionValid() — returns false if token is expired or missing
//   2. isAO401Error(e) — detects AO auth errors from any API call
//   3. AO_SESSION_EXPIRY_MS — tokens expire 24h after login
//   4. getAOSessionAge() — how old the current session is
//
// The app wires these into DataContext: on any 401 from AO, setAoSession(null)
// is called (already done). The SessionExpiredBanner component reads from
// context and surfaces a re-login prompt when session is null and credentials
// exist (key + clientCode stored in session).
// ─────────────────────────────────────────────────────────────────────────────

import { AOSession } from '../api/angelOne';

// AO tokens expire after 24 hours per Angel One documentation.
// We treat the session as expired after 23 hours to give a 1-hour buffer
// where background operations may still succeed but the UI prompts re-login.
export const AO_SESSION_EXPIRY_MS    = 23 * 60 * 60 * 1000;   // 23 hours
export const AO_SESSION_WARNING_MS   = 22 * 60 * 60 * 1000;   // 22 hours — show warning

/**
 * Returns true if the session exists and is within the valid window.
 * The session object must carry a loginAt timestamp to use time-based checks.
 * Falls back to accepting any non-null session if loginAt is absent (backward compat).
 */
export function isAOSessionValid(session: AOSession | null): boolean {
  if (!session?.jwtToken) return false;
  const loginAt = (session as any).loginAt as number | undefined;
  if (!loginAt) return true;   // no timestamp — assume valid (backward compat)
  return Date.now() - loginAt < AO_SESSION_EXPIRY_MS;
}

/**
 * Returns true if the session is within 1 hour of expiry (time to show banner).
 */
export function isAOSessionExpiringSoon(session: AOSession | null): boolean {
  if (!session?.jwtToken) return false;
  const loginAt = (session as any).loginAt as number | undefined;
  if (!loginAt) return false;
  const age = Date.now() - loginAt;
  return age >= AO_SESSION_WARNING_MS && age < AO_SESSION_EXPIRY_MS;
}

/**
 * Returns age of session in milliseconds, or null if no session / no timestamp.
 */
export function getAOSessionAgeMs(session: AOSession | null): number | null {
  const loginAt = (session as any)?.loginAt as number | undefined;
  if (!loginAt) return null;
  return Date.now() - loginAt;
}

/**
 * Detects a 401/auth-related error from Angel One API responses.
 * Used in catch blocks to trigger session invalidation.
 */
export function isAO401Error(e: any): boolean {
  const msg = (e?.message ?? '').toLowerCase();
  return msg.includes('401') ||
         msg.includes('token expired') ||
         msg.includes('invalid token') ||
         msg.includes('unauthorized') ||
         msg.includes('session expired') ||
         msg.includes('jwt');
}

/**
 * Formats session age as a human-readable string for display.
 */
export function formatSessionAge(session: AOSession | null): string {
  const ms = getAOSessionAgeMs(session);
  if (ms === null) return 'Unknown';
  const hours = Math.floor(ms / (60 * 60 * 1000));
  const mins  = Math.floor((ms % (60 * 60 * 1000)) / 60000);
  if (hours === 0) return `${mins}m ago`;
  return `${hours}h ${mins}m ago`;
}
