import AsyncStorage from '@react-native-async-storage/async-storage';
import { KVStore } from '../services/storage';
import { logger } from './logger';

// Training Status redesign — the single source of truth for "what
// actually happened" every time trainAndPredict is called, covering ALL
// four outcomes (trained / reused / skipped / failed), not just accepted
// training runs. Every field here is populated directly from real values
// computed inside trainAndPredict at the moment each outcome occurs —
// nothing here is inferred or fabricated after the fact.

export type TrainingStatusType = 'trained' | 'reused' | 'skipped' | 'rejected' | 'failed';

export type TrainingStatusInfo = {
  type: TrainingStatusType;
  symbol: string;
  assetClass: string;
  timeframe: string;
  timestamp: number;
  architectureVersion: number;
  trainingRunNumber: number | null; // null only for 'skipped'/'failed' before a run number could even be assigned (e.g. insufficient candles)
  durationMs: number;

  // Populated for 'trained' / 'rejected'
  previousVersion: number | null;
  newVersion: number | null;
  previousAccuracy: number | null;
  newAccuracy: number | null;
  samplesUsed: number | null;
  walkForwardAccuracy: number | null;
  calibrationScore: number | null;
  confidence: number | null;

  // Populated for 'reused'
  currentSamples: number | null;
  samplesAtLastTraining: number | null;
  newCandles: number | null;
  minRequired: number | null;

  // Populated for 'skipped' / 'failed'
  skipReason: string | null;
  errorMessage: string | null;

  explanation: string; // always present, built from the real fields above
};

const KEY = (symbol: string, timeframe: string) => `trainingHistory_${symbol}_${timeframe}`;
const LATEST_KEY = (symbol: string, timeframe: string) => `trainingLatestStatus_${symbol}_${timeframe}`;
const MAX_ENTRIES = 20;

export async function recordTrainingStatus(info: TrainingStatusInfo): Promise<void> {
  try {
    const key = KEY(info.symbol, info.timeframe);
    const raw = await KVStore.get(key);
    const existing: TrainingStatusInfo[] = raw ? JSON.parse(raw) : [];
    const updated = [info, ...existing].slice(0, MAX_ENTRIES);
    await KVStore.set(key, JSON.stringify(updated));
    await KVStore.set(LATEST_KEY(info.symbol, info.timeframe), JSON.stringify(info));
  } catch (e: any) {
    logger.error('trainingHistory', `Failed to record status for ${info.symbol}/${info.timeframe}: ${e.message}`);
  }
}

export async function getTrainingHistory(symbol: string, timeframe: string): Promise<TrainingStatusInfo[]> {
  try {
    const raw = await KVStore.get(KEY(symbol, timeframe));
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function getLatestTrainingStatus(symbol: string, timeframe: string): Promise<TrainingStatusInfo | null> {
  try {
    const raw = await KVStore.get(LATEST_KEY(symbol, timeframe));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
