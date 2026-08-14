import AsyncStorage from '@react-native-async-storage/async-storage';
import { KVStore } from 'services/storage';

export type RiskSettings = {
  accountSize:              number;
  riskPerTradePct:          number;   // e.g. 1 = 1% of account per trade
  maxDailyLossPct:          number;   // e.g. 3 = stop trading after -3% in a day
  maxFuturesLots:           number;   // max lots per NSE futures order (configurable, default 5)
  defaultFuturesLeverage:   number;   // default leverage for Binance perps (1–125, default 10)
};

const DEFAULT_SETTINGS: RiskSettings = {
  accountSize:            100000,
  riskPerTradePct:        1,
  maxDailyLossPct:        3,
  maxFuturesLots:         5,
  defaultFuturesLeverage: 10,
};

export async function getRiskSettings(): Promise<RiskSettings> {
  const raw = await KVStore.get('riskSettings');
  try { return raw ? JSON.parse(raw) : DEFAULT_SETTINGS; } catch (e: any) { console.warn("[riskManager] Corrupt risk settings in AsyncStorage — resetting to defaults.", e?.message); return DEFAULT_SETTINGS; }
}
export async function saveRiskSettings(s: RiskSettings) {
  await KVStore.set('riskSettings', JSON.stringify(s));
}

// FIX (Paper Trading Audit — root cause of "first trade on a fresh
// portfolio rejected for exceeding 30% exposure"): this formula correctly
// caps DOLLAR RISK (riskAmount = accountSize * riskPct%) but had no
// relationship at all to NOTIONAL exposure. qty = riskAmount/stopDistance
// means a TIGHT stop distance relative to price (completely normal for
// ATR-based stops — verified with realistic ETH numbers: a 1.13%
// ATR-to-price ratio, nothing unusual) produces a qty whose notional value
// (qty * entry) can be many multiples of the intended 1% risk, even though
// the dollar risk if stopped out is correctly ~1%. The exposure gate
// downstream was correctly catching this — it was never the bug — but
// nothing upstream ever tried to keep the position's SIZE consistent with
// exposure limits in the first place, so a "1% risk" trade could silently
// turn into an 86%-of-portfolio position. maxNotionalValue is optional and
// purely additive: omitting it reproduces this function's exact prior
// behavior (confirmed — RiskManagerScreen.tsx's standalone calculator
// still doesn't pass it, since it's a generic planning tool with no
// portfolio of its own to cap against).
export function calcPositionSize(accountSize: number, riskPct: number, entry: number, stopLoss: number, maxNotionalValue?: number) {
  const riskAmount = accountSize * (riskPct / 100);
  const perUnitRisk = Math.abs(entry - stopLoss);
  if (perUnitRisk <= 0) return { qty: 0, riskAmount, perUnitRisk: 0, positionValue: 0 };
  const riskBasedQty = Math.floor(riskAmount / perUnitRisk);
  const maxQtyByNotional = maxNotionalValue != null ? Math.floor(maxNotionalValue / entry) : Infinity;
  const qty = Math.max(0, Math.min(riskBasedQty, maxQtyByNotional));
  return { qty, riskAmount, perUnitRisk, positionValue: qty * entry };
}

// Kelly Criterion fraction — optimal % of capital to risk given win rate and avg win/loss ratio
export function calcKelly(winRatePct: number, avgWin: number, avgLoss: number): number {
  const p = winRatePct / 100;
  const q = 1 - p;
  const b = avgLoss > 0 ? avgWin / avgLoss : 0;
  if (b <= 0) return 0;
  const kelly = p - q / b;
  return Math.max(0, Math.min(kelly * 100, 25)); // cap at 25% for sanity, never negative
}

// Daily P&L tracking for the loss-limit lockout
export type DailyPnL = { date: string; realizedPnL: number; tradesCount: number };

export async function getTodayPnL(): Promise<DailyPnL> {
  const today = new Date().toISOString().slice(0, 10);
  const raw = await KVStore.get('dailyPnL_' + today);
  try { return raw ? JSON.parse(raw) : { date: today, realizedPnL: 0, tradesCount: 0 }; } catch (e: any) { console.warn("[riskManager] Corrupt daily P&L record in AsyncStorage — returning zero.", e?.message); return { date: today, realizedPnL: 0, tradesCount: 0 }; }
}

export async function addToDailyPnL(amount: number) {
  const today = new Date().toISOString().slice(0, 10);
  const current = await getTodayPnL();
  const updated = { date: today, realizedPnL: current.realizedPnL + amount, tradesCount: current.tradesCount + 1 };
  await KVStore.set('dailyPnL_' + today, JSON.stringify(updated));
  return updated;
}

export function isDailyLossLimitHit(todayPnL: DailyPnL, settings: RiskSettings): boolean {
  const lossLimit = settings.accountSize * (settings.maxDailyLossPct / 100);
  return todayPnL.realizedPnL <= -lossLimit;
}

// Paper trading mode — when on, the Journal and Risk Manager are clearly marked
// as simulation-only so real and practice trades never get mixed up.
export async function getPaperMode(): Promise<boolean> {
  const v = await KVStore.get('paperMode');
  return v === 'true';
}
export async function setPaperMode(on: boolean) {
  await KVStore.set('paperMode', on ? 'true' : 'false');
}
