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
  // FIX (Root cause — NFO "No Data"): Angel One scrip master uses the format
  // "NIFTY26JULFUT" — underlying + 2-digit year + 3-letter month + "FUT".
  // The lot size is NOT part of the symbol string. Previously this generated
  // "NIFTY26JUL75FUT" which never matched any scrip master entry, so
  // tokens[currentSym] was always undefined, aoToken always stayed '',
  // and every NFO chart showed "No Data".
  // The code's own comment on resolveFuturesTokensIntoAssets ("keyed by
  // 'NIFTY23NOVFUT'") correctly described the expected format — the
  // implementation was wrong, not the comment.
  const yy  = String(expiry.getFullYear()).slice(2);
  const mon = MONTH_ABBR[expiry.getMonth()];
  return `${underlying}${yy}${mon}FUT`;
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
      totalMarginPct:    marginPct};
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
  if (cached) {
    console.log(`[NFO Pipeline] Using cached scrip master tokens (${Object.keys(cached.tokens).length} entries)`);
    return cached.tokens;
  }

  // Timeout: scrip master is large (~10-15 MB). Without a timeout, a stalled
  // connection hangs forever and the chart shows "Loading..." indefinitely.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000); // 30s

  let r: Response;
  try {
    r = await fetch('https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json',
      { signal: controller.signal });
  } catch (e: any) {
    // Network error or abort (timeout) — throw so DataContext sets nftTokenError
    const reason = e?.name === 'AbortError' ? 'Scrip master request timed out (30s)' : (e?.message ?? 'Network error');
    throw new Error(`NFO token fetch failed: ${reason}`);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!r.ok) throw new Error(`NFO token fetch failed: scrip master HTTP ${r.status}`);

  console.log('[NFO Pipeline] Parsing scrip master JSON...');
  const raw: any[] = await r.json();
  console.log(`[NFO Pipeline] Parsed ${raw.length} total entries. Filtering for NFO futures...`);

  const underlyingSet = new Set(underlyings);
  const tokens: Record<string, string> = {};

  // Diagnostic: sample what the name/symbol fields look like for NFO entries
  const nfoSample = raw.filter(e => e.exch_seg === 'NFO').slice(0, 5);
  console.log(`[NFO Pipeline] NFO sample entries (first 5): ${JSON.stringify(nfoSample.map(e => ({name:e.name,symbol:e.symbol,instrumenttype:e.instrumenttype})))}`);

  // DIAGNOSTIC: show ALL FUTSTK entries' name field — this reveals what AO actually
  // uses as the underlying identifier for stock futures (may not be the NSE ticker).
  const futStkSample = raw.filter(e => e.exch_seg === 'NFO' && e.instrumenttype === 'FUTSTK').slice(0, 10);
  console.log(`[NFO Pipeline] FUTSTK sample (first 10 names): ${JSON.stringify(futStkSample.map(e => e.name))}`);
  const futIdxSample = raw.filter(e => e.exch_seg === 'NFO' && e.instrumenttype === 'FUTIDX').slice(0, 5);
  console.log(`[NFO Pipeline] FUTIDX sample (first 5 names): ${JSON.stringify(futIdxSample.map(e => e.name))}`);
  // Also log every unique instrumenttype in NFO segment to catch unexpected values
  const nfoTypes = [...new Set(raw.filter(e => e.exch_seg === 'NFO').map((e:any) => e.instrumenttype))];
  console.log(`[NFO Pipeline] All NFO instrumenttypes: ${JSON.stringify(nfoTypes)}`);
  console.log(`[NFO Pipeline] Looking for underlyings: ${[...underlyingSet].join(', ')}`);

  for (const entry of raw) {
    if (entry.exch_seg !== 'NFO') continue;
    if (entry.instrumenttype !== 'FUTSTK' && entry.instrumenttype !== 'FUTIDX') continue;
    if (!entry.symbol || !entry.token) continue;

    // PRIMARY: match by entry.name (normalised — strip suffixes like "-EQ", "-BF").
    // Angel One uses entry.name = underlying ticker for most futures (e.g. "NIFTY", "TCS").
    const normalizedName = (entry.name as string).replace(/-[A-Z0-9]+$/, '').toUpperCase();
    const matchedByName = underlyingSet.has(normalizedName as FuturesUnderlying);

    // FALLBACK: match by symbol prefix. entry.symbol is always
    // "<UNDERLYING><YY><MON>FUT" (e.g. "TCS26JULFUT") — extract the underlying
    // by stripping the date/FUT suffix. Catches cases where entry.name is a
    // display name (e.g. "Tata Consultancy Services") rather than the NSE ticker.
    const symMatch = (entry.symbol as string).match(/^([A-Z]+)\d{2}[A-Z]{3}FUT$/);
    const symUnderlying = symMatch ? symMatch[1] : null;
    const matchedBySymbol = symUnderlying ? underlyingSet.has(symUnderlying as FuturesUnderlying) : false;

    if (!matchedByName && !matchedBySymbol) continue;

    if (!matchedByName && matchedBySymbol) {
      // Log once per underlying so we know AO uses display name not ticker in entry.name
      console.log(`[NFO Pipeline] Symbol-prefix fallback: matched ${entry.symbol} (entry.name="${entry.name}" ≠ ticker)`);
    }

    tokens[entry.symbol] = entry.token;
  }

  const tokenCount = Object.keys(tokens).length;
  console.log(
    `[NFO Pipeline] Scrip master fetched` +
    ` | total NFO futures entries=${tokenCount}` +
    ` | sample=${Object.keys(tokens).slice(0, 5).join(', ')}`
  );

  // Only cache if we actually found tokens — prevent caching an empty dict
  // which would lock out retries for 4 hours.
  if (tokenCount > 0) {
    await saveCachedTokens(tokens);
  } else {
    console.warn(`[NFO Pipeline] No tokens found for underlyings: ${[...underlyingSet].join(', ')} — NOT caching empty result`);
  }

  return tokens;
}

/**
 * Resolves and patches aoToken for all ao_futures assets in ASSETS.
 * Called once from DataContext when Angel One session becomes active.
 * Uses the same scrip master cache as getContractsWithTokens.
 * Mutates asset.aoToken in place so all consumers (DataContext LTP poll,
 * useChartData, multiSourceFetch, etc.) see the resolved token automatically.
 */
export async function resolveFuturesTokensIntoAssets(assets: import('../../api/assets').Asset[]): Promise<void> {
  const futuresAssets = assets.filter(a => a.src === 'ao_futures' && a.underlying);
  if (!futuresAssets.length) return;

  const underlyings = [...new Set(futuresAssets.map(a => a.underlying as FuturesUnderlying))];

  // fetchNFOTokens now throws on network/timeout failure — let it propagate
  // so DataContext sets nftTokenError and the UI shows an actionable message.
  const tokens = await fetchNFOTokens(underlyings);

  if (Object.keys(tokens).length === 0) {
    throw new Error('Scrip master returned no NFO futures entries — check your Angel One connection and try re-logging in.');
  }

  // tokens is keyed by full symbol like 'NIFTY23NOVFUT'.
  // Each futures asset needs the CURRENT month front contract token.
  const now = new Date();
  let resolved = 0;
  for (const asset of futuresAssets) {
    try {
      const contracts = buildStaticContracts(asset.underlying as FuturesUnderlying, now);
      const currentSym = contracts.current.symbol;
      let token = tokens[currentSym] ?? '';

      // FALLBACK LOOKUP: if exact key miss, search tokens{} for the current-month
      // contract by underlying prefix. Handles AO symbol format differences
      // (e.g. AO stores "TCS26JUL26FUT" but we generate "TCS26JULFUT").
      // Pick the entry whose symbol starts with the underlying and contains the
      // current month+year — disambiguates from next/far month contracts.
      if (!token && Object.keys(tokens).length > 0) {
        const underlying = asset.underlying as string;
        const currentExpiry = contracts.current.expiry;
        const expiryDate = new Date(currentExpiry);
        const yy  = String(expiryDate.getFullYear()).slice(2);
        const MONTH_ABBR = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
        const mon = MONTH_ABBR[expiryDate.getMonth()];
        // Find any key matching <underlying><anything><yy><mon><anything>FUT
        const fallbackKey = Object.keys(tokens).find(k =>
          k.startsWith(underlying) &&
          k.includes(yy) &&
          k.toUpperCase().includes(mon) &&
          k.endsWith('FUT')
        );
        if (fallbackKey) {
          token = tokens[fallbackKey];
          console.log(`[NFO Pipeline] Fallback lookup: ${underlying} → matched key "${fallbackKey}" (generated "${currentSym}" not found) — AO uses different symbol format`);
        }
      }

      // ── Pipeline verification log ──────────────────────────────────────────
      console.log(
        `[NFO Pipeline] underlying=${asset.underlying}` +
        ` | generated symbol=${currentSym}` +
        ` | token=${token || '(not found in scrip master)'}` +
        ` | exchange=NFO` +
        ` | scrip master keys sample=${Object.keys(tokens).slice(0,3).join(', ')}` +
        ` | total NFO tokens fetched=${Object.keys(tokens).length}`
      );

      if (token) {
        asset.aoToken = token;
        resolved++;
      }
    } catch (e: any) {
      console.warn(`[NFO Pipeline] Failed to resolve ${asset.underlying}:`, e?.message);
    }
  }

  console.log(`[NFO Pipeline] Resolved ${resolved}/${futuresAssets.length} futures assets`);

  if (resolved === 0) {
    throw new Error(
      `Symbol format mismatch — no futures tokens matched in scrip master.\n` +
      `Expected format: e.g. "TCS26JULFUT". ` +
      `Check adb logcat for [NFO Pipeline] logs to see actual scrip master symbol format.`
    );
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
