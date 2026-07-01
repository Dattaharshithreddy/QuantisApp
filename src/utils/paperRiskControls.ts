import AsyncStorage from '@react-native-async-storage/async-storage';
import { getRiskSettings, getTodayPnL, isDailyLossLimitHit, RiskSettings } from './riskManager';
import { PaperPortfolioState, PaperPosition } from './paperPortfolio';

// Extends the EXISTING risk settings (account size, risk/trade %, daily loss
// limit) rather than duplicating them — getRiskSettings/isDailyLossLimitHit
// from riskManager.ts are reused directly. Only the genuinely NEW controls
// (max open positions, exposure caps, cooldown) live here.

export type PaperRiskExtras = {
  maxOpenPositions: number;
  maxExposurePerSymbolPct: number;   // % of portfolio value allowed in any single symbol
  maxExposurePerAssetClassPct: number; // % of portfolio value allowed in any single asset class (CRYPTO/STOCK/etc.)
  cooldownAfterLosses: number;       // pause new entries after N consecutive losses (0 = disabled)
  pauseOnDailyLossLimit: boolean;    // whether the daily loss limit actually blocks new paper entries
};

const DEFAULTS: PaperRiskExtras = { maxOpenPositions: 5, maxExposurePerSymbolPct: 30, maxExposurePerAssetClassPct: 60, cooldownAfterLosses: 3, pauseOnDailyLossLimit: true };
const KEY = 'paperRiskExtras';

export async function getPaperRiskExtras(): Promise<PaperRiskExtras> {
  const raw = await AsyncStorage.getItem(KEY);
  return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : DEFAULTS;
}
export async function savePaperRiskExtras(extras: PaperRiskExtras): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(extras));
}

export type RiskCheckResult = { allowed: boolean; reason?: string };

// FIX (Phase 5 — true asset-class exposure): previously this used the SAME
// per-symbol exposure number as a "proxy" for asset-class exposure, which
// meant the asset-class limit could never actually be tested independently
// — two different crypto symbols never summed together. Now sums real
// exposure across every open position sharing the same assetClass field
// (added to PaperPosition specifically for this), giving genuine
// CRYPTO/STOCK/INDEX/FOREX/COMMODITY-level aggregation.
export async function checkRiskGate(
  portfolio: PaperPortfolioState, symbol: string, assetClass: string, candidatePositionValue: number,
  portfolioValue: number, recentTrades: { pnl: number; exitTime: number }[]
): Promise<RiskCheckResult> {
  const settings: RiskSettings = await getRiskSettings();
  const extras = await getPaperRiskExtras();

  if (extras.pauseOnDailyLossLimit) {
    const todayPnL = await getTodayPnL();
    if (isDailyLossLimitHit(todayPnL, settings)) {
      const limitAmount = settings.accountSize * (settings.maxDailyLossPct / 100);
      return { allowed: false, reason: `Daily loss limit reached.\nToday's P&L: ${todayPnL.realizedPnL.toFixed(2)}\nLimit: -${limitAmount.toFixed(2)} (${settings.maxDailyLossPct}% of account)\nNo new paper trades until tomorrow — this is a deliberate circuit breaker and survives a portfolio reset by design.` };
    }
  }

  if (portfolio.openPositions.length >= extras.maxOpenPositions) {
    return { allowed: false, reason: `Maximum open positions reached.\nOpen positions: ${portfolio.openPositions.length}\nMaximum: ${extras.maxOpenPositions}\nClose an existing position before opening a new one, or raise the limit in Risk Manager.` };
  }

  // AUDIT FIX: portfolioValue = 0 produces NaN in the error strings below
  // (0/0*100 = NaN). Verified by test: Infinity > any limit correctly rejects
  // the trade, but the message was user-visible garbage. Guard it explicitly.
  if (portfolioValue <= 0) {
    return { allowed: false, reason: 'Portfolio value is zero or negative — cannot compute exposure percentages. Reset the portfolio or deposit capital before opening new positions.' };
  }

  const existingSymbolExposure = portfolio.openPositions.filter(p => p.symbol === symbol).reduce((s, p) => s + p.entryPrice * p.qty, 0);
  const symbolExposurePct = ((existingSymbolExposure + candidatePositionValue) / portfolioValue) * 100;
  if (symbolExposurePct > extras.maxExposurePerSymbolPct) {
    const currentPct = (existingSymbolExposure / portfolioValue) * 100;
    const availablePct = Math.max(0, extras.maxExposurePerSymbolPct - currentPct);
    return {
      allowed: false,
      reason: `No remaining ${symbol} exposure.\nCurrent exposure: ${currentPct.toFixed(0)}%\nMaximum: ${extras.maxExposurePerSymbolPct}%\nAvailable: ${availablePct.toFixed(0)}%\n${availablePct <= 0 ? 'Reduce the existing position or wait until it closes.' : `This trade would use ${(candidatePositionValue / portfolioValue * 100).toFixed(0)}% — reduce position size or close part of the existing position first.`}`,
    };
  }

  const existingClassExposure = portfolio.openPositions.filter(p => p.assetClass === assetClass).reduce((s, p) => s + p.entryPrice * p.qty, 0);
  const classExposurePct = ((existingClassExposure + candidatePositionValue) / portfolioValue) * 100;
  if (classExposurePct > extras.maxExposurePerAssetClassPct) {
    const currentClassPct = (existingClassExposure / portfolioValue) * 100;
    const availableClassPct = Math.max(0, extras.maxExposurePerAssetClassPct - currentClassPct);
    return { allowed: false, reason: `No remaining ${assetClass} exposure.\nCurrent exposure: ${currentClassPct.toFixed(0)}%\nMaximum: ${extras.maxExposurePerAssetClassPct}%\nAvailable: ${availableClassPct.toFixed(0)}%\nReduce an existing ${assetClass} position or wait for one to close.` };
  }

  // FIX (Paper Trading Audit — hidden state after Reset Portfolio):
  // recentTrades previously included trades from BEFORE a portfolio reset.
  // resetPortfolio() refreshes createdAt but never clears the trade
  // journal (intentional — the journal is a permanent historical record,
  // not something a reset should destroy). Without this filter, 3
  // consecutive losses from a PRIOR portfolio session could lock out a
  // deliberately fresh one immediately. Daily loss limit above is
  // correctly left untouched — that's meant to survive resets, or
  // resetting would become a loophole around its own purpose.
  if (extras.cooldownAfterLosses > 0) {
    const recentOutcomes = recentTrades.filter(t => t.exitTime >= portfolio.createdAt).slice(0, extras.cooldownAfterLosses);
    if (recentOutcomes.length === extras.cooldownAfterLosses && recentOutcomes.every(t => t.pnl < 0)) {
      const totalLoss = recentOutcomes.reduce((s, t) => s + t.pnl, 0);
      return { allowed: false, reason: `Cooldown active.\nConsecutive losses (most recent, across all symbols): ${extras.cooldownAfterLosses}\nTotal: ${totalLoss.toFixed(2)}\nThis blocks opening new positions only — closing an existing one (if any) with a non-losing result will clear it. Adjust the cooldown threshold in Risk Manager if this feels too aggressive.` };
    }
  }

  return { allowed: true };
}

// Real per-class exposure breakdown for the Health Dashboard / Analytics —
// pure aggregation of existing position data, same field used in the gate above.
export function computeAssetClassExposure(portfolio: PaperPortfolioState, portfolioValue: number): { assetClass: string; exposureValue: number; exposurePct: number; positionCount: number }[] {
  const classes = new Map<string, { value: number; count: number }>();
  portfolio.openPositions.forEach(p => {
    const entry = classes.get(p.assetClass) || { value: 0, count: 0 };
    entry.value += p.entryPrice * p.qty;
    entry.count += 1;
    classes.set(p.assetClass, entry);
  });
  return Array.from(classes.entries()).map(([assetClass, { value, count }]) => ({
    assetClass, exposureValue: value, exposurePct: portfolioValue > 0 ? (value / portfolioValue) * 100 : 0, positionCount: count,
  }));
}
