import AsyncStorage from '@react-native-async-storage/async-storage';
import { KVStore } from 'services/storage';
import type { StrategyId } from './strategy/strategyTypes';
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
  signalId?: string;   // links this position to its MLPrediction and any ShadowTrade
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
  // Renamed alias: maxUnrealizedProfit = maxProfitSeen (max favorable excursion, unrealized)
  // This is the MFE in absolute P&L terms — the highest unrealised profit seen tick-by-tick.
  maxUnrealizedProfit: number;   // alias: MFE / maxProfitSeen
  maxUnrealizedDrawdown: number; // alias: MAE / maxAdverseExcursion (always <= 0)
  // ── Peak-Profit Withdrawal tracking ─────────────────────────────────────────
  // Tracks the largest "profit given back" from a peak — computed tick-by-tick.
  //   peakProfit         = highest unrealizedPnL ever seen (== maxUnrealizedProfit when >0)
  //   maxProfitWithdrawn = max(peak - currentPnL) seen during the trade lifecycle
  // Required: must update EVERY tick inside monitorOpenPositions.
  // Must never decrease. Must survive UI rerenders and app backgrounding.
  peakProfit: number;          // running maximum of unrealizedPnL (>= maxUnrealizedProfit when positive)
  maxProfitWithdrawn: number;  // max(peakProfit - unrealizedPnL) seen across all ticks (>= 0)
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
    orderBookSnapshot: OrderBookSnapshot | null;
    // Immutable market context snapshot — captured once at entry, never recomputed.
    // Optional for backward compatibility with existing serialized positions.
    marketContext?: import('./marketContextSnapshot').MarketContextSnapshot | null;
  };

  // Trade management state — updated each candle, persisted.
  // Defaults to null so existing serialized positions deserialise safely.
  mgmt: TradeManagementState | null;
  // Strategy tag — which StrategyProfile was active when this position was opened.
  // Optional for backward compatibility: existing serialized positions without
  // this field deserialize safely as undefined (treated as 'no strategy').
  strategyId?:   StrategyId | null;
  strategyName?: string | null;   // display name e.g. 'Swing'
  strategyIcon?: string | null;   // emoji e.g. '🌊'

  // Signal snapshot — the AI's complete decision at the moment this position was opened.
  // Populated for EVERY trade (not just overrides), making the data model consistent:
  //   Normal trade:   originalState='READY', overrideUsed=false
  //   Override trade: originalState='WAIT'|'AVOID', overrideUsed=true
  //
  // This is a permanent record of what the AI believed at entry time.
  // If the model is retrained or the readiness engine is updated, historical trades
  // still know which version and what values produced them — enabling model-version
  // comparisons (v2 win rate vs v3 win rate, old regime engine vs new) without guessing.
  //
  // Future analytics this enables:
  //   "Are READY signals actually more profitable than overridden WAIT signals?"
  //   "Does higher confidence predict better outcomes?"
  //   "Which model version had the best signal quality?"
  //   "Are COUNTER_TREND signals worth taking at all?"
  // Optional for backward compatibility with existing serialized positions.
  signalSnapshot?: {
    // ── Decision ──────────────────────────────────────────────────────────────
    // Answers: "Why did the AI make this decision?"
    originalState:     'READY' | 'WAIT' | 'AVOID';
    overrideUsed:      boolean;           // true = user bypassed a non-READY verdict
    blockSource:       string | null;     // null when originalState='READY'
    blockReason:       string;            // empty string when originalState='READY'
    signalType:        string;            // TREND | BREAKOUT | MEAN_REVERSION | COUNTER_TREND
    mtfReadinessState: 'READY' | 'WAIT' | 'AVOID' | null;
    // ── AI Metadata ───────────────────────────────────────────────────────────
    // Answers: "Which model, at what confidence, under what conditions?"
    // Frozen at entry — never recomputed. Enables model-version comparisons
    // and calibration analysis across the full trade history.
    confidence:        number;            // 0–100 live overall confidence at entry
    ensembleProbUp:    number;            // 0–1 raw model probability (direction-aligned)
    modelVersion:      number;            // accepted model version — links signal to the model that produced it
    regimeLabel:       string;            // market regime label at entry
    strategyId:        string | null;     // active strategy profile at entry
    capturedAt:        number;            // Unix ms — immutable audit timestamp
  } | null;
};

// All fields are updated O(1) per candle inside tradeManager.ts.
// Nothing here feeds ML or feature engineering.
export type TradeManagementState = {
  // Initial 1R in price units — frozen at entry, never changes
  initialRisk:       number;
  // Current R-multiple: (currentPrice - entry) / initialRisk × direction
  currentR:          number;
  // Break-even: has stop been moved to entry?
  breakEvenTriggered:boolean;
  // Trailing mode chosen at entry from regime; frozen after first activation
  trailMode: 'ATR' | 'SWING' | 'STRUCTURE' | 'OB' | 'NONE';
  // Stop history: each element records (barIndex, stopPrice, reason)
  stopHistory:       { bar: number; price: number; reason: string }[];
  // Partial exits taken so far
  partialExits:      { bar: number; fraction: number; price: number; r: number }[];
  // Remaining qty fraction (1.0 at entry, decreases with partial exits)
  remainingFraction: number;
  // Highest unrealised R seen (used to decide when to trail)
  peakR:             number;
  // Locked profit in price units (from partial closes)
  lockedProfit:      number;
  // Bar count since entry (incremented each candle by tradeManager)
  barsHeld:          number;
  // Entry regime label — used to detect adverse regime change
  entryRegime:       string;
};

export type PaperPortfolioState = {
  startingCapital: number;
  cashBalance: number;
  openPositions: PaperPosition[];
  realizedPnL: number;
  createdAt: number;
  mode: 'AUTO' | 'MANUAL';
  // Version 0 (absent): created before the SHORT cash accounting fix.
  //   cashBalance may be inflated because SHORT open incorrectly
  //   credited positionValue instead of debiting it.
  // Version 1: current. Both LONG and SHORT debit (positionValue + entryFee).
  portfolioVersion?: number;
};

const PORTFOLIO_KEY = 'paperPortfolio';

// Increment this when any change to cash accounting logic requires recalculating
// stored portfolio state from trade history.
// v2: adds peakProfit and maxProfitWithdrawn fields to open positions that
// were created before these fields existed. Both initialize to safe defaults:
//   peakProfit = max(0, maxUnrealizedProfit)  — best guess from existing data
//   maxProfitWithdrawn = 0                    — unknown without tick history; reset to zero
const CURRENT_PORTFOLIO_VERSION = 2;

export async function getPortfolio(): Promise<PaperPortfolioState> {
  try {
    const raw = await KVStore.get(PORTFOLIO_KEY);
    if (raw) {
      const state: PaperPortfolioState = JSON.parse(raw);
      return await migratePortfolioIfNeeded(state);
    }
  } catch (e: any) {
    logger.error('paperPortfolio', `Failed to load: ${e.message}`);
  }
  // Fresh portfolio — already at current version.
  return { startingCapital: 100000, cashBalance: 100000, openPositions: [], realizedPnL: 0, createdAt: Date.now(), mode: 'MANUAL', portfolioVersion: CURRENT_PORTFOLIO_VERSION };
}

export async function savePortfolio(state: PaperPortfolioState): Promise<void> {
  try {
    await KVStore.set(PORTFOLIO_KEY, JSON.stringify(state));
  } catch (e: any) {
    logger.error('paperPortfolio', `Failed to save: ${e.message}`);
  }
}

export async function resetPortfolio(startingCapital: number): Promise<PaperPortfolioState> {
  const state: PaperPortfolioState = { startingCapital, cashBalance: startingCapital, openPositions: [], realizedPnL: 0, createdAt: Date.now(), mode: 'MANUAL', portfolioVersion: CURRENT_PORTFOLIO_VERSION };
  await savePortfolio(state);
  return state;
}

export async function setMode(mode: 'AUTO' | 'MANUAL'): Promise<PaperPortfolioState> {
  const state = await getPortfolio();
  state.mode = mode;
  await savePortfolio(state);
  return state;
}

// ── Portfolio migration ───────────────────────────────────────────────────────
//
// MIGRATION v0 → v1 (SHORT cash accounting fix):
//   Before the fix, opening a SHORT credited cashBalance with positionValue
//   instead of debiting it. This inflated cashBalance by ~2×positionValue
//   per SHORT trade. The pnl field on each trade and portfolio.realizedPnL
//   were computed correctly throughout — only cashBalance was wrong.
//
//   Correct formula:
//     cashBalance = startingCapital + realizedPnL
//                  - Σ(p.entryPrice × p.qty + p.entryFee)  for open positions
//
//   This holds because every closed trade is fully reflected in realizedPnL,
//   and every open position's true cost is (entryNotional + entryFee).
//
// Runs automatically once via getPortfolio(). Idempotent — safe to call
// multiple times (version check prevents re-running). Never alters trade
// history. Never runs on portfolios already at CURRENT_PORTFOLIO_VERSION.
//
async function migratePortfolioIfNeeded(state: PaperPortfolioState): Promise<PaperPortfolioState> {
  const version = state.portfolioVersion ?? 0;
  if (version >= CURRENT_PORTFOLIO_VERSION) return state;

  // ── v0 → v1: recalculate cashBalance from realizedPnL and open position costs ──
  let correctedCash = state.cashBalance;
  if (version < 1) {
    const openPositionCost = state.openPositions.reduce(
      (sum, p) => sum + p.entryPrice * p.qty + (p.entryFee ?? 0),
      0,
    );
    correctedCash = state.startingCapital + state.realizedPnL - openPositionCost;
    logger.info('paperPortfolio',
      `Portfolio migrated v0→v1: ` +
      `cashBalance ${state.cashBalance.toFixed(2)} → ${correctedCash.toFixed(2)} ` +
      `(startingCapital=${state.startingCapital}, realizedPnL=${state.realizedPnL.toFixed(2)}, ` +
      `openPositionCost=${openPositionCost.toFixed(2)})`,
    );
  }

  // ── v1 → v2: initialize peakProfit and maxProfitWithdrawn on open positions ──
  // These fields did not exist before v6.9.3. Positions opened before the upgrade
  // have no tick history to reconstruct these from, so we initialize from what IS
  // available: peakProfit = max(0, maxUnrealizedProfit) (the highest favorable P&L
  // seen is the best proxy for peak), maxProfitWithdrawn = 0 (unknown — reset).
  // After migration, every subsequent tick in monitorOpenPositions will accurately
  // update both fields going forward.
  let migratedPositions = state.openPositions;
  if (version < 2) {
    migratedPositions = state.openPositions.map(p => ({
      ...p,
      peakProfit:         (p as any).peakProfit         ?? Math.max(0, p.maxUnrealizedProfit ?? 0),
      maxProfitWithdrawn: (p as any).maxProfitWithdrawn ?? 0,
    }));
    logger.info('paperPortfolio',
      `Portfolio migrated v1→v2: initialized peakProfit/maxProfitWithdrawn on ${migratedPositions.length} open position(s)`,
    );
  }

  const migrated: PaperPortfolioState = {
    ...state,
    cashBalance: correctedCash,
    openPositions: migratedPositions,
    portfolioVersion: CURRENT_PORTFOLIO_VERSION,
  };

  await savePortfolio(migrated);
  migrationRanThisSession = true;
  return migrated;
}

// Returns true when the loaded portfolio needs migration — used by
// PaperTradingScreen to show a one-time informational banner explaining
// why the balance changed. The banner is not an error; it is reassurance.
export function needsMigration(state: PaperPortfolioState): boolean {
  return (state.portfolioVersion ?? 0) < CURRENT_PORTFOLIO_VERSION;
}

// One-shot session flag: set to true by migratePortfolioIfNeeded() when a
// migration actually ran in this app session. consumeMigrationFlag() reads
// and clears it, so the UI banner shows exactly once — in the session where
// the balance was corrected — and never again on subsequent screen mounts.
let migrationRanThisSession = false;
export function consumeMigrationFlag(): boolean {
  const v = migrationRanThisSession;
  migrationRanThisSession = false;
  return v;
}

// Portfolio value = cash + current market value of every open position,
// marked to the live price passed in for each symbol.
export function computePortfolioValue(state: PaperPortfolioState, livePrices: Record<string, number>): { portfolioValue: number; unrealizedPnL: number } {
  let positionsValue = 0, unrealizedPnL = 0;
  state.openPositions.forEach(p => {
    const cur = livePrices[p.symbol] ?? p.entryPrice;
    const pnl = calculatePnL({ entryPrice: p.entryPrice, exitPrice: cur, qty: p.qty, direction: p.direction });
    // After the SHORT cash fix: both LONG and SHORT open debit (posV + fee).
    // To "undo" that debit so the position shows its current mark-to-market
    // value rather than zero, entryNotional must be +posV for BOTH directions.
    // Previously SHORT used -posV here, which was consistent with the old model
    // where SHORT open CREDITED cash (+posV). With a debit on both sides,
    // using -posV for SHORT causes a double-subtraction of the notional.
    const entryNotional = p.entryPrice * p.qty; // always positive — same for LONG and SHORT
    positionsValue += entryNotional + pnl;
    unrealizedPnL += pnl;
  });
  return { portfolioValue: state.cashBalance + positionsValue, unrealizedPnL };
}
