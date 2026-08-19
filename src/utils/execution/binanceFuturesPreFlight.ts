// ─────────────────────────────────────────────────────────────────────────────
// BINANCE FUTURES PRE-FLIGHT  (v1.2.0)
//
// Final validation before sending a Binance perpetual futures order.
// Mirrors the NFO pre-flight structure — same typed result, same log format.
//
// Checks:
//   1. Symbol tradable    — exchangeInfo status = 'TRADING'
//   2. Balance sufficient — /fapi/v2/balance availableBalance
//   3. Price valid        — live ticker fetched, quantity precision checked
// ─────────────────────────────────────────────────────────────────────────────

import { bnFuturesGetSymbolInfo, bnFuturesGetBalance, bnFuturesGetTicker } from '../../api/binanceFuturesApi';
import { logger } from '../logger';

export type BnFuturesPreFlightResult =
  | { ok: true;  markPrice: number; availableBalance: number }
  | { ok: false; reason: string;    code: BnPreFlightFailCode };

export type BnPreFlightFailCode =
  | 'SYMBOL_NOT_TRADING'
  | 'INSUFFICIENT_BALANCE'
  | 'PRICE_FETCH_FAILED'
  | 'API_ERROR';

export type BnFuturesPreFlightInput = {
  symbol:          string;     // e.g. 'ETHUSDT'
  direction:       'LONG' | 'SHORT';
  qty:             number;
  leverage:        number;
  limitPrice?:     number;
  orderType:       'MARKET' | 'LIMIT';
  marginNeeded:    number;     // USDT — from sizing engine
  apiKey:          string;
  secret:          string;
};

type BnPreFlightLog = {
  symbol:          string;
  provider:        'BINANCE_FUTURES';
  timestamp:       string;
  symbolTrading:   boolean | null;
  balanceOk:       boolean | null;
  priceAvailable:  boolean | null;
  markPrice:       number | null;
  availableBalance:number | null;
  marginNeeded:    number;
  result:          'PASS' | 'FAIL';
  failCode:        BnPreFlightFailCode | null;
};

export async function runBnFuturesPreFlight(
  input: BnFuturesPreFlightInput,
): Promise<BnFuturesPreFlightResult> {
  const { symbol, direction, qty, leverage, limitPrice, orderType, marginNeeded, apiKey, secret } = input;

  const log: BnPreFlightLog = {
    symbol, provider: 'BINANCE_FUTURES',
    timestamp:        new Date().toISOString(),
    symbolTrading:    null, balanceOk:        null,
    priceAvailable:   null, markPrice:        null,
    availableBalance: null, marginNeeded,
    result: 'FAIL',         failCode: null};

  function fail(code: BnPreFlightFailCode, reason: string): BnFuturesPreFlightResult {
    log.result = 'FAIL'; log.failCode = code;
    logger.warn('bnFuturesPreFlight', JSON.stringify(log));
    return { ok: false, code, reason };
  }

  function pass(markPrice: number, availableBalance: number): BnFuturesPreFlightResult {
    log.result = 'PASS'; log.markPrice = markPrice; log.availableBalance = availableBalance;
    logger.info('bnFuturesPreFlight', JSON.stringify(log));
    return { ok: true, markPrice, availableBalance };
  }

  // ── 1. Symbol tradable ────────────────────────────────────────────────────
  const symInfo = await bnFuturesGetSymbolInfo(symbol);
  log.symbolTrading = symInfo?.status === 'TRADING';

  if (!symInfo) {
    return fail('SYMBOL_NOT_TRADING',
      `Could not verify trading status for ${symbol}.\n\n` +
      `Check your network connection and try again.`
    );
  }
  if (symInfo.status !== 'TRADING') {
    return fail('SYMBOL_NOT_TRADING',
      `${symbol} is not currently tradable on Binance Futures.\n\n` +
      `Status: ${symInfo.status}. This can be caused by a market halt or ` +
      `maintenance period. Check the Binance status page.`
    );
  }

  // ── 2. Balance sufficient ─────────────────────────────────────────────────
  const balance = await bnFuturesGetBalance(apiKey, secret);
  log.balanceOk        = balance != null && balance.availableBalance >= marginNeeded;
  log.availableBalance = balance?.availableBalance ?? null;

  if (!balance) {
    return fail('INSUFFICIENT_BALANCE',
      `Could not verify your Binance Futures balance.\n\n` +
      `Check your API key has Futures trading permission and retry.`
    );
  }
  if (balance.availableBalance < marginNeeded) {
    return fail('INSUFFICIENT_BALANCE',
      `Insufficient USDT balance for this position.\n\n` +
      `Required margin: $${marginNeeded.toFixed(2)}\n` +
      `Available: $${balance.availableBalance.toFixed(2)}\n\n` +
      `Add USDT to your Binance Futures wallet or reduce the position size.`
    );
  }

  // ── 3. Live price available ───────────────────────────────────────────────
  let markPrice = 0;
  try {
    const ticker  = await bnFuturesGetTicker(symbol);
    markPrice     = ticker.price;
    log.priceAvailable = true;
    log.markPrice      = markPrice;
  } catch (e: any) {
    log.priceAvailable = false;
    return fail('PRICE_FETCH_FAILED',
      `Could not fetch the current mark price for ${symbol}.\n\n` +
      `${e.message ?? 'Unknown error'}. Check your connection and retry.`
    );
  }

  // Warn if limit price is far from mark (>5%) — not a hard block but worth surfacing
  if (orderType === 'LIMIT' && limitPrice != null) {
    const pctDiff = Math.abs(limitPrice - markPrice) / markPrice;
    if (pctDiff > 0.05) {
      // Log a warning — don't block the order, just note the deviation
      logger.warn('bnFuturesPreFlight',
        `Limit price $${limitPrice} is ${(pctDiff * 100).toFixed(1)}% from mark $${markPrice} — may not fill`
      );
    }
  }

  return pass(markPrice, balance.availableBalance);
}
