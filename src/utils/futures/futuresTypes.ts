// ─────────────────────────────────────────────────────────────────────────────
// FUTURES TYPES  (v1.0.0)
//
// Type definitions for NSE futures contracts.
//
// Key differences from equity:
//   • Lot size — minimum tradeable unit is one lot (e.g. 75 units for NIFTY)
//   • Margin — only a fraction of notional is blocked as margin (~10-15%)
//   • Expiry — contracts expire on the last Thursday of each month
//   • MTM settlement — daily P&L credited/debited even on open positions
//   • No delivery — always cash-settled, no Demat involved
// ─────────────────────────────────────────────────────────────────────────────

export type FuturesUnderlying =
  | 'NIFTY' | 'BANKNIFTY' | 'FINNIFTY' | 'MIDCPNIFTY'
  | 'RELIANCE' | 'TCS' | 'INFY' | 'HDFCBANK' | 'ICICIBANK'
  | 'SBIN' | 'AXISBANK' | 'BHARTIARTL' | 'WIPRO' | 'TATAMOTORS' | 'ONGC';

export type ContractMonth = 'current' | 'next' | 'far';

export type FuturesContract = {
  underlying:         FuturesUnderlying;
  symbol:             string;   // full NFO symbol e.g. "NIFTY26JUL75FUT"
  aoToken:            string;   // Angel One instrument token
  exchange:           'NFO';
  lotSize:            number;   // units per lot
  expiry:             number;   // Unix ms — last Thursday of month
  expiryLabel:        string;   // "JUL 2026"
  month:              ContractMonth;
  spanMarginPct:      number;
  exposureMarginPct:  number;
  totalMarginPct:     number;
};

export type FuturesPosition = {
  id:                string;
  underlying:        FuturesUnderlying;
  contractSymbol:    string;
  direction:         'LONG' | 'SHORT';
  lots:              number;
  lotSize:           number;
  qty:               number;   // lots * lotSize
  entryPrice:        number;
  entryTime:         number;
  expiry:            number;
  expiryLabel:       string;
  stopLoss:          number;
  takeProfit:        number;
  notionalValue:     number;   // entryPrice * qty
  marginBlocked:     number;   // actual ₹ blocked as margin
  mtmSettledPnL:     number;   // cumulative daily MTM settled
  lastMtmPrice:      number;
  lastMtmAt:         number;
  signalSnapshot:    any;
};

export type MtmSettlement = {
  positionId:    string;
  settledAt:     number;
  settlePrice:   number;
  pnlForDay:     number;
  cumulativeMtm: number;
};

// ── Lot sizes — NSE circular, verified July 2026 ──────────────────────────
export const LOT_SIZES: Record<FuturesUnderlying, number> = {
  NIFTY: 75, BANKNIFTY: 30, FINNIFTY: 65, MIDCPNIFTY: 75,
  RELIANCE: 250, TCS: 150, INFY: 300, HDFCBANK: 550,
  ICICIBANK: 700, SBIN: 1500, AXISBANK: 625, BHARTIARTL: 475,
  WIPRO: 1500, TATAMOTORS: 1425, ONGC: 1925,
};

// ── Margin % of notional (SPAN + Exposure combined, approximate) ──────────
export const MARGIN_PCT: Record<FuturesUnderlying, number> = {
  NIFTY: 10, BANKNIFTY: 12, FINNIFTY: 11, MIDCPNIFTY: 12,
  RELIANCE: 13, TCS: 13, INFY: 13, HDFCBANK: 14,
  ICICIBANK: 14, SBIN: 15, AXISBANK: 14, BHARTIARTL: 14,
  WIPRO: 14, TATAMOTORS: 15, ONGC: 13,
};

// ── Expiry: last Thursday of month ────────────────────────────────────────
export function getLastThursday(year: number, month: number): Date {
  const lastDay   = new Date(year, month + 1, 0);
  const dayOfWeek = lastDay.getDay();
  const daysBack  = (dayOfWeek + 3) % 7;
  return new Date(year, month, lastDay.getDate() - daysBack, 15, 30, 0);
}

export function getCurrentExpiryDates(now: Date = new Date()): { current: Date; next: Date; far: Date } {
  const y = now.getFullYear();
  const m = now.getMonth();
  const thisExpiry = getLastThursday(y, m);
  const base = now >= thisExpiry ? { y: m === 11 ? y + 1 : y, m: (m + 1) % 12 } : { y, m };

  function addM(offset: number): Date {
    const total = base.m + offset;
    return getLastThursday(base.y + Math.floor(total / 12), total % 12);
  }

  return { current: addM(0), next: addM(1), far: addM(2) };
}

export function formatExpiryLabel(d: Date): string {
  const M = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  return `${M[d.getMonth()]} ${d.getFullYear()}`;
}

export function daysToExpiry(expiry: number): number {
  return Math.max(0, Math.floor((expiry - Date.now()) / 86_400_000));
}

// ── P&L and margin ────────────────────────────────────────────────────────
export function estimateMargin(underlying: FuturesUnderlying, price: number, lots: number): number {
  const notional = price * lots * LOT_SIZES[underlying];
  return notional * (MARGIN_PCT[underlying] / 100);
}

export function computeFuturesPnL(
  direction: 'LONG' | 'SHORT', entry: number, current: number, lots: number, lotSize: number,
): number {
  return (current - entry) * lots * lotSize * (direction === 'LONG' ? 1 : -1);
}

export function formatLotDisplay(lots: number, underlying: FuturesUnderlying): string {
  const qty = lots * LOT_SIZES[underlying];
  return `${lots} lot${lots !== 1 ? 's' : ''} (${qty.toLocaleString()} units)`;
}
