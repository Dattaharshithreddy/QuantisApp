// ─────────────────────────────────────────────────────────────────────────────
// STRATEGY PERFORMANCE  (v1.0.0)
//
// Pure analytics — reads completed trade records, groups by strategy and regime.
// Zero new engines. Zero new computation. Zero effect on live trading decisions.
//
// Two exports:
//   computeStrategyStats()        — per-strategy win rate, P/F, avg hold, drawdown
//   computeStrategyRegimeMatrix() — regime × strategy performance grid
//   recommendStrategy()           — "best strategy for current regime" (Step 10 data)
// ─────────────────────────────────────────────────────────────────────────────

import type { StrategyId } from './strategyTypes';

// ── Input type ────────────────────────────────────────────────────────────────
// The analytics functions read from PaperPosition (live) and the completed
// trade record stored in entrySnapshot. The caller maps whatever storage
// format they use to this minimal shape.
export type StrategyTradeRecord = {
  strategyId:     StrategyId | null | undefined;
  pnl:            number;         // net P&L in currency units
  pnlPct:         number;         // net P&L as percentage of entry value
  holdingBars:    number;         // bars held
  holdingMs:      number;         // milliseconds held
  entryConfidence:number;         // 0–100 confidence at entry
  regimeAtEntry:  string;         // e.g. 'STRONG_BULL_TREND' — from entrySnapshot.marketRegime
  direction:      'LONG' | 'SHORT';
  // Timestamp of trade close (ms since epoch). Used for rolling window sorting.
  // Optional for backward compatibility: older records without it sort last (oldest).
  closedAt?:      number;
};

// ── Per-strategy statistics (Step 8) ─────────────────────────────────────────

export type StrategyStats = {
  strategyId:      StrategyId | 'NONE';   // NONE = trades with no strategy tag
  tradeCount:      number;
  winCount:        number;
  winRate:         number;   // 0–100%
  profitFactor:    number;   // gross wins / gross losses (Infinity if no losses)
  avgPnlPct:       number;   // average trade P&L %
  avgHoldingBars:  number;
  avgHoldingHours: number;
  avgEntryConf:    number;   // average confidence at entry
  maxDrawdownPct:  number;   // max single losing trade (as positive %)
  totalPnl:        number;   // sum of all trade P&L
};

export function computeStrategyStats(
  trades: StrategyTradeRecord[],
): Map<StrategyId | 'NONE', StrategyStats> {
  const groups = new Map<StrategyId | 'NONE', StrategyTradeRecord[]>();

  for (const t of trades) {
    const key: StrategyId | 'NONE' = (t.strategyId as StrategyId) || 'NONE';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(t);
  }

  const result = new Map<StrategyId | 'NONE', StrategyStats>();

  for (const [id, group] of groups) {
    const wins   = group.filter(t => t.pnl > 0);
    const losses = group.filter(t => t.pnl <= 0);
    const grossWin  = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

    result.set(id, {
      strategyId:      id,
      tradeCount:      group.length,
      winCount:        wins.length,
      winRate:         group.length > 0 ? (wins.length / group.length) * 100 : 0,
      profitFactor:    grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
      avgPnlPct:       group.length > 0 ? group.reduce((s,t) => s + t.pnlPct, 0) / group.length : 0,
      avgHoldingBars:  group.length > 0 ? group.reduce((s,t) => s + t.holdingBars, 0) / group.length : 0,
      avgHoldingHours: group.length > 0 ? group.reduce((s,t) => s + t.holdingMs, 0) / group.length / 3_600_000 : 0,
      avgEntryConf:    group.length > 0 ? group.reduce((s,t) => s + t.entryConfidence, 0) / group.length : 0,
      maxDrawdownPct:  losses.length > 0 ? Math.max(...losses.map(t => Math.abs(t.pnlPct))) : 0,
      totalPnl:        group.reduce((s,t) => s + t.pnl, 0),
    });
  }

  return result;
}

// ── Rolling window options ───────────────────────────────────────────────────
// Passed to computeStrategyRegimeMatrix() and recommendStrategy() to scope
// the analysis to the most recent N trades, preventing stale history from
// dominating recommendations as market conditions evolve.
export type RollingWindowOptions = {
  // Max number of most-recent trades to include per (strategy, regime) combination.
  // Trades are sorted by closedAt descending before slicing.
  // Default: 100. Set to Infinity to use all trades (original behaviour).
  recencyWindow?: number;
  // Minimum trades per cell required for a MODERATE confidence recommendation.
  // Default: 10 (MIN_TRADES_MODERATE).
  minTradesForRecommendation?: number;
};

// ── Regime × Strategy matrix (Step 9) ────────────────────────────────────────

export type RegimeStrategyCell = {
  strategyId:   StrategyId;
  regimeLabel:  string;
  tradeCount:   number;
  winRate:      number;         // 0–100%
  profitFactor: number;
  avgPnlPct:    number;
  confidence:   'STRONG' | 'MODERATE' | 'WEAK' | 'INSUFFICIENT';
  // STRONG ≥ 20 trades, MODERATE ≥ 10, WEAK ≥ 5, INSUFFICIENT < 5
};

export type RegimeStrategyMatrix = Map<string, Map<StrategyId, RegimeStrategyCell>>;

const MIN_TRADES_STRONG     = 20;
const MIN_TRADES_MODERATE   = 10;
const MIN_TRADES_WEAK       = 5;

function cellConfidence(n: number): RegimeStrategyCell['confidence'] {
  if (n >= MIN_TRADES_STRONG)   return 'STRONG';
  if (n >= MIN_TRADES_MODERATE) return 'MODERATE';
  if (n >= MIN_TRADES_WEAK)     return 'WEAK';
  return 'INSUFFICIENT';
}

export function computeStrategyRegimeMatrix(
  trades:  StrategyTradeRecord[],
  options: RollingWindowOptions = {},
): RegimeStrategyMatrix {
  const recencyWindow = options.recencyWindow ?? 100;

  // Filter to tagged trades only — untagged trades have no strategy context
  const tagged = trades.filter(
    (t): t is StrategyTradeRecord & { strategyId: StrategyId } =>
      t.strategyId !== null && t.strategyId !== undefined
  );

  // Sort descending by closedAt — most recent trades first.
  // Trades without closedAt are treated as oldest (sort last).
  const sorted = [...tagged].sort(
    (a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0)
  );

  // Group by (regimeAtEntry, strategyId)
  const groups = new Map<string, Map<StrategyId, StrategyTradeRecord[]>>();

  for (const t of sorted) {
    if (!groups.has(t.regimeAtEntry)) groups.set(t.regimeAtEntry, new Map());
    const byStrategy = groups.get(t.regimeAtEntry)!;
    if (!byStrategy.has(t.strategyId)) byStrategy.set(t.strategyId, []);
    byStrategy.get(t.strategyId)!.push(t);
  }

  // Apply rolling window: keep only the most recent recencyWindow trades
  // per (strategyId, regime) cell. Since sorted[] is already descending,
  // the first N entries in each group are the most recent N trades.
  if (isFinite(recencyWindow)) {
    for (const byStrategy of groups.values()) {
      for (const [id, group] of byStrategy) {
        if (group.length > recencyWindow) {
          byStrategy.set(id, group.slice(0, recencyWindow));
        }
      }
    }
  }

  const matrix: RegimeStrategyMatrix = new Map();

  for (const [regime, byStrategy] of groups) {
    const cellMap = new Map<StrategyId, RegimeStrategyCell>();

    for (const [strategyId, group] of byStrategy) {
      const wins      = group.filter(t => t.pnl > 0);
      const losses    = group.filter(t => t.pnl <= 0);
      const grossWin  = wins.reduce((s,t) => s + t.pnl, 0);
      const grossLoss = Math.abs(losses.reduce((s,t) => s + t.pnl, 0));

      cellMap.set(strategyId, {
        strategyId,
        regimeLabel:  regime,
        tradeCount:   group.length,
        winRate:      (wins.length / group.length) * 100,
        profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
        avgPnlPct:    group.reduce((s,t) => s + t.pnlPct, 0) / group.length,
        confidence:   cellConfidence(group.length),
      });
    }

    matrix.set(regime, cellMap);
  }

  return matrix;
}

// ── Recommendation engine (Step 10) ──────────────────────────────────────────

export type StrategyRecommendation = {
  strategyId:   StrategyId;
  winRate:      number;
  profitFactor: number;
  tradeCount:   number;
  confidence:   RegimeStrategyCell['confidence'];
  reason:       string;   // plain-English explanation
};

/**
 * Recommends the best strategy for the current regime based on historical
 * paper trade performance. Returns null if no recommendation can be made.
 *
 * Only recommends when confidence is MODERATE or better (≥10 trades).
 * Never modifies any engine output — pure read of historical records.
 *
 * @param options.recencyWindow  How many recent trades per cell were used
 *   to build the matrix (surfaced in the reason string so the user knows
 *   the recommendation is time-scoped, not based on all-time history).
 */
export function recommendStrategy(
  currentRegime: string,
  matrix:        RegimeStrategyMatrix,
  options:       RollingWindowOptions = {},
): StrategyRecommendation | null {
  const recencyWindow          = options.recencyWindow ?? 100;
  const minTrades              = options.minTradesForRecommendation ?? MIN_TRADES_MODERATE;

  const regimeRow = matrix.get(currentRegime);
  if (!regimeRow) return null;

  // Filter to cells with sufficient data
  const candidates = [...regimeRow.values()].filter(
    cell => cell.confidence !== 'INSUFFICIENT' && cell.tradeCount >= minTrades
  );
  if (!candidates.length) return null;

  // Rank by profitFactor first (primary), winRate second (tiebreaker)
  const best = candidates.sort((a, b) => {
    const pfDiff = (isFinite(b.profitFactor) ? b.profitFactor : 99)
                 - (isFinite(a.profitFactor) ? a.profitFactor : 99);
    if (Math.abs(pfDiff) > 0.1) return pfDiff;
    return b.winRate - a.winRate;
  })[0];

  const confLabel  = best.confidence === 'STRONG' ? 'strong' : 'moderate';
  const windowNote = isFinite(recencyWindow)
    ? ` (last ${recencyWindow} trades per strategy)`
    : '';
  const reason = `Based on ${best.tradeCount} recent paper trades in ${currentRegime} regime${windowNote}, ` +
    `${best.strategyId} achieved ${best.winRate.toFixed(0)}% win rate and ` +
    `${isFinite(best.profitFactor) ? best.profitFactor.toFixed(1) + 'x' : '∞'} profit factor. ` +
    `Confidence: ${confLabel}.`;

  return {
    strategyId:   best.strategyId,
    winRate:      best.winRate,
    profitFactor: best.profitFactor,
    tradeCount:   best.tradeCount,
    confidence:   best.confidence,
    reason,
  };
}

// ── Global fallback recommendation (Fix #10) ─────────────────────────────────
// Used when per-regime data is insufficient (< minTrades trades in this regime).
// Aggregates across ALL regimes to give useful guidance from day 1 of paper trading.
// Returns null if no strategy has enough global trades either.
export function recommendStrategyGlobal(
  allTrades:  StrategyTradeRecord[],
  options:    RollingWindowOptions = {},
): (StrategyRecommendation & { isGlobalFallback: true }) | null {
  const minTrades = options.minTradesForRecommendation ?? MIN_TRADES_MODERATE;

  // Build per-strategy stats across all regimes (ignore regime filtering)
  const tagged = allTrades.filter(
    (t): t is StrategyTradeRecord & { strategyId: StrategyId } =>
      t.strategyId !== null && t.strategyId !== undefined
  );
  if (!tagged.length) return null;

  const byStrategy = new Map<StrategyId, StrategyTradeRecord[]>();
  for (const t of tagged) {
    if (!byStrategy.has(t.strategyId)) byStrategy.set(t.strategyId, []);
    byStrategy.get(t.strategyId)!.push(t);
  }

  const cells: RegimeStrategyCell[] = [];
  for (const [strategyId, group] of byStrategy) {
    if (group.length < minTrades) continue;
    const wins      = group.filter(t => t.pnl > 0);
    const losses    = group.filter(t => t.pnl <= 0);
    const grossWin  = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    cells.push({
      strategyId,
      regimeLabel:  'ALL',
      tradeCount:   group.length,
      winRate:      (wins.length / group.length) * 100,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
      avgPnlPct:    group.reduce((s, t) => s + t.pnlPct, 0) / group.length,
      confidence:   cellConfidence(group.length),
    });
  }

  if (!cells.length) return null;

  const best = cells.sort((a, b) => {
    const pfDiff = (isFinite(b.profitFactor) ? b.profitFactor : 99)
                 - (isFinite(a.profitFactor) ? a.profitFactor : 99);
    return Math.abs(pfDiff) > 0.1 ? pfDiff : b.winRate - a.winRate;
  })[0];

  return {
    strategyId:      best.strategyId,
    winRate:         best.winRate,
    profitFactor:    best.profitFactor,
    tradeCount:      best.tradeCount,
    confidence:      best.confidence,
    isGlobalFallback: true,
    reason: `Based on ${best.tradeCount} paper trades across all regimes, ` +
      `${best.strategyId} leads with ${best.winRate.toFixed(0)}% win rate. ` +
      `Not enough data for a regime-specific recommendation yet.`,
  };
}

// ── Formatting helpers (for UI display) ──────────────────────────────────────

export function formatHoldingTime(avgHoldingHours: number): string {
  if (avgHoldingHours < 1)   return `${Math.round(avgHoldingHours * 60)}m avg`;
  if (avgHoldingHours < 24)  return `${avgHoldingHours.toFixed(1)}h avg`;
  const days = avgHoldingHours / 24;
  return `${days.toFixed(1)}d avg`;
}

export function formatProfitFactor(pf: number): string {
  if (!isFinite(pf)) return '∞';
  return pf.toFixed(2) + 'x';
}
