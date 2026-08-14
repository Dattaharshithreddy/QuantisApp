// ─────────────────────────────────────────────────────────────────────────────
// MANUAL TRADE JOURNAL  (journal.ts)
//
// PURPOSE: Manual-entry journal for user-recorded trades (JournalScreen).
// BOUNDARY: This file stores only trades the user enters manually.
//
// AI paper trades (opened by the prediction engine) are stored in:
//   paperTradeJournal.ts → PaperTradeRecord (30+ fields, full AI metadata)
//
// Do NOT add AI-opened trade records here. Do NOT read this file for
// analytics that should include AI trades — use paperTradeJournal.ts instead.
//
// These are two separate systems by design:
//   journal.ts          — user control, simple schema, JournalScreen
//   paperTradeJournal.ts — AI control, rich schema, PaperJournalScreen + validationEngine
// ─────────────────────────────────────────────────────────────────────────────
import AsyncStorage from '@react-native-async-storage/async-storage';
import { KVStore } from '../services/storage';
import { calculatePnLWithMultiplier } from './pnlCalculator';

export type Trade = {
  id: string;
  symbol: string;
  direction: 'LONG' | 'SHORT' | 'BUY_CE' | 'BUY_PE' | 'SELL_CE' | 'SELL_PE';
  entry: number;
  exit: number | null; // null = still open
  qty: number;
  stopLoss?: number;
  target?: number;
  setupTag: string; // e.g. 'Breakout', 'Reversal', 'AI Signal'
  notes: string;
  openedAt: number;
  closedAt: number | null;
};

const KEY = 'tradeJournal';

export async function getTrades(): Promise<Trade[]> {
  const raw = await KVStore.get(KEY);
  try { return raw ? JSON.parse(raw) : []; } catch (e: any) { console.warn('[journal] corrupt storage:', e?.message); return []; }
}

export async function addTrade(trade: Omit<Trade, 'id' | 'openedAt'>): Promise<Trade[]> {
  const trades = await getTrades();
  const newTrade: Trade = { ...trade, id: Date.now().toString(), openedAt: Date.now() };
  const updated = [newTrade, ...trades];
  await KVStore.set(KEY, JSON.stringify(updated));
  return updated;
}

export async function closeTrade(id: string, exitPrice: number): Promise<Trade[]> {
  const trades = await getTrades();
  const updated = trades.map(t => (t.id === id ? { ...t, exit: exitPrice, closedAt: Date.now() } : t));
  await KVStore.set(KEY, JSON.stringify(updated));
  return updated;
}

export async function deleteTrade(id: string): Promise<Trade[]> {
  const trades = await getTrades();
  const updated = trades.filter(t => t.id !== id);
  await KVStore.set(KEY, JSON.stringify(updated));
  return updated;
}

function pnlOf(t: Trade): number {
  if (t.exit == null) return 0;
  const dir = ['LONG', 'BUY_CE', 'BUY_PE'].includes(t.direction) ? 1 : -1;
  return calculatePnLWithMultiplier(t.entry, t.exit, t.qty, dir);
}

export type JournalStats = {
  totalTrades: number; closedTrades: number; winRate: number; profitFactor: number;
  avgRR: number; totalPnL: number; maxDrawdown: number; bestSetup: string;
};

export function computeStats(trades: Trade[]): JournalStats {
  const closed = trades.filter(t => t.exit != null);
  const pnls = closed.map(pnlOf);
  const wins = pnls.filter(p => p > 0);
  const losses = pnls.filter(p => p < 0);
  const grossWin = wins.reduce((s, p) => s + p, 0);
  const grossLoss = Math.abs(losses.reduce((s, p) => s + p, 0));
  const winRate = closed.length ? (wins.length / closed.length) * 100 : 0;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : 0;
  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const avgRR = avgLoss > 0 ? avgWin / avgLoss : 0;
  const totalPnL = pnls.reduce((s, p) => s + p, 0);

  // Max drawdown across equity curve built from closed trades in chronological order
  const chrono = [...closed].sort((a, b) => (a.closedAt || 0) - (b.closedAt || 0));
  let equity = 0, peak = 0, maxDD = 0;
  chrono.forEach(t => {
    equity += pnlOf(t);
    peak = Math.max(peak, equity);
    maxDD = Math.min(maxDD, equity - peak);
  });

  // Best performing setup tag
  const bySetup: Record<string, number> = {};
  closed.forEach(t => { bySetup[t.setupTag] = (bySetup[t.setupTag] || 0) + pnlOf(t); });
  const bestSetup = Object.entries(bySetup).sort((a, b) => b[1] - a[1])[0]?.[0] || '—';

  return { totalTrades: trades.length, closedTrades: closed.length, winRate, profitFactor, avgRR, totalPnL, maxDrawdown: maxDD, bestSetup };
}

export { pnlOf };
