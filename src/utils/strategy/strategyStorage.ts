// ─────────────────────────────────────────────────────────────────────────────
// STRATEGY STORAGE  (v1.0.0)
//
// Persists the active StrategyId across app sessions via AsyncStorage.
// Pattern mirrors regimeFilter.ts (KEY constant + typed get/set functions).
//
// null = no strategy active → existing app behavior unchanged.
// This is the only entry point for reading/writing strategy selection.
// ─────────────────────────────────────────────────────────────────────────────

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { StrategyId } from './strategyTypes';

const KEY = 'activeStrategyId';

// ── Valid strategy IDs for safe deserialization ───────────────────────────────
// Checked on read so a corrupt AsyncStorage value never causes a runtime error.
const VALID_IDS: StrategyId[] = ['SCALPING', 'INTRADAY', 'SWING', 'POSITION'];

function isValidStrategyId(value: unknown): value is StrategyId {
  return typeof value === 'string' && VALID_IDS.includes(value as StrategyId);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns the currently active StrategyId, or null if no strategy is selected.
 * null = all existing app behavior is unchanged.
 * Never throws — returns null on any read/parse error.
 */
export async function getActiveStrategyId(): Promise<StrategyId | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isValidStrategyId(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Persists the active strategy selection.
 * Pass null to clear the selection (= no strategy active).
 * Never throws — swallows write errors silently (same pattern as riskManager.ts).
 */
export async function setActiveStrategyId(id: StrategyId | null): Promise<void> {
  try {
    if (id === null) {
      await AsyncStorage.removeItem(KEY);
    } else {
      await AsyncStorage.setItem(KEY, JSON.stringify(id));
    }
  } catch {
    // Storage failures are non-fatal — the app continues with the in-memory default
  }
}

/**
 * Clears the active strategy selection.
 * Convenience wrapper around setActiveStrategyId(null).
 */
export async function clearActiveStrategy(): Promise<void> {
  return setActiveStrategyId(null);
}
