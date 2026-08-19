// ─────────────────────────────────────────────────────────────────────────────
// useModelRepair — champion integrity check on app startup
//
// Called once after authentication is available.
// For each recently-used symbol/timeframe that has a champion pointer,
// verifies weights are loadable and repairs from the next valid version
// if not. Also bootstraps legacy mlModel_* users.
//
// GUARANTEES:
//   - Never blocks app startup (runs in background after auth)
//   - Never crashes the app (all errors caught)
//   - Never re-runs on every render (runs once per auth session)
//   - Only scans symbols that actually have a champion or legacy weights
//   - Does not run model repair when no versioned model exists yet
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { validateAndRepairChampion, bootstrapLegacyModel } from '../utils/modelVersioning';
import { findAssetByLegacySymbol } from '../utils/assetResolver';
import { loadModelMetadata } from '../utils/mlSignal';
import { logger } from '../utils/logger';

const HORIZONS = [1, 3, 5, 10, 20];

// ── Symbols to check — read from the existing metadata keys that mlSignal writes
// This avoids scanning every possible symbol by only looking at keys the app
// has actually trained a model for in this user's storage.
async function _getTrainedSymbolTfs(): Promise<Array<{ symbol: string; timeframe: string }>> {
  try {
    const allKeys = await AsyncStorage.getAllKeys();
    // mlMetadata_{symbol}_{tf} is the key written by mlSignal after every training run
    const metaKeys = allKeys.filter(k => k.startsWith('mlMetadata_'));
    return metaKeys.map(k => {
      // mlMetadata_{symbol}_{tf}
      const suffix = k.slice('mlMetadata_'.length);
      // tf is always the last _-separated token: 1m, 5m, 15m, 1h, 4h, 1D, 1W
      const tfMatch = suffix.match(/_(1m|3m|5m|15m|30m|1h|4h|1D|1W)$/);
      if (!tfMatch) return null;
      const tf     = tfMatch[1];
      const symbol = suffix.slice(0, suffix.length - tf.length - 1);
      return { symbol, timeframe: tf };
    }).filter((x): x is { symbol: string; timeframe: string } => x !== null);
  } catch { return []; }
}

export function useModelRepair(uid: string | null): void {
  const hasRun = useRef(false);

  useEffect(() => {
    if (!uid || hasRun.current) return;
    hasRun.current = true;

    // Run in background — never block startup
    (async () => {
      try {
        logger.info('useModelRepair', `Running champion repair check for uid=${uid}`);
        const symbolTfs = await _getTrainedSymbolTfs();
        if (symbolTfs.length === 0) {
          logger.info('useModelRepair', 'No trained models found — skipping repair');
          return;
        }

        for (const { symbol, timeframe } of symbolTfs) {
          try {
            // Bootstrap: if legacy model exists but no version list, create champion
            const meta = await loadModelMetadata(symbol, timeframe);
            // Resolve real exchange src from variant.symbol using asset registry
            const _exchange = findAssetByLegacySymbol(symbol)?.exchange ?? 'unknown';
            await bootstrapLegacyModel(
              symbol,
              _exchange,
              timeframe,
              HORIZONS,
              meta ? {
                modelVersion:        meta.modelVersion,
                validationAccuracy:  meta.walkForwardAccuracy ?? 50,
                holdoutAccuracy:     meta.holdout?.ensembleAccuracy ?? null,
                trainingCandleCount: meta.candlesAtTraining,
                trainingSampleCount: meta.sampleCount,
                trainedAt:           meta.trainedAt,
              } : null,
            );

            // Validate and repair champion weights
            const repairResult = await validateAndRepairChampion(symbol, timeframe, HORIZONS);
            if (!repairResult.valid) {
              if (repairResult.repairedTo !== null) {
                logger.info('useModelRepair', `${symbol}/${timeframe}: repaired to slot ${repairResult.repairedTo}`);
              } else {
                logger.warn('useModelRepair', `${symbol}/${timeframe}: repair failed — no valid slot found`);
              }
            }
          } catch (e: any) {
            logger.warn('useModelRepair', `${symbol}/${timeframe}: repair check error: ${e?.message ?? e}`);
          }
        }

        logger.info('useModelRepair', `Champion repair check complete (${symbolTfs.length} symbols checked)`);
      } catch (e: any) {
        // Never crash the app
        logger.warn('useModelRepair', `Startup repair error (non-fatal): ${e?.message ?? e}`);
      }
    })();
  }, [uid]);
}
