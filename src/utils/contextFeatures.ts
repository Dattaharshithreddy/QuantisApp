// ─────────────────────────────────────────────────────────────────────────────
// CONTEXT FEATURES  v1.0.0
// Module 1 of the Market Intelligence upgrade.
//
// Extracts numeric features from:
//   a) MarketContextSnapshot — crypto (Fear&Greed, dominance, funding, OI,
//      stablecoin) and Indian (VIX, breadth, FII/DII, PCR) context
//   b) Economic calendar — event proximity (days to next CRITICAL/HIGH event,
//      FOMC week flag, RBI MPC week flag, expiry week flag)
//
// DESIGN INVARIANTS:
//   • Pure functions — no async, no side effects, no React imports
//   • Safe fallback — missing context → all zeros, never throws
//   • Asset-class aware — crypto features only for CRYPTO assets,
//     Indian features only for AO/AO_FUTURES assets
//   • All outputs normalised to [-1, 1] or [0, 1]
//   • Feature count is FIXED per asset class (checked by assertion in mlSignal)
//   • CRYPTO_CONTEXT_FEATURE_COUNT + CALENDAR_FEATURE_COUNT = total appended
//
// FEATURE ACCOUNTING:
//   Crypto context features:   8  (indices 116–123 when appended after 116 base)
//   Indian context features:   8  (same slots, different fields — never both)
//   Calendar features:         5  (indices 124–128 for all assets)
//   ─────────────────────────────
//   Total new features:       13  → 116 + 13 = 129
//
// EPISODIC CONTEXT (for Memory Engine, Module 2):
//   extractEpisodicContext() returns a plain object snapshot used by the
//   episode store. It does NOT affect feature vectors — it's a separate
//   human-readable record of macro state at signal time.
// ─────────────────────────────────────────────────────────────────────────────

import type { MarketContextSnapshot } from './marketContextSnapshot';
import { getMarketEvents }             from './marketIntelligenceCalendar';

// ── Feature counts (exported for FEATURE_NAMES construction) ─────────────────

export const CONTEXT_ASSET_FEATURE_COUNT    = 8;  // crypto OR indian (same slot count)
export const CONTEXT_CALENDAR_FEATURE_COUNT = 5;
export const CONTEXT_TOTAL_FEATURE_COUNT    = CONTEXT_ASSET_FEATURE_COUNT + CONTEXT_CALENDAR_FEATURE_COUNT; // 13

// ── Feature names (appended to FEATURE_NAMES in mlSignal.ts) ─────────────────

export const CRYPTO_CONTEXT_FEATURE_NAMES = [
  'Ctx: Fear&Greed norm',        // 0–1  (0=extreme fear, 1=extreme greed)
  'Ctx: Fear&Greed direction',   // -1=falling, 0=stable, 1=rising
  'Ctx: BTC dominance',          // 0–1
  'Ctx: BTC dominance delta',    // -1–1  (24h change, clamped)
  'Ctx: Market 24h pct',         // -1–1  (total market cap % change)
  'Ctx: Funding rate norm',      // -1–1  (clamped at ±0.05%)
  'Ctx: Stablecoin dom',         // 0–1
  'Ctx: OI conviction',          // -1=bearish, 0=weak/neutral, 1=bullish
] as const;

export const INDIAN_CONTEXT_FEATURE_NAMES = [
  'Ctx: India VIX norm',         // 0–1  (0=low, 1=extreme, clamped at 40)
  'Ctx: VIX direction',          // -1=falling, 0=flat, 1=rising
  'Ctx: Breadth AD ratio',       // 0–1
  'Ctx: Breadth thrust',         // 0 or 1
  'Ctx: FII net flow norm',      // -1–1  (net flow / rolling max, clamped)
  'Ctx: FII consec days',        // -1–1  (consec buy/sell days, clamped at ±10)
  'Ctx: PCR norm',               // -1–1  (centred on 1.0, bullish=positive)
  'Ctx: PCR direction',          // -1=falling, 0=flat, 1=rising
] as const;

export const CALENDAR_FEATURE_NAMES = [
  'Ctx: Days to critical event', // 0–1  (0=today, 1=≥14 days away)
  'Ctx: Days to high event',     // 0–1
  'Ctx: Is FOMC week',           // 0 or 1
  'Ctx: Is RBI MPC week',        // 0 or 1
  'Ctx: Is expiry week',         // 0 or 1
] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Clamp x to [min, max] */
function clamp(x: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, x));
}

/** Normalise x from [fromMin, fromMax] → [toMin, toMax]. Safe on degenerate range. */
function norm(x: number, fromMin: number, fromMax: number, toMin = 0, toMax = 1): number {
  const range = fromMax - fromMin;
  if (range === 0) return (toMin + toMax) / 2;
  return toMin + (clamp(x, fromMin, fromMax) - fromMin) / range * (toMax - toMin);
}

/** Encode a trend string to [-1, 0, 1] */
function trendEnc(trend: string | undefined): number {
  if (!trend) return 0;
  const t = trend.toUpperCase();
  if (t === 'RISING')  return 1;
  if (t === 'FALLING') return -1;
  return 0;
}

// ── Crypto context features ───────────────────────────────────────────────────

function cryptoContextFeatures(snap: MarketContextSnapshot): number[] {
  if (snap.kind !== 'CRYPTO') return new Array(CONTEXT_ASSET_FEATURE_COUNT).fill(0);
  const c = snap.ctx;

  // Fear & Greed: 0–100 → 0–1
  const fg        = c.fearGreed?.value       ?? 50;
  const fgNorm    = norm(fg, 0, 100);
  const fgDir     = trendEnc(c.fearGreed?.trend);

  // BTC dominance: 0–100 → 0–1
  const btcDom    = norm(c.marketCap?.btcDominance ?? 50, 0, 100);
  // 24h dominance change: clamp ±5pp → -1..1
  const btcDomDelta = norm(c.marketCap?.btcDominanceChange24h ?? 0, -5, 5, -1, 1);

  // Total market 24h pct: clamp ±20% → -1..1
  const mkt24h    = norm(c.marketCap?.totalChange24h ?? 0, -20, 20, -1, 1);

  // Funding rate: clamp ±0.05% → -1..1 (positive funding = longs paying = bearish pressure)
  const fr        = c.funding?.fundingRate ?? 0;
  const frNorm    = norm(fr, -0.0005, 0.0005, -1, 1);

  // Stablecoin dominance: 0–100 → 0–1
  const stableDom = norm(c.stablecoin?.totalStableDom ?? 10, 0, 30);

  // Open Interest conviction: BULLISH=1, BEARISH=-1, others=0
  const oiConv    = c.openInterest?.conviction === 'BULLISH' ? 1
                  : c.openInterest?.conviction === 'BEARISH' ? -1 : 0;

  return [fgNorm, fgDir, btcDom, btcDomDelta, mkt24h, frNorm, stableDom, oiConv];
}

// ── Indian context features ───────────────────────────────────────────────────

function indianContextFeatures(snap: MarketContextSnapshot): number[] {
  if (snap.kind !== 'INDIAN') return new Array(CONTEXT_ASSET_FEATURE_COUNT).fill(0);
  const c = snap.ctx;

  // India VIX: 0–40 → 0–1 (anything above 40 = maxed out)
  const vixNorm   = norm(c.vix?.current ?? 15, 0, 40);
  const vixDir    = trendEnc(c.vix?.trend);

  // Market breadth: adRatio already 0–1
  const adRatio   = clamp(c.breadth?.adRatio ?? 0.5, 0, 1);
  const thrust    = c.breadth?.breadthThrust ? 1 : 0;

  // FII net flow: normalise against rolling 5-day average as a scale reference
  // Use fiiRolling5 to normalise fiiNetCash — gives relative strength
  const fiiNet    = c.fiidii?.fiiNetCash    ?? 0;
  const fiiRoll   = Math.abs(c.fiidii?.fiiRolling5 ?? 1000);
  const scale     = fiiRoll > 100 ? fiiRoll * 3 : 3000; // fallback scale: ±3000 crores
  const fiiNorm   = norm(fiiNet, -scale, scale, -1, 1);

  // Consecutive buy/sell days: clamp ±10 → -1..1
  const fiiConsec = norm(c.fiidii?.fiiConsecBuys ?? 0, -10, 10, -1, 1);

  // PCR: centre on 1.0 (neutral), typical range 0.5–1.8
  // PCR > 1.3 = contrarian bull (encode as positive), < 0.7 = contrarian bear (negative)
  const pcr       = c.pcr?.current ?? 1.0;
  const pcrNorm   = norm(pcr, 0.5, 1.8, -1, 1); // high PCR = positive = contrarian long
  const pcrDir    = trendEnc(c.pcr?.trend);

  return [vixNorm, vixDir, adRatio, thrust, fiiNorm, fiiConsec, pcrNorm, pcrDir];
}

// ── Calendar / event proximity features ──────────────────────────────────────

function calendarFeatures(assetClass: string): number[] {
  try {
    const events = getMarketEvents();
    const now    = Date.now();
    const MS_PER_DAY = 86_400_000;

    // Days to next CRITICAL event
    const criticals = events.filter(e => e.impact === 'CRITICAL' && e.date.getTime() > now);
    const daysToCrit = criticals.length > 0
      ? (criticals[0].date.getTime() - now) / MS_PER_DAY
      : 14; // no event found → treat as "far away"

    // Days to next HIGH or CRITICAL event
    const highs = events.filter(e => (e.impact === 'CRITICAL' || e.impact === 'HIGH') && e.date.getTime() > now);
    const daysToHigh = highs.length > 0
      ? (highs[0].date.getTime() - now) / MS_PER_DAY
      : 14;

    // Normalise days: 0 days = 1.0, 14+ days = 0.0
    const critNorm  = 1 - norm(daysToCrit, 0, 14);
    const highNorm  = 1 - norm(daysToHigh, 0, 14);

    // FOMC week: any FOMC event within 0–7 days
    const isFOMCWeek = events.some(e =>
      e.category === 'FOMC' &&
      e.date.getTime() > now &&
      e.date.getTime() - now < 7 * MS_PER_DAY
    ) ? 1 : 0;

    // RBI MPC week: any RBI_MPC event within 0–7 days
    const isRBIWeek = events.some(e =>
      e.category === 'RBI_MPC' &&
      e.date.getTime() > now &&
      e.date.getTime() - now < 7 * MS_PER_DAY
    ) ? 1 : 0;

    // Expiry week: NSE weekly/monthly expiry — Thursday of each week is expiry
    // If today is Mon–Thu and Thursday is within 4 days, it's expiry week
    const dayOfWeek = new Date().getDay(); // 0=Sun, 4=Thu
    const daysToThursday = (4 - dayOfWeek + 7) % 7;
    const isExpiryWeek = (daysToThursday <= 3) ? 1 : 0; // Mon-Thu = expiry week

    return [critNorm, highNorm, isFOMCWeek, isRBIWeek, isExpiryWeek];
  } catch {
    return new Array(CONTEXT_CALENDAR_FEATURE_COUNT).fill(0);
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Extract all context features from a market context snapshot.
 * Returns exactly CONTEXT_TOTAL_FEATURE_COUNT (13) values.
 * Safe: never throws, returns zeros on missing/invalid input.
 *
 * @param snap       MarketContextSnapshot fetched by usePrediction
 * @param assetClass 'CRYPTO' | 'AO' | 'AO_FUTURES' | 'AV' | 'UNKNOWN'
 */
export function extractContextFeatures(
  snap: MarketContextSnapshot | null | undefined,
  assetClass: string,
): number[] {
  // Asset-class specific features (8 values)
  let assetFeatures: number[];
  if (!snap || snap.kind === 'NONE') {
    assetFeatures = new Array(CONTEXT_ASSET_FEATURE_COUNT).fill(0);
  } else if (snap.kind === 'CRYPTO') {
    assetFeatures = cryptoContextFeatures(snap);
  } else if (snap.kind === 'INDIAN') {
    assetFeatures = indianContextFeatures(snap);
  } else {
    assetFeatures = new Array(CONTEXT_ASSET_FEATURE_COUNT).fill(0);
  }

  // Calendar features (5 values) — always computed for all assets
  const calFeatures = calendarFeatures(assetClass);

  const result = [...assetFeatures, ...calFeatures];

  // Runtime assertion — if this throws, there's a programming error here
  if (result.length !== CONTEXT_TOTAL_FEATURE_COUNT) {
    throw new Error(
      `extractContextFeatures: expected ${CONTEXT_TOTAL_FEATURE_COUNT} features, got ${result.length}. ` +
      `Asset features: ${assetFeatures.length}, Calendar: ${calFeatures.length}.`
    );
  }

  return result;
}

/**
 * Feature names for the context features, in the same order as extractContextFeatures().
 * Asset-class agnostic — caller selects the correct asset variant for display,
 * but feature POSITIONS are identical regardless of asset class.
 */
export function getContextFeatureNames(snap: MarketContextSnapshot | null | undefined): readonly string[] {
  const assetNames = (!snap || snap.kind === 'NONE')
    ? CRYPTO_CONTEXT_FEATURE_NAMES   // default to crypto names for unknown
    : snap.kind === 'CRYPTO'
    ? CRYPTO_CONTEXT_FEATURE_NAMES
    : INDIAN_CONTEXT_FEATURE_NAMES;

  return [...assetNames, ...CALENDAR_FEATURE_NAMES];
}

// ── Episodic context snapshot (for Memory Engine) ─────────────────────────────
// A human-readable snapshot of macro state at signal time.
// Stored alongside each episode in the Memory Engine's episode database.
// Not part of the feature vector — separate record for explainability.

export type EpisodicContext = {
  assetKind:       'CRYPTO' | 'INDIAN' | 'NONE';
  // Crypto
  fearGreed?:      number | null;
  fearGreedLabel?: string | null;
  fundingRate?:    number | null;
  fundingSentiment?: string | null;
  btcDominance?:   number | null;
  marketRegime?:   string | null;
  // Indian
  vixValue?:       number | null;
  vixRegime?:      string | null;
  fiiBias?:        string | null;
  fiiConsecDays?:  number | null;
  pcr?:            number | null;
  pcrSentiment?:   string | null;
  // Calendar (all assets)
  daysToCritical:  number;
  daysToHigh:      number;
  isFOMCWeek:      boolean;
  isRBIWeek:       boolean;
  isExpiryWeek:    boolean;
  capturedAt:      number;
};

export function extractEpisodicContext(
  snap: MarketContextSnapshot | null | undefined,
): EpisodicContext {
  const MS_PER_DAY = 86_400_000;
  const now = Date.now();

  // Calendar
  let daysToCritical = 14, daysToHigh = 14;
  let isFOMCWeek = false, isRBIWeek = false;
  try {
    const events = getMarketEvents();
    const crit = events.filter(e => e.impact === 'CRITICAL' && e.date.getTime() > now);
    const high = events.filter(e => (e.impact === 'CRITICAL' || e.impact === 'HIGH') && e.date.getTime() > now);
    if (crit.length) daysToCritical = (crit[0].date.getTime() - now) / MS_PER_DAY;
    if (high.length) daysToHigh     = (high[0].date.getTime() - now) / MS_PER_DAY;
    isFOMCWeek = events.some(e => e.category === 'FOMC' && e.date.getTime() > now && e.date.getTime() - now < 7 * MS_PER_DAY);
    isRBIWeek  = events.some(e => e.category === 'RBI_MPC' && e.date.getTime() > now && e.date.getTime() - now < 7 * MS_PER_DAY);
  } catch { /* graceful */ }

  const dayOfWeek = new Date().getDay();
  const daysToThursday = (4 - dayOfWeek + 7) % 7;
  const isExpiryWeek = daysToThursday <= 3;

  const base = { daysToCritical, daysToHigh, isFOMCWeek, isRBIWeek, isExpiryWeek, capturedAt: now };

  if (!snap || snap.kind === 'NONE') return { assetKind: 'NONE', ...base };

  if (snap.kind === 'CRYPTO') {
    const c = snap.ctx;
    return {
      assetKind:       'CRYPTO',
      fearGreed:       c.fearGreed?.value          ?? null,
      fearGreedLabel:  c.fearGreed?.classification ?? null,
      fundingRate:     c.funding?.fundingRate       ?? null,
      fundingSentiment: c.funding?.sentiment        ?? null,
      btcDominance:    c.marketCap?.btcDominance   ?? null,
      marketRegime:    c.marketCap?.regime          ?? null,
      ...base,
    };
  }

  if (snap.kind === 'INDIAN') {
    const c = snap.ctx;
    return {
      assetKind:    'INDIAN',
      vixValue:     c.vix?.current     ?? null,
      vixRegime:    c.vix?.regime      ?? null,
      fiiBias:      c.fiidii?.bias     ?? null,
      fiiConsecDays: c.fiidii?.fiiConsecBuys ?? null,
      pcr:          c.pcr?.current     ?? null,
      pcrSentiment: c.pcr?.sentiment   ?? null,
      ...base,
    };
  }

  return { assetKind: 'NONE', ...base };
}
