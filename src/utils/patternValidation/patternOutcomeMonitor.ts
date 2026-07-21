// ─────────────────────────────────────────────────────────────────────────────
// PATTERN OUTCOME MONITOR  (v6.3.23)
//
// Lightweight per-candle hook that keeps PatternOutcome records current.
// Called from ChartScreen (or useChartData) whenever a new candle arrives.
//
// Responsibilities:
//   1. Update all ACTIVE outcomes with the new candle (detect TP/SL hits).
//   2. Auto-expire outcomes that have exceeded MAX_BARS_ANY_PATTERN.
//   3. When a ValidatedPattern first reaches CONFIRMED, create a new outcome.
//   4. Persist all changes via patternOutcomeStore.ts.
//
// This module is completely decoupled from:
//   - The validation engine (validatePattern.ts) — no imports from it.
//   - The ML pipeline — no imports from mlSignal.ts.
//   - The trading engine — no imports from paperTradingEngine.ts.
//
// REUSES:
//   patternOutcomeTracker.ts — updateOutcome, createOutcome, isOutcomeActive
//   patternOutcomeStore.ts   — getActiveOutcomes, saveOutcome, closeExpiredOutcomes
//   Candle from indicators.ts
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef } from 'react';
import { Candle } from '../indicators';
import { ValidatedPattern } from './patternValidationTypes';
import {
  createOutcome, updateOutcome, isOutcomeActive,
} from './patternOutcomeTracker';
import {
  getActiveOutcomes, saveOutcome, getOutcome, closeExpiredOutcomes,
} from './patternOutcomeStore';
import { logger } from '../logger';

// ── Hook: call this inside any component that receives live candles ─────────
// symbol and timeframe are needed to key the outcome record.
// validatedPatterns is the output of validateAllPatterns() from useChartIndicators.
//
// Usage:
//   usePatternOutcomeMonitor(symbol, tf, candles, validatedPatterns ?? []);
//
export function usePatternOutcomeMonitor(
  symbol:            string,
  timeframe:         string,
  candles:           Candle[],
  validatedPatterns: ValidatedPattern[],
): void {
  // Track which patternIds we've already created outcomes for
  // so createOutcome is called exactly once per patternId.
  const createdOutcomeIds = useRef<Set<string>>(new Set());
  const lastCandleCount   = useRef<number>(0);

  // Clear the local deduplication set when symbol or timeframe changes.
  // The AsyncStorage check in createOutcome() prevents actual duplicates,
  // but clearing the ref prevents unbounded memory growth across many
  // symbol switches in a single session.
  useEffect(() => {
    createdOutcomeIds.current.clear();
    lastCandleCount.current = 0;
  }, [symbol, timeframe]);

  useEffect(() => {
    if (!candles.length) return;
    const currentBar = candles.length - 1;
    const currentCandle = candles[currentBar];

    // Only run on new candle arrival
    if (candles.length === lastCandleCount.current) return;
    lastCandleCount.current = candles.length;

    (async () => {
      try {
        // ── Step 1: Create outcomes for newly CONFIRMED patterns ──────────────
        for (const vp of validatedPatterns) {
          if (
            vp.status === 'CONFIRMED' &&
            vp.risk != null &&
            !createdOutcomeIds.current.has(vp.patternId)
          ) {
            // Only create if not already stored
            const existing = await getOutcome(vp.patternId);
            if (!existing) {
              const outcome = createOutcome(vp, symbol, timeframe, currentBar);
              if (outcome) {
                await saveOutcome(outcome);
                createdOutcomeIds.current.add(vp.patternId);
                logger.info(
                  'patternOutcomeMonitor',
                  `Created outcome for CONFIRMED pattern: ${vp.patternId} ` +
                  `(confidence: ${vp.confidence}, R:R: ${vp.risk.riskReward2})`,
                );
              }
            } else {
              // Already stored — still mark as created so we don't re-check
              createdOutcomeIds.current.add(vp.patternId);
            }
          }
        }

        // ── Step 2: Update all ACTIVE outcomes with the new candle ─────────────
        const active = await getActiveOutcomes();
        for (const outcome of active) {
          const updated = updateOutcome(outcome, currentCandle, currentBar);
          // Only save when state actually changed (avoids redundant writes)
          if (updated.outcomeStatus !== outcome.outcomeStatus ||
              updated.tp1Hit !== outcome.tp1Hit ||
              updated.tp2Hit !== outcome.tp2Hit ||
              updated.tp3Hit !== outcome.tp3Hit ||
              updated.stopHit !== outcome.stopHit) {
            await saveOutcome(updated);
            logger.info(
              'patternOutcomeMonitor',
              `Outcome updated: ${updated.patternId} → ${updated.outcomeStatus} ` +
              `(completionReason: ${updated.completionReason ?? 'none'})`,
            );
          }
        }

        // ── Step 3: Auto-expire very old outcomes (TIME_EXPIRY) ───────────────
        const expired = await closeExpiredOutcomes(currentBar, currentCandle.close);
        if (expired.length > 0) {
          logger.info(
            'patternOutcomeMonitor',
            `Auto-expired ${expired.length} pattern outcome(s): ${expired.map(o => o.patternId).join(', ')}`,
          );
        }
      } catch (e: any) {
        logger.error('patternOutcomeMonitor', `Error in outcome monitoring: ${e.message}`);
      }
    })();
  }, [candles.length, validatedPatterns, symbol, timeframe]);
}

// ── Standalone function (for non-hook contexts) ───────────────────────────────
// Call this in any async context (e.g. background task, paper trading monitor).
export async function runPatternOutcomeUpdate(
  symbol:            string,
  timeframe:         string,
  candles:           Candle[],
  validatedPatterns: ValidatedPattern[],
  alreadyCreated:    Set<string> = new Set(),
): Promise<void> {
  if (!candles.length) return;
  const currentBar    = candles.length - 1;
  const currentCandle = candles[currentBar];

  // Create outcomes for newly CONFIRMED patterns
  for (const vp of validatedPatterns) {
    if (vp.status === 'CONFIRMED' && vp.risk != null && !alreadyCreated.has(vp.patternId)) {
      const existing = await getOutcome(vp.patternId);
      if (!existing) {
        const outcome = createOutcome(vp, symbol, timeframe, currentBar);
        if (outcome) { await saveOutcome(outcome); alreadyCreated.add(vp.patternId); }
      }
    }
  }

  // Update active outcomes
  const active = await getActiveOutcomes();
  for (const outcome of active) {
    const updated = updateOutcome(outcome, currentCandle, currentBar);
    if (!isOutcomeActive(updated) || updated.outcomeStatus !== outcome.outcomeStatus)
      await saveOutcome(updated);
  }

  // Auto-expire
  await closeExpiredOutcomes(currentBar, currentCandle.close);
}
