import { ExecTrade } from './strategyExecutor';
import { createRNG } from './seededRandom';

// Monte Carlo analysis via BOOTSTRAP RESAMPLING (sampling WITH replacement
// from the real trades' returns) — NOT a pure shuffle/permutation.
//
// This distinction matters and was verified before writing this: permuting
// the SAME fixed set of % returns and compounding them multiplicatively is
// mathematically ORDER-INVARIANT — (1+r1)(1+r2)...(1+rn) gives the identical
// final value no matter what order you multiply in. A pure shuffle would
// therefore show ZERO variance in final return (confirmed with a direct
// test), making it useless for answering "how much could the outcome have
// varied" — it would only vary the drawdown PATH, not the endpoint.
//
// Bootstrap resampling (allowing trades to repeat or be omitted entirely in
// each simulated sequence) is the standard, statistically correct technique
// for this kind of analysis, and is what's implemented here.

export type MonteCarloResult = {
  iterations: number;
  finalReturnsPct: number[];
  worstDrawdownPct: number;
  bestDrawdownPct: number;
  medianReturnPct: number;
  meanReturnPct: number;
  probabilityOfLoss: number;
  probabilityOfProfit: number;
  ci90Low: number; ci90High: number;
  originalReturnPct: number;
  originalPercentile: number;
  // Fuller distribution summary than just the 90% CI
  p5: number; p25: number; p75: number; p95: number;
  // Probability the simulated drawdown exceeds each of these thresholds —
  // answers "how likely is a drawdown worse than X%" directly.
  drawdownExceedance: { thresholdPct: number; probability: number }[];
};

function maxDrawdownFromReturns(pctReturns: number[], startingCapital: number): number {
  let equity = startingCapital, peak = startingCapital, maxDD = 0;
  pctReturns.forEach(r => {
    equity *= (1 + r / 100);
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, ((peak - equity) / peak) * 100);
  });
  return maxDD;
}

export function runMonteCarlo(trades: ExecTrade[], startingCapital: number, iterations = 2000, seed = 123): MonteCarloResult | null {
  if (trades.length < 5) return null;

  const rng = createRNG(seed);
  const pctReturns = trades.map(t => t.pnlPct);
  const n = pctReturns.length;

  function bootstrapSample(): number[] {
    return Array.from({ length: n }, () => pctReturns[Math.floor(rng() * n)]);
  }

  const finalReturns: number[] = [];
  const drawdowns: number[] = [];

  for (let iter = 0; iter < iterations; iter++) {
    const sample = bootstrapSample();
    let equity = startingCapital;
    sample.forEach(r => { equity *= (1 + r / 100); });
    finalReturns.push(((equity - startingCapital) / startingCapital) * 100);
    drawdowns.push(maxDrawdownFromReturns(sample, startingCapital));
  }

  finalReturns.sort((a, b) => a - b);
  drawdowns.sort((a, b) => a - b);

  if (!finalReturns.length) return { mean: 0, stdDev: 0, percentile5: 0, percentile95: 0, probabilityOfLoss: 50, probabilityOfProfit: 50, maxDrawdown: 0, originalPercentile: 50 };
  const mean = finalReturns.reduce((s, r) => s + r, 0) / finalReturns.length;
  const median = finalReturns[Math.floor(finalReturns.length / 2)];
  const lossCount = finalReturns.filter(r => r < 0).length;
  const pAt = (pct: number) => finalReturns[Math.floor(finalReturns.length * pct)];

  const drawdownThresholds = [10, 20, 30, 50];
  const drawdownExceedance = drawdownThresholds.map(thresholdPct => ({
    thresholdPct,
    probability: (drawdowns.filter(d => d > thresholdPct).length / drawdowns.length) * 100}));

  let realEquity = startingCapital;
  pctReturns.forEach(r => { realEquity *= (1 + r / 100); });
  const originalReturnPct = ((realEquity - startingCapital) / startingCapital) * 100;
  const rank = finalReturns.filter(r => r <= originalReturnPct).length;
  const originalPercentile = (rank / finalReturns.length) * 100;

  return {
    iterations,
    finalReturnsPct: finalReturns,
    worstDrawdownPct: drawdowns[drawdowns.length - 1],
    bestDrawdownPct: drawdowns[0],
    medianReturnPct: median,
    meanReturnPct: mean,
    probabilityOfLoss: (lossCount / finalReturns.length) * 100,
    probabilityOfProfit: 100 - (lossCount / finalReturns.length) * 100,
    ci90Low: pAt(0.05), ci90High: pAt(0.95),
    p5: pAt(0.05), p25: pAt(0.25), p75: pAt(0.75), p95: pAt(0.95),
    drawdownExceedance,
    originalReturnPct, originalPercentile};
}
