import AsyncStorage from '@react-native-async-storage/async-storage';
import { logger } from './logger';
import { Candle } from './indicators';
import { OrderBookSnapshot } from './orderBook';
import { TradeEconomics } from './tradeEconomics';
import { classifyPredictionResult } from './predictionResult';
import { PaperPosition } from './paperPortfolio';

// A SEPARATE store from the existing manual trade journal (journal.ts) —
// deliberately not merged into it. The existing journal's `Trade` schema is
// simple (symbol, direction, entry/exit, qty, SL/target, a tag, notes) and
// the manual JournalScreen UI depends on exactly that shape. Paper trades
// need a much richer schema (fees, slippage, AI confidence, model version,
// horizon, top features, regime, drawdown/profit extremes) — retrofitting
// those fields onto the existing journal would risk breaking working manual
// journaling for a fundamentally different use case. Same underlying
// AsyncStorage approach, different key, no shared mutable state.

export type PaperTradeRecord = {
  id: string;
  symbol: string;
  timeframe: string;
  assetClass: string; // FIX: was missing entirely — Portfolio Intelligence's "performance by asset class" had no data source without this
  direction: 'LONG' | 'SHORT';
  entryTime: number; entryPrice: number;
  exitTime: number; exitPrice: number;
  qty: number;
  grossPnl: number; // price-only P&L using the slippage-adjusted entry/exit prices, BEFORE any fee deduction - this is the figure that lets grossPnl - totalFees be checked against pnl by hand
  fees: number; // exit-time fee ONLY, kept for backward compatibility with any existing stored records
  totalFees: number; // entry fee + exit fee combined - the true total subtracted to arrive at pnl. Use this, not `fees` alone, when verifying Gross - Fees = Net.
  slippageCost: number;
  holdingMs: number;
  pnl: number;
  pnlPct: number;
  maxDrawdownDuringTrade: number;
  maxUnrealizedProfit: number;
  aiConfidence: number;
  riskScoreAtEntry: number;
  tradeQuality: { score: number; grade: string; stars: string; riskBadge: 'Low' | 'Medium' | 'High' } | null;
  modelVersion: number;
  predictionHorizon: number;
  topFeatures: { name: string; value: number; influence: number }[];
  marketRegime: string;
  orderBookSnapshot: OrderBookSnapshot | null; // GOAL 3 (persistence) - propagated from the position's entrySnapshot, same pattern as topFeatures/marketRegime above
  tradeEconomics: TradeEconomics; // DIAGNOSTICS ONLY - propagated from the position, frozen at entry, never recomputed
  predictionResult: PredictionResult; // direction-forecasting correctness, computed ONLY from entryPrice/exitPrice/direction - see predictionResult.ts
  entryReason: string;
  exitReason: string;
  // FIX: this was being captured on the live position's entrySnapshot but
  // never actually copied into the persisted record below — meaning by the
  // time a trade closes and shows up in the Journal/Replay screens, the
  // candle snapshot would already be silently lost (only topFeatures and
  // marketRegime were being carried over, not the candles themselves).
  recentCandles: Candle[];
}

const KEY = 'paperTradeJournal';

export async function getPaperTrades(): Promise<PaperTradeRecord[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e: any) {
    logger.error('paperTradeJournal', `Failed to load: ${e.message}`);
    return [];
  }
}

export async function recordCompletedTrade(record: PaperTradeRecord): Promise<PaperTradeRecord[]> {
  const trades = await getPaperTrades();
  const updated = [record, ...trades];
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(updated));
    logger.info('paperTradeJournal', `Journal entry created: ${record.direction} ${record.symbol} closed via ${record.exitReason}, pnl=${record.pnl.toFixed(2)} (${record.pnlPct.toFixed(2)}%), held ${(record.holdingMs / 60000).toFixed(0)}min. ${updated.length} total trades in journal.`);
  } catch (e: any) {
    logger.error('paperTradeJournal', `Failed to persist: ${e.message}`);
  }
  return updated;
}

// FIX: this used to recompute pnl independently from closePosition's own
// calculation — two separate formulas that were supposed to agree but
// didn't: this one double-counted slippage (subtracting slippageCost AGAIN
// on top of an exitPrice that already had slippage baked in) and never
// included the entry fee at all. Now takes the already-correct pnl/pnlPct
// as parameters — ONE authoritative calculation (in paperTradingEngine.ts),
// the journal just records it. slippageCost is kept as a separate DISPLAY
// field (genuinely useful to show the user) without being subtracted here.
export function buildTradeRecord(
  position: PaperPosition, exitTime: number, exitPrice: number, fees: number, slippageCost: number,
  exitReason: string, pnl: number, pnlPct: number, grossPnl: number
): PaperTradeRecord {
  return {
    id: position.id, symbol: position.symbol, timeframe: position.timeframe, assetClass: position.assetClass, direction: position.direction,
    entryTime: position.entryTime, entryPrice: position.entryPrice, exitTime, exitPrice,
    qty: position.qty, grossPnl, fees, totalFees: fees + position.entryFee, slippageCost, holdingMs: exitTime - position.entryTime,
    pnl, pnlPct,
    maxDrawdownDuringTrade: position.maxUnrealizedDrawdown, maxUnrealizedProfit: position.maxUnrealizedProfit,
    aiConfidence: position.aiConfidence, riskScoreAtEntry: position.riskScoreAtEntry, tradeQuality: position.tradeQuality, modelVersion: position.modelVersion, predictionHorizon: position.predictionHorizon,
    topFeatures: position.entrySnapshot.topFeatures, marketRegime: position.entrySnapshot.marketRegime,
    orderBookSnapshot: position.entrySnapshot.orderBookSnapshot,
    tradeEconomics: position.tradeEconomics,
    predictionResult: classifyPredictionResult(position.direction, position.entryPrice, exitPrice),
    entryReason: position.entryReason, exitReason,
    recentCandles: position.entrySnapshot.recentCandles,
  };
}
