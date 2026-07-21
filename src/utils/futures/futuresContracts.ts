// ─────────────────────────────────────────────────────────────────────────────
// FUTURES CONTRACTS  (v1.1.1)
//
// Resolves the current/next/far month contracts for a given underlying.
// Two modes:
//   1. Static (offline)  — derives symbol string from underlying + expiry date.
//      Works without network. Used for paper trading.
//   2. Live scrip lookup — queries Angel One scrip master for the exact token.
//      Required for live orders. Cached in AsyncStorage with rollover-aware
//      invalidation.
//
// ROLLOVER SAFETY:
//   The token cache is invalidated on expiry day (last Thursday of month)
//   after 15:30 IST so rolled contracts are always fetched fresh.
//   getActiveContract() always recomputes the current month from today's date,
//   validates the token is non-empty, and retries once with a cache bust if not.
// ─────────────────────────────────────────────────────────────────────────────

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  FuturesUnderlying, FuturesContract, ContractMonth,
  LOT_SIZES, MARGIN_PCT,
  getCurrentExpiryDates, formatExpiryLabel, getLastThursday,
} from './futuresTypes';

const CACHE_KEY    = 'futuresContracts_v2';    // v2 — v1 had no rollover invalidation
const CACHE_TTL_MS = 4 * 60 * 60 * 1000;      // 4 hours base TTL

const MONTH_ABBR = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

// ── Rollover detection ────────────────────────────────────────────────────────

function isCacheStale(fetchedAt: number): boolean {
  const now = Date.now();
  if (now - fetchedAt > CACHE_TTL_MS) return true;

  // Bust cache on expiry day after 15:30 IST if cache was fetched before rollover
  const today        = new Date();
  const expiry       = getLastThursday(today.getFullYear(), today.getMonth());
  const rolloverMs   = expiry.getTime();  // getLastThursday sets time to 15:30 IST
  const isExpiryDay  = today.toDateString() === expiry.toDateString();

  if (isExpiryDay && now >= rolloverMs && fetchedAt < rolloverMs) return true;

  return false;
}

// ── Symbol derivation (offline) ───────────────────────────────────────────────

function buildNFOSymbol(underlying: FuturesUnderlying, expiry: Date): string {
  const yy  = String(expiry.getFullYear()).slice(2);
  const mon = MONTH_ABBR[expiry.getMonth()];
  const lot = LOT_SIZES[underlying];
  return `${underlying}${yy}${mon}${lot}FUT`;
}

// ── Static contract builder (no network) ─────────────────────────────────────

export function buildStaticContracts(
  underlying: FuturesUnderlying,
  now: Date = new Date(),
): Record<ContractMonth, FuturesContract> {
  const expiries = getCurrentExpiryDates(now);
  const months: ContractMonth[] = ['current', 'next', 'far'];
  const result = {} as Record<ContractMonth, FuturesContract>;

  for (const month of months) {
    const expiry    = expiries[month];
    const symbol    = buildNFOSymbol(underlying, expiry);
    const marginPct = MARGIN_PCT[underlying];

    result[month] = {
      underlying,
      symbol,
      aoToken:           '',
      exchange:          'NFO',
      lotSize:           LOT_SIZES[underlying],
      expiry:            expiry.getTime(),
      expiryLabel:       formatExpiryLabel(expiry),
      month,
      spanMarginPct:     marginPct * 0.73,
      exposureMarginPct: marginPct * 0.27,
      totalMarginPct:    marginPct,
    };
  }

  return result;
}

// ── Scrip master token lookup ─────────────────────────────────────────────────

type CachedTokens = { fetchedAt: number; tokens: Record<string, string> };

async function getCachedTokens(): Promise<CachedTokens | null> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const cached: CachedTokens = JSON.parse(raw);
    if (isCacheStale(cached.fetchedAt)) return null;
    return cached;
  } catch { return null; }
}

async function saveCachedTokens(tokens: Record<string, string>): Promise<void> {
  try {
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), tokens }));
  } catch {}
}

export async function fetchNFOTokens(
  underlyings: FuturesUnderlying[],
): Promise<Record<string, string>> {
  const cached = await getCachedTokens();
  if (cached) return cached.tokens;

  try {
    const r = await fetch('https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json');
    if (!r.ok) throw new Error(`Scrip master HTTP ${r.status}`);
    const raw: any[] = await r.json();

    const underlyingSet = new Set(underlyings);
    const tokens: Record<string, string> = {};

    for (const entry of raw) {
      if (entry.exch_seg !== 'NFO') continue;
      if (entry.instrumenttype !== 'FUTSTK' && entry.instrumenttype !== 'FUTIDX') continue;
      if (!underlyingSet.has(entry.name as FuturesUnderlying)) continue;
      if (!entry.symbol || !entry.token) continue;
      tokens[entry.symbol] = entry.token;
    }

    await saveCachedTokens(tokens);
    return tokens;
  } catch {
    return {};
  }
}

export async function getContractsWithTokens(
  underlying: FuturesUnderlying,
  now: Date = new Date(),
): Promise<Record<ContractMonth, FuturesContract>> {
  const contracts = buildStaticContracts(underlying, now);
  const tokens    = await fetchNFOTokens([underlying]);

  for (const month of ['current', 'next', 'far'] as ContractMonth[]) {
    const sym = contracts[month].symbol;
    if (tokens[sym]) contracts[month].aoToken = tokens[sym];
  }

  return contracts;
}

/**
 * Returns the active front-month contract for live order placement.
 *
 * Always recomputes the active contract from today's date (not cached).
 * Validates token is non-empty. On failure, busts cache and retries once.
 * Throws a clear, user-readable error if token cannot be resolved — the
 * UI surfaces this instead of sending a bad order to the broker.
 */
export async function getActiveContract(
  underlying: FuturesUnderlying,
): Promise<FuturesContract> {
  const now       = new Date();
  const contracts = await getContractsWithTokens(underlying, now);
  const contract  = contracts.current;

  if (!contract.aoToken) {
    // Token missing — could be network failure or rollover race.
    // Bust cache and retry once before failing.
    await clearContractCache();
    const fresh   = await getContractsWithTokens(underlying, now);
    const retried = fresh.current;

    if (!retried.aoToken) {
      throw new Error(
        `Could not resolve the instrument token for ${retried.symbol}.\n\n` +
        `This can happen:\n` +
        `• Around contract rollover (last Thursday after 3:30 PM)\n` +
        `• When the device has no network connection\n\n` +
        `Please check your connection and try again. If today is expiry day, ` +
        `wait a few minutes for the new contract to appear in the scrip master.`
      );
    }
    return retried;
  }

  return contract;
}

export async function clearContractCache(): Promise<void> {
  await AsyncStorage.removeItem(CACHE_KEY).catch(() => {});
}
