// ─────────────────────────────────────────────────────────────────────────────
// BINANCE FUTURES TYPES  (v1.0.0)
//
// Types for Binance USDT-Margined perpetual futures (USDM).
//
// Key differences from NSE futures:
//
//   Perpetual — no expiry date. Position runs until closed or liquidated.
//   Leverage is explicit — user chooses 1×–125× (unlike NSE where margin% is
//     fixed by the exchange).
//   Isolated margin — each position has its own margin wallet. A loss on
//     BTC cannot liquidate your ETH position. (vs NSE where one F&O account
//     backs all positions).
//   Funding rate — instead of MTM daily settlement, longs pay shorts (or vice
//     versa) every 8 hours based on the funding rate. Positive rate = longs pay.
//     Negative rate = shorts pay. This keeps the perp price anchored to spot.
//   Liquidation price — when unrealised loss consumes all isolated margin,
//     Binance force-closes the position. Critical to understand before trading.
//   Quantity in contracts — each contract = 1 unit of base asset for BTC/ETH,
//     but varies. Binance USDM perps quote in base asset units.
//
// Paper trading scope:
//   All of the above is modelled in paper trading.
//   Live futures on Binance (fapi.binance.com) is not wired yet — the API
//   client is in bnFuturesApi.ts for future use.
// ─────────────────────────────────────────────────────────────────────────────

export type BnFuturesSymbol =
  | 'BTCUSDT'
  | 'ETHUSDT'
  | 'BNBUSDT'
  | 'SOLUSDT'
  | 'XRPUSDT'
  | 'ADAUSDT'
  | 'DOGEUSDT'
  | 'AVAXUSDT'
  | 'DOTUSDT'
  | 'MATICUSDT';

// ── Contract specs ────────────────────────────────────────────────────────────
// contractSize: units of base asset per contract (1 BTC, 1 ETH, etc.)
// minQty: minimum order size in contracts
// qtyStep: order size increment
// maxLeverage: maximum leverage Binance allows for this symbol

export type BnContractSpec = {
  symbol:       BnFuturesSymbol;
  name:         string;
  contractSize: number;   // always 1 for USDM perps
  minQty:       number;
  qtyStep:      number;
  maxLeverage:  number;
  takerFeeRate: number;   // 0.0004 = 0.04%
  makerFeeRate: number;   // 0.0002 = 0.02%
};

export const BN_CONTRACT_SPECS: Record<BnFuturesSymbol, BnContractSpec> = {
  BTCUSDT:   { symbol: 'BTCUSDT',   name: 'Bitcoin',   contractSize: 1, minQty: 0.001, qtyStep: 0.001, maxLeverage: 125, takerFeeRate: 0.0004, makerFeeRate: 0.0002 },
  ETHUSDT:   { symbol: 'ETHUSDT',   name: 'Ethereum',  contractSize: 1, minQty: 0.001, qtyStep: 0.001, maxLeverage: 100, takerFeeRate: 0.0004, makerFeeRate: 0.0002 },
  BNBUSDT:   { symbol: 'BNBUSDT',   name: 'BNB',       contractSize: 1, minQty: 0.01,  qtyStep: 0.01,  maxLeverage: 75,  takerFeeRate: 0.0004, makerFeeRate: 0.0002 },
  SOLUSDT:   { symbol: 'SOLUSDT',   name: 'Solana',    contractSize: 1, minQty: 0.1,   qtyStep: 0.1,   maxLeverage: 50,  takerFeeRate: 0.0004, makerFeeRate: 0.0002 },
  XRPUSDT:   { symbol: 'XRPUSDT',   name: 'XRP',       contractSize: 1, minQty: 1,     qtyStep: 1,     maxLeverage: 75,  takerFeeRate: 0.0004, makerFeeRate: 0.0002 },
  ADAUSDT:   { symbol: 'ADAUSDT',   name: 'Cardano',   contractSize: 1, minQty: 1,     qtyStep: 1,     maxLeverage: 75,  takerFeeRate: 0.0004, makerFeeRate: 0.0002 },
  DOGEUSDT:  { symbol: 'DOGEUSDT',  name: 'Dogecoin',  contractSize: 1, minQty: 1,     qtyStep: 1,     maxLeverage: 75,  takerFeeRate: 0.0004, makerFeeRate: 0.0002 },
  AVAXUSDT:  { symbol: 'AVAXUSDT',  name: 'Avalanche', contractSize: 1, minQty: 0.1,   qtyStep: 0.1,   maxLeverage: 50,  takerFeeRate: 0.0004, makerFeeRate: 0.0002 },
  DOTUSDT:   { symbol: 'DOTUSDT',   name: 'Polkadot',  contractSize: 1, minQty: 0.1,   qtyStep: 0.1,   maxLeverage: 50,  takerFeeRate: 0.0004, makerFeeRate: 0.0002 },
  MATICUSDT: { symbol: 'MATICUSDT', name: 'Polygon',   contractSize: 1, minQty: 1,     qtyStep: 1,     maxLeverage: 75,  takerFeeRate: 0.0004, makerFeeRate: 0.0002 },
};

// ── Position type ─────────────────────────────────────────────────────────────

export type BnFuturesPosition = {
  id:              string;
  symbol:          BnFuturesSymbol;
  direction:       'LONG' | 'SHORT';
  qty:             number;         // contracts (base asset units)
  leverage:        number;         // chosen leverage (1–125×)
  entryPrice:      number;         // USDT
  entryTime:       number;         // Unix ms
  stopLoss:        number;
  takeProfit:      number;
  isolatedMargin:  number;         // USDT locked as margin for this position
  liquidationPrice: number;        // price at which margin is exhausted
  notionalValue:   number;         // qty × entryPrice
  unrealisedPnL:   number;         // updated on monitor tick
  fundingAccrued:  number;         // total USDT paid/received as funding
  lastFundingAt:   number;         // last 8h funding tick
  signalSnapshot?: any;
};

export type BnFundingPayment = {
  positionId:  string;
  symbol:      BnFuturesSymbol;
  paidAt:      number;
  fundingRate: number;
  payment:     number;   // positive = paid by long, negative = received by long
  direction:   'LONG' | 'SHORT';
};

// ── Leverage tiers ────────────────────────────────────────────────────────────
// Binance uses a tiered leverage system — higher notional = lower max leverage.
// For paper trading purposes we use simplified tiers.

export const LEVERAGE_TIERS = [1, 2, 3, 5, 10, 20, 25, 50, 75, 100, 125] as const;

export function clampLeverage(leverage: number, symbol: BnFuturesSymbol): number {
  const max = BN_CONTRACT_SPECS[symbol].maxLeverage;
  const valid = LEVERAGE_TIERS.filter(t => t <= max);
  // Find the closest valid tier
  return valid.reduce((prev, curr) =>
    Math.abs(curr - leverage) < Math.abs(prev - leverage) ? curr : prev
  );
}

// ── Core maths ────────────────────────────────────────────────────────────────

/**
 * Isolated margin required to open a position.
 * margin = notionalValue / leverage
 * Binance adds an opening fee on top.
 */
export function computeIsolatedMargin(
  qty: number, entryPrice: number, leverage: number, feeRate: number,
): number {
  const notional    = qty * entryPrice;
  const margin      = notional / leverage;
  const openingFee  = notional * feeRate;
  return margin + openingFee;
}

/**
 * Liquidation price for isolated margin.
 *
 * For LONG:  liqPrice = entryPrice × (1 - 1/leverage + maintenanceMarginRate)
 * For SHORT: liqPrice = entryPrice × (1 + 1/leverage - maintenanceMarginRate)
 *
 * Maintenance margin rate on Binance is typically 0.5% for BTC/ETH at low
 * notional values. Simplified here as 0.5%.
 */
export function computeLiquidationPrice(
  direction:   'LONG' | 'SHORT',
  entryPrice:  number,
  leverage:    number,
  mmRate:      number = 0.005,
): number {
  if (direction === 'LONG') {
    return entryPrice * (1 - 1 / leverage + mmRate);
  }
  return entryPrice * (1 + 1 / leverage - mmRate);
}

/**
 * Unrealised P&L in USDT.
 */
export function computeBnPnL(
  direction:    'LONG' | 'SHORT',
  entryPrice:   number,
  currentPrice: number,
  qty:          number,
): number {
  const mult = direction === 'LONG' ? 1 : -1;
  return (currentPrice - entryPrice) * qty * mult;
}

/**
 * Return on equity (RoE) — P&L as % of isolated margin.
 */
export function computeRoE(pnl: number, isolatedMargin: number): number {
  if (isolatedMargin <= 0) return 0;
  return (pnl / isolatedMargin) * 100;
}

/**
 * Maximum qty for a given USDT budget at the chosen leverage.
 * Rounded down to the symbol's qty step.
 */
export function maxQtyFromBudget(
  budget:     number,
  entryPrice: number,
  leverage:   number,
  spec:       BnContractSpec,
): number {
  // budget = margin = notional / leverage  →  notional = budget * leverage
  const notional  = budget * leverage;
  const rawQty    = notional / entryPrice;
  const steps     = Math.floor(rawQty / spec.qtyStep);
  const qty       = steps * spec.qtyStep;
  return Math.max(0, qty);
}

/**
 * Risk-based qty sizing: how many contracts so a SL hit = riskPct% of account.
 */
export function riskBasedQty(
  entryPrice:  number,
  stopLoss:    number,
  accountSize: number,
  riskPct:     number,
  spec:        BnContractSpec,
): number {
  const riskAmount   = accountSize * (riskPct / 100);
  const riskPerUnit  = Math.abs(entryPrice - stopLoss);
  if (riskPerUnit <= 0) return 0;
  const rawQty = riskAmount / riskPerUnit;
  const steps  = Math.floor(rawQty / spec.qtyStep);
  return Math.max(0, steps * spec.qtyStep);
}

/**
 * Funding payment for a position held through one 8-hour period.
 * Positive fundingRate = longs pay shorts.
 * Negative fundingRate = shorts pay longs.
 */
export function computeFundingPayment(
  direction:   'LONG' | 'SHORT',
  qty:         number,
  markPrice:   number,
  fundingRate: number,
): number {
  const notional = qty * markPrice;
  const payment  = notional * fundingRate;
  // Positive payment for LONG = cost; for SHORT = received (negated)
  return direction === 'LONG' ? -payment : payment;
}

/**
 * Checks whether a position should be liquidated at the given price.
 */
export function isLiquidated(
  position: Pick<BnFuturesPosition, 'direction' | 'liquidationPrice'>,
  price:    number,
): boolean {
  if (position.direction === 'LONG')  return price <= position.liquidationPrice;
  return price >= position.liquidationPrice;
}
