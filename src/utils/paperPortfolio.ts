import AsyncStorage from '@react-native-async-storage/async-storage';
import { Candle } from './indicators';
import { logger } from './logger';
import { calculatePnL } from './pnlCalculator';
import { OrderBookSnapshot } from './orderBook';
import { TradeEconomics } from './tradeEconomics';

// The actual core of paper trading that never existed before — a real
// virtual portfolio with cash balance and open positions, persisted to
// AsyncStorage. Position SIZING math is reused directly from riskManager.ts
// (calcPositionSize) rather than reimplemented here.

export type PaperPosition = {
  id: string;
  symbol: string;
  timeframe: string;
  assetClass: string; // 'CRYPTO' | 'STOCK' | 'INDEX' | 'FOREX' | 'COMMODITY' — stored at entry so exposure checks never need to re-resolve it from elsewhere
  direction: 'LONG' | 'SHORT'; // both genuinely supported — see paperTradingEngine.ts's shared sideMultiplier-based logic
  entryTime: number;
  entryPrice: number;
  qty: number;
  stopLoss: number;
  takeProfit: number;
  aiConfidence: number;
  riskScoreAtEntry: number; // FIX: previously riskScore was used transiently (just to label marketRegime as HIGH_RISK/NORMAL) and then discarded — never actually stored, so "Average Risk" in Portfolio Intelligence had no real data source
  tradeQuality: { score: number; grade: string; stars: string; riskBadge: 'Low' | 'Medium' | 'High' } | null; // computed once at entry via tradeQuality.ts — the single scoring implementation — and persisted so Journal/Replay/Portfolio show the REAL score from that moment, never a recomputed-after-the-fact approximation
  modelVersion: number;
  predictionHorizon: number;
  entryReason: string;
  entryFee: number; // FIX (Phase 5 cash accounting audit): without storing this, the
  // fee paid at OPEN had nowhere to be re-included in the final P&L
  // calculation at CLOSE — reported pnl was silently missing the entry fee
  // entirely (confirmed via direct regression test: reported pnl overstated
  // the true cash-implied P&L by exactly the entry fee amount, every time).
  // Tracked live as price updates — needed for the journal's "Maximum
  // Unrealized Profit" / "Maximum Drawdown" fields, which can't be
  // reconstructed after the fact without having watched the position live.
  maxUnrealizedProfit: number;
  maxUnrealizedDrawdown: number;
  // DIAGNOSTICS ONLY - never used to accept/reject the trade. Computed
  // once at entry by computeTradeEconomics() and frozen here.
  tradeEconomics: TradeEconomics;
  // Captured ONCE at entry — what the AI actually saw when deciding, frozen
  // in time. This is what makes Replay (Phase 8) honest: it shows this
  // stored snapshot, never recomputed later with hindsight.
  entrySnapshot: {
    recentCandles: Candle[];
    topFeatures: { name: string; value: number; influence: number }[];
    marketRegime: string;
    orderBookSnapshot: OrderBookSnapshot | null; // GOAL 3 (persistence) - whatever the AI prediction carried at entry time, frozen here exactly like the rest of entrySnapshot
  };
};

export type PaperPortfolioState = {
  startingCapital: number;
  cashBalance: number;
  openPositions: PaperPosition[];
  realizedPnL: number;
  createdAt: number;
  mode: 'AUTO' | 'MANUAL';
};

const PORTFOLIO_KEY = 'paperPortfolio';

export async function getPortfolio(): Promise<PaperPortfolioState> {
  try {
    const raw = await AsyncStorage.getItem(PORTFOLIO_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e: any) {
    logger.error('paperPortfolio', `Failed to load: ${e.message}`);
  }
  return { startingCapital: 100000, cashBalance: 100000, openPositions: [], realizedPnL: 0, createdAt: Date.now(), mode: 'MANUAL' };
}

export async function savePortfolio(state: PaperPortfolioState): Promise<void> {
  try {
    await AsyncStorage.setItem(PORTFOLIO_KEY, JSON.stringify(state));
  } catch (e: any) {
    logger.error('paperPortfolio', `Failed to save: ${e.message}`);
  }
}

export async function resetPortfolio(startingCapital: number): Promise<PaperPortfolioState> {
  const state: PaperPortfolioState = { startingCapital, cashBalance: startingCapital, openPositions: [], realizedPnL: 0, createdAt: Date.now(), mode: 'MANUAL' };
  await savePortfolio(state);
  return state;
}

export async function setMode(mode: 'AUTO' | 'MANUAL'): Promise<PaperPortfolioState> {
  const state = await getPortfolio();
  state.mode = mode;
  await savePortfolio(state);
  return state;
}

// Portfolio value = cash + current market value of every open position,
// marked to the live price passed in for each symbol.
export function computePortfolioValue(state: PaperPortfolioState, livePrices: Record<string, number>): { portfolioValue: number; unrealizedPnL: number } {
  let positionsValue = 0, unrealizedPnL = 0;
  state.openPositions.forEach(p => {
    const cur = livePrices[p.symbol] ?? p.entryPrice;
    const pnl = calculatePnL({ entryPrice: p.entryPrice, exitPrice: cur, qty: p.qty, direction: p.direction });
    // Undo the entry-time cash adjustment (cash was reduced by entryPrice*qty for
    // LONG, increased by it for SHORT - see attemptOpenPosition), then layer the
    // real current P&L on top. This is the only formula that's consistent with
    // how cash actually moved at entry for both directions - verified directly
    // against that cash-flow logic, not assumed.
    const entryNotional = p.direction === 'LONG' ? p.entryPrice * p.qty : -(p.entryPrice * p.qty);
    positionsValue += entryNotional + pnl;
    unrealizedPnL += pnl;
  });
  return { portfolioValue: state.cashBalance + positionsValue, unrealizedPnL };
}
