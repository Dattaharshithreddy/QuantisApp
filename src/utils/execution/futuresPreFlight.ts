// ─────────────────────────────────────────────────────────────────────────────
// FUTURES PRE-FLIGHT  (v1.1.1)
//
// Final validation checks run immediately before sending a futures order to
// Angel One, after the user has tapped "Confirm" on the confirmation screen.
//
// Checks (in order):
//   1. Market open       — NFO hours Mon–Fri 09:15–15:30 IST
//   2. Contract active   — expiry not in the past
//   3. Quote available   — live price fetched successfully
//   4. Instrument tradable — volume/depth heuristic detects halts/suspensions
//   5. Circuit limits    — price and limit price within exchange bands
//   6. Margin sufficient — re-fetched from AO RMS at confirm time (TOCTOU guard)
//
// All checks emit a single structured log for diagnostics.
// Each failure returns a typed code + user-readable reason with no internal jargon.
// ─────────────────────────────────────────────────────────────────────────────

import { aoGetRMS, aoLTP, AORMSData }  from '../../api/angelOne';
import { getLastThursday }             from '../futures/futuresTypes';
import type { AOSession }              from '../../api/angelOne';
import { logger }                      from '../logger';

// ── Market hours ──────────────────────────────────────────────────────────────
// NSE NFO: Monday–Friday 09:15–15:30 IST = 03:45–10:00 UTC

const NFO_OPEN_UTC_MINS  = 3 * 60 + 45;   // 03:45 UTC
const NFO_CLOSE_UTC_MINS = 10 * 60 + 0;   // 10:00 UTC

function isNFOMarketOpen(now: Date = new Date()): boolean {
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  return mins >= NFO_OPEN_UTC_MINS && mins < NFO_CLOSE_UTC_MINS;
}

function currentISTTime(now: Date): string {
  const utcMins  = now.getUTCHours() * 60 + now.getUTCMinutes();
  const istMins  = utcMins + 5 * 60 + 30;
  const h        = Math.floor(istMins / 60) % 24;
  const m        = istMins % 60;
  const period   = h < 12 ? 'AM' : 'PM';
  const h12      = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period} IST`;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type PreFlightResult =
  | { ok: true;  ltp: number; availableMargin: number }
  | { ok: false; reason: string; code: PreFlightFailCode };

export type PreFlightFailCode =
  | 'MARKET_CLOSED'
  | 'CONTRACT_EXPIRED'
  | 'INSUFFICIENT_MARGIN'
  | 'PRICE_AT_CIRCUIT'
  | 'TRADING_SUSPENDED'
  | 'SESSION_INVALID'
  | 'QUOTE_UNAVAILABLE';

export type PreFlightInput = {
  symbol:       string;
  symbolToken:  string;
  direction:    'LONG' | 'SHORT';
  limitPrice?:  number;
  orderType:    'MARKET' | 'LIMIT';
  expiry:       number;         // Unix ms — FuturesContract.expiry
  marginNeeded: number;         // ₹ — from futuresRiskEngine.marginRequired
  aoSession:    AOSession;
};

// Structured log written before every order — makes support/debugging deterministic
type PreFlightLog = {
  symbol:           string;
  provider:         'ANGEL_ONE_FUTURES';
  timestamp:        string;
  marketOpen:       boolean | null;
  contractValid:    boolean | null;
  quoteAvailable:   boolean | null;
  instrumentTradable: boolean | null;
  withinCircuit:    boolean | null;
  marginOk:         boolean | null;
  ltp:              number | null;
  availableMargin:  number | null;
  marginNeeded:     number;
  result:           'PASS' | 'FAIL';
  failCode:         PreFlightFailCode | null;
};

// ── Main validation ───────────────────────────────────────────────────────────

export async function runFuturesPreFlight(input: PreFlightInput): Promise<PreFlightResult> {
  const { symbol, symbolToken, direction, limitPrice, orderType, expiry, marginNeeded, aoSession } = input;
  const now = new Date();

  const log: PreFlightLog = {
    symbol, provider: 'ANGEL_ONE_FUTURES',
    timestamp:          now.toISOString(),
    marketOpen:         null, contractValid:    null,
    quoteAvailable:     null, instrumentTradable: null,
    withinCircuit:      null, marginOk:         null,
    ltp: null,           availableMargin: null,
    marginNeeded,        result: 'FAIL', failCode: null,
  };

  function fail(code: PreFlightFailCode, reason: string): PreFlightResult {
    log.result   = 'FAIL';
    log.failCode = code;
    logger.warn('preFlight', JSON.stringify(log));
    return { ok: false, code, reason };
  }

  function pass(ltp: number, availableMargin: number): PreFlightResult {
    log.result = 'PASS'; log.ltp = ltp; log.availableMargin = availableMargin;
    logger.info('preFlight', JSON.stringify(log));
    return { ok: true, ltp, availableMargin };
  }

  // ── 1. Market open ────────────────────────────────────────────────────────
  log.marketOpen = isNFOMarketOpen(now);
  if (!log.marketOpen) {
    return fail('MARKET_CLOSED',
      `NFO market is closed.\n\n` +
      `Current time: ${currentISTTime(now)}\n` +
      `Trading hours: Monday–Friday, 09:15 AM – 3:30 PM IST`
    );
  }

  // ── 2. Contract not expired ───────────────────────────────────────────────
  log.contractValid = now.getTime() < expiry;
  if (!log.contractValid) {
    return fail('CONTRACT_EXPIRED',
      `The ${symbol} contract has expired.\n\n` +
      `Return to the chart, run a new prediction, and the app will ` +
      `automatically select the new front-month contract.`
    );
  }

  // ── 3 + 4 + 5: Quote, tradability, circuits ───────────────────────────────
  let ltp = 0;
  let upperCircuit: number | undefined;
  let lowerCircuit: number | undefined;
  let totBuyQty  = 0;
  let totSellQty = 0;
  let volume     = 0;

  try {
    const quotes = await aoLTP([{ symbol, token: symbolToken, ex: 'NFO' }], aoSession);
    const q = quotes[symbol];
    if (!q) {
      log.quoteAvailable = false;
      return fail('QUOTE_UNAVAILABLE',
        `Could not fetch the current price for ${symbol}.\n\n` +
        `This can happen if the instrument token is stale or the market data feed ` +
        `is temporarily unavailable. Please try again in a few seconds.`
      );
    }
    log.quoteAvailable = true;
    ltp          = q.price;
    upperCircuit = q.upperCircuit;
    lowerCircuit = q.lowerCircuit;
    totBuyQty    = q.totBuyQty  ?? 0;
    totSellQty   = q.totSellQty ?? 0;
    volume       = q.volume;
    log.ltp      = ltp;
  } catch (e: any) {
    log.quoteAvailable = false;
    return fail('QUOTE_UNAVAILABLE',
      `Market data unavailable: ${e.message ?? 'unknown error'}.\n\nCheck your connection and retry.`
    );
  }

  // ── 4. Instrument tradable ────────────────────────────────────────────────
  // Heuristic: within market hours, if volume=0 AND both bid+ask qty=0,
  // the instrument is very likely halted or suspended by NSE/SEBI/broker.
  // This catches: circuit breaker freeze, SEBI suspension, broker risk block.
  // False positives: first few seconds of market open (acceptable — order would
  // be queued anyway). False negatives: suspension with some residual quotes
  // (unlikely for NFO during trading hours).
  const likelySuspended = volume === 0 && totBuyQty === 0 && totSellQty === 0;
  log.instrumentTradable = !likelySuspended;
  if (likelySuspended) {
    return fail('TRADING_SUSPENDED',
      `${symbol} appears to be suspended or halted right now.\n\n` +
      `No trading volume and no bid/ask orders were found. This can happen due to:\n` +
      `• NSE circuit breaker (market-wide or instrument-specific)\n` +
      `• SEBI-ordered trading suspension\n` +
      `• Broker risk restriction\n\n` +
      `Please check NSE website or Angel One app for the current status.`
    );
  }

  // ── 5. Circuit limits ─────────────────────────────────────────────────────
  log.withinCircuit = true;
  if (direction === 'LONG' && upperCircuit && ltp >= upperCircuit * 0.999) {
    log.withinCircuit = false;
    return fail('PRICE_AT_CIRCUIT',
      `${symbol} has hit the upper circuit limit (₹${upperCircuit.toFixed(2)}).\n\n` +
      `No sellers are available at this price. Wait for the circuit to reopen.`
    );
  }
  if (direction === 'SHORT' && lowerCircuit && ltp <= lowerCircuit * 1.001) {
    log.withinCircuit = false;
    return fail('PRICE_AT_CIRCUIT',
      `${symbol} has hit the lower circuit limit (₹${lowerCircuit.toFixed(2)}).\n\n` +
      `No buyers are available at this price. Wait for the circuit to reopen.`
    );
  }
  if (orderType === 'LIMIT' && limitPrice != null) {
    if (upperCircuit && limitPrice > upperCircuit) {
      log.withinCircuit = false;
      return fail('PRICE_AT_CIRCUIT',
        `Limit price ₹${limitPrice.toFixed(2)} exceeds upper circuit ₹${upperCircuit.toFixed(2)}.\n\n` +
        `Angel One will reject orders outside circuit limits. Lower your limit price.`
      );
    }
    if (lowerCircuit && limitPrice < lowerCircuit) {
      log.withinCircuit = false;
      return fail('PRICE_AT_CIRCUIT',
        `Limit price ₹${limitPrice.toFixed(2)} is below lower circuit ₹${lowerCircuit.toFixed(2)}.\n\n` +
        `Angel One will reject orders outside circuit limits. Raise your limit price.`
      );
    }
  }

  // ── 6. Margin re-confirmed (TOCTOU guard) ─────────────────────────────────
  let availableMargin = 0;
  let rms: AORMSData | null = null;

  try {
    rms = await aoGetRMS(aoSession);
  } catch {
    return fail('INSUFFICIENT_MARGIN',
      `Could not verify available margin before placing the order.\n\n` +
      `Angel One RMS is temporarily unavailable. Please try again in a few seconds.`
    );
  }

  if (!rms) {
    return fail('SESSION_INVALID',
      `Your Angel One session may have expired.\n\n` +
      `Please reconnect in Settings → Angel One and try again.`
    );
  }

  availableMargin      = rms.availablecash + rms.collateral;
  log.availableMargin  = availableMargin;
  const BUFFER         = 0.80;
  log.marginOk         = availableMargin * BUFFER >= marginNeeded;

  if (!log.marginOk) {
    return fail('INSUFFICIENT_MARGIN',
      `Insufficient margin at order placement time.\n\n` +
      `Required: ≈ ₹${marginNeeded.toFixed(0)}\n` +
      `Available now: ₹${(availableMargin * BUFFER).toFixed(0)} ` +
      `(80% of ₹${availableMargin.toFixed(0)} RMS balance)\n\n` +
      `Another position may have consumed margin since you confirmed. ` +
      `Close a position or add funds, then retry.`
    );
  }

  return pass(ltp, availableMargin);
}
