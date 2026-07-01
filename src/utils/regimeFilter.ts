import AsyncStorage from '@react-native-async-storage/async-storage';
import { Candle } from './indicators';
import { precomputeSeries } from './mlSignal';
import { detectTrendDirection, detectVolatilityRegime } from './marketStructure';

// A REAL execution-time regime filter — previously, market regime was only
// ever analyzed AFTER trades closed (regimeAnalysis.ts, for backtest
// reporting). This is the first time regime classification actually gates
// whether a trade is allowed to open at all, reusing the same causal
// detectTrendDirection/detectVolatilityRegime classifiers already built and
// tested, not a new classification method.

export type RegimeFilterMode = 'DISABLED' | 'BULL_ONLY' | 'TRENDING_ONLY' | 'AVOID_LOW_VOL' | 'AVOID_RANGING';

const KEY = 'regimeFilterMode';

export async function getRegimeFilterMode(): Promise<RegimeFilterMode> {
  const raw = await AsyncStorage.getItem(KEY);
  return (raw as RegimeFilterMode) || 'DISABLED';
}
export async function setRegimeFilterMode(mode: RegimeFilterMode): Promise<void> {
  await AsyncStorage.setItem(KEY, mode);
}

export type RegimeCheckResult = { allowed: boolean; currentRegime: string; skipMessage?: string };

export function checkRegimeFilter(candles: Candle[], mode: RegimeFilterMode): RegimeCheckResult {
  // FIX (found while building Phase 1 — multi-timeframe regime display):
  // this used to short-circuit to currentRegime:'UNKNOWN' whenever mode was
  // DISABLED, which seemed reasonable for the execution-gating use case
  // (no point computing a regime you're not going to act on) but silently
  // broke any OTHER caller that just wants to know the current regime label
  // without applying a filter — exactly the multi-timeframe evaluator's
  // need. The regime label is cheap to compute regardless; only the GATING
  // decision should depend on whether a filter mode is actually active.
  if (candles.length < 60) return { allowed: true, currentRegime: 'UNKNOWN' };

  const S = precomputeSeries(candles);
  const i = candles.length - 1;
  const trend = detectTrendDirection(candles, S.ema20, S.ema50);
  const volSamples = S.histVol.filter((v): v is number => v != null);
  const avgVol = volSamples.length ? volSamples.reduce((s, v) => s + v, 0) / volSamples.length : 1;
  const volRegime = detectVolatilityRegime(S.histVol[i] ?? avgVol, avgVol);

  // A single, human-readable label for the message format requested ("Current regime = Range")
  const currentRegime = volRegime === 'LOW' ? 'Low Volatility' : volRegime === 'EXTREME' || volRegime === 'HIGH' ? `${volRegime} Volatility`
    : trend === 'UPTREND' ? 'Bull' : trend === 'DOWNTREND' ? 'Bear' : 'Range';

  if (mode === 'DISABLED') return { allowed: true, currentRegime };

  const filterLabel: Record<RegimeFilterMode, string> = {
    DISABLED: '', BULL_ONLY: 'Bull filter enabled', TRENDING_ONLY: 'Trending-only filter enabled',
    AVOID_LOW_VOL: 'Avoid-low-volatility filter enabled', AVOID_RANGING: 'Avoid-ranging filter enabled',
  };

  let allowed = true;
  if (mode === 'BULL_ONLY' && trend !== 'UPTREND') allowed = false;
  else if (mode === 'TRENDING_ONLY' && trend === 'RANGING') allowed = false;
  else if (mode === 'AVOID_LOW_VOL' && volRegime === 'LOW') allowed = false;
  else if (mode === 'AVOID_RANGING' && trend === 'RANGING') allowed = false;

  return {
    allowed, currentRegime,
    skipMessage: allowed ? undefined : `Skipped because:\n${filterLabel[mode]}\nCurrent regime = ${currentRegime}`,
  };
}
