// ─────────────────────────────────────────────────────────────────────────────
// FUTURES MARGIN CALCULATOR  (v1.0.0)
//
// Computes required margin and determines maximum affordable lot count
// given available capital and risk settings.
//
// Two methods:
//   1. Estimated (offline) — uses static MARGIN_PCT from futuresTypes.ts.
//      Instant, no network. ±5% accuracy. Sufficient for UI display.
//
//   2. Live (Angel One API) — calls the actual margin calculator endpoint.
//      Exact. Requires session. Used before confirming a live futures order.
// ─────────────────────────────────────────────────────────────────────────────

import { FuturesUnderlying, LOT_SIZES, MARGIN_PCT, estimateMargin } from './futuresTypes';
import type { AOSession } from '../../api/angelOne';

export type MarginBreakdown = {
  lotSize:             number;
  lots:                number;
  qty:                 number;
  notionalValue:       number;
  spanMargin:          number;
  exposureMargin:      number;
  totalMargin:         number;
  marginPct:           number;
  estimatedBrokerage:  number;
  totalRequired:       number;
  source:              'estimated' | 'live';
};

// ── Estimated margin (offline) ────────────────────────────────────────────────

export function estimateMarginBreakdown(
  underlying: FuturesUnderlying,
  entryPrice: number,
  lots: number,
): MarginBreakdown {
  const lotSize     = LOT_SIZES[underlying];
  const qty         = lots * lotSize;
  const notional    = entryPrice * qty;
  const marginPct   = MARGIN_PCT[underlying] / 100;
  const total       = notional * marginPct;
  const span        = total * 0.73;
  const exposure    = total * 0.27;
  const brokerage   = Math.min(20, notional * 0.0003) + notional * 0.0002;   // flat + STT + charges

  return {
    lotSize, lots, qty, notionalValue: notional,
    spanMargin: span, exposureMargin: exposure, totalMargin: total,
    marginPct: marginPct * 100, estimatedBrokerage: brokerage,
    totalRequired: total + brokerage,
    source: 'estimated'};
}

// ── Live margin (Angel One API) ────────────────────────────────────────────────
// Endpoint: POST https://apiconnect.angelbroking.com/rest/secure/angelbroking/margin/v1/getMargin

export async function getLiveMargin(
  params: {
    symbol:    string;    // NFO symbol e.g. "NIFTY26JULFUT"
    token:     string;    // instrument token
    lots:      number;
    lotSize:   number;
    price:     number;
    direction: 'LONG' | 'SHORT';
  },
  session: AOSession,
): Promise<MarginBreakdown> {
  const underlying = params.symbol.replace(/\d{2}[A-Z]{3}.*/, '') as FuturesUnderlying;
  const qty        = params.lots * params.lotSize;

  try {
    const r = await fetch(
      'https://apiconnect.angelbroking.com/rest/secure/angelbroking/margin/v1/getMargin',
      {
        method:  'POST',
        headers: {
          'Content-Type':     'application/json',
          Accept:             'application/json',
          'X-UserType':       'USER',
          'X-SourceID':       'WEB',
          'X-ClientLocalIP':  '192.168.1.1',
          'X-ClientPublicIP': '1.1.1.1',
          'X-MACAddress':     'fe80::1',
          'X-PrivateKey':     session.apiKey,
          Authorization:      `Bearer ${session.jwtToken}`},
        body: JSON.stringify({
          positions: [{
            exchange:        'NFO',
            qty:             String(qty),
            price:           String(params.price),
            productType:     'CARRYFORWARD',
            token:           params.token,
            tradeType:       params.direction === 'LONG' ? 'BUY' : 'SELL'}]})}
    );

    if (!r.ok) throw new Error(`Margin API HTTP ${r.status}`);
    const json = await r.json();
    if (!json.status || !json.data) throw new Error(json.message ?? 'Margin API failed');

    const data      = json.data;
    const span      = Number(data.span ?? 0);
    const exposure  = Number(data.exposure ?? 0);
    const total     = Number(data.totalMarginRequired ?? span + exposure);
    const brokerage = Number(data.charges ?? qty * params.price * 0.0002);

    return {
      lotSize: params.lotSize, lots: params.lots, qty,
      notionalValue:      qty * params.price,
      spanMargin:         span,
      exposureMargin:     exposure,
      totalMargin:        total,
      marginPct:          (total / (qty * params.price)) * 100,
      estimatedBrokerage: brokerage,
      totalRequired:      total + brokerage,
      source:             'live'};
  } catch {
    // Fall back to estimated if live call fails
    return estimateMarginBreakdown(underlying, params.price, params.lots);
  }
}

// ── Max lots from available capital ──────────────────────────────────────────

export function maxAffordableLots(
  underlying: FuturesUnderlying,
  entryPrice: number,
  availableCapital: number,
  reservePct: number = 20,   // keep this % of capital in reserve
): number {
  const usableCapital = availableCapital * (1 - reservePct / 100);
  const marginPerLot  = estimateMargin(underlying, entryPrice, 1);
  if (marginPerLot <= 0) return 0;
  return Math.floor(usableCapital / marginPerLot);
}

// ── Risk-based lot sizing ─────────────────────────────────────────────────────
// Compute lots so that a 1-lot SL hit equals riskPct% of capital

export function riskBasedLots(
  entryPrice:  number,
  stopLoss:    number,
  lotSize:     number,
  accountSize: number,
  riskPct:     number,
): number {
  const riskAmount   = accountSize * (riskPct / 100);
  const riskPerUnit  = Math.abs(entryPrice - stopLoss);
  if (riskPerUnit <= 0) return 0;
  const riskPerLot   = riskPerUnit * lotSize;
  return Math.max(1, Math.floor(riskAmount / riskPerLot));
}
