import { ExecTrade } from './strategyExecutor';

// Tracks whether performance is DETERIORATING over the course of the
// backtest walk, by splitting the trade sequence into N sequential chunks
// and computing win-rate / profit-factor / average-confidence per chunk.
// A real scheduled-retraining infrastructure (Priority 9 from the earlier
// audit) doesn't exist yet, so this approximates "stability over time"
// using the SINGLE walk-forward run's own chronological trade sequence —
// an honest, available signal, not a substitute for true multi-period
// retraining monitoring, which would need that infrastructure built first.

export type StabilityChunk = {
  chunkIndex: number;
  tradeCount: number;
  winRate: number;
  profitFactor: number;
  avgPnlPct: number;
};

export type StabilityResult = {
  chunks: StabilityChunk[];
  winRateDriftSlope: number;   // simple linear regression slope across chunks
  profitFactorDriftSlope: number;
  deteriorating: boolean;      // true if win rate shows a meaningfully negative trend
};

function linearRegressionSlope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const xMean = (n - 1) / 2;
  const yMean = values.reduce((s, v) => s + v, 0) / n;
  let num = 0, den = 0;
  values.forEach((y, x) => { num += (x - xMean) * (y - yMean); den += (x - xMean) ** 2; });
  return den === 0 ? 0 : num / den;
}

export function analyzeModelStability(trades: ExecTrade[], numChunks = 5): StabilityResult | null {
  if (trades.length < numChunks * 3) return null; // need a reasonable number of trades per chunk to be meaningful

  const chunkSize = Math.ceil(trades.length / numChunks);
  const chunks: StabilityChunk[] = [];

  for (let c = 0; c < numChunks; c++) {
    const slice = trades.slice(c * chunkSize, (c + 1) * chunkSize);
    if (!slice.length) continue;
    const wins = slice.filter(t => t.pnl > 0);
    const losses = slice.filter(t => t.pnl <= 0);
    const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    chunks.push({
      chunkIndex: c,
      tradeCount: slice.length,
      winRate: slice.length ? (wins.length / slice.length) * 100 : 0,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 999 : 0),
      avgPnlPct: slice.length ? slice.reduce((s, t) => s + t.pnlPct, 0) / slice.length : 0,
    });
  }

  const winRateDriftSlope = linearRegressionSlope(chunks.map(c => c.winRate));
  const profitFactorDriftSlope = linearRegressionSlope(chunks.map(c => Math.min(c.profitFactor, 10))); // cap outliers for slope stability

  return {
    chunks, winRateDriftSlope, profitFactorDriftSlope,
    // A win rate dropping by more than ~2 percentage points per chunk, on
    // average, across the walk is flagged as a deteriorating trend worth
    // attention — a heuristic threshold, not a formal statistical test.
    deteriorating: winRateDriftSlope < -2,
  };
}
