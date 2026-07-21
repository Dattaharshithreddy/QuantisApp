import { ExecTrade } from './strategyExecutor';
import { BarDecision, SkipReason } from './strategyExecutor';

// Derives all the requested trade-level analytics from data that already
// exists (trades + the per-bar decision stream) — no new simulation, just
// real aggregation of real results.

export type SkipReasonBreakdown = { reason: SkipReason; count: number; pct: number };
export type SignalDistribution = { buy: number; sell: number; hold: number; buyPct: number; sellPct: number; holdPct: number };

export function analyzeSkipReasons(decisions: BarDecision[]): { breakdown: SkipReasonBreakdown[]; totalSkipped: number } {
  const skipped = decisions.filter(d => !d.executed && d.skipReason);
  const counts: Record<string, number> = {};
  skipped.forEach(d => { counts[d.skipReason!] = (counts[d.skipReason!] || 0) + 1; });
  const breakdown = Object.entries(counts)
    .map(([reason, count]) => ({ reason: reason as SkipReason, count, pct: (count / skipped.length) * 100 }))
    .sort((a, b) => b.count - a.count);
  return { breakdown, totalSkipped: skipped.length };
}

export function analyzeSignalDistribution(decisions: BarDecision[]): SignalDistribution {
  const buy = decisions.filter(d => d.action === 'BUY').length;
  const sell = decisions.filter(d => d.action === 'SELL').length;
  const hold = decisions.filter(d => d.action === 'HOLD').length;
  const total = decisions.length || 1;
  return { buy, sell, hold, buyPct: (buy / total) * 100, sellPct: (sell / total) * 100, holdPct: (hold / total) * 100 };
}

export function avgConfidenceAtEntry(trades: { entryConfidence: number }[]): number {
  return trades.length ? trades.reduce((s, t) => s + t.entryConfidence, 0) / trades.length : 0;
}
export function avgConfidenceAtExit(trades: { exitConfidence: number }[]): number {
  return trades.length ? trades.reduce((s, t) => s + t.exitConfidence, 0) / trades.length : 0;
}

export type ConfidenceBucket = { range: string; count: number };
export function confidenceDistribution(decisions: BarDecision[]): ConfidenceBucket[] {
  const ranges = [{ label: '0-20', min: 0, max: 20 }, { label: '20-40', min: 20, max: 40 }, { label: '40-60', min: 40, max: 60 }, { label: '60-80', min: 60, max: 80 }, { label: '80-100', min: 80, max: 101 }];
  return ranges.map(r => ({ range: r.label, count: decisions.filter(d => d.confidence >= r.min && d.confidence < r.max).length }));
}

export type DurationBucket = { range: string; count: number };
export function tradeDurationHistogram(trades: { holdingBars: number }[]): DurationBucket[] {
  const ranges = [{ label: '1-5', min: 1, max: 6 }, { label: '6-10', min: 6, max: 11 }, { label: '11-20', min: 11, max: 21 }, { label: '21-40', min: 21, max: 41 }, { label: '40+', min: 41, max: Infinity }];
  return ranges.map(r => ({ range: r.label, count: trades.filter(t => t.holdingBars >= r.min && t.holdingBars < r.max).length }));
}

export type PeriodSummary = { period: string; trades: number; netPnl: number; winRate: number };

function groupByPeriod(trades: ExecTrade[], keyFn: (date: Date) => string): PeriodSummary[] {
  const groups: Record<string, ExecTrade[]> = {};
  trades.forEach(t => { const key = keyFn(new Date(t.entryTime)); (groups[key] ||= []).push(t); });
  return Object.entries(groups)
    .map(([period, ts]) => ({
      period, trades: ts.length, netPnl: ts.reduce((s, t) => s + t.pnl, 0),
      winRate: (ts.filter(t => t.pnl > 0).length / ts.length) * 100,
    }))
    .sort((a, b) => a.period.localeCompare(b.period));
}

export function monthlyPerformance(trades: ExecTrade[]): PeriodSummary[] {
  return groupByPeriod(trades, d => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
}

export function weeklyPerformance(trades: ExecTrade[]): PeriodSummary[] {
  // ISO-ish week bucketing: year + week number (days since Jan 1 / 7) — a
  // simple, real, deterministic week grouping, not a precise ISO-8601 week
  // (which has edge-case rules around year boundaries) — fine for a
  // performance summary, not for legal/financial reporting.
  return groupByPeriod(trades, d => {
    const start = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNum = Math.floor((d.getTime() - start.getTime()) / (7 * 86400000)) + 1;
    return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
  });
}
