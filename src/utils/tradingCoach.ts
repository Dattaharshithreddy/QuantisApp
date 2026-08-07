// ─────────────────────────────────────────────────────────────────────────────
// TRADING COACH ENGINE  (v1.0.0)
//
// Analyses the user's complete trade history and generates personalised,
// evidence-based insights. Every insight is grounded in real data from
// PaperTradeRecord — no generic advice, no fabricated statistics.
//
// Two output modes:
//   1. computeCoachInsights()  — pure TypeScript, no API call, deterministic
//      Runs locally, produces structured CoachInsight[] immediately.
//      Used for the insights cards on the Coach screen.
//
//   2. getCoachNarrative()     — calls Anthropic API with the insights as
//      context, returns a conversational written summary.
//      Requires the user's Anthropic key in secureCredentials.
//
// Design rules:
//   • Never fabricate a number. Every statistic has a `sampleSize` field.
//   • Insights with fewer than MIN_SAMPLE trades are suppressed.
//   • Insights are ranked by impact (largest positive or negative delta).
//   • The coach identifies patterns, not trade recommendations.
//   • No ML training data or signal weights are exposed here.
// ─────────────────────────────────────────────────────────────────────────────

import { PaperTradeRecord, getPaperTrades } from './paperTradeJournal';
import { getFuturesPortfolio }   from './futures/futuresPortfolio';
import { getBnFuturesPortfolio } from './futures/binance/bnFuturesPortfolio';
import { getSecureCredential }   from './secureCredentials';
import { ShadowTrade, loadShadowTrades } from './shadowTradeJournal';
import { getLivePortfolio }      from './livePortfolio';
const MIN_SAMPLE         = 5;   // minimum trades to surface an insight
const MIN_TRADES_OVERALL = 10;  // minimum total trades to run coach at all
const CALIBRATION_BAND   = 10;  // ±10% — confidence "should" predict win rate

// ── Types ─────────────────────────────────────────────────────────────────────

export type InsightCategory =
  | 'OVERRIDE'        // override behaviour vs AI advice
  | 'CONFIDENCE'      // confidence calibration
  | 'REGIME'          // market regime performance
  | 'STRATEGY'        // strategy profile performance
  | 'DIRECTION'       // long vs short behaviour
  | 'TIMING'          // holding time patterns
  | 'SIGNAL_TYPE'     // trend vs breakout vs mean reversion
  | 'MODEL_VERSION'   // model improvement over time
  | 'EXITS'          // early exits / letting winners run
  | 'GENERAL';        // overall stats

export type InsightSentiment = 'positive' | 'negative' | 'neutral' | 'warning';

export type CoachInsight = {
  id:          string;
  category:    InsightCategory;
  headline:    string;       // one-line summary — bold, specific
  detail:      string;       // 1-2 sentences of explanation
  evidence:    string;       // the actual numbers behind the insight
  sentiment:   InsightSentiment;
  sampleSize:  number;       // how many trades this is based on
  impact:      number;       // magnitude 0–100, used for ranking
};

export type CoachReport = {
  generatedAt:   number;
  totalTrades:   number;
  hasSufficientData: boolean;
  insufficientReason?: string;
  insights:      CoachInsight[];
  overallGrade:  'A+' | 'A' | 'B' | 'C' | 'D' | 'F' | 'INSUFFICIENT';
  oneLiner:      string;     // single most actionable takeaway
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function winRate(trades: PaperTradeRecord[]): number {
  if (!trades.length) return 0;
  return (trades.filter(t => t.pnl > 0).length / trades.length) * 100;
}

function avgPnl(trades: PaperTradeRecord[]): number {
  if (!trades.length) return 0;
  return trades.reduce((s, t) => s + t.pnl, 0) / trades.length;
}

function profitFactor(trades: PaperTradeRecord[]): number {
  const wins = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const loss = Math.abs(trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
  return loss > 0 ? wins / loss : wins > 0 ? Infinity : 0;
}

function groupBy<T>(arr: T[], key: (t: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of arr) {
    const k = key(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(item);
  }
  return map;
}

function pct(n: number): string { return `${n.toFixed(1)}%`; }
function fmt(n: number): string { return n >= 0 ? `+${n.toFixed(2)}` : n.toFixed(2); }

// ── Insight generators ────────────────────────────────────────────────────────

function overrideInsights(trades: PaperTradeRecord[]): CoachInsight[] {
  const overrides = trades.filter(t => t.signalSnapshot?.overrideUsed === true);
  const normal    = trades.filter(t => t.signalSnapshot?.overrideUsed === false);

  if (overrides.length < MIN_SAMPLE || normal.length < MIN_SAMPLE) return [];

  const overrideWR  = winRate(overrides);
  const normalWR    = winRate(normal);
  const overridePnl = avgPnl(overrides);
  const normalPnl   = avgPnl(normal);
  const delta       = overrideWR - normalWR;

  const sentiment: InsightSentiment = delta < -10 ? 'negative'
    : delta > 10 ? 'positive' : 'neutral';

  return [{
    id:         'override-wr',
    category:   'OVERRIDE',
    headline:   delta < -10
      ? `Overriding the AI costs you ${Math.abs(delta).toFixed(0)}% win rate`
      : delta > 10
      ? `Your overrides outperform AI signals by ${delta.toFixed(0)}%`
      : `Your override win rate is close to normal trades`,
    detail:     delta < -10
      ? `When you bypass WAIT/AVOID signals and force a trade, your results are significantly worse. The AI gates are protecting you.`
      : delta > 10
      ? `Your judgment when overriding the AI has been better than the signal alone. You may have good contextual awareness the model is missing.`
      : `Override and non-override trades perform similarly, suggesting your manual judgment is reasonably calibrated.`,
    evidence:   `Overrides: ${pct(overrideWR)} WR, avg ${fmt(overridePnl)} P&L (${overrides.length} trades) · Normal: ${pct(normalWR)} WR, avg ${fmt(normalPnl)} P&L (${normal.length} trades)`,
    sentiment,
    sampleSize: overrides.length + normal.length,
    impact:     Math.min(100, Math.abs(delta) * 2)}];
}

function confidenceInsights(trades: PaperTradeRecord[]): CoachInsight[] {
  const withConf = trades.filter(t => t.signalSnapshot?.confidence != null);
  if (withConf.length < MIN_SAMPLE * 2) return [];

  // Bucket by confidence band: <50, 50-65, 65-80, 80+
  const bands = [
    { label: 'Low (<50)',   min: 0,  max: 50  },
    { label: 'Mid (50-65)', min: 50, max: 65  },
    { label: 'High (65-80)',min: 65, max: 80  },
    { label: 'Top (80+)',   min: 80, max: 101 },
  ];

  const insights: CoachInsight[] = [];
  const buckets = bands.map(b => ({
    ...b,
    trades: withConf.filter(t => {
      const c = t.signalSnapshot!.confidence;
      return c >= b.min && c < b.max;
    })})).filter(b => b.trades.length >= MIN_SAMPLE);

  if (buckets.length < 2) return [];

  // Check if high confidence actually beats low confidence
  const top    = buckets[buckets.length - 1];
  const bottom = buckets[0];
  const topWR    = winRate(top.trades);
  const bottomWR = winRate(bottom.trades);
  const delta    = topWR - bottomWR;

  if (Math.abs(delta) > 5) {
    insights.push({
      id:        'confidence-calibration',
      category:  'CONFIDENCE',
      headline:  delta > 0
        ? `High-confidence signals (80+) win ${pct(topWR)} — ${delta.toFixed(0)}% more than low-confidence`
        : `High confidence is NOT predicting better outcomes — confidence calibration needs attention`,
      detail:    delta > 0
        ? `The confidence score is well-calibrated for your trading. Focusing on 80+ confidence signals should continue to produce better results.`
        : `Your ${top.label} trades win ${pct(topWR)} while ${bottom.label} trades win ${pct(bottomWR)}. Confidence score may need recalibration — consider retraining the model.`,
      evidence:  buckets.map(b => `${b.label}: ${pct(winRate(b.trades))} WR (${b.trades.length})`).join(' · '),
      sentiment: delta > 5 ? 'positive' : 'warning',
      sampleSize: top.trades.length + bottom.trades.length,
      impact:    Math.min(100, Math.abs(delta) * 1.5)});
  }

  return insights;
}

function regimeInsights(trades: PaperTradeRecord[]): CoachInsight[] {
  const withRegime = trades.filter(t => t.marketRegime && t.marketRegime !== 'UNKNOWN');
  if (withRegime.length < MIN_SAMPLE * 2) return [];

  const byRegime = groupBy(withRegime, t => t.marketRegime);
  const regimeStats = Array.from(byRegime.entries())
    .map(([regime, ts]) => ({ regime, count: ts.length, wr: winRate(ts), avg: avgPnl(ts) }))
    .filter(r => r.count >= MIN_SAMPLE)
    .sort((a, b) => b.wr - a.wr);

  if (regimeStats.length < 2) return [];

  const best  = regimeStats[0];
  const worst = regimeStats[regimeStats.length - 1];
  const delta = best.wr - worst.wr;

  if (delta < 15) return [];

  return [{
    id:        'regime-performance',
    category:  'REGIME',
    headline:  `You perform best in ${best.regime.replace(/_/g, ' ')} (${pct(best.wr)} WR)`,
    detail:    `There's a ${delta.toFixed(0)}% win rate gap between your best and worst regimes. Consider reducing position size or being more selective in ${worst.regime.replace(/_/g, ' ')} conditions.`,
    evidence:  `Best: ${best.regime} ${pct(best.wr)} WR (${best.count} trades) · Worst: ${worst.regime} ${pct(worst.wr)} WR (${worst.count} trades)`,
    sentiment: 'neutral',
    sampleSize: best.count + worst.count,
    impact:    Math.min(100, delta * 1.2)}];
}

function strategyInsights(trades: PaperTradeRecord[]): CoachInsight[] {
  const withStrategy = trades.filter(t => t.signalSnapshot?.strategyId);
  if (withStrategy.length < MIN_SAMPLE * 2) return [];

  const byStrategy = groupBy(withStrategy, t => t.signalSnapshot!.strategyId!);
  const stats = Array.from(byStrategy.entries())
    .map(([s, ts]) => ({ strategy: s, count: ts.length, wr: winRate(ts), pf: profitFactor(ts) }))
    .filter(r => r.count >= MIN_SAMPLE)
    .sort((a, b) => b.pf - a.pf);

  if (stats.length < 2) return [];

  const best  = stats[0];
  const worst = stats[stats.length - 1];

  return [{
    id:        'strategy-performance',
    category:  'STRATEGY',
    headline:  `${best.strategy} is your best-performing strategy (PF ${best.pf.toFixed(2)})`,
    detail:    `${best.strategy} produces a profit factor of ${best.pf.toFixed(2)} vs ${worst.pf.toFixed(2)} for ${worst.strategy}. Your trading style fits ${best.strategy} conditions best.`,
    evidence:  stats.map(s => `${s.strategy}: PF ${s.pf.toFixed(2)}, ${pct(s.wr)} WR (${s.count})`).join(' · '),
    sentiment: best.pf > 1.5 ? 'positive' : 'neutral',
    sampleSize: withStrategy.length,
    impact:    Math.min(100, (best.pf - worst.pf) * 20)}];
}

function directionInsights(trades: PaperTradeRecord[]): CoachInsight[] {
  const longs  = trades.filter(t => t.direction === 'LONG');
  const shorts = trades.filter(t => t.direction === 'SHORT');
  if (longs.length < MIN_SAMPLE || shorts.length < MIN_SAMPLE) return [];

  const longWR  = winRate(longs);
  const shortWR = winRate(shorts);
  const delta   = Math.abs(longWR - shortWR);
  if (delta < 10) return [];

  const better  = longWR > shortWR ? 'LONG' : 'SHORT';
  const betterWR = Math.max(longWR, shortWR);
  const worseWR  = Math.min(longWR, shortWR);

  return [{
    id:        'direction-bias',
    category:  'DIRECTION',
    headline:  `${better} trades win ${pct(betterWR)} vs ${pct(worseWR)} for the other direction`,
    detail:    `You have a ${delta.toFixed(0)}% win rate advantage on ${better} trades. This may reflect the market environment during your trading period, or a natural tendency to read ${better} setups better.`,
    evidence:  `LONG: ${pct(longWR)} WR (${longs.length} trades) · SHORT: ${pct(shortWR)} WR (${shorts.length} trades)`,
    sentiment: delta > 20 ? 'warning' : 'neutral',
    sampleSize: longs.length + shorts.length,
    impact:    Math.min(100, delta * 1.5)}];
}

function timingInsights(trades: PaperTradeRecord[]): CoachInsight[] {
  if (trades.length < MIN_SAMPLE * 2) return [];

  // Early exits: trades closed well before TP hit where TP would have been more profitable
  const earlyExits = trades.filter(t =>
    t.exitReason && t.exitReason.toLowerCase().includes('manual') && t.pnl > 0
  );
  const tpHits = trades.filter(t =>
    t.exitReason && t.exitReason.toLowerCase().includes('take_profit')
  );

  if (earlyExits.length >= MIN_SAMPLE && tpHits.length >= MIN_SAMPLE) {
    const earlyAvg = avgPnl(earlyExits);
    const tpAvg    = avgPnl(tpHits);
    const leaving  = tpAvg - earlyAvg;

    if (leaving > 0 && leaving > Math.abs(earlyAvg) * 0.3) {
      return [{
        id:        'early-exits',
        category:  'EXITS',
        headline:  `You exit winners ${fmt(leaving)} earlier than your take-profit level`,
        detail:    `Trades closed at take-profit average ${fmt(tpAvg)} P&L, but manual closes on winning trades average only ${fmt(earlyAvg)}. You may be cutting winners too early.`,
        evidence:  `TP hits: avg ${fmt(tpAvg)} (${tpHits.length} trades) · Manual closes: avg ${fmt(earlyAvg)} (${earlyExits.length} trades)`,
        sentiment: 'warning',
        sampleSize: earlyExits.length + tpHits.length,
        impact:    Math.min(100, leaving * 5)}];
    }
  }

  return [];
}

function signalTypeInsights(trades: PaperTradeRecord[]): CoachInsight[] {
  const withType = trades.filter(t => t.signalSnapshot?.signalType);
  if (withType.length < MIN_SAMPLE * 2) return [];

  const byType = groupBy(withType, t => t.signalSnapshot!.signalType);
  const stats  = Array.from(byType.entries())
    .map(([type, ts]) => ({ type, count: ts.length, wr: winRate(ts), avg: avgPnl(ts) }))
    .filter(r => r.count >= MIN_SAMPLE)
    .sort((a, b) => b.wr - a.wr);

  if (stats.length < 2) return [];

  const best = stats[0];
  const worst = stats[stats.length - 1];
  const delta = best.wr - worst.wr;
  if (delta < 12) return [];

  return [{
    id:        'signal-type',
    category:  'SIGNAL_TYPE',
    headline:  `${best.type} signals win ${pct(best.wr)} — your strongest signal type`,
    detail:    `There's a ${delta.toFixed(0)}% gap between ${best.type} (best) and ${worst.type} (weakest). Consider favouring ${best.type} setups.`,
    evidence:  stats.map(s => `${s.type}: ${pct(s.wr)} (${s.count})`).join(' · '),
    sentiment: 'positive',
    sampleSize: withType.length,
    impact:    Math.min(100, delta * 1.3)}];
}

function modelVersionInsights(trades: PaperTradeRecord[]): CoachInsight[] {
  const withVersion = trades.filter(t => t.signalSnapshot?.modelVersion != null);
  if (withVersion.length < MIN_SAMPLE * 2) return [];

  const byVersion = groupBy(withVersion, t => String(t.signalSnapshot!.modelVersion));
  const stats = Array.from(byVersion.entries())
    .map(([v, ts]) => ({ version: Number(v), count: ts.length, wr: winRate(ts) }))
    .filter(s => s.count >= MIN_SAMPLE)
    .sort((a, b) => a.version - b.version);

  if (stats.length < 2) return [];

  const oldest = stats[0];
  const newest = stats[stats.length - 1];
  const delta  = newest.wr - oldest.wr;

  if (Math.abs(delta) < 8) return [];

  return [{
    id:        'model-improvement',
    category:  'MODEL_VERSION',
    headline:  delta > 0
      ? `Model v${newest.version} outperforms v${oldest.version} by ${delta.toFixed(0)}% win rate`
      : `Model v${newest.version} performs worse than v${oldest.version} — consider reviewing recent retraining`,
    detail:    delta > 0
      ? `Retraining is working. Your most recent model version produces measurably better results than earlier versions.`
      : `Recent retraining may have degraded performance. Check if training data quality changed or if the market regime shifted significantly.`,
    evidence:  stats.map(s => `v${s.version}: ${pct(s.wr)} WR (${s.count})`).join(' · '),
    sentiment: delta > 0 ? 'positive' : 'warning',
    sampleSize: withVersion.length,
    impact:    Math.min(100, Math.abs(delta) * 1.5)}];
}

function generalInsights(trades: PaperTradeRecord[]): CoachInsight[] {
  if (trades.length < MIN_SAMPLE) return [];

  const wr = winRate(trades);
  const pf = profitFactor(trades);
  const avgHoldMs = trades.reduce((s, t) => s + t.holdingMs, 0) / trades.length;
  const avgHoldH  = avgHoldMs / 3_600_000;

  return [{
    id:        'overall',
    category:  'GENERAL',
    headline:  `${trades.length} trades · ${pct(wr)} win rate · ${pf.toFixed(2)} profit factor`,
    detail:    pf > 1.5
      ? `Strong overall performance. A profit factor above 1.5 means your winners significantly outpace your losers.`
      : pf > 1.0
      ? `Profitable overall but the margin is slim. Focus on improving average winner size or reducing average loser size.`
      : `Currently below breakeven. Review the specific conditions where losses occur most frequently.`,
    evidence:  `WR ${pct(wr)} · PF ${pf.toFixed(2)} · Avg hold ${avgHoldH.toFixed(1)}h · ${trades.length} trades`,
    sentiment: pf > 1.5 ? 'positive' : pf > 1.0 ? 'neutral' : 'negative',
    sampleSize: trades.length,
    impact:    50}];
}

// ── Shadow Journal insights ───────────────────────────────────────────────────
// Analyses blocked opportunities to tell users whether the AI gates are helping.

function shadowInsights(shadows: ShadowTrade[]): CoachInsight[] {
  const insights: CoachInsight[] = [];
  if (shadows.length < 5) return insights;   // not enough data

  const closed     = shadows.filter(s => s.outcome !== 'OPEN');
  const tpHit      = closed.filter(s => s.outcome === 'TP_HIT').length;
  const slHit      = closed.filter(s => s.outcome === 'SL_HIT').length;
  const total      = closed.length;
  if (total < 5) return insights;

  const gateAccuracy = slHit / total;   // % of blocks that would have been losses

  if (gateAccuracy >= 0.60) {
    insights.push({
      category:  'GENERAL',
      sentiment: 'positive',
      headline:  `AI gates saved you from ${slHit} losing trades`,
      detail:    `Of ${total} blocked opportunities that resolved, ${slHit} (${(gateAccuracy * 100).toFixed(0)}%) would have hit stop-loss. The gates are working as intended — blocking more losers than winners.`,
      impact:    7,
      metric:    `${(gateAccuracy * 100).toFixed(0)}% gate accuracy`});
  } else if (gateAccuracy <= 0.35) {
    insights.push({
      category:  'GENERAL',
      sentiment: 'negative',
      headline:  `AI gates may be too conservative — ${tpHit} profitable signals were blocked`,
      detail:    `Of ${total} blocked opportunities, ${tpHit} (${(100 - gateAccuracy * 100).toFixed(0)}%) would have hit take-profit. Consider reviewing your gate thresholds in Settings, or using the Override option selectively.`,
      impact:    8,
      metric:    `${(100 - gateAccuracy * 100).toFixed(0)}% of blocks were winners`});
  }

  // Gate breakdown — which gate blocks the most
  const gateCounts: Record<string, number> = {};
  for (const s of shadows) {
    gateCounts[s.blockGate] = (gateCounts[s.blockGate] ?? 0) + 1;
  }
  const topGate = Object.entries(gateCounts).sort((a, b) => b[1] - a[1])[0];
  if (topGate && topGate[1] >= 5) {
    insights.push({
      category:  'REGIME',
      sentiment: 'warning',
      headline:  `${topGate[0].replace('_', ' ')} is your most active gate (${topGate[1]} blocks)`,
      detail:    `This gate has blocked the most signals. Review Shadow Journal to see whether these blocks were correct or too aggressive.`,
      impact:    5,
      metric:    `${topGate[1]} blocks`});
  }

  return insights;
}

// ── Live trade insights ───────────────────────────────────────────────────────
// Compares live trading outcomes to paper trading to detect slippage / execution gaps.

function liveTradeInsights(livePositions: import('./livePortfolio').LivePosition[]): CoachInsight[] {
  const insights: CoachInsight[] = [];
  if (livePositions.length === 0) return insights;

  const totalFees = livePositions.reduce((s, p) => s + (p.estimatedFees ?? 0), 0);
  const avgFee    = totalFees / livePositions.length;

  if (avgFee > 50) {
    insights.push({
      category:  'GENERAL',
      sentiment: 'warning',
      headline:  `Average live trading fee is ₹${avgFee.toFixed(0)} per order`,
      detail:    `High fees reduce net returns. Consider using LIMIT orders instead of MARKET to get maker rates, and batch fewer, higher-conviction trades.`,
      impact:    6,
      metric:    `₹${avgFee.toFixed(0)} avg fee`});
  }

  const brokerCounts: Record<string, number> = {};
  for (const p of livePositions) {
    brokerCounts[p.broker] = (brokerCounts[p.broker] ?? 0) + 1;
  }
  if (Object.keys(brokerCounts).length > 1) {
    insights.push({
      category:  'GENERAL',
      sentiment: 'positive',
      headline:  `Active across ${Object.keys(brokerCounts).length} live execution providers`,
      detail:    `You have positions across: ${Object.keys(brokerCounts).join(', ')}. Make sure your risk is not concentrated — diversification across instruments is good, but monitor total exposure.`,
      impact:    4,
      metric:    Object.keys(brokerCounts).join(', ')});
  }

  return insights;
}

// ── Grade computation ─────────────────────────────────────────────────────────

function computeGrade(trades: PaperTradeRecord[]): CoachReport['overallGrade'] {
  if (trades.length < MIN_TRADES_OVERALL) return 'INSUFFICIENT';
  const pf = profitFactor(trades);
  const wr = winRate(trades);
  const score = pf * 40 + (wr / 100) * 60;
  if (score >= 90) return 'A+';
  if (score >= 75) return 'A';
  if (score >= 60) return 'B';
  if (score >= 45) return 'C';
  if (score >= 35) return 'D';
  return 'F';
}

// ── Futures-specific insights ────────────────────────────────────────────────

export type FuturesCoachSummary = {
  nse: {
    totalTrades:   number;
    openPositions: number;
    realizedPnL:   number;
    cashBalance:   number;
    initialCapital: number;
    returnPct:     number;
  };
  bn: {
    totalTrades:   number;
    openPositions: number;
    realizedPnL:   number;
    usdtBalance:   number;
    initialCapital: number;
    returnPct:      number;
    totalFundingPaid: number;
  };
};

export async function getFuturesCoachSummary(): Promise<FuturesCoachSummary> {
  const [nse, bn] = await Promise.all([
    getFuturesPortfolio(), getBnFuturesPortfolio(),
  ]);
  const nseReturn = nse.initialCapital > 0
    ? ((nse.cashBalance - nse.initialCapital) / nse.initialCapital) * 100 : 0;
  const bnReturn  = bn.initialCapital > 0
    ? ((bn.usdtBalance - bn.initialCapital) / bn.initialCapital) * 100 : 0;
  return {
    nse: {
      totalTrades:    0,  // futures don't use PaperTradeRecord yet
      openPositions:  nse.openPositions.length,
      realizedPnL:    nse.totalRealizedPnL,
      cashBalance:    nse.cashBalance,
      initialCapital: nse.initialCapital,
      returnPct:      nseReturn},
    bn: {
      totalTrades:      0,
      openPositions:    bn.openPositions.length,
      realizedPnL:      bn.totalRealizedPnL,
      usdtBalance:      bn.usdtBalance,
      initialCapital:   bn.initialCapital,
      returnPct:        bnReturn,
      totalFundingPaid: bn.totalFundingPaid}};
}

// ── Main compute function ─────────────────────────────────────────────────────

export async function computeCoachInsights(): Promise<CoachReport> {
  const [trades, shadows, livePortfolio] = await Promise.all([
    getPaperTrades(),
    loadShadowTrades().catch(() => [] as ShadowTrade[]),
    getLivePortfolio().catch(() => null),
  ]);

  if (trades.length < MIN_TRADES_OVERALL) {
    return {
      generatedAt:     Date.now(),
      totalTrades:     trades.length,
      hasSufficientData: false,
      insufficientReason: `The coach needs at least ${MIN_TRADES_OVERALL} completed trades to generate insights. You have ${trades.length} so far.`,
      insights:        [],
      overallGrade:    'INSUFFICIENT',
      oneLiner:        `Keep trading — insights unlock at ${MIN_TRADES_OVERALL} trades.`};
  }

  const livePositions = livePortfolio?.openPositions ?? [];

  const allInsights: CoachInsight[] = [
    ...generalInsights(trades),
    ...overrideInsights(trades),
    ...confidenceInsights(trades),
    ...regimeInsights(trades),
    ...strategyInsights(trades),
    ...directionInsights(trades),
    ...timingInsights(trades),
    ...signalTypeInsights(trades),
    ...modelVersionInsights(trades),
    ...shadowInsights(shadows),
    ...liveTradeInsights(livePositions),
  ].sort((a, b) => b.impact - a.impact);

  const grade  = computeGrade(trades);
  const top    = allInsights.find(i => i.sentiment === 'negative' || i.sentiment === 'warning')
              ?? allInsights[0];
  const oneLiner = top ? top.headline : `${trades.length} trades analysed. Keep building your trade history.`;

  return {
    generatedAt:       Date.now(),
    totalTrades:       trades.length,
    hasSufficientData: true,
    insights:          allInsights,
    overallGrade:      grade,
    oneLiner};
}

// ── Narrative via Anthropic API ────────────────────────────────────────────────

export async function getCoachNarrative(report: CoachReport): Promise<string> {
  const key = await getSecureCredential('anthropicKey');
  if (!key) throw new Error('Anthropic API key not configured. Add it in Settings.');
  if (!report.hasSufficientData) return report.insufficientReason ?? '';

  const topInsights = report.insights.slice(0, 6);
  const prompt = `You are a professional trading coach reviewing a trader's performance data.

Overall: ${report.totalTrades} trades · Grade ${report.overallGrade}

Key findings:
${topInsights.map((i, n) => `${n+1}. [${i.category}] ${i.headline}
   Evidence: ${i.evidence}`).join('\n')}

Write a concise, direct coaching message (3-4 short paragraphs). 
- Start with the most important finding
- Be specific — reference the actual numbers
- Give one concrete actionable recommendation  
- Do not use bullet points
- Do not give generic trading advice
- Speak directly to the trader as "you"`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':    'application/json',
      'x-api-key':       key,
      'anthropic-version': '2023-06-01'},
    body: JSON.stringify({
      model:      'claude-sonnet-4-6',
      max_tokens: 500,
      messages:   [{ role: 'user', content: prompt }]})});

  if (!res.ok) throw new Error(`Anthropic API ${res.status}`);
  const json = await res.json();
  return json.content?.[0]?.text ?? 'Unable to generate narrative.';
}
