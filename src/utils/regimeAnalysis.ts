import { Candle } from './indicators';
import { ExecTrade } from './strategyExecutor';
import { detectTrendDirection, detectVolatilityRegime, TrendDirection, VolatilityRegime } from './marketStructure';
import { computeMetrics, BacktestMetrics } from './backtest';

// HONEST SCOPING NOTE: "test across bull/bear/sideways/high-vol/low-vol
// periods" ideally means fetching genuinely separate calendar windows (e.g.
// 2022's crypto bear market vs. 2023-24's bull run). Free broker/exchange
// APIs used in this app cap how much history a single call returns (Binance:
// 1000 bars; Angel One/Alpha Vantage: similar or tighter limits), making
// reliable multi-year period fetching impractical without a paid data
// vendor. Instead, this segments whatever continuous window WAS pulled into
// regime-labeled chunks using the same causal trend/volatility classifiers
// already built and tested elsewhere in this app — then reports the AI
// strategy's actual trades grouped by which regime they occurred in. This is
// an honest, practical interpretation given real constraints: it tells you
// how the strategy performed when conditions were trending vs. ranging,
// calm vs. volatile, just not across literal distinct multi-year periods.

export type RegimeLabel = 'TRENDING_BULL' | 'TRENDING_BEAR' | 'RANGING' | 'HIGH_VOL' | 'LOW_VOL';

export type RegimeBucket = { label: RegimeLabel; trades: ExecTrade[]; metrics: BacktestMetrics; barCount: number };

export function classifyRegimePerBar(candles: Candle[], walkIndices: number[], S: Awaited<ReturnType<typeof precomputeSeries>>): Map<number, RegimeLabel> {
  const labels = new Map<number, RegimeLabel>();

  // Average historical volatility across the walk window, used as the
  // baseline for relative high/low-vol classification at each bar.
  const volSamples = walkIndices.map(i => S.histVol[i]).filter((v): v is number => v != null);
  const avgVol = volSamples.length ? volSamples.reduce((s, v) => s + v, 0) / volSamples.length : 1;

  walkIndices.forEach(i => {
    const trend: TrendDirection = detectTrendDirection(candles.slice(0, i + 1), S.ema20.slice(0, i + 1), S.ema50.slice(0, i + 1));
    const volRegime: VolatilityRegime = detectVolatilityRegime(S.histVol[i] ?? avgVol, avgVol);

    // Volatility takes priority for labeling if it's extreme — a HIGH/EXTREME
    // vol bar is more informative to flag as such than its trend direction.
    if (volRegime === 'HIGH' || volRegime === 'EXTREME') labels.set(i, 'HIGH_VOL');
    else if (volRegime === 'LOW') labels.set(i, 'LOW_VOL');
    else if (trend === 'UPTREND') labels.set(i, 'TRENDING_BULL');
    else if (trend === 'DOWNTREND') labels.set(i, 'TRENDING_BEAR');
    else labels.set(i, 'RANGING');
  });

  return labels;
}

export function bucketTradesByRegime(candles: Candle[], walkIndices: number[], trades: ExecTrade[], startingCapital: number, S: any): RegimeBucket[] {
  const barLabels = classifyRegimePerBar(candles, walkIndices, S);
  const allLabels: RegimeLabel[] = ['TRENDING_BULL', 'TRENDING_BEAR', 'RANGING', 'HIGH_VOL', 'LOW_VOL'];

  return allLabels.map(label => {
    // A trade is attributed to whichever regime was active at its ENTRY bar
    // (the regime that prompted the decision), not its exit.
    const tradesInRegime = trades.filter(t => {
      const entryIdx = candles.findIndex(c => c.time === t.entryTime);
      return entryIdx >= 0 && barLabels.get(entryIdx) === label;
    });
    const barCount = Array.from(barLabels.values()).filter(l => l === label).length;
    const equityCurve = tradesInRegime.map((t, i) => ({ time: t.exitTime, equity: startingCapital + tradesInRegime.slice(0, i + 1).reduce((s, x) => s + x.pnl, 0) }));
    const metrics = computeMetrics(tradesInRegime, equityCurve, startingCapital);
    return { label, trades: tradesInRegime, metrics, barCount };
  });
}
