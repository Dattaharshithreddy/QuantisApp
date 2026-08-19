import AsyncStorage from '@react-native-async-storage/async-storage';
import { KVStore } from '../services/storage';
import { logger } from './logger';
import { PaperPosition, getPortfolio } from './paperPortfolio';

// DUPLICATE kept for backward compat with records stored before v1.0.2.
// New code uses DUPLICATE_POSITION (more descriptive) and POSITION_SIZING.
export type GateType =
  | 'CONFIDENCE'        // AI signal quality gate — low confidence / grade D/F
  | 'REGIME'            // Market regime mismatch — e.g. bearish trend vs bullish signal
  | 'PORTFOLIO_RISK'    // Portfolio-level risk engine BLOCK decision
  | 'DUPLICATE'         // Legacy alias — kept so old stored records still display correctly
  | 'DUPLICATE_POSITION'// Already have an open position for this exact symbol
  | 'POSITION_SIZING'   // calcPositionSize returned qty=0 — risk budget too small for ATR stop distance
  | 'CASH'              // Insufficient cash balance to fund the position
  | 'FILTER'            // Strategy profile gate — signal type not allowed by active strategy
  | 'OTHER';            // Catch-all for unexpected engine rejections
export type ShadowOutcome = 'OPEN' | 'TP_HIT' | 'SL_HIT' | 'EXPIRED';

export type ShadowTrade = {
  id: string; symbol: string; timeframe: string; direction: 'LONG' | 'SHORT';
  entryPrice: number; stopLoss: number; takeProfit: number;
  blockedAt: number; blockReason: string; blockGate: GateType;
  outcome: ShadowOutcome; exitPrice?: number; closedAt?: number; pnlPct?: number;
  ticksElapsed: number;
  // Rich signal snapshot — never parse blockReason string for analytics
  signal: {
    action: string; confidence: number; ensembleProbUp: number;
    regime: string; signalType?: string;
  };
  gateDetails?: Record<string, string | number>;
  rr?: number;
  signalId?: string;    // links to the MLPrediction that was blocked
  // Immutable market context at the moment this signal was blocked.
  // Optional for backward compatibility with existing stored shadows.
  marketContext?: import('./marketContextSnapshot').MarketContextSnapshot | null;
};

const KEY = 'shadowTrades_v1';
const MAX_SHADOWS = 500;
const MAX_TICKS = 1800; // ~30 candles × 60 ticks each

export async function loadShadowTrades(): Promise<ShadowTrade[]> {
  try { const r = await KVStore.get(KEY); return r ? JSON.parse(r) : []; }
  catch (e: any) { logger.warn('shadow', e?.message); return []; }
}

export async function saveShadowTrades(trades: ShadowTrade[]): Promise<void> {
  try {
    const open = trades.filter(t => t.outcome === 'OPEN');
    const closed = trades.filter(t => t.outcome !== 'OPEN')
      .sort((a,b) => (b.closedAt??0)-(a.closedAt??0)).slice(0, MAX_SHADOWS);
    await KVStore.set(KEY, JSON.stringify([...open, ...closed]));
  } catch (e: any) { logger.warn('shadow', e?.message); }
}

// Fallback only — prefer passing blockGate directly to recordShadowTrade.
export function classifyGate(reason: string): GateType {
  const r = reason.toLowerCase();
  if (r.includes('position sizing') || r.includes('zero units') || r.includes('risk setting') && r.includes('stop-loss distance')) return 'POSITION_SIZING';
  if (r.includes('already have an open position') || r.includes('duplicate position')) return 'DUPLICATE_POSITION';
  if (r.includes('confidence') && !r.includes('regime')) return 'CONFIDENCE';
  if (r.includes('regime') || r.includes('signal blocked') || r.includes('trend signal') || r.includes('mean_reversion')) return 'REGIME';
  if (r.includes('portfolio risk') || r.includes('risk limit') || r.includes('risk would reach')) return 'PORTFOLIO_RISK';
  if (r.includes('already have') || r.includes('duplicate')) return 'DUPLICATE';
  if (r.includes('insufficient cash') || r.includes('cash balance')) return 'CASH';
  if (r.includes('skipped because') || r.includes('filter')) return 'FILTER';
  return 'OTHER';
}

export async function recordShadowTrade(params: {
  symbol: string; timeframe: string; direction: 'LONG' | 'SHORT';
  entryPrice: number; stopLoss: number; takeProfit: number; blockReason: string;
  blockGate: GateType;  // structured — not parsed from string
  signal: { action: string; confidence: number; ensembleProbUp: number; regime: string; signalType?: string };
  gateDetails?: Record<string, string | number>;
  signalId?: string;
  marketContext?: import('./marketContextSnapshot').MarketContextSnapshot | null;
}): Promise<void> {
  try {
    const trades = await loadShadowTrades();

    // ── Deduplication ─────────────────────────────────────────────────────
    // The scanner re-evaluates every symbol each cycle (~5 min). A blocked
    // signal is usually STILL blocked next cycle, so without this guard the
    // same opportunity is recorded once per cycle — inflating the journal
    // and double-counting in Gate Analytics.
    // Rule 1: same signalId already recorded (open or closed) → skip.
    //         Precise dedup when the caller links the exact MLPrediction.
    // Rule 2: an OPEN shadow already exists for the same
    //         symbol+timeframe+direction → skip. That counterfactual is
    //         already being tracked; it resolves via TP/SL/expiry, after
    //         which a NEW block legitimately creates a fresh shadow.
    const dup = trades.find(t =>
      (params.signalId != null && t.signalId === params.signalId) ||
      (t.outcome === 'OPEN' &&
       t.symbol === params.symbol &&
       t.timeframe === params.timeframe &&
       t.direction === params.direction)
    );
    if (dup) {
      logger.info('shadow', `Skip duplicate shadow: ${params.symbol} ${params.direction} ` +
        `(existing ${dup.outcome} id=${dup.id}${params.signalId && dup.signalId === params.signalId ? ', same signalId' : ''})`);
      return;
    }

    // ── Rule 3: cross-journal idempotency ──────────────────────────────────
    // A real open position may already have consumed this signalId — meaning
    // the signal was NOT blocked, it was executed. Recording a shadow for it
    // would be factually wrong and inflates Gate Analytics counts.
    //
    // This fires when a race condition bypasses the UI guard:
    //   - Background automation / scanner calling attemptOpenPosition directly
    //   - Two fast taps where the second reaches a gate before the first
    //     position write to AsyncStorage completes
    //   - Future callers (tests, batch replay) that have no UI layer at all
    //
    // The UI isSubmitting guard handles the common path; this guard makes
    // the ENGINE independently correct regardless of caller.
    if (params.signalId) {
      const portfolio = await getPortfolio();
      const consumedByRealPosition = portfolio.openPositions.some(
        (p: PaperPosition) => p.signalId === params.signalId
      );
      if (consumedByRealPosition) {
        logger.info('shadow', `Skip shadow: signalId ${params.signalId} already has a real open position`);
        return;
      }
    }

    const rr = params.stopLoss > 0 && params.entryPrice !== params.stopLoss
      ? Math.abs(params.takeProfit - params.entryPrice) / Math.abs(params.entryPrice - params.stopLoss) : undefined;
    trades.push({
      id: `sh_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
      symbol: params.symbol, timeframe: params.timeframe, direction: params.direction,
      entryPrice: params.entryPrice, stopLoss: params.stopLoss, takeProfit: params.takeProfit,
      blockedAt: Date.now(), blockReason: params.blockReason,
      blockGate: params.blockGate,  // typed directly — no string parsing
      outcome: 'OPEN', ticksElapsed: 0,
      signal: params.signal, gateDetails: params.gateDetails, rr, signalId: params.signalId,
      marketContext: params.marketContext ?? null});
    await saveShadowTrades(trades);
    logger.info('shadow', `Recorded shadow: ${params.symbol} ${params.direction} gate=${classifyGate(params.blockReason)}`);
  } catch (e: any) { logger.warn('shadow', e?.message); }
}

// One-time cleanup for journals polluted before the dedup guard existed
// (pre-v6.3.36). Keeps the OLDEST open shadow per symbol+timeframe+direction
// (it has the most tick history) and the first record per signalId; removes
// the rest. Safe to run repeatedly — idempotent. Returns removed count.
export async function dedupExistingShadowTrades(): Promise<number> {
  try {
    const trades = await loadShadowTrades();
    const seenOpen = new Set<string>();
    const seenSignal = new Set<string>();
    const keep: ShadowTrade[] = [];
    // oldest-first so the earliest record of each duplicate group survives
    for (const t of [...trades].sort((a, b) => a.blockedAt - b.blockedAt)) {
      if (t.signalId && seenSignal.has(t.signalId)) continue;
      if (t.outcome === 'OPEN') {
        const k = `${t.symbol}|${t.timeframe}|${t.direction}`;
        if (seenOpen.has(k)) continue;
        seenOpen.add(k);
      }
      if (t.signalId) seenSignal.add(t.signalId);
      keep.push(t);
    }
    const removed = trades.length - keep.length;
    if (removed > 0) {
      await saveShadowTrades(keep);
      logger.info('shadow', `Dedup cleanup removed ${removed} duplicate shadow trade(s)`);
    }
    return removed;
  } catch (e: any) { logger.warn('shadow', e?.message); return 0; }
}

export async function clearAllShadowTrades(): Promise<void> {
  await saveShadowTrades([]);
}

export async function monitorShadowTrades(livePrices: Record<string, number>): Promise<void> {
  try {
    const trades = await loadShadowTrades();
    let changed = false;
    for (const t of trades) {
      if (t.outcome !== 'OPEN') continue;
      const price = livePrices[t.symbol];
      if (!price || !Number.isFinite(price)) continue;
      t.ticksElapsed = (t.ticksElapsed ?? 0) + 1;
      const tpHit  = t.direction === 'LONG' ? price >= t.takeProfit : price <= t.takeProfit;
      const slHit  = t.direction === 'LONG' ? price <= t.stopLoss   : price >= t.stopLoss;
      const expired = t.ticksElapsed >= MAX_TICKS;
      if (tpHit || slHit || expired) {
        t.outcome = tpHit ? 'TP_HIT' : slHit ? 'SL_HIT' : 'EXPIRED';
        t.exitPrice = price; t.closedAt = Date.now();
        const raw = t.direction === 'LONG' ? (price - t.entryPrice)/t.entryPrice : (t.entryPrice - price)/t.entryPrice;
        t.pnlPct = parseFloat((raw * 100).toFixed(3));
        changed = true;
        logger.info('shadow', `${t.symbol} → ${t.outcome} P&L=${t.pnlPct}%`);
      }
    }
    if (changed) await saveShadowTrades(trades);
  } catch (e: any) { logger.warn('shadow', e?.message); }
}

export type GateStats = {
  gate: GateType; blocked: number; tpHit: number; slHit: number;
  expired: number; stillOpen: number; winRate: number;
  profitFactor: number; avgPnlPct: number; netExpectedPnl: number;
};

export function computeGateAnalytics(trades: ShadowTrade[]): GateStats[] {
  const gates: GateType[] = ['CONFIDENCE','REGIME','PORTFOLIO_RISK','POSITION_SIZING','DUPLICATE_POSITION','DUPLICATE','CASH','FILTER','OTHER'];
  return gates.map(gate => {
    const g = trades.filter(t => t.blockGate === gate);
    const closed = g.filter(t => t.outcome !== 'OPEN' && t.pnlPct != null);
    const tpHit = g.filter(t => t.outcome === 'TP_HIT').length;
    const slHit = g.filter(t => t.outcome === 'SL_HIT').length;
    const wins   = closed.filter(t => (t.pnlPct??0) > 0);
    const losses = closed.filter(t => (t.pnlPct??0) <= 0);
    const gw = wins.reduce((s,t) => s+(t.pnlPct??0), 0);
    const gl = Math.abs(losses.reduce((s,t) => s+(t.pnlPct??0), 0));
    const wr = (tpHit+slHit) > 0 ? tpHit/(tpHit+slHit)*100 : 0;
    const pf = gl > 0 ? gw/gl : gw > 0 ? Infinity : 0;
    const avg = closed.length > 0 ? closed.reduce((s,t) => s+(t.pnlPct??0),0)/closed.length : 0;
    return {
      gate, blocked: g.length, tpHit, slHit, expired: g.filter(t=>t.outcome==='EXPIRED').length,
      stillOpen: g.filter(t=>t.outcome==='OPEN').length,
      winRate: +wr.toFixed(1), profitFactor: +pf.toFixed(2),
      avgPnlPct: +avg.toFixed(2), netExpectedPnl: +(avg*closed.length).toFixed(2)};
  }).filter(g => g.blocked > 0);
}
