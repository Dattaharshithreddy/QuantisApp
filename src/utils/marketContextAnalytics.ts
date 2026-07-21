// ─────────────────────────────────────────────────────────────────────────────
// MARKET CONTEXT ANALYTICS  (v1.0.0)
//
// Computes win-rate, profit factor, and performance metrics bucketed by
// market context conditions. All input data comes from closed PaperTradeRecords
// that already carry a frozen MarketContextSnapshot. Zero new computation,
// zero ML changes — pure aggregation over stored snapshots.
//
// Analytics produced:
//   • Win rate by Fear & Greed bucket (Crypto)
//   • Profit Factor by Funding Rate sentiment (Crypto)
//   • Win rate by India VIX range (Indian)
//   • Performance by Overall Market Sentiment (both)
//   • BTC Dominance performance bands (Crypto)
//   • Market Breadth performance bands (Indian)
// ─────────────────────────────────────────────────────────────────────────────

import type { PaperTradeRecord } from './paperTradeJournal';
import { getPaperTrades } from './paperTradeJournal';
import { summariseContext, isContextAvailable } from './marketContextSnapshot';
import type { ContextSummary } from './marketContextSnapshot';

// ── Shared bucket type ────────────────────────────────────────────────────────

export type ContextBucket = {
  label:        string;
  trades:       number;
  wins:         number;
  losses:       number;
  winRate:      number;   // 0–100
  profitFactor: number;   // Infinity when no losses
  avgPnlPct:    number;
  netPnlPct:    number;
  expectancy:   number;   // avgWin × winRate - avgLoss × lossRate
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function emptyBucket(label: string): ContextBucket {
  return { label, trades: 0, wins: 0, losses: 0, winRate: 0, profitFactor: 0, avgPnlPct: 0, netPnlPct: 0, expectancy: 0 };
}

function computeBucket(label: string, tradesInBucket: PaperTradeRecord[]): ContextBucket {
  if (!tradesInBucket.length) return emptyBucket(label);
  const wins   = tradesInBucket.filter(t => t.pnlPct > 0);
  const losses = tradesInBucket.filter(t => t.pnlPct <= 0);
  const grossWin  = wins.reduce((s, t) => s + t.pnlPct, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlPct, 0));
  const winRate   = tradesInBucket.length ? (wins.length / tradesInBucket.length) * 100 : 0;
  const lossRate  = 100 - winRate;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  const avgWin  = wins.length   ? grossWin  / wins.length   : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const avgPnlPct = tradesInBucket.reduce((s, t) => s + t.pnlPct, 0) / tradesInBucket.length;
  const netPnlPct = tradesInBucket.reduce((s, t) => s + t.pnlPct, 0);
  const expectancy = (winRate / 100) * avgWin - (lossRate / 100) * avgLoss;
  return { label, trades: tradesInBucket.length, wins: wins.length, losses: losses.length, winRate, profitFactor, avgPnlPct, netPnlPct, expectancy };
}

// ── Filter helpers ────────────────────────────────────────────────────────────

function tradesWithContext(trades: PaperTradeRecord[]): Array<{ trade: PaperTradeRecord; summary: ContextSummary }> {
  return trades
    .filter(t => isContextAvailable((t as any).marketContext))
    .map(t => ({ trade: t, summary: summariseContext((t as any).marketContext) }));
}

// ── 1. Win rate by Fear & Greed bucket ───────────────────────────────────────
// Buckets: Extreme Fear (0-25), Fear (25-45), Neutral (45-55), Greed (55-75), Extreme Greed (75-100)

export type FearGreedBuckets = {
  extremeFear:  ContextBucket;
  fear:         ContextBucket;
  neutral:      ContextBucket;
  greed:        ContextBucket;
  extremeGreed: ContextBucket;
};

export function computeFearGreedAnalytics(trades: PaperTradeRecord[]): FearGreedBuckets {
  const withCtx = tradesWithContext(trades).filter(({ summary }) =>
    summary.assetKind === 'CRYPTO' && summary.fearGreed != null
  );
  const bucket = (min: number, max: number, label: string) =>
    computeBucket(label, withCtx.filter(({ summary }) => summary.fearGreed! >= min && summary.fearGreed! < max).map(x => x.trade));

  return {
    extremeFear:  bucket(0,  25,  'Extreme Fear (0–25)'),
    fear:         bucket(25, 45,  'Fear (25–45)'),
    neutral:      bucket(45, 55,  'Neutral (45–55)'),
    greed:        bucket(55, 75,  'Greed (55–75)'),
    extremeGreed: bucket(75, 101, 'Extreme Greed (75–100)'),
  };
}

// ── 2. Profit Factor by Funding Rate sentiment ─────────────────────────────

export type FundingRateBuckets = {
  extremeShort: ContextBucket;
  shortBiased:  ContextBucket;
  neutral:      ContextBucket;
  longBiased:   ContextBucket;
  extremeLong:  ContextBucket;
};

export function computeFundingAnalytics(trades: PaperTradeRecord[]): FundingRateBuckets {
  const withCtx = tradesWithContext(trades).filter(({ summary }) =>
    summary.assetKind === 'CRYPTO' && summary.fundingSentiment != null
  );
  const bucket = (sentiment: string, label: string) =>
    computeBucket(label, withCtx.filter(({ summary }) => summary.fundingSentiment === sentiment).map(x => x.trade));

  return {
    extremeShort: bucket('EXTREME_SHORT', 'Extreme Short'),
    shortBiased:  bucket('SHORT_BIASED',  'Short Biased'),
    neutral:      bucket('NEUTRAL',       'Neutral'),
    longBiased:   bucket('LONG_BIASED',   'Long Biased'),
    extremeLong:  bucket('EXTREME_LONG',  'Extreme Long'),
  };
}

// ── 3. Win rate by India VIX range ────────────────────────────────────────────
// Buckets mirror VIX regime thresholds from marketContextTypes.ts:
//   LOW<12, NORMAL 12-20, HIGH 20-30, EXTREME>30

export type VIXBuckets = {
  low:     ContextBucket;   // VIX < 12
  normal:  ContextBucket;   // 12–20
  high:    ContextBucket;   // 20–30
  extreme: ContextBucket;   // > 30
};

export function computeVIXAnalytics(trades: PaperTradeRecord[]): VIXBuckets {
  const withCtx = tradesWithContext(trades).filter(({ summary }) =>
    summary.assetKind === 'INDIAN' && summary.indiaVIX != null
  );
  const bucket = (min: number, max: number, label: string) =>
    computeBucket(label, withCtx.filter(({ summary }) => summary.indiaVIX! >= min && summary.indiaVIX! < max).map(x => x.trade));

  return {
    low:     bucket(0,   12,    'Low (<12)'),
    normal:  bucket(12,  20,    'Normal (12–20)'),
    high:    bucket(20,  30,    'High (20–30)'),
    extreme: bucket(30, 999,    'Extreme (>30)'),
  };
}

// ── 4. Performance by Overall Market Sentiment ────────────────────────────────
// Applies to both INDIAN and CRYPTO trades — uses the heuristic overall sentinel
// produced by summariseContext()

export type SentimentBuckets = {
  bullish:     ContextBucket;
  neutral:     ContextBucket;
  bearish:     ContextBucket;
  unavailable: ContextBucket;
};

export function computeSentimentAnalytics(trades: PaperTradeRecord[]): SentimentBuckets {
  const all = trades.map(t => ({
    trade: t,
    summary: summariseContext((t as any).marketContext ?? null),
  }));
  const bucket = (sentiment: string, label: string) =>
    computeBucket(label, all.filter(x => x.summary.overallSentiment === sentiment).map(x => x.trade));

  return {
    bullish:     bucket('BULLISH',     'Bullish Market'),
    neutral:     bucket('NEUTRAL',     'Neutral Market'),
    bearish:     bucket('BEARISH',     'Bearish Market'),
    unavailable: bucket('UNAVAILABLE', 'Context Unavailable'),
  };
}

// ── 5. BTC Dominance performance bands (Crypto) ───────────────────────────────
// Quartile-style bands: <40%, 40-50%, 50-60%, >60%

export type BTCDominanceBuckets = {
  altSeason:   ContextBucket;   // BTC.D < 40 — alts dominating
  balanced:    ContextBucket;   // 40–50
  btcLead:     ContextBucket;   // 50–60
  btcDominant: ContextBucket;   // > 60
};

export function computeBTCDominanceAnalytics(trades: PaperTradeRecord[]): BTCDominanceBuckets {
  const withCtx = tradesWithContext(trades).filter(({ summary }) =>
    summary.assetKind === 'CRYPTO' && summary.btcDominance != null
  );
  const bucket = (min: number, max: number, label: string) =>
    computeBucket(label, withCtx.filter(({ summary }) => summary.btcDominance! >= min && summary.btcDominance! < max).map(x => x.trade));

  return {
    altSeason:   bucket(0,  40, 'Alt Season (<40%)'),
    balanced:    bucket(40, 50, 'Balanced (40–50%)'),
    btcLead:     bucket(50, 60, 'BTC Lead (50–60%)'),
    btcDominant: bucket(60, 100, 'BTC Dominant (>60%)'),
  };
}

// ── 6. Market Breadth performance bands (Indian) ─────────────────────────────
// Mirrors adTrend thresholds from marketContextTypes.ts

export type BreadthBuckets = {
  bullish: ContextBucket;   // adTrend BULLISH
  neutral: ContextBucket;   // NEUTRAL
  bearish: ContextBucket;   // BEARISH
};

export function computeBreadthAnalytics(trades: PaperTradeRecord[]): BreadthBuckets {
  const withCtx = tradesWithContext(trades).filter(({ summary }) =>
    summary.assetKind === 'INDIAN' && summary.adTrend != null
  );
  const bucket = (trend: string, label: string) =>
    computeBucket(label, withCtx.filter(({ summary }) => summary.adTrend === trend).map(x => x.trade));

  return {
    bullish: bucket('BULLISH', 'Breadth Bullish'),
    neutral: bucket('NEUTRAL', 'Breadth Neutral'),
    bearish: bucket('BEARISH', 'Breadth Bearish'),
  };
}

// ── Full analytics report ─────────────────────────────────────────────────────

export type MarketContextAnalyticsReport = {
  // Metadata
  totalTrades:         number;
  tradesWithContext:   number;
  cryptoTrades:        number;
  indianTrades:        number;
  generatedAt:         number;

  // Crypto analytics
  fearGreed:     FearGreedBuckets | null;   // null when no crypto trades
  funding:       FundingRateBuckets | null;
  btcDominance:  BTCDominanceBuckets | null;

  // Indian analytics
  vix:           VIXBuckets | null;         // null when no indian trades
  breadth:       BreadthBuckets | null;

  // Cross-asset
  sentiment:     SentimentBuckets;
};

export async function computeMarketContextAnalytics(): Promise<MarketContextAnalyticsReport> {
  const trades = await getPaperTrades();
  const withCtxTrades = trades.filter(t => isContextAvailable((t as any).marketContext));
  const cryptoTrades  = withCtxTrades.filter(t => summariseContext((t as any).marketContext).assetKind === 'CRYPTO');
  const indianTrades  = withCtxTrades.filter(t => summariseContext((t as any).marketContext).assetKind === 'INDIAN');

  return {
    totalTrades:       trades.length,
    tradesWithContext: withCtxTrades.length,
    cryptoTrades:      cryptoTrades.length,
    indianTrades:      indianTrades.length,
    generatedAt:       Date.now(),

    fearGreed:    cryptoTrades.length ? computeFearGreedAnalytics(trades) : null,
    funding:      cryptoTrades.length ? computeFundingAnalytics(trades)   : null,
    btcDominance: cryptoTrades.length ? computeBTCDominanceAnalytics(trades) : null,

    vix:     indianTrades.length ? computeVIXAnalytics(trades)     : null,
    breadth: indianTrades.length ? computeBreadthAnalytics(trades)  : null,

    sentiment: computeSentimentAnalytics(trades),
  };
}
