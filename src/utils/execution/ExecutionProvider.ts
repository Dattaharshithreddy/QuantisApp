// ─────────────────────────────────────────────────────────────────────────────
// EXECUTION PROVIDER INTERFACE  (v1.1.0)
//
// Every broker/asset-type combination is an ExecutionProvider.
// liveOrderExecution.ts routes to the correct provider based on assetSrc.
//
// Current providers:
//   AngelOneEquityExecutor  — AO NSE/BSE equity (INTRADAY)
//   AngelOneFuturesExecutor — AO NFO futures (CARRYFORWARD, lots)
//   BinanceSpotExecutor     — Binance spot USDT pairs
//
// Adding a new provider (e.g. BinanceFuturesExecutor, ZerodhaEquityExecutor):
//   1. Implement ExecutionProvider
//   2. Add the assetSrc key to EXECUTOR_MAP in liveOrderExecution.ts
//   3. Add the provider ID to PROVIDER_ID in useLiveTrading.ts
//   Done — no other files need to change.
// ─────────────────────────────────────────────────────────────────────────────

import type { AOSession } from '../../api/angelOne';

// ── Shared order request — same shape for all providers ──────────────────────

export type ExecutionOrderRequest = {
  // Identifies which executor handles this order
  assetSrc:      string;             // 'ao' | 'binance' | 'ao_futures' | ...

  // Core order fields
  symbol:        string;             // trading symbol as expected by the broker
  direction:     'LONG' | 'SHORT';
  qty:           number;             // units for equity/spot; lots*lotSize for futures
  orderType:     'MARKET' | 'LIMIT';
  limitPrice?:   number;

  // Risk levels — tracked only, not placed as bracket orders
  stopLoss?:     number;
  takeProfit?:   number;

  // Angel One specific — required for AO orders
  symbolToken?:  string;             // AO instrument token
  exchange?:     string;             // 'NSE' | 'BSE' | 'NFO'
  productType?:  'INTRADAY' | 'CARRYFORWARD' | 'DELIVERY' | 'MARGIN';

  // Futures specific
  lots?:         number;             // number of lots (futures only)
  lotSize?:      number;             // units per lot (futures only)
  underlying?:   string;             // NIFTY, BANKNIFTY etc. (futures only)
  expiry?:       number;             // Unix ms (futures only)
  expiryLabel?:  string;             // 'JUL 2026' (futures only)

  // Idempotency key — provider passes this to broker as client order ID
  clientOrderId: string;
};

// ── Fill returned by every executor ──────────────────────────────────────────

export type ExecutionFill = {
  orderId:       string;
  broker:        'ANGEL_ONE' | 'ANGEL_ONE_FUTURES' | 'BINANCE';
  symbol:        string;
  direction:     'LONG' | 'SHORT';
  filledQty:     number;
  filledPrice:   number;
  filledAt:      number;
  fees:          number;

  // Futures-specific fill fields — undefined for equity/spot
  lots?:         number;
  lotSize?:      number;
  marginBlocked?: number;
  underlying?:   string;
  expiry?:       number;
  expiryLabel?:  string;
};

// ── Context passed to every executor — broker credentials and sessions ────────

export type ExecutionContext = {
  aoSession?:     AOSession | null;
  binanceApiKey?: string;
  binanceSecret?: string;
};

// ── The contract every executor must implement ────────────────────────────────

export type OrderTypeCapability = 'MARKET' | 'LIMIT' | 'STOPLOSS_LIMIT' | 'STOPLOSS_MARKET';

/**
 * Structured capability descriptor for each ExecutionProvider.
 *
 * Nested rather than flat so new providers (Zerodha, Bybit, OKX, Upstox)
 * can be described without adding top-level boolean fields each time.
 * The UI queries these instead of scattering assetSrc checks everywhere.
 */
export type ExecutionCapabilities = {
  execution: {
    live:              boolean;   // supports real order placement
    paper:             boolean;   // has paper trading simulator
  };
  orders: {
    market:            boolean;
    limit:             boolean;
    stopLoss:          boolean;   // STOPLOSS_LIMIT or STOPLOSS_MARKET
    bracket:           boolean;   // bracket/OCO orders
  };
  position: {
    overnight:         boolean;   // can carry position past market close
    lotBased:          boolean;   // sizing is in lots (futures), not units (equity/spot)
    partialClose:      boolean;   // can close part of a position
    maxLotsPerOrder:   number;    // 0 = no cap; >0 = enforced cap
  };
  risk: {
    marginRequired:    boolean;   // requires margin (vs full notional for spot)
    leverage:          boolean;   // position size > deployed cash
    preFlight:         boolean;   // executor runs pre-flight checks before order
  };
  display: {
    currency:          string;    // '₹' | '$' | '€' etc.
    exchangeLabel:     string;    // shown in UI e.g. "NSE", "NFO Futures", "Binance Spot"
    priceDecimals:     number;    // decimal places for price display
    qtyLabel:          string;    // "shares" | "lots" | "units" | "contracts"
  };
};

export interface ExecutionProvider {
  readonly capabilities: ExecutionCapabilities;

  /**
   * Place a live order. Throws on any failure — caller handles the error.
   * clientOrderId is the idempotency key; broker rejects duplicate submissions.
   */
  execute(req: ExecutionOrderRequest, ctx: ExecutionContext): Promise<ExecutionFill>;

  cancel(orderId: string, symbol: string, ctx: ExecutionContext): Promise<void>;

  cancelAll(symbol: string, ctx: ExecutionContext): Promise<{ cancelled: number; errors: string[] }>;
}
