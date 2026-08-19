// ─────────────────────────────────────────────────────────────────────────────
// TRADE OBSERVATIONS  (v1.0.0)
//
// Pure deterministic function — no AI calls, no engine calls, no new data.
// Every observation is derived solely from fields already on PaperTradeRecord.
//
// Evidence classification (per project audit standard):
//   PROVEN  — computed directly from a stored PaperTradeRecord field
//   All observations below are PROVEN unless explicitly noted otherwise.
//
// Design constraints (from feature freeze decision):
//   • No new fields added to PaperTradeRecord
//   • No imports from engine files (mlSignal, indicators, mtfEngine, etc.)
//   • No async operations
//   • Returns string[] — UI decides how to render
//   • Handles undefined/optional fields gracefully (backward compat)
// ─────────────────────────────────────────────────────────────────────────────

import type { TradeManagementOutcome } from './predictionResult';

// Minimal shape — only the fields generateObservations actually reads.
// PaperTradeRecord satisfies this type; older records may have undefined
// for optional fields and are handled gracefully throughout.
type ObservableRecord = {
  direction:            'LONG' | 'SHORT';
  entryPrice:           number;
  exitPrice:            number;
  pnlPct:               number;
  holdingMs:            number;
  predictionHorizon:    number;
  timeframe:            string;
  aiConfidence:         number;
  marketRegime:         string;
  predictionResult:     string;         // 'CORRECT' | 'INCORRECT' | 'NEUTRAL'
  maxUnrealizedProfit:  number;
  maxDrawdownDuringTrade: number;
  tradeQuality?:        { score: number; grade: string } | null;
  tradeManagementOutcome?: TradeManagementOutcome;
  exitReason?:          string;
  reviewLevels?:        { stopLoss: number; takeProfit: number } | null;
};

// Timeframe bar duration in milliseconds — mirrors TF_SECONDS from mtfTypes.ts
// Kept local so this file has zero engine imports.
const TF_MS: Record<string, number> = {
  '1m':   60_000,
  '3m':   180_000,
  '5m':   300_000,
  '15m':  900_000,
  '30m':  1_800_000,
  '1h':   3_600_000,
  '4h':   14_400_000,
  '1d':   86_400_000,
};

/**
 * Returns 3–6 plain-English observations about a completed trade.
 * All observations are deterministic and derived only from stored fields.
 * Returns an empty array when insufficient data is available.
 */
export function generateObservations(trade: ObservableRecord): string[] {
  const obs: string[] = [];
  const { direction, entryPrice, exitPrice, pnlPct,
          holdingMs, predictionHorizon, timeframe,
          aiConfidence, marketRegime, predictionResult,
          maxUnrealizedProfit, maxDrawdownDuringTrade,
          tradeQuality, tradeManagementOutcome, exitReason,
          reviewLevels } = trade;

  const mgmt: TradeManagementOutcome | 'UNKNOWN' =
    tradeManagementOutcome ?? (
      exitReason === 'STOP_LOSS'                                 ? 'STOP_LOSS'
      : exitReason === 'TAKE_PROFIT'                            ? 'TAKE_PROFIT'
      : exitReason === 'MANUAL_EXIT' || exitReason === 'MANUAL_CLOSE' ? 'MANUAL_CLOSE'
      : exitReason === 'TIME_EXIT'                              ? 'TIME_EXIT'
      : 'UNKNOWN'
    );

  // ── 1. Move capture efficiency ─────────────────────────────────────────────
  // PROVEN: entryPrice, exitPrice, reviewLevels.takeProfit all stored
  if (reviewLevels?.takeProfit && reviewLevels.takeProfit !== entryPrice) {
    const fullMove = Math.abs(reviewLevels.takeProfit - entryPrice);
    const actualMove = Math.abs(exitPrice - entryPrice);
    if (fullMove > 0) {
      const capturePct = Math.round((actualMove / fullMove) * 100);
      if (mgmt === 'TAKE_PROFIT') {
        obs.push(`Captured 100% of the planned move — Take Profit reached.`);
      } else if (mgmt === 'STOP_LOSS') {
        // No capture to measure — SL hit, describe the loss instead
        const slMove = reviewLevels.stopLoss ? Math.abs(reviewLevels.stopLoss - entryPrice) : 0;
        if (slMove > 0) {
          const slCapture = Math.round((actualMove / slMove) * 100);
          obs.push(`Stop Loss was hit at ${slCapture}% of the SL distance from entry.`);
        }
      } else if (capturePct >= 80) {
        obs.push(`Captured ${capturePct}% of the planned move before closing.`);
      } else if (capturePct >= 40) {
        obs.push(`Captured ${capturePct}% of the planned move — ${100 - capturePct}% left on the table.`);
      } else if (pnlPct > 0) {
        obs.push(`Early exit: captured only ${capturePct}% of the planned move.`);
      }
    }
  }

  // ── 2. Trade management vs prediction alignment ────────────────────────────
  // PROVEN: predictionResult, tradeManagementOutcome stored
  if (mgmt === 'MANUAL_CLOSE') {
    if (predictionResult === 'CORRECT' && pnlPct > 0) {
      obs.push(`Closed manually in profit — prediction was correct but TP was not reached.`);
    } else if (predictionResult === 'CORRECT' && pnlPct <= 0) {
      obs.push(`Price moved in the predicted direction but fees/slippage produced a loss at manual close.`);
    } else if (predictionResult === 'INCORRECT') {
      obs.push(`Closed manually while price was against the predicted direction.`);
    }
  } else if (mgmt === 'TIME_EXIT') {
    obs.push(`Position closed by time limit before reaching either TP or SL.`);
  } else if (mgmt === 'STOP_LOSS' && predictionResult === 'CORRECT') {
    obs.push(`Stop Loss was triggered despite price moving in the predicted direction — stop may have been too tight.`);
  }

  // ── 3. Regime alignment ────────────────────────────────────────────────────
  // PROVEN: marketRegime and direction stored; NOTE this is regime AT ENTRY
  const regimeBull = marketRegime.includes('BULL');
  const regimeBear = marketRegime.includes('BEAR');
  const regimeSide = marketRegime.includes('SIDEWAYS') || marketRegime.includes('RANGING');
  const trendAligned = (direction === 'LONG' && regimeBull)
                    || (direction === 'SHORT' && regimeBear);
  const trendCounter = (direction === 'LONG' && regimeBear)
                    || (direction === 'SHORT' && regimeBull);

  if (trendAligned) {
    obs.push(`Trade was aligned with the ${marketRegime.replace(/_/g, ' ').toLowerCase()} regime at entry.`);
  } else if (trendCounter) {
    obs.push(`Trade went against the ${marketRegime.replace(/_/g, ' ').toLowerCase()} regime at entry — counter-trend trade.`);
  } else if (regimeSide) {
    obs.push(`Market was ranging at entry — higher noise, lower trend reliability.`);
  }

  // ── 4. Holding period vs prediction horizon ────────────────────────────────
  // PROVEN: holdingMs, predictionHorizon, timeframe stored
  const barMs = TF_MS[timeframe] ?? 900_000;
  const horizonMs = predictionHorizon * barMs;
  if (holdingMs > 0 && horizonMs > 0) {
    const holdBars = Math.round(holdingMs / barMs);
    if (holdBars < predictionHorizon * 0.5) {
      obs.push(`Held for ${holdBars} bars — less than half the ${predictionHorizon}-bar prediction horizon.`);
    } else if (holdBars > predictionHorizon * 2) {
      obs.push(`Held for ${holdBars} bars — more than twice the ${predictionHorizon}-bar prediction horizon.`);
    }
  }

  // ── 5. Confidence vs outcome ───────────────────────────────────────────────
  // PROVEN: aiConfidence, predictionResult stored
  if (aiConfidence >= 75 && predictionResult === 'INCORRECT') {
    obs.push(`High confidence (${aiConfidence.toFixed(0)}/100) but prediction was incorrect — consider reviewing signal quality filters.`);
  } else if (aiConfidence < 45 && predictionResult === 'CORRECT') {
    obs.push(`Low confidence (${aiConfidence.toFixed(0)}/100) but prediction was correct — lucky win or the model underestimated its own signal.`);
  }

  // ── 6. Max drawdown vs final outcome ──────────────────────────────────────
  // PROVEN: maxDrawdownDuringTrade, maxUnrealizedProfit, pnlPct stored
  if (maxDrawdownDuringTrade > 0 && pnlPct > 0) {
    // Trade ended in profit but dipped during holding
    if (maxDrawdownDuringTrade > Math.abs(pnlPct) * 0.5) {
      obs.push(`Experienced a drawdown of ${maxDrawdownDuringTrade.toFixed(1)} before recovering to a profit — required patience.`);
    }
  }
  if (maxUnrealizedProfit > 0 && pnlPct < maxUnrealizedProfit * 0.5 && pnlPct >= 0) {
    // Left significant unrealized profit on the table
    obs.push(`Peak unrealized profit was ${maxUnrealizedProfit.toFixed(1)} — exited at ${pnlPct.toFixed(1)}% of that peak.`);
  }

  // ── 7. Trade quality score ─────────────────────────────────────────────────
  // PROVEN: tradeQuality stored
  if (tradeQuality) {
    if (tradeQuality.score >= 80) {
      obs.push(`High-quality setup at entry (score ${tradeQuality.score}/100 — ${tradeQuality.grade}).`);
    } else if (tradeQuality.score < 40) {
      obs.push(`Low-quality setup at entry (score ${tradeQuality.score}/100 — ${tradeQuality.grade}) — higher risk trade from the start.`);
    }
  }

  // Cap at 5 observations — more than that becomes noise on a small screen
  return obs.slice(0, 5);
}
