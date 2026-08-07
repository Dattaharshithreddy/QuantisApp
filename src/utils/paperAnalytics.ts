import { PaperTradeRecord, getPaperTrades } from './paperTradeJournal';

// Reuses the SAME metric formulas as the backtest engine's computeMetrics
// (verified there already — Sharpe, profit factor, drawdown, etc.) but
// applied to the persisted paper trade journal instead of a simulated run.
// Deliberately not importing computeMetrics directly since its signature
// expects ExecTrade[] with an equityCurve; paper trades have a different
// shape (no equity curve snapshots), so the relevant formulas are
// reproduced here at the same verified correctness rather than forcing an
// awkward type adapter — same math, right shape for this data.

export type BestWorstTrade = { symbol: string; pnl: number; pnlPct: number; entryTime: number; exitTime: number } | null;

export type PaperPortfolioStats = {
  totalTrades: number; winningTrades: number; losingTrades: number;
  winRate: number; profitFactor: number; sharpeRatio: number; maxDrawdownPct: number;
  avgWin: number; avgLoss: number; avgHoldingMs: number;
  longCount: number; shortCount: number; longWinRate: number; shortWinRate: number;
  bySymbol: { symbol: string; trades: number; netPnl: number; winRate: number }[];
  byTimeframe: { timeframe: string; trades: number; netPnl: number; winRate: number }[];
  byHorizon: { horizon: number; trades: number; netPnl: number; winRate: number }[];
  byAssetClass: { assetClass: string; trades: number; netPnl: number; winRate: number }[];
  byRegime: { regime: string; trades: number; netPnl: number; winRate: number }[];
  bestTrade: BestWorstTrade;
  worstTrade: BestWorstTrade;
  // FIX (Audit item #3): aggregated peak-profit withdrawal metrics across all closed trades.
  // All values read from frozen PaperTradeRecord fields — never recomputed.
  avgPeakProfit: number | null;          // mean peak unrealized P&L across all trades
  avgMaxProfitWithdrawn: number | null;  // mean largest "profit given back" across all trades
  avgMFE: number | null;                 // mean Maximum Favorable Excursion (= avgPeakProfit when > 0)
  avgMAE: number | null;                 // mean Maximum Adverse Excursion (always <= 0)
  // FIX (Audit item #1): partial-close breakdown — how many journal entries are partial closes.
  // Partial closes now appear in the journal (PARTIAL_CLOSE exitReason). This count helps the
  // user understand the composition of their trade history.
  partialCloseCount: number;
  mostProfitableSymbol: string | null;
  mostAccurateSymbol: string | null;
  mostProfitableTimeframe: string | null;
  mostAccurateTimeframe: string | null;
  avgConfidence: number;
  avgRisk: number;
  avgTradeQuality: number | null; // pure aggregation of each trade's already-persisted score — not recomputed
  // Performance trend: net P&L of the most recent half of trades vs the
  // older half, in chronological (exit time) order — a simple, real,
  // verifiable "is performance improving or declining" signal, not a
  // fabricated trend line.
  performanceTrend: 'IMPROVING' | 'DECLINING' | 'STABLE' | 'INSUFFICIENT_DATA';
  tradeEconomicsStats: TradeEconomicsStats; // DIAGNOSTICS ONLY - see tradeEconomics.ts. Never used to filter/reject trades.
  // Direction-forecasting accuracy - measures something DIFFERENT from
  // winRate above. winRate = % of trades that were net-profitable after
  // fees/slippage (financial outcome, unchanged). predictionAccuracy =
  // % of directionally-graded trades where the AI called the market's
  // direction correctly (forecasting skill), regardless of whether costs
  // later ate into that correct call. Neither replaces the other.
  predictionAccuracyStats: PredictionAccuracyStats;
};

export type CostProfitRatioBucket = { range: string; count: number };
export type TradeEconomicsStats = {
  tradesWithData: number; // how many trades actually have tradeEconomics (older records before this feature was added won't)
  negativeEdgeCount: number;
  positiveEdgeCount: number;
  negativeEdgeWinRate: number | null; // null when negativeEdgeCount is 0 - no division by zero, no fabricated 0%
  positiveEdgeWinRate: number | null;
  avgPnlByEdgeBucket: { bucket: 'NEGATIVE' | 'THIN' | 'HEALTHY'; trades: number; avgPnl: number }[];
  costProfitRatioDistribution: CostProfitRatioBucket[]; // histogram of costAsPctOfExpectedProfit, plus a separate N/A bucket for trades with no expected profit at all
};

export type PredictionAccuracyStats = {
  predictionAccuracy: number | null; // % of (CORRECT + INCORRECT) trades that were CORRECT - NEUTRAL trades excluded from the denominator since they have no directional call to grade
  correctCount: number;
  incorrectCount: number;
  neutralCount: number;
  correctButLosingCount: number;   // direction call was right, but fees/slippage turned it into a net loss
  incorrectButWinningCount: number; // structurally should be 0 given how P&L is computed from the same prices - shown as a real, computed number anyway, not assumed
  avgPnlCorrect: number | null;
  avgPnlIncorrect: number | null;
};

function computePredictionAccuracyStats(trades: PaperTradeRecord[]): PredictionAccuracyStats {
  const correct = trades.filter(t => t.predictionResult === 'CORRECT');
  const incorrect = trades.filter(t => t.predictionResult === 'INCORRECT');
  const neutral = trades.filter(t => t.predictionResult === 'NEUTRAL');
  const graded = correct.length + incorrect.length; // NEUTRAL excluded - there's no direction call to score

  const avg = (group: PaperTradeRecord[]): number | null => group.length ? group.reduce((s, t) => s + t.pnl, 0) / group.length : null;

  return {
    predictionAccuracy: graded > 0 ? (correct.length / graded) * 100 : null,
    correctCount: correct.length, incorrectCount: incorrect.length, neutralCount: neutral.length,
    correctButLosingCount: correct.filter(t => t.pnl <= 0).length,
    incorrectButWinningCount: incorrect.filter(t => t.pnl > 0).length,
    avgPnlCorrect: avg(correct), avgPnlIncorrect: avg(incorrect)};
}

function computeTradeEconomicsStats(trades: PaperTradeRecord[]): TradeEconomicsStats {
  const withData = trades.filter(t => t.tradeEconomics != null);
  const negative = withData.filter(t => t.tradeEconomics.expectedNetEdge < 0);
  const positive = withData.filter(t => t.tradeEconomics.expectedNetEdge >= 0);

  const winRate = (group: PaperTradeRecord[]): number | null => group.length ? (group.filter(t => t.pnl > 0).length / group.length) * 100 : null;

  // THIN/HEALTHY split reuses the EXACT same 50%-cost-of-profit boundary
  // as tradeEconomicsWarning's per-trade warning text, so the bucket
  // labels here mean the same thing a user already saw on individual
  // trades - not a second, inconsistent threshold invented separately.
  const thin = positive.filter(t => (t.tradeEconomics.costAsPctOfExpectedProfit ?? 0) > 50);
  const healthy = positive.filter(t => (t.tradeEconomics.costAsPctOfExpectedProfit ?? 0) <= 50);

  const avgPnl = (group: PaperTradeRecord[]): number => group.length ? group.reduce((s, t) => s + t.pnl, 0) / group.length : 0;

  const ratios = withData.map(t => t.tradeEconomics.costAsPctOfExpectedProfit);
  const bucketRanges: [string, (r: number | null) => boolean][] = [
    ['N/A (no expected profit)', r => r == null],
    ['0-25%', r => r != null && r < 25],
    ['25-50%', r => r != null && r >= 25 && r < 50],
    ['50-75%', r => r != null && r >= 50 && r < 75],
    ['75-100%', r => r != null && r >= 75 && r < 100],
    ['100%+', r => r != null && r >= 100],
  ];
  const costProfitRatioDistribution = bucketRanges.map(([range, test]) => ({ range, count: ratios.filter(test).length }));

  return {
    tradesWithData: withData.length,
    negativeEdgeCount: negative.length, positiveEdgeCount: positive.length,
    negativeEdgeWinRate: winRate(negative), positiveEdgeWinRate: winRate(positive),
    avgPnlByEdgeBucket: [
      { bucket: 'NEGATIVE', trades: negative.length, avgPnl: avgPnl(negative) },
      { bucket: 'THIN', trades: thin.length, avgPnl: avgPnl(thin) },
      { bucket: 'HEALTHY', trades: healthy.length, avgPnl: avgPnl(healthy) },
    ],
    costProfitRatioDistribution};
}

function groupStats<T>(trades: PaperTradeRecord[], keyFn: (t: PaperTradeRecord) => T): { key: T; trades: number; netPnl: number; winRate: number }[] {
  const groups = new Map<string, PaperTradeRecord[]>();
  trades.forEach(t => {
    const k = String(keyFn(t));
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(t);
  });
  return Array.from(groups.entries()).map(([k, ts]) => ({
    key: k as any, trades: ts.length, netPnl: ts.reduce((s, t) => s + t.pnl, 0),
    winRate: (ts.filter(t => t.pnl > 0).length / ts.length) * 100}));
}

export async function computePaperPortfolioStats(startingCapital: number): Promise<PaperPortfolioStats> {
  const trades = await getPaperTrades();
  const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0), grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

  const pctReturns = trades.map(t => t.pnlPct);
  const mean = pctReturns.length ? pctReturns.reduce((s, r) => s + r, 0) / pctReturns.length : 0;
  const variance = pctReturns.length > 1 ? pctReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (pctReturns.length - 1) : 0;
  const sharpeRatio = Math.sqrt(variance) > 0 ? (mean / Math.sqrt(variance)) * Math.sqrt(pctReturns.length) : 0;

  // Max drawdown from chronological cumulative equity (sorted by exit time, since that's when P&L realizes)
  const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  let equity = startingCapital, peak = startingCapital, maxDD = 0;
  sorted.forEach(t => { equity += t.pnl; peak = Math.max(peak, equity); maxDD = Math.max(maxDD, ((peak - equity) / peak) * 100); });

  const longs = trades.filter(t => t.direction === 'LONG'), shorts = trades.filter(t => t.direction === 'SHORT');

  const bySymbol = groupStats(trades, t => t.symbol).map(g => ({ symbol: g.key as string, trades: g.trades, netPnl: g.netPnl, winRate: g.winRate }));
  const byTimeframe = groupStats(trades, t => t.timeframe).map(g => ({ timeframe: g.key as string, trades: g.trades, netPnl: g.netPnl, winRate: g.winRate }));
  const byHorizon = groupStats(trades, t => t.predictionHorizon).map(g => ({ horizon: Number(g.key), trades: g.trades, netPnl: g.netPnl, winRate: g.winRate }));
  const byAssetClass = groupStats(trades, t => t.assetClass).map(g => ({ assetClass: g.key as string, trades: g.trades, netPnl: g.netPnl, winRate: g.winRate }));
  const byRegime = groupStats(trades, t => t.marketRegime).map(g => ({ regime: g.key as string, trades: g.trades, netPnl: g.netPnl, winRate: g.winRate }));

  // "Most accurate" requires a minimum sample (3+ trades) so a single lucky
  // trade can't claim a misleading 100% win rate over genuinely
  // higher-sample-size performers.
  const MIN_SAMPLE = 3;
  const mostProfitableSymbol = bySymbol.length ? bySymbol.reduce((b, s) => s.netPnl > b.netPnl ? s : b).symbol : null;
  const accurateSymbols = bySymbol.filter(s => s.trades >= MIN_SAMPLE);
  const mostAccurateSymbol = accurateSymbols.length ? accurateSymbols.reduce((b, s) => s.winRate > b.winRate ? s : b).symbol : null;
  const mostProfitableTimeframe = byTimeframe.length ? byTimeframe.reduce((b, s) => s.netPnl > b.netPnl ? s : b).timeframe : null;
  const accurateTimeframes = byTimeframe.filter(s => s.trades >= MIN_SAMPLE);
  const mostAccurateTimeframe = accurateTimeframes.length ? accurateTimeframes.reduce((b, s) => s.winRate > b.winRate ? s : b).timeframe : null;

  // FIX (Audit item #1): exclude PARTIAL_CLOSE entries from best/worst trade.
  // Partial closes are now in the journal but represent fractions — including them would
  // distort best/worst (a partial of a big winner would appear as a separate "trade").
  // Analytics stats (winRate, avgWin, etc.) DO include partials since they are real realized P&L.
  const fullTrades = trades.filter(t => t.exitReason !== 'PARTIAL_CLOSE');
  const bestTrade: BestWorstTrade = fullTrades.length ? (() => { const t = fullTrades.reduce((b, t) => t.pnl > b.pnl ? t : b); return { symbol: t.symbol, pnl: t.pnl, pnlPct: t.pnlPct, entryTime: t.entryTime, exitTime: t.exitTime }; })() : null;
  const worstTrade: BestWorstTrade = fullTrades.length ? (() => { const t = fullTrades.reduce((b, t) => t.pnl < b.pnl ? t : b); return { symbol: t.symbol, pnl: t.pnl, pnlPct: t.pnlPct, entryTime: t.entryTime, exitTime: t.exitTime }; })() : null;

  // FIX (Audit item #3): compute MFE/MAE/peak-profit aggregates from stored trade fields.
  // Every field read here was frozen at trade close — never recomputed.
  const tradesWithPeakData = trades.filter(t => t.peakProfit != null);
  const tradesWithMAE      = trades.filter(t => t.maxDrawdownDuringTrade != null);
  const avgPeakProfit         = tradesWithPeakData.length ? tradesWithPeakData.reduce((s, t) => s + (t.peakProfit ?? 0), 0) / tradesWithPeakData.length : null;
  const avgMaxProfitWithdrawn = tradesWithPeakData.length ? tradesWithPeakData.reduce((s, t) => s + (t.maxProfitWithdrawn ?? 0), 0) / tradesWithPeakData.length : null;
  // MFE = maxUnrealizedProfit (most favorable excursion in absolute P&L terms)
  const avgMFE = trades.length ? trades.reduce((s, t) => s + (t.maxUnrealizedProfit ?? 0), 0) / trades.length : null;
  const avgMAE = tradesWithMAE.length  ? tradesWithMAE.reduce((s, t) => s + (t.maxDrawdownDuringTrade ?? 0), 0) / tradesWithMAE.length : null;

  const partialCloseCount = trades.filter(t => t.exitReason === 'PARTIAL_CLOSE').length;

  // Performance trend: older half vs. recent half of trades by exit time —
  // a real, verifiable signal, not a fabricated trend line.
  let performanceTrend: PaperPortfolioStats['performanceTrend'] = 'INSUFFICIENT_DATA';
  if (trades.length >= 6) {
    const byExit = [...trades].sort((a, b) => a.exitTime - b.exitTime);
    const mid = Math.floor(byExit.length / 2);
    const older = byExit.slice(0, mid), recent = byExit.slice(mid);
    const olderAvg = older.reduce((s, t) => s + t.pnl, 0) / older.length;
    const recentAvg = recent.reduce((s, t) => s + t.pnl, 0) / recent.length;
    const diff = recentAvg - olderAvg;
    performanceTrend = Math.abs(diff) < Math.abs(olderAvg) * 0.1 + 0.01 ? 'STABLE' : diff > 0 ? 'IMPROVING' : 'DECLINING';
  }

  return {
    totalTrades: trades.length, winningTrades: wins.length, losingTrades: losses.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
    sharpeRatio, maxDrawdownPct: maxDD,
    avgWin: wins.length ? grossWin / wins.length : 0,
    avgLoss: losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0,
    avgHoldingMs: trades.length ? trades.reduce((s, t) => s + t.holdingMs, 0) / trades.length : 0,
    longCount: longs.length, shortCount: shorts.length,
    longWinRate: longs.length ? (longs.filter(t => t.pnl > 0).length / longs.length) * 100 : 0,
    shortWinRate: shorts.length ? (shorts.filter(t => t.pnl > 0).length / shorts.length) * 100 : 0,
    bySymbol, byTimeframe, byHorizon, byAssetClass, byRegime,
    bestTrade, worstTrade, mostProfitableSymbol, mostAccurateSymbol, mostProfitableTimeframe, mostAccurateTimeframe,
    avgPeakProfit, avgMaxProfitWithdrawn, avgMFE, avgMAE, partialCloseCount,
    avgConfidence: trades.length ? trades.reduce((s, t) => s + t.aiConfidence, 0) / trades.length : 0,
    avgRisk: trades.length ? trades.reduce((s, t) => s + t.riskScoreAtEntry, 0) / trades.length : 0,
    avgTradeQuality: (() => {
      const withQuality = trades.filter(t => t.tradeQuality != null);
      return withQuality.length ? withQuality.reduce((s, t) => s + t.tradeQuality!.score, 0) / withQuality.length : null;
    })(),
    performanceTrend,
    tradeEconomicsStats: computeTradeEconomicsStats(trades),
    predictionAccuracyStats: computePredictionAccuracyStats(trades)};
}
