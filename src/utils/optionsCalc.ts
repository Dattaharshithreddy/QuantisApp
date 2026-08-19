// ─────────────────────────────────────────────────────────────────────────────
// OPTIONS CALC  v2.0
// Black-Scholes pricing + Greeks, multi-leg payoff, strategy templates,
// NSE expiry calendar, and custom leg support.
// All client-side — no external feed required.
// ─────────────────────────────────────────────────────────────────────────────

// ── Normal CDF (Abramowitz & Stegun approximation) ───────────────────────────
function normCDF(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (x > 0) p = 1 - p;
  return p;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type Greeks = { price: number; delta: number; gamma: number; theta: number; vega: number };

export type OptionLeg = {
  id:       string;
  type:     'CE' | 'PE';
  action:   'BUY' | 'SELL';
  strike:   number;
  premium:  number;   // per-unit entry premium
  qty:      number;   // lot size × lots
};

// ── Black-Scholes ─────────────────────────────────────────────────────────────
// S=spot, K=strike, T=years to expiry, r=risk-free rate, sigma=IV (decimal)

export function blackScholes(S: number, K: number, T: number, r: number, sigma: number, type: 'CE' | 'PE'): Greeks {
  if (T <= 0) T = 0.0007; // ~few hours, avoid div-by-zero
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const Nd1 = normCDF(d1), Nd2 = normCDF(d2);
  const pdf = Math.exp((-d1 * d1) / 2) / Math.sqrt(2 * Math.PI);

  let price: number, delta: number;
  if (type === 'CE') {
    price = S * Nd1 - K * Math.exp(-r * T) * Nd2;
    delta = Nd1;
  } else {
    price = K * Math.exp(-r * T) * (1 - Nd2) - S * (1 - Nd1);
    delta = Nd1 - 1;
  }
  const gamma = pdf / (S * sigma * sqrtT);
  const vega  = (S * pdf * sqrtT) / 100;   // per 1% IV move
  const theta = type === 'CE'
    ? (-S * pdf * sigma) / (2 * sqrtT) - r * K * Math.exp(-r * T) * Nd2
    : (-S * pdf * sigma) / (2 * sqrtT) + r * K * Math.exp(-r * T) * (1 - Nd2);

  return { price: Math.max(price, 0), delta, gamma, theta: theta / 365, vega };
}

// ── Strategy templates ────────────────────────────────────────────────────────
// Each function returns legs with qty=1 (scaled by lotSz×lots in the screen).

type LegTemplate = Omit<OptionLeg, 'id' | 'premium'>;

export const STRATEGY_TEMPLATES: Record<string, (spot: number, gap: number) => LegTemplate[]> = {
  // ── Volatility plays ────────────────────────────────────────────────────────
  'Long Straddle': (spot, gap) => {
    const atm = Math.round(spot / gap) * gap;
    return [
      { type: 'CE', action: 'BUY', strike: atm, qty: 1 },
      { type: 'PE', action: 'BUY', strike: atm, qty: 1 },
    ];
  },
  'Short Straddle': (spot, gap) => {
    const atm = Math.round(spot / gap) * gap;
    return [
      { type: 'CE', action: 'SELL', strike: atm, qty: 1 },
      { type: 'PE', action: 'SELL', strike: atm, qty: 1 },
    ];
  },
  'Long Strangle': (spot, gap) => {
    const atm = Math.round(spot / gap) * gap;
    return [
      { type: 'CE', action: 'BUY', strike: atm + gap, qty: 1 },
      { type: 'PE', action: 'BUY', strike: atm - gap, qty: 1 },
    ];
  },
  'Short Strangle': (spot, gap) => {
    const atm = Math.round(spot / gap) * gap;
    return [
      { type: 'CE', action: 'SELL', strike: atm + gap, qty: 1 },
      { type: 'PE', action: 'SELL', strike: atm - gap, qty: 1 },
    ];
  },

  // ── Spread plays ────────────────────────────────────────────────────────────
  'Bull Call Spread': (spot, gap) => {
    const atm = Math.round(spot / gap) * gap;
    return [
      { type: 'CE', action: 'BUY',  strike: atm,           qty: 1 },
      { type: 'CE', action: 'SELL', strike: atm + 2 * gap, qty: 1 },
    ];
  },
  'Bear Put Spread': (spot, gap) => {
    const atm = Math.round(spot / gap) * gap;
    return [
      { type: 'PE', action: 'BUY',  strike: atm,           qty: 1 },
      { type: 'PE', action: 'SELL', strike: atm - 2 * gap, qty: 1 },
    ];
  },
  'Bull Put Spread': (spot, gap) => {
    const atm = Math.round(spot / gap) * gap;
    return [
      { type: 'PE', action: 'SELL', strike: atm,           qty: 1 },
      { type: 'PE', action: 'BUY',  strike: atm - 2 * gap, qty: 1 },
    ];
  },
  'Bear Call Spread': (spot, gap) => {
    const atm = Math.round(spot / gap) * gap;
    return [
      { type: 'CE', action: 'SELL', strike: atm,           qty: 1 },
      { type: 'CE', action: 'BUY',  strike: atm + 2 * gap, qty: 1 },
    ];
  },

  // ── Wing plays ──────────────────────────────────────────────────────────────
  'Iron Condor': (spot, gap) => {
    const atm = Math.round(spot / gap) * gap;
    return [
      { type: 'PE', action: 'SELL', strike: atm - gap,     qty: 1 },
      { type: 'PE', action: 'BUY',  strike: atm - 2 * gap, qty: 1 },
      { type: 'CE', action: 'SELL', strike: atm + gap,     qty: 1 },
      { type: 'CE', action: 'BUY',  strike: atm + 2 * gap, qty: 1 },
    ];
  },
  'Iron Butterfly': (spot, gap) => {
    const atm = Math.round(spot / gap) * gap;
    return [
      { type: 'PE', action: 'BUY',  strike: atm - gap, qty: 1 },
      { type: 'PE', action: 'SELL', strike: atm,        qty: 1 },
      { type: 'CE', action: 'SELL', strike: atm,        qty: 1 },
      { type: 'CE', action: 'BUY',  strike: atm + gap,  qty: 1 },
    ];
  },
  'Long Butterfly': (spot, gap) => {
    const atm = Math.round(spot / gap) * gap;
    return [
      { type: 'CE', action: 'BUY',  strike: atm - gap,  qty: 1 },
      { type: 'CE', action: 'SELL', strike: atm,         qty: 2 },
      { type: 'CE', action: 'BUY',  strike: atm + gap,  qty: 1 },
    ];
  },

  // ── Directional with protection ─────────────────────────────────────────────
  'Covered Call': (spot, gap) => {
    const atm = Math.round(spot / gap) * gap;
    return [
      // Stock/index long modelled as deep ITM call proxy
      { type: 'CE', action: 'BUY',  strike: atm - 2 * gap, qty: 1 },
      { type: 'CE', action: 'SELL', strike: atm + gap,      qty: 1 },
    ];
  },
  'Protective Put': (spot, gap) => {
    const atm = Math.round(spot / gap) * gap;
    return [
      { type: 'CE', action: 'BUY',  strike: atm - 2 * gap, qty: 1 },
      { type: 'PE', action: 'BUY',  strike: atm - gap,      qty: 1 },
    ];
  },
};

// ── Strategy metadata ─────────────────────────────────────────────────────────
// Used to show description and market outlook in the UI.

export type StrategyMeta = {
  outlook:     string;   // e.g. "Neutral — high volatility expected"
  description: string;
  maxProfitNote: string;
  maxLossNote:   string;
  tag:           'VOLATILITY' | 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'PROTECTED';
};

export const STRATEGY_META: Record<string, StrategyMeta> = {
  'Long Straddle':    { tag: 'VOLATILITY', outlook: 'Big move expected, direction unknown', description: 'Buy ATM CE + PE. Profit when the underlying moves significantly in either direction. Loses if spot stays near the strike.', maxProfitNote: 'Unlimited (CE side)', maxLossNote: 'Total premium paid' },
  'Short Straddle':   { tag: 'NEUTRAL',    outlook: 'Sideways / low volatility expected',   description: 'Sell ATM CE + PE. Collect premium if spot stays near the strike till expiry. Maximum risk on large moves.', maxProfitNote: 'Total premium received', maxLossNote: 'Unlimited' },
  'Long Strangle':    { tag: 'VOLATILITY', outlook: 'Big move expected, cheaper than straddle', description: 'Buy OTM CE + OTM PE. Cheaper than straddle but needs a larger move to profit.', maxProfitNote: 'Unlimited (CE side)', maxLossNote: 'Total premium paid' },
  'Short Strangle':   { tag: 'NEUTRAL',    outlook: 'Range-bound market',                   description: 'Sell OTM CE + OTM PE. Wider profit zone than short straddle but still has unlimited risk.', maxProfitNote: 'Total premium received', maxLossNote: 'Unlimited' },
  'Bull Call Spread': { tag: 'BULLISH',    outlook: 'Moderately bullish',                   description: 'Buy lower CE, sell higher CE. Capped profit but also capped cost. Best when you expect a moderate upside move.', maxProfitNote: 'Width of spread − net premium', maxLossNote: 'Net premium paid' },
  'Bear Put Spread':  { tag: 'BEARISH',    outlook: 'Moderately bearish',                   description: 'Buy higher PE, sell lower PE. Capped profit in exchange for lower cost vs buying a naked put.', maxProfitNote: 'Width of spread − net premium', maxLossNote: 'Net premium paid' },
  'Bull Put Spread':  { tag: 'BULLISH',    outlook: 'Moderately bullish or neutral',         description: 'Sell higher PE, buy lower PE for protection. Collect credit. Profit if spot stays above the short strike.', maxProfitNote: 'Net credit received', maxLossNote: 'Width of spread − net credit' },
  'Bear Call Spread': { tag: 'BEARISH',    outlook: 'Moderately bearish or neutral',         description: 'Sell lower CE, buy higher CE for protection. Collect credit. Profit if spot stays below the short strike.', maxProfitNote: 'Net credit received', maxLossNote: 'Width of spread − net credit' },
  'Iron Condor':      { tag: 'NEUTRAL',    outlook: 'Low volatility, range-bound',           description: 'Sell OTM strangle, buy further OTM wings as protection. Four legs, defined risk and reward.', maxProfitNote: 'Net credit from both spreads', maxLossNote: 'Width of one spread − net credit' },
  'Iron Butterfly':   { tag: 'NEUTRAL',    outlook: 'Very tight range expected at ATM',     description: 'Sell ATM straddle, buy OTM wings. Maximum profit exactly at ATM. Tighter profit zone than Iron Condor.', maxProfitNote: 'Net credit received', maxLossNote: 'Wing width − net credit' },
  'Long Butterfly':   { tag: 'NEUTRAL',    outlook: 'Spot expected to pin near ATM',        description: 'Buy two outer CEs, sell two ATM CEs. Low cost, limited risk, profits if spot closes near middle strike.', maxProfitNote: 'Wing width − net premium', maxLossNote: 'Net premium paid' },
  'Covered Call':     { tag: 'PROTECTED',  outlook: 'Moderately bullish, generate income',  description: 'Hold underlying (modelled as deep ITM call), sell OTM CE. Generates income but caps upside.', maxProfitNote: 'Short strike − entry + premium received', maxLossNote: 'Significant if underlying falls' },
  'Protective Put':   { tag: 'PROTECTED',  outlook: 'Bullish but want downside hedge',      description: 'Hold underlying, buy OTM PE as insurance. Full upside participation with floor protection.', maxProfitNote: 'Unlimited (underlying appreciation)', maxLossNote: 'Entry − put strike + premium paid' },
};

// Tag colors used in UI (exported for screen to read)
export const TAG_COLORS: Record<StrategyMeta['tag'], string> = {
  VOLATILITY: '#f59e0b',
  BULLISH:    '#22c55e',
  BEARISH:    '#ef4444',
  NEUTRAL:    '#6366f1',
  PROTECTED:  '#06b6d4',
};

// ── NSE expiry calendar ───────────────────────────────────────────────────────
// Returns upcoming NSE expiry dates (Thursdays).
// Weekly expiry = every Thursday. Monthly expiry = last Thursday of the month.

export function getNSEExpiries(fromDate: Date = new Date(), count = 8): { date: Date; label: string; daysAway: number; isMonthly: boolean }[] {
  const result = [];
  const d = new Date(fromDate);
  // Move to next Thursday
  while (d.getDay() !== 4) d.setDate(d.getDate() + 1);

  while (result.length < count) {
    const expDate = new Date(d);
    const daysAway = Math.round((expDate.getTime() - fromDate.getTime()) / 86400000);
    // Is it the last Thursday of the month?
    const nextThursday = new Date(d);
    nextThursday.setDate(d.getDate() + 7);
    const isMonthly = nextThursday.getMonth() !== d.getMonth();
    const label = expDate.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) +
                  (isMonthly ? ' (M)' : '');
    result.push({ date: expDate, label, daysAway: Math.max(daysAway, 0), isMonthly });
    d.setDate(d.getDate() + 7);
  }
  return result;
}

// ── Payoff engine ─────────────────────────────────────────────────────────────

function legPayoff(leg: OptionLeg, underlyingAtExpiry: number): number {
  const intrinsic = leg.type === 'CE'
    ? Math.max(underlyingAtExpiry - leg.strike, 0)
    : Math.max(leg.strike - underlyingAtExpiry, 0);
  const pnlPerUnit = leg.action === 'BUY' ? intrinsic - leg.premium : leg.premium - intrinsic;
  return pnlPerUnit * leg.qty;
}

export function calcPayoffCurve(legs: OptionLeg[], spot: number, range = 0.1, points = 60) {
  const lo = spot * (1 - range), hi = spot * (1 + range);
  const step = (hi - lo) / points;
  return Array.from({ length: points + 1 }, (_, i) => {
    const price = lo + step * i;
    return { price, pnl: legs.reduce((s, leg) => s + legPayoff(leg, price), 0) };
  });
}

export function calcNetGreeks(
  legs: OptionLeg[], spot: number, daysToExpiry: number, ivPct: number, riskFreeRate = 0.07,
): Greeks & { netPremium: number } {
  const T = Math.max(daysToExpiry, 0.5) / 365;
  let delta = 0, gamma = 0, theta = 0, vega = 0, netPremium = 0;
  legs.forEach(leg => {
    const g    = blackScholes(spot, leg.strike, T, riskFreeRate, ivPct / 100, leg.type);
    const sign = leg.action === 'BUY' ? 1 : -1;
    delta      += g.delta * sign * leg.qty;
    gamma      += g.gamma * sign * leg.qty;
    theta      += g.theta * sign * leg.qty;
    vega       += g.vega  * sign * leg.qty;
    netPremium += (leg.action === 'BUY' ? -leg.premium : leg.premium) * leg.qty;
  });
  return { price: 0, delta, gamma, theta, vega, netPremium };
}

export function maxProfitLoss(curve: { price: number; pnl: number }[]) {
  const pnls = curve.map(c => c.pnl);
  return { maxProfit: Math.max(...pnls), maxLoss: Math.min(...pnls) };
}

export function breakevens(curve: { price: number; pnl: number }[]): number[] {
  const points: number[] = [];
  for (let i = 1; i < curve.length; i++) {
    const prev = curve[i - 1], curr = curve[i];
    if ((prev.pnl < 0 && curr.pnl >= 0) || (prev.pnl >= 0 && curr.pnl < 0)) {
      // Linear interpolation for more accurate BE
      const ratio = Math.abs(prev.pnl) / (Math.abs(prev.pnl) + Math.abs(curr.pnl));
      points.push(prev.price + ratio * (curr.price - prev.price));
    }
  }
  return points;
}
