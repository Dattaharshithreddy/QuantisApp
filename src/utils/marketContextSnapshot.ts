// ─────────────────────────────────────────────────────────────────────────────
// MARKET CONTEXT SNAPSHOT  (v1.0.0)
//
// Immutable snapshot of market context captured at the moment a trade opens or
// a prediction is generated. Once stored, this object NEVER changes — it is
// historical context only.
//
// Design invariants:
//   • Zero ML impact — nothing here enters the 116-feature vector.
//   • All fields optional — missing context never blocks a trade.
//   • Persisted on PaperPosition, ShadowTrade, PaperTradeRecord.
//   • Structured for future analytics: win rate by Fear/Greed zone, etc.
//
// Routing:
//   kind === 'INDIAN'  → Indian equity context (NSE)
//   kind === 'CRYPTO'  → Crypto context (Binance / CoinGecko)
//   kind === 'NONE'    → Unknown asset or fetch failed — treat as unavailable
// ─────────────────────────────────────────────────────────────────────────────

import type { MarketContext }       from './marketContext/marketContextTypes';
import type { CryptoMarketContext } from './cryptoMarketContext/cryptoMarketContextTypes';

// ── Snapshot union ────────────────────────────────────────────────────────────

export type MarketContextSnapshot =
  | { kind: 'INDIAN'; ctx: MarketContext;       capturedAt: number }
  | { kind: 'CRYPTO'; ctx: CryptoMarketContext; capturedAt: number }
  | { kind: 'NONE';                             capturedAt: number };

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Freeze a UnifiedMarketContext (from marketContextRouter) into an immutable snapshot. */
import type { UnifiedMarketContext } from './cryptoMarketContext/marketContextRouter';

export function captureSnapshot(
  unified: UnifiedMarketContext,
): MarketContextSnapshot {
  const capturedAt = Date.now();
  if (unified.kind === 'INDIAN') return { kind: 'INDIAN', ctx: unified.ctx, capturedAt };
  if (unified.kind === 'CRYPTO') return { kind: 'CRYPTO', ctx: unified.ctx, capturedAt };
  return { kind: 'NONE', capturedAt };
}

export function isContextAvailable(snap: MarketContextSnapshot | null | undefined): boolean {
  if (!snap) return false;
  if (snap.kind === 'NONE') return false;
  if (snap.kind === 'INDIAN') return snap.ctx.available.length > 0;
  if (snap.kind === 'CRYPTO') return snap.ctx.available.length > 0;
  return false;
}

// ── Analytics-friendly summary (persisted with the snapshot for easy querying) ──

export type ContextSummary = {
  assetKind:       'INDIAN' | 'CRYPTO' | 'NONE';
  overallSentiment: 'BEARISH' | 'NEUTRAL' | 'BULLISH' | 'UNAVAILABLE';
  // Indian
  indiaVIX?:       number | null;    // raw VIX value
  vixRegime?:      string | null;    // LOW / NORMAL / HIGH / EXTREME
  breadthADRatio?: number | null;    // 0–1
  adTrend?:        string | null;    // BULLISH / NEUTRAL / BEARISH
  fiiBias?:        string | null;    // FII_BUY / FII_SELL / DII_BUY / MIXED
  pcrSentiment?:   string | null;    // EXTREME_BULLISH … EXTREME_BEARISH
  sectorLeader?:   string | null;
  // Crypto
  fearGreed?:      number | null;    // 0–100
  fearGreedLabel?: string | null;    // EXTREME_FEAR … EXTREME_GREED
  btcDominance?:   number | null;    // %
  fundingRate?:    number | null;    // raw 8h rate
  fundingSentiment?: string | null;  // EXTREME_LONG … EXTREME_SHORT
  openInterestConviction?: string | null; // BULLISH / BEARISH / WEAK
  stablecoinSignal?: string | null;  // RISK_ON / NEUTRAL / RISK_OFF
  marketRegime?:   string | null;    // RISK_ON / BTC_SEASON / ALT_SEASON etc
};

export function summariseContext(snap: MarketContextSnapshot | null | undefined): ContextSummary {
  if (!snap || snap.kind === 'NONE' || !isContextAvailable(snap)) {
    return { assetKind: snap?.kind ?? 'NONE', overallSentiment: 'UNAVAILABLE' };
  }

  if (snap.kind === 'INDIAN') {
    const c = snap.ctx;
    // Heuristic overall sentiment from breadth + VIX + FII bias
    const signals: number[] = [];
    if (c.breadth)  signals.push(c.breadth.adTrend === 'BULLISH' ? 1 : c.breadth.adTrend === 'BEARISH' ? -1 : 0);
    if (c.vix)      signals.push(c.vix.trend === 'FALLING' ? 1 : c.vix.trend === 'RISING' ? -1 : 0);
    if (c.fiidii)   signals.push(c.fiidii.bias === 'FII_BUY' ? 1 : c.fiidii.bias === 'FII_SELL' ? -1 : 0);
    if (c.pcr)      signals.push(c.pcr.isContrarianBull ? 1 : c.pcr.isContrarianBear ? -1 : 0);
    const avg = signals.length ? signals.reduce((a, b) => a + b, 0) / signals.length : 0;
    const overallSentiment: ContextSummary['overallSentiment'] =
      avg >  0.3 ? 'BULLISH' : avg < -0.3 ? 'BEARISH' : 'NEUTRAL';
    return {
      assetKind: 'INDIAN', overallSentiment,
      indiaVIX:       c.vix?.current ?? null,
      vixRegime:      c.vix?.regime  ?? null,
      breadthADRatio: c.breadth?.adRatio ?? null,
      adTrend:        c.breadth?.adTrend ?? null,
      fiiBias:        c.fiidii?.bias     ?? null,
      pcrSentiment:   c.pcr?.sentiment   ?? null,
      sectorLeader:   c.sectors?.leader  ?? null};
  }

  if (snap.kind === 'CRYPTO') {
    const c = snap.ctx;
    const fg = c.fearGreed?.value ?? 50;
    const funding = c.funding?.fundingRate ?? 0;
    const stableSignal = c.stablecoin?.signal;
    const signals: number[] = [
      (fg - 50) / 50,
      Math.sign(funding) * Math.min(Math.abs(funding) / 0.05, 1) * -1, // positive funding → bearish (overheated longs)
      stableSignal === 'RISK_ON' ? 1 : stableSignal === 'RISK_OFF' ? -1 : 0,
    ];
    const avg = signals.reduce((a, b) => a + b, 0) / signals.length;
    const overallSentiment: ContextSummary['overallSentiment'] =
      avg >  0.25 ? 'BULLISH' : avg < -0.25 ? 'BEARISH' : 'NEUTRAL';
    return {
      assetKind: 'CRYPTO', overallSentiment,
      fearGreed:       c.fearGreed?.value          ?? null,
      fearGreedLabel:  c.fearGreed?.classification ?? null,
      btcDominance:    c.marketCap?.btcDominance   ?? null,
      fundingRate:     c.funding?.fundingRate       ?? null,
      fundingSentiment: c.funding?.sentiment        ?? null,
      openInterestConviction: c.openInterest?.conviction ?? null,
      stablecoinSignal: c.stablecoin?.signal        ?? null,
      marketRegime:    c.marketCap?.regime          ?? null};
  }

  return { assetKind: 'NONE', overallSentiment: 'UNAVAILABLE' };
}
