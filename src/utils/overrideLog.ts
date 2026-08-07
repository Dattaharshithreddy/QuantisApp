// ─────────────────────────────────────────────────────────────────────────────
// OVERRIDE LOG  (v1.0.0)
//
// Append-only log of trades where user overrode a WAIT or AVOID signal.
// Never overwrites history. Each entry is appended to the existing array.
// ─────────────────────────────────────────────────────────────────────────────
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'quantis_override_log';

export type OverrideLogEntry = {
  timestamp:          number;   // Date.now()
  symbol:             string;
  timeframe:          string;   // '5m' | '15m' | '1h' | '4h' | '1D' — added v2
  tradeReadiness:     string;   // 'READY' | 'WAIT' | 'AVOID'
  blockerReason:      string;
  predictionDirection:string;   // 'UP' | 'DOWN' | 'NEUTRAL'
  predictionProbability:number; // 0–1 ensembleProbUp
  confidenceOverall:  number;   // 0–100
  confidenceGrade:    string;   // 'A+' | 'A' | 'B' | 'C' | 'D' | 'F'
  recommendation:     string;   // from conf.recommendation
};

/** Appends one entry to the override log. Never clears existing entries. */
export async function appendOverrideLog(entry: OverrideLogEntry): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const existing: OverrideLogEntry[] = raw ? JSON.parse(raw) : [];
    existing.push(entry);
    await AsyncStorage.setItem(KEY, JSON.stringify(existing));
  } catch {
    // Non-fatal — override proceeds regardless of log failure
  }
}

/** Reads override log. Returns empty array on any read/parse failure. */
export async function readOverrideLog(): Promise<OverrideLogEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Returns { total, forState } counts without computing profitability. */
export function summariseOverrides(
  log:      OverrideLogEntry[],
  forState: 'AVOID' | 'WAIT',
): { total: number; forState: number } {
  return {
    total:    log.length,
    forState: log.filter(e => e.tradeReadiness === forState).length};
}

// ── Outcome-aware summary ──────────────────────────────────────────────────────
// Cross-references override log entries with closed paper trade records so the
// UI can show "2 overrides • 1 Win • 1 Loss • 50% WR" instead of just "2 overrides".
// Matching strategy: signalSnapshot field on PaperTradeRecord (exact signalId match)
// is the primary key. Falls back to timestamp proximity (±5 min, same symbol) for
// records created before signalSnapshot was added.

export type OverrideOutcomeSummary = {
  total:    number;  // all overrides ever (any state)
  forState: number;  // overrides for this specific state (WAIT or AVOID)
  wins:     number;
  losses:   number;
  winRate:  number;  // 0–100, NaN when no settled trades
  settled:  number;  // trades where outcome is known (wins + losses)
};

export async function summariseOverrideOutcomes(
  log:      OverrideLogEntry[],
  forState: 'AVOID' | 'WAIT',
  symbol?:  string,
  timeframe?: string,
): Promise<OverrideOutcomeSummary> {
  // Filter to current symbol+timeframe if provided (backward-compat: old entries
  // without timeframe field fall through the timeframe check gracefully)
  const scoped = (symbol && timeframe)
    ? log.filter(e =>
        e.symbol === symbol &&
        (e.timeframe === timeframe || !e.timeframe) // old entries have no timeframe
      )
    : log;

  const forStateEntries = scoped.filter(e => e.tradeReadiness === forState);
  const base: OverrideOutcomeSummary = {
    total:    scoped.length,
    forState: forStateEntries.length,
    wins: 0, losses: 0, winRate: NaN, settled: 0};
  if (!forStateEntries.length) return base;

  try {
    // Lazy import to avoid circular dep — paperTradeJournal imports nothing from overrideLog
    const { getPaperTrades } = await import('./paperTradeJournal');
    const records = await getPaperTrades();

    for (const entry of forStateEntries) {
      // Primary match: record has signalSnapshot.overrideUsed=true + symbol + timestamp proximity
      const bySnapshot = records.find(r =>
        (r as any).signalSnapshot?.overrideUsed === true &&
        r.symbol === entry.symbol &&
        Math.abs(r.entryTime - entry.timestamp) < 5 * 60 * 1000
      );
      // Fallback: any closed trade for this symbol opened within 5 min of the override
      const match = bySnapshot ?? records.find(r =>
        r.symbol === entry.symbol &&
        Math.abs(r.entryTime - entry.timestamp) < 5 * 60 * 1000
      );

      if (match) {
        if (match.pnl > 0) base.wins++;
        else base.losses++;
      }
    }

    base.settled = base.wins + base.losses;
    base.winRate = base.settled > 0 ? (base.wins / base.settled) * 100 : NaN;
  } catch {
    // Non-fatal — fall back to count-only display
  }

  return base;
}
