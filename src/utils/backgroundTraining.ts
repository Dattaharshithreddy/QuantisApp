// ─────────────────────────────────────────────────────────────────────────────
// backgroundTraining.ts — Pre-train ML model on candle close
//
// Priority 2: Background pre-training so Production Evaluation and first
// Predict tap find an already-trained model rather than training on demand.
//
// Architecture:
//   Every candle close → scheduleBackgroundTrain()
//   → debounced 5s (prevents training during rapid candle appends)
//   → trainAndPredict() with silent mode (no UI state changes)
//   → model saved to AsyncStorage + native Kotlin weights loaded
//   → next Predict tap hits inference-only path (<100ms)
//
// Guards:
//   • Only trains if candles.length >= MIN_CANDLES_FOR_TRAINING
//   • Only trains if no prediction is currently running (_inFlightKey check)
//   • Debounced — multiple close events within 5s trigger only one train
//   • Max one background train per symbol/tf at a time
//   • Silent — never touches UI state (no setMl, no spinner)
// ─────────────────────────────────────────────────────────────────────────────

import { trainAndPredict, MIN_CANDLES_FOR_TRAINING } from './mlSignal';
import type { Candle } from './indicators';

// Active background training sessions — prevents duplicate trains
const _activeTrains = new Set<string>();
// Debounce timers per symbol/tf
const _debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * scheduleBackgroundTrain — call on every candle close.
 * Debounces 5s then silently trains the model for symbol/tf if needed.
 *
 * @param symbol      — e.g. "BTCUSDT"
 * @param timeframe   — e.g. "15m"
 * @param candles     — current candle array (after close appended)
 * @param assetType   — "CRYPTO" | "INDEX" | "STOCK" etc.
 */
export function scheduleBackgroundTrain(
  symbol: string,
  timeframe: string,
  candles: Candle[],
  assetType: string,
): void {
  if (candles.length < MIN_CANDLES_FOR_TRAINING) return;

  const key = `${symbol}_${timeframe}`;

  // Clear any pending debounce for this key
  const existing = _debounceTimers.get(key);
  if (existing) clearTimeout(existing);

  // Debounce 5s — multiple close events (e.g. from catchup on reconnect)
  // won't trigger multiple training runs
  const timer = setTimeout(() => {
    _debounceTimers.delete(key);
    _runBackgroundTrain(key, symbol, timeframe, candles, assetType);
  }, 5_000);

  _debounceTimers.set(key, timer);
}

/**
 * cancelBackgroundTrain — call when symbol changes or component unmounts.
 * Clears the pending debounce so stale trains don't fire.
 */
export function cancelBackgroundTrain(symbol: string, timeframe: string): void {
  const key = `${symbol}_${timeframe}`;
  const timer = _debounceTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    _debounceTimers.delete(key);
  }
}

async function _runBackgroundTrain(
  key: string,
  symbol: string,
  timeframe: string,
  candles: Candle[],
  assetType: string,
): Promise<void> {
  // Skip if a train is already running for this key
  if (_activeTrains.has(key)) return;

  _activeTrains.add(key);
  const _bgT0 = Date.now();
  console.log(`[PERF TRAIN] Background train START ${symbol}/${timeframe} candles=${candles.length}`);
  try {
    // trainAndPredict with forceRetrain=false — it will:
    //   1. Check if model exists and is fresh → if yes, returns quickly (inference only)
    //   2. If stale or missing → trains in background, saves to AsyncStorage + native
    // We discard the result — the point is to warm the cache, not display the output.
    await trainAndPredict(
      symbol, timeframe, candles,
      undefined, undefined,
      false,          // forceRetrain=false — respects staleness threshold
      assetType,
      null,           // no order book snapshot in background
      null,           // no market context in background
    );
    console.log(`[PERF TRAIN] Background train COMPLETE ${symbol}/${timeframe} t=+${Date.now()-_bgT0}ms`);
  } catch {
    // Background training failures are silent — user still gets JS inference on next tap
    console.log(`[PERF TRAIN] Background train FAILED ${symbol}/${timeframe} t=+${Date.now()-_bgT0}ms`);
  } finally {
    _activeTrains.delete(key);
  }
}
