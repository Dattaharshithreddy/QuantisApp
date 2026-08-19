import { Candle }                                                     from './indicators';
import { fitEnsemble, computeMetrics, BacktestMetrics,
         PrecomputedFitCache }                                        from './backtest';
import { simulateSignalStrategy, ExecConfig, ExecTrade }             from './strategyExecutor';

// Evaluates EVERY prediction horizon independently in actual TRADING terms.
// Requires a full retrain per horizon: the horizon defines the LABEL itself
// (price up in N bars), so it cannot be avoided without changing the measurement.
//
// ── Opt 2 ──────────────────────────────────────────────────────────────────────
// evaluateAllHorizonsWithTrades() was previously a separate function that
// called fitEnsemble() 5 additional times producing byte-identical models to
// evaluateAllHorizons(). They are now unified: evaluateAllHorizons() always
// returns trades alongside metrics, eliminating the 5 duplicate fits.
// evaluateAllHorizonsWithTrades() is kept as a zero-cost alias for backward
// compatibility with regimeEvaluation.ts.
//
// ── Opt 4 ──────────────────────────────────────────────────────────────────────
// Accepts an optional PrecomputedFitCache. When provided (built once in
// evaluateProductionModel), fitEnsemble skips precomputeSeries and feature
// extraction for every horizon fit — those are horizon-independent and
// identical across all 5 calls.

export type HorizonEvalEntry = {
  horizon:          number;
  metrics:          BacktestMetrics;
  trainSampleCount: number;
  trades:           ExecTrade[];   // Opt 2: always included, no extra cost
};

// Backward-compat alias — callers that use HorizonEvalEntryWithTrades still work.
export type HorizonEvalEntryWithTrades = HorizonEvalEntry;

const HORIZONS_TO_TEST = [1, 3, 5, 10, 20];

const tick = () => new Promise<void>(r => setTimeout(r, 0));

export async function evaluateAllHorizons(
  candles:    Candle[],
  execConfig: ExecConfig & { trainSplitPct: number; buyThreshold: number; seed: number },
  onHorizonDone?: (horizon: number, idx: number, total: number, entry: HorizonEvalEntry) => void,
  cache?:          PrecomputedFitCache | null,
  // Opt 1: when provided, skip fitEnsemble entirely and reuse pre-fitted models.
  // Only simulateSignalStrategy re-runs (with this call's execConfig, which may
  // differ per strategy). Results differ only in execution output, not model weights.
  horizonFittedMap?: Map<number, import('./backtest').FittedEnsemble>,
): Promise<HorizonEvalEntry[]> {
  const results: HorizonEvalEntry[] = [];

  for (let hi = 0; hi < HORIZONS_TO_TEST.length; hi++) {
    const horizon = HORIZONS_TO_TEST[hi];
    await tick();

    try {
      // Opt 1: use pre-fitted model if available — no retraining.
      // Opt 4: otherwise pass cache to skip precomputeSeries.
      const fitted = horizonFittedMap?.get(horizon)
        ?? await fitEnsemble(candles, execConfig.trainSplitPct, execConfig.seed, horizon, cache);
      if (!fitted) continue;

      const { trades, equityCurve } = simulateSignalStrategy(
        candles, fitted.walkIndices,
        (idx) => {
          const { ensembleProb, agree } = fitted.predictProb(idx);
          return { enter: ensembleProb > execConfig.buyThreshold && agree, reason: `horizon=${horizon}` };
        },
        fitted.atrAt, execConfig,
      );

      const metrics = computeMetrics(trades, equityCurve, execConfig.startingCapital);
      const entry: HorizonEvalEntry = { horizon, metrics, trainSampleCount: fitted.trainSampleCount, trades };
      results.push(entry);
      onHorizonDone?.(horizon, hi, HORIZONS_TO_TEST.length, entry);
    } catch (e: any) {
      // Log the exact error for each horizon so we can diagnose
      console.error('[horizonEval] horizon=' + horizon + ' failed: ' + e?.message + ' | stack: ' + e?.stack?.split('\n')[1]);
    }
    await tick();
  }

  return results;
}

// Opt 2: Zero-cost alias. evaluateAllHorizonsWithTrades() previously called
// fitEnsemble 5 extra times producing identical results. Now it just calls
// evaluateAllHorizons() which already returns trades. No retraining, no change
// in output.
export async function evaluateAllHorizonsWithTrades(
  candles:    Candle[],
  execConfig: ExecConfig & { trainSplitPct: number; buyThreshold: number; seed: number },
  cache?:     PrecomputedFitCache | null,
  horizonFittedMap?: Map<number, import('./backtest').FittedEnsemble>,
): Promise<HorizonEvalEntryWithTrades[]> {
  return evaluateAllHorizons(candles, execConfig, undefined, cache, horizonFittedMap);
}

export function scoreMetrics(m: BacktestMetrics): number {
  return (m.profitFactor === Infinity ? 5 : m.profitFactor) * 0.6 + (m.winRate / 100) * 0.4;
}

export function pickBestHorizon(entries: HorizonEvalEntry[]): HorizonEvalEntry | null {
  const withTrades = entries.filter(e => e.metrics.numTrades >= 5);
  if (!withTrades.length) return null;
  return withTrades.reduce((best, e) => scoreMetrics(e.metrics) > scoreMetrics(best.metrics) ? e : best);
}
