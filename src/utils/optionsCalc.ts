// Black-Scholes pricing + Greeks, and multi-leg payoff diagram generator.
// All client-side — no external Greeks feed needed.

function normCDF(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (x > 0) p = 1 - p;
  return p;
}

export type Greeks = { price: number; delta: number; gamma: number; theta: number; vega: number };

// S=spot, K=strike, T=years to expiry, r=risk-free rate, sigma=IV (decimal), type='CE'|'PE'
export function blackScholes(S: number, K: number, T: number, r: number, sigma: number, type: 'CE' | 'PE'): Greeks {
  if (T <= 0) T = 0.0007; // ~ a few hours, avoid div by zero
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
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
  const gamma = pdf / (S * sigma * Math.sqrt(T));
  const vega = (S * pdf * Math.sqrt(T)) / 100; // per 1% IV change
  const theta = type === 'CE'
    ? (-S * pdf * sigma) / (2 * Math.sqrt(T)) - r * K * Math.exp(-r * T) * Nd2
    : (-S * pdf * sigma) / (2 * Math.sqrt(T)) + r * K * Math.exp(-r * T) * (1 - Nd2);

  return { price: Math.max(price, 0), delta, gamma, theta: theta / 365, vega };
}

export type OptionLeg = {
  id: string;
  type: 'CE' | 'PE';
  action: 'BUY' | 'SELL';
  strike: number;
  premium: number; // entry premium paid/received
  qty: number; // lot size * lots
};

export const STRATEGY_TEMPLATES: Record<string, (spot: number, gap: number) => Omit<OptionLeg, 'id' | 'premium'>[]> = {
  'Long Straddle': (spot, gap) => [
    { type: 'CE', action: 'BUY', strike: Math.round(spot / gap) * gap, qty: 1 },
    { type: 'PE', action: 'BUY', strike: Math.round(spot / gap) * gap, qty: 1 },
  ],
  'Long Strangle': (spot, gap) => [
    { type: 'CE', action: 'BUY', strike: Math.round(spot / gap) * gap + gap, qty: 1 },
    { type: 'PE', action: 'BUY', strike: Math.round(spot / gap) * gap - gap, qty: 1 },
  ],
  'Iron Condor': (spot, gap) => [
    { type: 'PE', action: 'SELL', strike: Math.round(spot / gap) * gap - gap, qty: 1 },
    { type: 'PE', action: 'BUY', strike: Math.round(spot / gap) * gap - 2 * gap, qty: 1 },
    { type: 'CE', action: 'SELL', strike: Math.round(spot / gap) * gap + gap, qty: 1 },
    { type: 'CE', action: 'BUY', strike: Math.round(spot / gap) * gap + 2 * gap, qty: 1 },
  ],
  'Bull Call Spread': (spot, gap) => [
    { type: 'CE', action: 'BUY', strike: Math.round(spot / gap) * gap, qty: 1 },
    { type: 'CE', action: 'SELL', strike: Math.round(spot / gap) * gap + 2 * gap, qty: 1 },
  ],
  'Bear Put Spread': (spot, gap) => [
    { type: 'PE', action: 'BUY', strike: Math.round(spot / gap) * gap, qty: 1 },
    { type: 'PE', action: 'SELL', strike: Math.round(spot / gap) * gap - 2 * gap, qty: 1 },
  ],
};

// Payoff at expiry for a single leg at a given underlying price
function legPayoff(leg: OptionLeg, underlyingAtExpiry: number): number {
  const intrinsic = leg.type === 'CE' ? Math.max(underlyingAtExpiry - leg.strike, 0) : Math.max(leg.strike - underlyingAtExpiry, 0);
  const pnlPerUnit = leg.action === 'BUY' ? intrinsic - leg.premium : leg.premium - intrinsic;
  return pnlPerUnit * leg.qty;
}

export function calcPayoffCurve(legs: OptionLeg[], spot: number, range = 0.08, points = 40) {
  const lo = spot * (1 - range), hi = spot * (1 + range);
  const step = (hi - lo) / points;
  const curve: { price: number; pnl: number }[] = [];
  for (let i = 0; i <= points; i++) {
    const price = lo + step * i;
    const pnl = legs.reduce((s, leg) => s + legPayoff(leg, price), 0);
    curve.push({ price, pnl });
  }
  return curve;
}

export function calcNetGreeks(legs: OptionLeg[], spot: number, daysToExpiry: number, ivPct: number, riskFreeRate = 0.07): Greeks & { netPremium: number } {
  const T = Math.max(daysToExpiry, 0.5) / 365;
  let net = { price: 0, delta: 0, gamma: 0, theta: 0, vega: 0 };
  let netPremium = 0;
  legs.forEach(leg => {
    const g = blackScholes(spot, leg.strike, T, riskFreeRate, ivPct / 100, leg.type);
    const sign = leg.action === 'BUY' ? 1 : -1;
    net.delta += g.delta * sign * leg.qty;
    net.gamma += g.gamma * sign * leg.qty;
    net.theta += g.theta * sign * leg.qty;
    net.vega += g.vega * sign * leg.qty;
    netPremium += (leg.action === 'BUY' ? -leg.premium : leg.premium) * leg.qty;
  });
  return { ...net, price: 0, netPremium };
}

export function maxProfitLoss(curve: { price: number; pnl: number }[]) {
  const pnls = curve.map(c => c.pnl);
  return { maxProfit: Math.max(...pnls), maxLoss: Math.min(...pnls) };
}

export function breakevens(curve: { price: number; pnl: number }[]): number[] {
  const points: number[] = [];
  for (let i = 1; i < curve.length; i++) {
    if ((curve[i - 1].pnl < 0 && curve[i].pnl >= 0) || (curve[i - 1].pnl >= 0 && curve[i].pnl < 0)) {
      points.push((curve[i - 1].price + curve[i].price) / 2);
    }
  }
  return points;
}
