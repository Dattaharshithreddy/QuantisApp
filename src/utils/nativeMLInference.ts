// ─────────────────────────────────────────────────────────────────────────────
// nativeMLInference.ts — TypeScript bridge to QuantisMLModule (Kotlin)
//
// Wraps the native module with:
//   1. Availability check — falls back to JS inference if native unavailable
//   2. Type-safe serialization of weights → ReadableMap format
//   3. Batch loadWeights after training completes
//   4. Single runInference call for all horizons simultaneously
//
// The native module runs on Android's ThreadPoolExecutor — zero JS thread
// blocking. Forward pass for 5 horizons completes in < 5ms vs ~200ms in JS.
// ─────────────────────────────────────────────────────────────────────────────

import { NativeModules, Platform } from 'react-native';
import type { MLPWeights, HorizonResult } from './mlSignal';
import type { LRWeights } from './logisticRegression';

const { QuantisML } = NativeModules;

// ── Availability ─────────────────────────────────────────────────────────────
// Native module is only available on Android (where it's compiled).
// iOS and dev environments fall back to JS inference transparently.
export const isNativeMLAvailable = (): boolean => {
  return Platform.OS === 'android' && QuantisML != null;
};

// ── Weight loading ────────────────────────────────────────────────────────────
// Called once after JS training completes. Serializes weights from JS objects
// into the format expected by the Kotlin module.
export async function nativeLoadWeights(
  symbol: string,
  timeframe: string,
  horizonWeights: Array<{ horizon: number; weights: MLPWeights }>,
  lrWeights: LRWeights,
): Promise<boolean> {
  if (!isNativeMLAvailable()) return false;
  try {
    await QuantisML.loadWeights({
      symbol,
      timeframe,
      horizons: horizonWeights.map(({ horizon, weights: w }) => ({
        horizon,
        W1:          w.W1,
        b1:          w.b1,
        W2:          w.W2,
        b2:          w.b2,
        featureMean: w.featureMean,
        featureStd:  w.featureStd,
      })),
      lr: { w: lrWeights.w, b: lrWeights.b },
    });
    return true;
  } catch (e) {
    console.warn('[NativeML] loadWeights failed, will use JS fallback:', e);
    return false;
  }
}

// ── Inference ─────────────────────────────────────────────────────────────────
// Runs MLP + LR forward pass for all horizons on a Kotlin background thread.
// Returns same shape as the JS inference path so callers need no changes.
export async function nativeRunInference(
  symbol: string,
  timeframe: string,
  horizons: number[],
  features: number[],
): Promise<Array<{ horizon: number; mlpProbUp: number; lrProbUp: number }> | null> {
  if (!isNativeMLAvailable()) return null;
  try {
    const result = await QuantisML.runInference({
      symbol,
      timeframe,
      horizons,
      features,
    });
    return result.horizonResults;
  } catch (e) {
    console.warn('[NativeML] runInference failed, will use JS fallback:', e);
    return null;
  }
}

// ── Model presence check ──────────────────────────────────────────────────────
export async function nativeHasModel(symbol: string, timeframe: string): Promise<boolean> {
  if (!isNativeMLAvailable()) return false;
  try {
    return await QuantisML.hasModel(symbol, timeframe);
  } catch {
    return false;
  }
}

// ── Cleanup ───────────────────────────────────────────────────────────────────
export async function nativeClearModel(symbol: string, timeframe: string): Promise<void> {
  if (!isNativeMLAvailable()) return;
  try {
    await QuantisML.clearModel(symbol, timeframe);
  } catch { /* non-fatal */ }
}
