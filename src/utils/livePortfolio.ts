// ─────────────────────────────────────────────────────────────────────────────
// LIVE PORTFOLIO STATE  (v1.0.0)
//
// Stores and manages real open positions — separate from paper portfolio.
// Mirrors the PaperPosition structure exactly so the journal, analytics,
// signal snapshot, and market context systems work identically for both.
//
// Key differences from paper portfolio:
//   • positions carry liveOrderId (broker order ID)
//   • positions carry broker ('ANGEL_ONE' | 'BINANCE')
//   • filledPrice (actual execution) stored alongside suggestedEntry
//   • never has AUTO/MANUAL distinction here — that is in liveSettings.ts
// ─────────────────────────────────────────────────────────────────────────────

import AsyncStorage from '@react-native-async-storage/async-storage';
import { logger } from './logger';
import type { PaperPosition } from './paperPortfolio';

const KEY = 'livePortfolio_v1';

export type LivePosition = PaperPosition & {
  // Additional fields for live trading
  liveOrderId:   string;                     // broker-assigned order ID
  broker:        'ANGEL_ONE' | 'ANGEL_ONE_FUTURES' | 'BINANCE' | 'BINANCE_FUTURES';
  filledPrice:   number;                     // actual execution price from broker
  filledAt:      number;                     // when the broker confirmed fill
  estimatedFees: number;                     // fees at entry
  isLive:        true;                       // type discriminator

  // Futures-specific fields — undefined for equity/spot
  lots?:         number;
  lotSize?:      number;
  marginBlocked?: number;
  underlying?:   string;
  expiry?:       number;
  expiryLabel?:  string;
};

export type LivePortfolioState = {
  openPositions:  LivePosition[];
  totalRealizedPnL: number;
  lastSyncedAt:   number;     // when we last reconciled with broker
  version:        number;
};

const DEFAULT_STATE: LivePortfolioState = {
  openPositions:    [],
  totalRealizedPnL: 0,
  lastSyncedAt:     0,
  version:          1,
};

export async function getLivePortfolio(): Promise<LivePortfolioState> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_STATE };
    return { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch (e: any) {
    logger.error('livePortfolio', `Failed to read: ${e.message}`);
    return { ...DEFAULT_STATE };
  }
}

export async function saveLivePortfolio(state: LivePortfolioState): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(state));
  } catch (e: any) {
    logger.error('livePortfolio', `Failed to save: ${e.message}`);
  }
}

export async function addLivePosition(pos: LivePosition): Promise<LivePortfolioState> {
  const state = await getLivePortfolio();
  state.openPositions = [...state.openPositions, pos];
  await saveLivePortfolio(state);
  return state;
}

export async function removeLivePosition(positionId: string, realizedPnL: number): Promise<LivePortfolioState> {
  const state = await getLivePortfolio();
  state.openPositions    = state.openPositions.filter(p => p.id !== positionId);
  state.totalRealizedPnL = state.totalRealizedPnL + realizedPnL;
  await saveLivePortfolio(state);
  return state;
}

export async function updateLivePosition(positionId: string, updates: Partial<LivePosition>): Promise<LivePortfolioState> {
  const state = await getLivePortfolio();
  state.openPositions = state.openPositions.map(p =>
    p.id === positionId ? { ...p, ...updates } : p
  );
  await saveLivePortfolio(state);
  return state;
}

export async function resetLivePortfolio(): Promise<void> {
  await AsyncStorage.removeItem(KEY);
}
