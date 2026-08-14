// STATUS: DISCONNECTED — not currently imported by any screen.
// Wire into VerificationScreen.tsx or PaperAnalyticsScreen.tsx to surface
// prediction accuracy, false signal rates, and calibration curves.
//
// ─────────────────────────────────────────────────────────────────────────────
// VALIDATION ENGINE  (v5.6.0)
//
// Consumes existing PaperTradeRecord[] from paperTradeJournal.
// No model re-runs. No indicator recomputation. O(T) where T = trade count.
// ─────────────────────────────────────────────────────────────────────────────
import { getPaperTrades, PaperTradeRecord } from '../utils/paperTradeJournal';
import {
  ValidatedTrade, ValidationStats, ValidationSlice, CalibrationRow,
  FalseSignalSummary, ValidationReport, FalseSignalType, ConfidenceGrade,
} from './validationTypes';

// ── Timeframe string → milliseconds ──────────────────────────────────────────
const TF_MS: Record<string, number> = {
  '1m':300000/5,'5m':300000,'15m':900000,'30m':1800000,
  '1h':3600000,'4h':14400000,'1d':86400000,
};

function tfToMs(tf: string): number {
  return TF_MS[tf] ?? 3600000;
}

// ── UTC hour → trading session ────────────────────────────────────────────────
function sessionOf(unixMs: number): string {
  const h = new Date(unixMs).getUTCHours();
  if (h >= 22 || h < 2)  return 'Asia';        // Tokyo/Sydney
  if (h >= 7  && h < 10) return 'LondonOpen';  // London open (high activity)
  if (h >= 10 && h < 13) return 'LonNY Overlap'; // London-NY overlap
  if (h >= 13 && h < 17) return 'NewYork';
  if (h >= 2  && h < 7)  return 'Asia';
  return 'Off';
}

// ── Confidence → grade ────────────────────────────────────────────────────────
function gradeOf(conf: number): ConfidenceGrade {
  if (conf >= 0.80) return 'A+';
  if (conf >= 0.70) return 'A';
  if (conf >= 0.55) return 'B';
  if (conf >= 0.40) return 'C';
  return 'D';
}

// ── Feature value from topFeatures by name ────────────────────────────────────
function featVal(t: PaperTradeRecord, name: string): number {
  return t.topFeatures.find(f => f.name === name)?.value ?? 0;
}

// ── False signal classification ───────────────────────────────────────────────
function classifyFalseSignal(t: PaperTradeRecord): FalseSignalType | null {
  const mfePct = t.maxUnrealizedProfit / (t.entryPrice || 1) * 100;
  const maePct = t.maxDrawdownDuringTrade / (t.entryPrice || 1) * 100;
  const expectedMovePct = Math.abs(t.entryPrice - t.takeProfit) / (t.entryPrice || 1) * 100;

  // Early adverse move: immediate loss > MFE gain
  if (maePct > mfePct * 2 && t.pnl < 0) {
    return t.direction === 'LONG' ? 'FALSE_BUY' : 'FALSE_SELL';
  }
  // Late entry: very small MFE despite a winning entry
  if (mfePct < expectedMovePct * 0.3 && t.pnl < 0) {
    return 'LATE_ENTRY';
  }
  // Early exit: closed profitably but MFE was much larger than actual gain
  if (mfePct > t.pnlPct * 2 && t.pnlPct > 0) {
    return 'EARLY_EXIT';
  }
  return null;
}

// ── Enrich a PaperTradeRecord → ValidatedTrade ────────────────────────────────
function enrich(t: PaperTradeRecord): ValidatedTrade {
  const tfMs = tfToMs(t.timeframe);
  return {
    ...t,
    returnPct:  t.pnlPct,
    mfe:        (t.maxUnrealizedProfit / (t.entryPrice || 1)) * 100,
    mae:        (t.maxDrawdownDuringTrade / (t.entryPrice || 1)) * 100,
    holdingBars: Math.round(t.holdingMs / tfMs),
    isWin:      t.pnl > 0,
    falseSignal: classifyFalseSignal(t),
    regimeLabel: t.marketRegime || 'UNKNOWN',
    confidenceGrade: gradeOf(t.aiConfidence),
    sessionLabel: sessionOf(t.entryTime * 1000),
    mtfAligned:  Math.abs(featVal(t, 'MTF overall score')) > 0.2,
    hasBullOB:   featVal(t, 'SMC bull OB strength') > 0.2,
    hasFVG:      featVal(t, 'FVG bull strength') > 0.2 || featVal(t, 'FVG bear strength') > 0.2};
}

// ── Core statistics from a set of trades ─────────────────────────────────────
function computeStats(trades: ValidatedTrade[]): ValidationStats {
  const n = trades.length;
  if (n === 0) return {
    tradeCount:0,winCount:0,lossCount:0,winRate:0,profitFactor:0,
    expectancy:0,avgWin:0,avgLoss:0,avgMFE:0,avgMAE:0,avgHoldingBars:0,
    sharpeRatio:0,sortinoRatio:0,calmarRatio:0,maxDrawdownPct:0,totalReturnPct:0};

  const wins   = trades.filter(t => t.isWin);
  const losses = trades.filter(t => !t.isWin);
  const winRate     = wins.length / n;
  const grossWin    = wins.reduce((s, t) => s + t.pnlPct, 0);
  const grossLoss   = Math.abs(losses.reduce((s, t) => s + t.pnlPct, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
  const expectancy  = trades.reduce((s, t) => s + t.pnlPct, 0) / n;
  const avgWin      = wins.length   > 0 ? grossWin   / wins.length   : 0;
  const avgLoss     = losses.length > 0 ? grossLoss  / losses.length : 0;
  const avgMFE      = trades.reduce((s, t) => s + t.mfe, 0) / n;
  const avgMAE      = trades.reduce((s, t) => s + t.mae, 0) / n;
  const avgHoldingBars = trades.reduce((s, t) => s + t.holdingBars, 0) / n;

  // Equity curve for drawdown
  let peak = 0, equity = 0, maxDD = 0;
  for (const t of trades) {
    equity += t.pnlPct;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }
  const totalReturnPct = trades.reduce((s, t) => s + t.pnlPct, 0);

  // Sharpe: mean / std of per-trade returns (simplified, not annualized by bar)
  const mean = expectancy;
  const variance = trades.reduce((s, t) => s + (t.pnlPct - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance) || 1;
  const sharpeRatio = mean / std;

  // Sortino: downside deviation only
  const downsideVar = trades.reduce((s, t) => {
    const v = Math.min(0, t.pnlPct - mean); return s + v * v;
  }, 0) / n;
  const sortinoRatio = mean / (Math.sqrt(downsideVar) || 1);

  // Calmar: total return / max drawdown
  const calmarRatio = maxDD > 0 ? totalReturnPct / maxDD : totalReturnPct > 0 ? Infinity : 0;

  return {
    tradeCount: n, winCount: wins.length, lossCount: losses.length, winRate,
    profitFactor, expectancy, avgWin, avgLoss, avgMFE, avgMAE, avgHoldingBars,
    sharpeRatio, sortinoRatio, calmarRatio, maxDrawdownPct: maxDD, totalReturnPct};
}

// ── Group into slices ─────────────────────────────────────────────────────────
function groupBy(
  trades: ValidatedTrade[],
  keyFn: (t: ValidatedTrade) => string
): ValidationSlice[] {
  const groups = new Map<string, ValidatedTrade[]>();
  for (const t of trades) {
    const k = keyFn(t);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(t);
  }
  return Array.from(groups.entries())
    .map(([label, ts]) => ({ label, stats: computeStats(ts), trades: ts, sampleSize: ts.length }))
    .sort((a, b) => b.stats.expectancy - a.stats.expectancy);
}

// ── Calibration table ─────────────────────────────────────────────────────────
function buildCalibration(trades: ValidatedTrade[]): CalibrationRow[] {
  const BANDS = [
    [0.90,1.00,'90–100%'],[0.80,0.90,'80–90%'],[0.70,0.80,'70–80%'],
    [0.60,0.70,'60–70%'],[0.50,0.60,'50–60%'],[0.00,0.50,'<50%'],
  ] as [number,number,string][];
  return BANDS.map(([lo,hi,band]) => {
    const bucket = trades.filter(t => t.aiConfidence >= lo && t.aiConfidence < hi);
    const wins   = bucket.filter(t => t.isWin).length;
    const actualWinRate = bucket.length > 0 ? wins / bucket.length : 0;
    const mid = (lo + hi) / 2;
    return { band, nominalLow: lo, nominalHigh: hi, actualWinRate,
             sampleCount: bucket.length, calibrationError: Math.abs(mid - actualWinRate) };
  }).filter(r => r.sampleCount > 0);
}

// ── False signal summary ──────────────────────────────────────────────────────
function buildFalseSignals(trades: ValidatedTrade[]): FalseSignalSummary[] {
  const types: FalseSignalType[] = ['FALSE_BUY','FALSE_SELL','LATE_ENTRY','EARLY_EXIT'];
  return types.map(type => {
    const group = trades.filter(t => t.falseSignal === type);
    if (group.length === 0) return null;
    const regimeCounts: Record<string,number> = {};
    group.forEach(t => { regimeCounts[t.regimeLabel] = (regimeCounts[t.regimeLabel]??0)+1; });
    const commonRegime = Object.entries(regimeCounts).sort((a,b)=>b[1]-a[1])[0]?.[0] ?? 'UNKNOWN';
    return {
      type, count: group.length,
      pct: group.length / trades.length,
      avgLossPct: group.reduce((s,t)=>s+t.pnlPct,0)/group.length,
      commonRegime};
  }).filter(Boolean) as FalseSignalSummary[];
}

// ── Feature attribution ───────────────────────────────────────────────────────
function featureAttribution(trades: ValidatedTrade[], wins: boolean) {
  const counts: Record<string, { sum: number; n: number }> = {};
  const group = trades.filter(t => t.isWin === wins);
  for (const t of group) {
    for (const f of t.topFeatures) {
      if (!counts[f.name]) counts[f.name] = { sum: 0, n: 0 };
      counts[f.name].sum += f.influence;
      counts[f.name].n   += 1;
    }
  }
  return Object.entries(counts)
    .map(([name, { sum, n }]) => ({
      name,
      [wins ? 'avgInfluenceOnWins' : 'avgInfluenceOnLosses']: sum / n}))
    .sort((a, b) => {
      const key = wins ? 'avgInfluenceOnWins' : 'avgInfluenceOnLosses';
      return (b as any)[key] - (a as any)[key];
    })
    .slice(0, 10) as any[];
}

// ── Main: generate full validation report ────────────────────────────────────
export async function generateValidationReport(
  symbol?: string,
  timeframe?: string
): Promise<ValidationReport> {
  const allTrades = await getPaperTrades();
  const filtered  = allTrades.filter(t =>
    (!symbol    || t.symbol    === symbol) &&
    (!timeframe || t.timeframe === timeframe)
  );

  const trades = filtered.map(enrich);
  const n = trades.length;

  const dates = trades.map(t => t.entryTime);
  const dateRange = n > 0
    ? { from: Math.min(...dates), to: Math.max(...dates) }
    : { from: 0, to: 0 };

  const overall = computeStats(trades);

  const allSlices = [
    ...groupBy(trades, t => t.regimeLabel),
    ...groupBy(trades, t => t.confidenceGrade),
    ...groupBy(trades, t => t.mtfAligned ? 'MTF Aligned' : 'MTF Divergent'),
    ...groupBy(trades, t => t.hasBullOB   ? 'Has OB'    : 'No OB'),
    ...groupBy(trades, t => t.hasFVG      ? 'Has FVG'   : 'No FVG'),
    ...groupBy(trades, t => t.sessionLabel),
    ...groupBy(trades, t => t.timeframe),
  ];

  const sorted = [...allSlices].filter(s => s.sampleSize >= 3)
    .sort((a, b) => b.stats.expectancy - a.stats.expectancy);

  return {
    generatedAt:    Date.now(),
    symbol:         symbol ?? 'ALL',
    timeframe:      timeframe ?? 'ALL',
    totalTrades:    n,
    dateRange,
    overall,
    byRegime:       groupBy(trades, t => t.regimeLabel),
    byGrade:        groupBy(trades, t => t.confidenceGrade),
    byMTFAlignment: groupBy(trades, t => t.mtfAligned ? 'MTF Aligned' : 'MTF Divergent'),
    bySMC:          groupBy(trades, t => t.hasBullOB   ? 'Has OB'    : 'No OB'),
    byFVG:          groupBy(trades, t => t.hasFVG      ? 'Has FVG'   : 'No FVG'),
    bySession:      groupBy(trades, t => t.sessionLabel),
    byTimeframe:    groupBy(trades, t => t.timeframe),
    calibration:    buildCalibration(trades),
    falseSignals:   buildFalseSignals(trades),
    bestConditions: sorted.slice(0, 3),
    worstConditions:sorted.slice(-3).reverse(),
    highConfTrades: trades.filter(t => t.aiConfidence >= 0.75)
                         .sort((a,b) => b.pnlPct - a.pnlPct).slice(0,10),
    lowConfTrades:  trades.filter(t => t.aiConfidence < 0.45)
                         .sort((a,b) => a.pnlPct - b.pnlPct).slice(0,10),
    bestFeatures:   featureAttribution(trades, true),
    worstFeatures:  featureAttribution(trades, false)};
}
