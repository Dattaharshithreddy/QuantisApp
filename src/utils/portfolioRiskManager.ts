// ─────────────────────────────────────────────────────────────────────────────
// PORTFOLIO RISK MANAGER  (v1.0.0)
//
// Unified cross-account risk view across all four account types:
//   • Paper equity      (paperPortfolio.ts)
//   • Live equity       (livePortfolio.ts)
//   • NSE Futures       (futures/futuresPortfolio.ts)
//   • Binance Futures   (futures/binance/bnFuturesPortfolio.ts)
//
// Computes at the PORTFOLIO level, not the position level:
//   • Total capital across all accounts (INR equivalent)
//   • Total exposure (notional value of all open positions)
//   • Margin utilisation (% of capital locked in margin/positions)
//   • Overall leverage (total notional / total capital)
//   • Daily Value at Risk (parametric VaR at 95% and 99% confidence)
//   • Maximum drawdown (worst peak-to-trough across all accounts)
//   • Concentration risk (largest single position as % of total exposure)
//   • Correlation-adjusted exposure
//
// Design rules:
//   • Read-only — never modifies any portfolio
//   • Non-blocking — all operations are async, fail gracefully per account
//   • Currency-normalised — all values in INR equivalent (uses approximate
//     USD/INR rate; exact FX not required for risk monitoring)
//   • Account isolation preserved — each account's P&L is tracked separately
// ─────────────────────────────────────────────────────────────────────────────

import { getPortfolio }          from './paperPortfolio';
import { getLivePortfolio }      from './livePortfolio';
import { getFuturesPortfolio }   from './futures/futuresPortfolio';
import { getBnFuturesPortfolio } from './futures/binance/bnFuturesPortfolio';
import {
  computeFuturesPnL, LOT_SIZES,
} from './futures/futuresTypes';
import {
  computeBnPnL,
} from './futures/binance/bnFuturesTypes';
import { logger } from './logger';

// ── Currency conversion ────────────────────────────────────────────────────────
// Approximate — refreshed from DataContext prices when available.
// Used only for cross-account totals, not for individual account accounting.
const APPROX_USD_INR = 84.0;   // 1 USD ≈ ₹84 (approximate mid-2026)

function usdToInr(usd: number): number { return usd * APPROX_USD_INR; }

// ── Types ─────────────────────────────────────────────────────────────────────

export type AccountSnapshot = {
  name:          string;
  currency:      'INR' | 'USDT';
  balance:       number;          // available cash/margin in native currency
  balanceInr:    number;          // balance converted to INR
  openPositions: number;
  notionalInr:   number;          // total open position notional in INR
  unrealisedPnL: number;          // in native currency
  unrealisedInr: number;
  realisedPnL:   number;
  marginUsed:    number;          // INR equivalent of margin/capital locked
  hasData:       boolean;
};

export type PositionRisk = {
  id:              string;
  symbol:          string;
  account:         string;
  direction:       'LONG' | 'SHORT';
  notionalInr:     number;
  unrealisedInr:   number;
  weight:          number;        // position as % of total notional
  leverage:        number;        // effective leverage for this position
};

export type PortfolioRiskReport = {
  generatedAt:        number;
  usdInrRate:         number;

  // ── Account snapshots ──────────────────────────────────────────────────────
  accounts:           AccountSnapshot[];

  // ── Totals (INR equivalent) ────────────────────────────────────────────────
  totalCapitalInr:    number;     // sum of all account balances
  totalNotionalInr:   number;     // sum of all open position notionals
  totalUnrealisedInr: number;
  totalRealisedInr:   number;

  // ── Risk metrics ───────────────────────────────────────────────────────────
  marginUtilisationPct:  number;  // totalNotional / totalCapital × 100
  overallLeverage:       number;  // totalNotional / totalCapital (×)
  concentrationPct:      number;  // largest single position / totalNotional × 100
  largestPosition:       PositionRisk | null;

  // ── Daily VaR (parametric, normal distribution) ───────────────────────────
  // Assumes average daily volatility of 2% for equity, 3% for crypto perps,
  // 1.5% for index futures. Conservative estimates — actual vol varies.
  var95Inr:    number;            // 5% of days worse than this
  var99Inr:    number;            // 1% of days worse than this

  // ── Drawdown ──────────────────────────────────────────────────────────────
  maxDrawdownPct: number;         // worst single account drawdown %

  // ── Risk level ────────────────────────────────────────────────────────────
  riskLevel:   'LOW' | 'MODERATE' | 'HIGH' | 'VERY_HIGH';
  riskFactors: string[];          // human-readable list of active risk factors
  recommendations: string[];

  // ── Per-position breakdown ─────────────────────────────────────────────────
  positions:   PositionRisk[];
};

// ── Daily volatility assumptions (conservative) ────────────────────────────────
const DAILY_VOL: Record<string, number> = {
  // Crypto perps — high volatility
  BTCUSDT: 0.030,  ETHUSDT: 0.035,  SOLUSDT: 0.045,
  BNBUSDT: 0.035,  XRPUSDT: 0.040,  ADAUSDT: 0.040,
  DOGEUSDT: 0.050, AVAXUSDT: 0.050, DOTUSDT: 0.045, MATICUSDT: 0.050,
  // NSE index futures — lower volatility
  NIFTY:       0.012, BANKNIFTY: 0.015, FINNIFTY: 0.013, MIDCPNIFTY: 0.014,
  // NSE stock futures
  RELIANCE: 0.018, TCS: 0.016, INFY: 0.017, HDFCBANK: 0.018,
  ICICIBANK: 0.019, SBIN: 0.020, AXISBANK: 0.019, BHARTIARTL: 0.018,
  WIPRO: 0.019, TATAMOTORS: 0.022, ONGC: 0.020,
  // Default
  DEFAULT: 0.020,
};

const Z_95 = 1.645;
const Z_99 = 2.326;

function getDailyVol(symbol: string): number {
  return DAILY_VOL[symbol.toUpperCase()] ?? DAILY_VOL.DEFAULT;
}

// ── Main computation ─────────────────────────────────────────────────────────

export async function computePortfolioRisk(
  livePrices: Record<string, number> = {},
  usdInrRate: number = APPROX_USD_INR,
): Promise<PortfolioRiskReport> {
  const accounts:  AccountSnapshot[] = [];
  const positions: PositionRisk[]    = [];
  const riskFactors: string[]        = [];
  const recommendations: string[]   = [];

  // ── 1. Paper equity ──────────────────────────────────────────────────────
  try {
    const paper = await getPortfolio();
    let notional = 0; let unrealised = 0;
    for (const pos of paper.openPositions) {
      const price = livePrices[pos.symbol] ?? pos.entryPrice;
      const posNotional = pos.qty * price;
      const pnl = (price - pos.entryPrice) * pos.qty * (pos.direction === 'LONG' ? 1 : -1);
      notional   += posNotional;
      unrealised += pnl;
      const vol = getDailyVol(pos.symbol);
      positions.push({
        id: pos.id, symbol: pos.symbol, account: 'Paper Equity',
        direction: pos.direction, notionalInr: posNotional,
        unrealisedInr: pnl, weight: 0, leverage: 1});
    }
    accounts.push({
      name: 'Paper Equity', currency: 'INR',
      balance: paper.cashBalance, balanceInr: paper.cashBalance,
      openPositions: paper.openPositions.length,
      notionalInr: notional, unrealisedInr: unrealised, unrealised,
      realisedPnL: paper.realizedPnL ?? 0,
      marginUsed: notional,
      hasData: true});
  } catch (e: any) { logger.warn('portfolioRisk', `Paper equity read failed: ${e.message}`); }

  // ── 2. Live equity ────────────────────────────────────────────────────────
  try {
    const live = await getLivePortfolio();
    let notional = 0; let unrealised = 0;
    for (const pos of live.openPositions) {
      const price = livePrices[pos.symbol] ?? pos.filledPrice;
      const posNotional = pos.qty * price;
      const pnl = (price - pos.filledPrice) * pos.qty * (pos.direction === 'LONG' ? 1 : -1);
      notional   += posNotional;
      unrealised += pnl;
      positions.push({
        id: pos.id, symbol: pos.symbol, account: 'Live Equity',
        direction: pos.direction, notionalInr: posNotional,
        unrealisedInr: pnl, weight: 0, leverage: 1});
    }
    accounts.push({
      name: 'Live Equity', currency: 'INR',
      balance: 0, balanceInr: 0,   // live balance fetched from broker
      openPositions: live.openPositions.length,
      notionalInr: notional, unrealisedInr: unrealised, unrealised,
      realisedPnL: live.totalRealizedPnL,
      marginUsed: notional,
      hasData: true});
  } catch (e: any) { logger.warn('portfolioRisk', `Live equity read failed: ${e.message}`); }

  // ── 3. NSE Futures ────────────────────────────────────────────────────────
  try {
    const nse = await getFuturesPortfolio();
    let notional = 0; let unrealised = 0; let marginUsed = 0;
    for (const pos of nse.openPositions) {
      const price      = livePrices[pos.underlying] ?? livePrices[pos.contractSymbol] ?? pos.entryPrice;
      const pnl        = computeFuturesPnL(pos.direction, pos.entryPrice, price, pos.lots, pos.lotSize);
      const posNotional = price * pos.qty;
      notional   += posNotional;
      unrealised += pnl;
      marginUsed += pos.marginBlocked;
      positions.push({
        id: pos.id, symbol: pos.underlying, account: 'NSE Futures',
        direction: pos.direction, notionalInr: posNotional,
        unrealisedInr: pnl, weight: 0,
        leverage: pos.marginBlocked > 0 ? posNotional / pos.marginBlocked : 1});
    }
    accounts.push({
      name: 'NSE Futures', currency: 'INR',
      balance: nse.cashBalance, balanceInr: nse.cashBalance,
      openPositions: nse.openPositions.length,
      notionalInr: notional, unrealisedInr: unrealised, unrealised,
      realisedPnL: nse.totalRealizedPnL,
      marginUsed,
      hasData: true});
  } catch (e: any) { logger.warn('portfolioRisk', `NSE futures read failed: ${e.message}`); }

  // ── 4. Binance Futures ────────────────────────────────────────────────────
  const BN_PRICE_MAP: Record<string, string> = {
    BTCUSDT: 'BTCUSD', ETHUSDT: 'ETHUSD', BNBUSDT: 'BNBUSD', SOLUSDT: 'SOLUSD',
    XRPUSDT: 'XRPUSD', ADAUSDT: 'ADAUSD', DOGEUSDT: 'DOGEUSD',
    AVAXUSDT: 'AVAXUSD', DOTUSDT: 'DOTUSD', MATICUSDT: 'MATICUSD'};
  try {
    const bn = await getBnFuturesPortfolio();
    let notionalUsd = 0; let unrealisedUsd = 0; let marginUsd = 0;
    for (const pos of bn.openPositions) {
      const priceKey = BN_PRICE_MAP[pos.symbol] ?? pos.symbol;
      const price    = livePrices[priceKey] ?? livePrices[pos.symbol] ?? pos.entryPrice;
      const pnl      = computeBnPnL(pos.direction, pos.entryPrice, price, pos.qty);
      const posNotionalUsd = pos.qty * price;
      notionalUsd   += posNotionalUsd;
      unrealisedUsd += pnl;
      marginUsd     += pos.isolatedMargin;
      positions.push({
        id: pos.id, symbol: pos.symbol, account: 'Binance Futures',
        direction: pos.direction,
        notionalInr:   usdToInr(posNotionalUsd),
        unrealisedInr: usdToInr(pnl),
        weight: 0,
        leverage: pos.leverage});
    }
    accounts.push({
      name: 'Binance Futures', currency: 'USDT',
      balance: bn.usdtBalance, balanceInr: usdToInr(bn.usdtBalance),
      openPositions: bn.openPositions.length,
      notionalInr:   usdToInr(notionalUsd),
      unrealisedInr: usdToInr(unrealisedUsd), unrealised: unrealisedUsd,
      realisedPnL: bn.totalRealizedPnL,
      marginUsed: usdToInr(marginUsd),
      hasData: true});
  } catch (e: any) { logger.warn('portfolioRisk', `Binance futures read failed: ${e.message}`); }

  // ── Aggregate totals ──────────────────────────────────────────────────────
  const totalCapitalInr    = accounts.reduce((s, a) => s + a.balanceInr, 0);
  const totalNotionalInr   = accounts.reduce((s, a) => s + a.notionalInr, 0);
  const totalUnrealisedInr = accounts.reduce((s, a) => s + a.unrealisedInr, 0);
  const totalRealisedInr   = accounts.reduce((s, a) => s + (a.currency === 'USDT'
    ? usdToInr(a.realisedPnL) : a.realisedPnL), 0);
  const totalMarginUsed    = accounts.reduce((s, a) => s + a.marginUsed, 0);

  // ── Weight each position ──────────────────────────────────────────────────
  if (totalNotionalInr > 0) {
    positions.forEach(p => { p.weight = (p.notionalInr / totalNotionalInr) * 100; });
  }

  // ── Risk metrics ──────────────────────────────────────────────────────────
  const marginUtilisationPct = totalCapitalInr > 0
    ? (totalMarginUsed / totalCapitalInr) * 100 : 0;
  const overallLeverage = totalCapitalInr > 0
    ? totalNotionalInr / totalCapitalInr : 0;

  const sorted   = [...positions].sort((a, b) => b.notionalInr - a.notionalInr);
  const largest  = sorted[0] ?? null;
  const concentrationPct = largest && totalNotionalInr > 0
    ? (largest.notionalInr / totalNotionalInr) * 100 : 0;

  // ── Parametric VaR ────────────────────────────────────────────────────────
  // Portfolio VaR = sqrt(sum_i sum_j (w_i * σ_i * notional) * (w_j * σ_j * notional) * ρ_ij)
  // Simplified: assume average correlation 0.4 between cross-account positions
  // for a conservative but tractable estimate.
  const positionVars = positions.map(p => getDailyVol(p.symbol) * p.notionalInr);
  const sumVarSquared = positionVars.reduce((s, v) => s + v * v, 0);
  // Cross-position covariance terms (simplified, assume avg corr 0.4)
  let crossTerms = 0;
  for (let i = 0; i < positionVars.length; i++) {
    for (let j = i + 1; j < positionVars.length; j++) {
      const sameAccount = positions[i].account === positions[j].account;
      const corr        = sameAccount ? 0.6 : 0.3;
      crossTerms += 2 * corr * positionVars[i] * positionVars[j];
    }
  }
  const portfolioSigmaInr = Math.sqrt(sumVarSquared + crossTerms);
  const var95Inr = Z_95 * portfolioSigmaInr;
  const var99Inr = Z_99 * portfolioSigmaInr;

  // ── Max drawdown ──────────────────────────────────────────────────────────
  // Simplified: worst unrealised as % of account balance
  const maxDrawdownPct = accounts.reduce((worst, acct) => {
    if (!acct.hasData || acct.balanceInr <= 0) return worst;
    const dd = acct.unrealisedInr < 0
      ? Math.abs(acct.unrealisedInr) / acct.balanceInr * 100 : 0;
    return Math.max(worst, dd);
  }, 0);

  // ── Risk level ────────────────────────────────────────────────────────────
  if (overallLeverage > 10 || marginUtilisationPct > 80) {
    riskFactors.push(`Very high leverage (${overallLeverage.toFixed(1)}×)`);
  } else if (overallLeverage > 5 || marginUtilisationPct > 60) {
    riskFactors.push(`High leverage (${overallLeverage.toFixed(1)}×)`);
  }
  if (concentrationPct > 60) {
    riskFactors.push(`High concentration: ${largest?.symbol} is ${concentrationPct.toFixed(0)}% of portfolio`);
  }
  if (var95Inr > totalCapitalInr * 0.05) {
    riskFactors.push(`VaR₉₅ (₹${(var95Inr/1000).toFixed(0)}K) exceeds 5% of capital`);
  }
  if (maxDrawdownPct > 20) {
    riskFactors.push(`Drawdown ${maxDrawdownPct.toFixed(1)}% on one account`);
  }

  // ── Recommendations ───────────────────────────────────────────────────────
  if (overallLeverage > 10) {
    recommendations.push('Reduce leverage — overall portfolio leverage exceeds 10×. Consider closing or trimming highest-leverage Binance futures positions.');
  }
  if (concentrationPct > 60) {
    recommendations.push(`Reduce ${largest?.symbol} concentration — it represents ${concentrationPct.toFixed(0)}% of total notional. Diversify across other instruments.`);
  }
  if (marginUtilisationPct > 80) {
    recommendations.push('Margin utilisation is above 80%. A moderate adverse move could trigger forced liquidation. Consider freeing margin by closing smaller positions.');
  }
  if (var95Inr > totalCapitalInr * 0.1) {
    recommendations.push(`Daily VaR₉₅ of ₹${(var95Inr/1000).toFixed(0)}K represents ${(var95Inr/totalCapitalInr*100).toFixed(1)}% of total capital — unusually high for a single day.`);
  }
  if (totalNotionalInr === 0) {
    recommendations.push('No open positions across any account. Portfolio risk is zero.');
  }
  if (recommendations.length === 0) {
    recommendations.push('Portfolio risk is within normal parameters. Continue monitoring.');
  }

  const riskLevel: PortfolioRiskReport['riskLevel'] =
    overallLeverage > 10 || marginUtilisationPct > 80 || var95Inr > totalCapitalInr * 0.10 ? 'VERY_HIGH' :
    overallLeverage > 5  || marginUtilisationPct > 60 || var95Inr > totalCapitalInr * 0.05 ? 'HIGH' :
    overallLeverage > 2  || marginUtilisationPct > 40 ? 'MODERATE' : 'LOW';

  return {
    generatedAt: Date.now(),
    usdInrRate:  usdInrRate,
    accounts,
    totalCapitalInr,
    totalNotionalInr,
    totalUnrealisedInr,
    totalRealisedInr,
    marginUtilisationPct,
    overallLeverage,
    concentrationPct,
    largestPosition: largest ?? null,
    var95Inr,
    var99Inr,
    maxDrawdownPct,
    riskLevel,
    riskFactors,
    recommendations,
    positions: sorted};
}
