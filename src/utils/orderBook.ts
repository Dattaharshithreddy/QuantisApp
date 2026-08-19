// SINGLE SOURCE for order book types and derived calculations, shared by
// Angel One (existing) and Binance (new) order book data, and by every UI
// screen that displays it. Before this file existed, ChartScreen.tsx
// computed buy%/sell% inline, AO-only — extending that same inline pattern
// to a second source would have meant a second, separately-maintained
// copy of the same arithmetic. This module is built once and reused.

export type DepthLevel = {
  price: number;
  qty: number;
  // Angel One reports a real per-level order count; Binance's public
  // depth endpoint does not expose this at all. Optional and left
  // undefined for Binance rather than set to 0 — 0 would dishonestly
  // imply "zero orders confirmed," when the truth is "this source
  // doesn't tell us."
  orders?: number;
};

export type OrderBookSnapshot = {
  source: 'ao' | 'binance';
  symbol: string;
  buy: DepthLevel[];  // best bid first
  sell: DepthLevel[]; // best ask first
  timestamp: number;
};

export function bestBid(snap: OrderBookSnapshot): DepthLevel | null {
  return snap.buy[0] ?? null;
}
export function bestAsk(snap: OrderBookSnapshot): DepthLevel | null {
  return snap.sell[0] ?? null;
}

/** Best ask minus best bid. Null if either side is empty (nothing to spread between). */
export function bidAskSpread(snap: OrderBookSnapshot): number | null {
  const bid = bestBid(snap), ask = bestAsk(snap);
  if (!bid || !ask) return null;
  return ask.price - bid.price;
}

export function spreadPct(snap: OrderBookSnapshot): number | null {
  const spread = bidAskSpread(snap);
  const bid = bestBid(snap);
  if (spread == null || !bid || bid.price === 0) return null;
  return (spread / bid.price) * 100;
}

function sumQty(levels: DepthLevel[], depth?: number): number {
  return (depth != null ? levels.slice(0, depth) : levels).reduce((s, l) => s + l.qty, 0);
}

export function totalBidVolume(snap: OrderBookSnapshot, depth?: number): number {
  return sumQty(snap.buy, depth);
}
export function totalAskVolume(snap: OrderBookSnapshot, depth?: number): number {
  return sumQty(snap.sell, depth);
}

/**
 * Order book imbalance: (bidVol - askVol) / (bidVol + askVol), range -1..1.
 * Positive = more resting buy interest than sell interest at this depth.
 * Returns 0 (not null) when both sides are empty — an honest "no lean
 * either way" rather than a missing value, since a 0/0 ratio is
 * mathematically undefined but "no imbalance detected" is still a
 * meaningful, true statement when there's no book to read at all.
 */
export function orderBookImbalance(snap: OrderBookSnapshot, depth?: number): number {
  const bidVol = totalBidVolume(snap, depth), askVol = totalAskVolume(snap, depth);
  const total = bidVol + askVol;
  return total > 0 ? (bidVol - askVol) / total : 0;
}

/** Buy/sell pressure as a percentage split of total resting volume — what the UI shows as "BUY 62% / SELL 38%". */
export function buySellPressurePct(snap: OrderBookSnapshot, depth?: number): { buyPct: number; sellPct: number } {
  const bidVol = totalBidVolume(snap, depth), askVol = totalAskVolume(snap, depth);
  const total = bidVol + askVol || 1; // avoid div-by-zero; both percentages correctly come out 0 when there's truly nothing on the book
  return { buyPct: (bidVol / total) * 100, sellPct: (askVol / total) * 100 };
}

/** True if this snapshot has no real depth at all (every level is zero or the arrays are empty) - the same condition ChartScreen.tsx uses to distinguish "no real data" from "genuinely balanced market." */
export function isEmptyDepth(snap: OrderBookSnapshot | null | undefined): boolean {
  if (!snap) return true;
  return snap.buy.every(d => d.qty === 0) && snap.sell.every(d => d.qty === 0);
}

/**
 * Liquidity ratio at a given depth: total resting volume at that depth
 * relative to total resting volume across the entire fetched book.
 * Range 0..1. Useful for "how concentrated is liquidity near the top of
 * book" — close to 1 means most of the visible liquidity sits within the
 * first `depth` levels.
 */
export function liquidityRatio(snap: OrderBookSnapshot, depth: number): number {
  const nearTotal = totalBidVolume(snap, depth) + totalAskVolume(snap, depth);
  const fullTotal = totalBidVolume(snap) + totalAskVolume(snap);
  return fullTotal > 0 ? nearTotal / fullTotal : 0;
}

/**
 * "Wall" detection: a single price level whose quantity is at least
 * `multiplier` times the AVERAGE quantity of the other levels on the same
 * side. This is a real, computable statistical outlier check, not a
 * fabricated heuristic — it flags a level that genuinely stands out from
 * its own side's typical size, nothing more or less than that.
 */
export function detectLargeWall(levels: DepthLevel[], multiplier = 3): { index: number; level: DepthLevel } | null {
  if (levels.length < 2) return null;
  for (let i = 0; i < levels.length; i++) {
    const others = levels.filter((_, j) => j !== i);
    const avgOthers = others.reduce((s, l) => s + l.qty, 0) / others.length;
    if (avgOthers > 0 && levels[i].qty >= avgOthers * multiplier) {
      return { index: i, level: levels[i] };
    }
  }
  return null;
}
