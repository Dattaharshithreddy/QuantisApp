// ─────────────────────────────────────────────────────────────────────────────
// PATTERN OUTCOME STORE  (v6.3.21)
//
// Persists PatternOutcome records to AsyncStorage and answers aggregate
// statistical queries per pattern family.
//
// Answers questions like:
//   "Which pattern has the highest TP1 hit rate?"
//   "Does Double Bottom confidence weighting need adjusting?"
//   "Which confirmations actually produce profitable trades?"
//   "What is the average bars-to-TP1 for a Bull Flag?"
//
// Architecture:
//   Storage key: 'patternOutcomes_v1'
//   Format: Record<patternId, PatternOutcome>
//
//   getOutcome(id)              → load one outcome by patternId
//   saveOutcome(outcome)        → persist (create or update)
//   getAllOutcomes()             → all stored outcomes
//   getOutcomesByPattern(name)  → filter by pattern family
//   computeFamilyStats(name)    → aggregate stats for one pattern family
//   computeAllFamilyStats()     → stats for every pattern family seen
//   getActiveOutcomes()         → outcomes that still need price monitoring
//
// ─────────────────────────────────────────────────────────────────────────────

import AsyncStorage from '@react-native-async-storage/async-storage';
import { logger } from '../logger';
import {
  PatternOutcome, PatternFamilyStats, MIN_OUTCOME_SAMPLE,
} from './patternValidationTypes';

const STORE_KEY = 'patternOutcomes_v1';

// ── Internal: load the full store (Record<patternId, PatternOutcome>) ─────────
async function loadStore(): Promise<Record<string, PatternOutcome>> {
  try {
    const raw = await AsyncStorage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e: any) {
    logger.error('patternOutcomeStore', `Failed to load: ${e.message}`);
    return {};
  }
}

async function saveStore(store: Record<string, PatternOutcome>): Promise<void> {
  try {
    await AsyncStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch (e: any) {
    logger.error('patternOutcomeStore', `Failed to save: ${e.message}`);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function getOutcome(patternId: string): Promise<PatternOutcome | null> {
  const store = await loadStore();
  return store[patternId] ?? null;
}

export async function saveOutcome(outcome: PatternOutcome): Promise<void> {
  const store = await loadStore();
  store[outcome.patternId] = outcome;
  await saveStore(store);
  logger.info(
    'patternOutcomeStore',
    `Saved outcome ${outcome.patternId}: ${outcome.outcomeStatus} ` +
    `(TP1:${outcome.tp1Hit} TP2:${outcome.tp2Hit} TP3:${outcome.tp3Hit} STOP:${outcome.stopHit})`,
  );
}

export async function getAllOutcomes(): Promise<PatternOutcome[]> {
  const store = await loadStore();
  return Object.values(store);
}

export async function getOutcomesByPattern(patternName: string): Promise<PatternOutcome[]> {
  const all = await getAllOutcomes();
  return all.filter(o => o.patternName === patternName);
}

// Returns all outcomes that are still ACTIVE or partially hit (TP1/TP2)
// and therefore need continued price monitoring.
export async function getActiveOutcomes(): Promise<PatternOutcome[]> {
  const all = await getAllOutcomes();
  return all.filter(o =>
    o.outcomeStatus === 'ACTIVE' ||
    o.outcomeStatus === 'TP1_HIT' ||
    o.outcomeStatus === 'TP2_HIT'
  );
}

export async function deleteOutcome(patternId: string): Promise<void> {
  const store = await loadStore();
  delete store[patternId];
  await saveStore(store);
}

// ── Aggregate statistics for one pattern family ───────────────────────────────
// Only counts TERMINAL outcomes (STOPPED / TP1_HIT / TP2_HIT / TP3_HIT / CLOSED).
// ACTIVE outcomes are excluded — they haven't resolved yet.
export function computeFamilyStats(
  patternName: string,
  outcomes:    PatternOutcome[],
): PatternFamilyStats {
  const resolved = outcomes.filter(o =>
    o.patternName === patternName &&
    o.outcomeStatus !== 'ACTIVE'
  );

  const total    = resolved.length;
  const tp1Count = resolved.filter(o => o.tp1Hit).length;
  const tp2Count = resolved.filter(o => o.tp2Hit).length;
  const tp3Count = resolved.filter(o => o.tp3Hit).length;
  const stopCount= resolved.filter(o => o.stopHit).length;

  const pnlValues = resolved
    .filter(o => o.realizedPnLPct != null)
    .map(o => o.realizedPnLPct!);
  const avgPnL = pnlValues.length > 0
    ? pnlValues.reduce((s, v) => s + v, 0) / pnlValues.length
    : 0;

  const tp1Bars = resolved
    .filter(o => o.barsToFirstTarget != null)
    .map(o => o.barsToFirstTarget!);
  const avgBarsToTP1 = tp1Bars.length > 0
    ? tp1Bars.reduce((s, v) => s + v, 0) / tp1Bars.length
    : null;

  const durations = resolved
    .filter(o => o.validationDuration != null)
    .map(o => o.validationDuration!);
  const avgDuration = durations.length > 0
    ? durations.reduce((s, v) => s + v, 0) / durations.length
    : null;

  // completionReason breakdown
  const expiredCount     = resolved.filter(o => o.completionReason === 'TIME_EXPIRY').length;
  const manualCloseCount = resolved.filter(o => o.completionReason === 'MANUAL_CLOSE').length;
  const invalidatedCount = resolved.filter(o => o.completionReason === 'INVALIDATED').length;

  return {
    patternName,
    totalConfirmed:      total,
    tp1HitCount:         tp1Count,
    tp2HitCount:         tp2Count,
    tp3HitCount:         tp3Count,
    stoppedCount:        stopCount,
    tp1HitRate:          total > 0 ? Math.round((tp1Count / total) * 1000) / 1000 : 0,
    tp2HitRate:          total > 0 ? Math.round((tp2Count / total) * 1000) / 1000 : 0,
    tp3HitRate:          total > 0 ? Math.round((tp3Count / total) * 1000) / 1000 : 0,
    stopRate:            total > 0 ? Math.round((stopCount / total) * 1000) / 1000 : 0,
    avgRealizedPnLPct:   Math.round(avgPnL * 10000) / 10000,
    avgBarsToTP1:        avgBarsToTP1 != null ? Math.round(avgBarsToTP1 * 10) / 10 : null,
    avgValidationDuration: avgDuration != null ? Math.round(avgDuration * 10) / 10 : null,
    sampleSufficient:    total >= MIN_OUTCOME_SAMPLE,
    expiredCount,
    manualCloseCount,
    invalidatedCount,
    expiredRate:         total > 0 ? Math.round((expiredCount / total) * 1000) / 1000 : 0,
  };
}

// ── Stats for every pattern family that has at least one resolved outcome ─────
export async function computeAllFamilyStats(): Promise<PatternFamilyStats[]> {
  const all    = await getAllOutcomes();
  const names  = [...new Set(all.map(o => o.patternName))];
  return names
    .map(name => computeFamilyStats(name, all))
    .sort((a, b) => b.totalConfirmed - a.totalConfirmed);
}

// ── Stats for a specific symbol + timeframe ───────────────────────────────────
export async function computeSymbolStats(
  symbol:    string,
  timeframe: string,
): Promise<PatternFamilyStats[]> {
  const all     = await getAllOutcomes();
  const filtered = all.filter(o => o.symbol === symbol && o.timeframe === timeframe);
  const names   = [...new Set(filtered.map(o => o.patternName))];
  return names
    .map(name => computeFamilyStats(name, filtered))
    .sort((a, b) => b.totalConfirmed - a.totalConfirmed);
}

// ── Auto-close outcomes whose pattern has expired (TIME_EXPIRY) ──────────────
// Call once per bar. Loads all active outcomes, closes any that have exceeded
// their maxAgeBars without reaching a terminal state.
// Returns the list of outcomes that were closed in this call.
export async function closeExpiredOutcomes(
  currentBar:   number,
  currentPrice: number,
): Promise<PatternOutcome[]> {
  const active  = await getActiveOutcomes();
  const closed: PatternOutcome[] = [];
  for (const o of active) {
    // expiresAtBar is stored on the outcome's patternId — we stored it via
    // the ValidatedPattern.expiresAtBar at createOutcome time.
    // PatternOutcome does not directly store expiresAtBar — check via
    // confirmedAtBar + reasonable max (130 bars = longest Cup & Handle expiry + buffer).
    // For precise expiry, callers can store expiresAtBar themselves.
    // This function provides a safety net: close anything ACTIVE after 130 bars.
    const MAX_BARS_ANY_PATTERN = 130;
    if (currentBar - o.confirmedAtBar >= MAX_BARS_ANY_PATTERN) {
      const expired = closeOutcomeWithReason(o, currentBar, currentPrice, 'TIME_EXPIRY');
      await saveOutcome(expired);
      closed.push(expired);
    }
  }
  return closed;
}

// Internal helper used by closeExpiredOutcomes
function closeOutcomeWithReason(
  outcome:          PatternOutcome,
  currentBar:       number,
  closePrice:       number,
  completionReason: import('./patternValidationTypes').CompletionReason,
): PatternOutcome {
  return {
    ...outcome,
    outcomeStatus:    'CLOSED',
    completionReason,
    closedBar:        currentBar,
    closeBar:         currentBar,
    closedPrice:      closePrice,
    barsToClose:      currentBar - outcome.confirmedAtBar,
    realizedPnLPct:   computePnLPctLocal(outcome.entry, closePrice, outcome.direction),
  };
}

function computePnLPctLocal(
  entry: number, exit: number, direction: string
): number {
  if (entry === 0) return 0;
  const raw = (exit - entry) / entry;
  return direction === 'bearish' ? -raw : raw;
}

// ── Clear all outcome data (use with caution) ─────────────────────────────────
export async function clearAllOutcomes(): Promise<void> {
  await AsyncStorage.removeItem(STORE_KEY);
  logger.warn('patternOutcomeStore', 'All pattern outcomes cleared.');
}
