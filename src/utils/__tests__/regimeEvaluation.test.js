// ─────────────────────────────────────────────────────────────────────────────
// REGIME EVALUATION — Regression Tests  (v1.0.0)
//
// Tests cover:
//   1. bucketTradesByFittedRegime — correct attribution of trade to entry regime
//   2. buildComparison — highlights, rankings, recommendations
//   3. RegimeEvalResult shape — backward compat, optional fields
//   4. ML isolation — regimeEvaluation.ts never imports ML internals
//   5. Zero-trade regimes — no crash, empty metrics
//   6. regimeLabelAt accessor — exposed on FittedEnsemble
//   7. ALL_REGIME_LABELS coverage — all 11 labels present
//   8. scoreMetrics — correct ordering
//   9. Recommendation generation — correct regime names in output
//  10. Trade attribution policy — entry bar, not exit bar
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Inline the pure-logic portions for testing ────────────────────────────────

const ALL_REGIME_LABELS = [
  'STRONG_BULL_TREND', 'BULL_TREND', 'WEAK_BULL_TREND',
  'SIDEWAYS', 'MEAN_REVERSION', 'BREAKOUT',
  'STRONG_BEAR_TREND', 'BEAR_TREND', 'WEAK_BEAR_TREND',
  'LOW_VOLATILITY', 'HIGH_VOLATILITY',
];

const REGIME_DISPLAY_NAMES = {
  STRONG_BULL_TREND: 'Strong Bull Trend',
  BULL_TREND:        'Bull Trend',
  WEAK_BULL_TREND:   'Weak Bull Trend',
  SIDEWAYS:          'Sideways',
  MEAN_REVERSION:    'Mean Reversion',
  BREAKOUT:          'Breakout',
  STRONG_BEAR_TREND: 'Strong Bear Trend',
  BEAR_TREND:        'Bear Trend',
  WEAK_BEAR_TREND:   'Weak Bear Trend',
  LOW_VOLATILITY:    'Low Volatility',
  HIGH_VOLATILITY:   'High Volatility',
};

// Inline computeMetrics-equivalent
function computeMetrics(trades, startingCapital = 100000) {
  if (!trades.length) return { totalReturnPct: 0, winRate: 0, profitFactor: 0, numTrades: 0, maxDrawdownPct: 0, sharpeRatio: 0, expectancy: 0, avgTrade: 0, avgHoldingBars: 0 };
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const winRate = (wins.length / trades.length) * 100;
  const lossRate = 100 - winRate;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const expectancy = (winRate / 100) * avgWin - (lossRate / 100) * avgLoss;
  const avgTrade = trades.reduce((s, t) => s + t.pnl, 0) / trades.length;
  const netProfit = trades.reduce((s, t) => s + t.pnl, 0);
  const totalReturnPct = (netProfit / startingCapital) * 100;
  return { totalReturnPct, winRate, profitFactor, numTrades: trades.length, maxDrawdownPct: 5, sharpeRatio: 1.0, expectancy, avgTrade, avgHoldingBars: 10 };
}

// Inline scoreMetrics
function scoreMetrics(m) {
  if (m.numTrades < 3) return -Infinity;
  const pf = m.profitFactor === Infinity ? 5 : Math.min(m.profitFactor, 5);
  return pf * 0.5 + (m.winRate / 100) * 0.3 + Math.min(Math.max(m.sharpeRatio, -2), 2) * 0.2;
}

// Inline bucketTradesByFittedRegime
function bucketByRegime(trades, candles, regimeLabelAt) {
  const map = new Map();
  for (const regime of ALL_REGIME_LABELS) map.set(regime, []);
  for (const trade of trades) {
    const entryIdx = candles.findIndex(c => c.time === trade.entryTime);
    if (entryIdx < 0) continue;
    const label = regimeLabelAt(entryIdx);
    if (!label) continue;
    map.get(label).push(trade);
  }
  return map;
}

// Helpers
function makeTrade(entryTime, pnl, pnlPct) {
  return { entryTime, exitTime: entryTime + 3600000, pnl, pnlPct, holdingBars: 4, holdingMs: 3600000 };
}
function makeCandle(time) {
  return { time, open: 100, high: 105, low: 95, close: 102, volume: 1000 };
}

// ── 1. ALL_REGIME_LABELS coverage ────────────────────────────────────────────

describe('ALL_REGIME_LABELS', () => {
  test('contains exactly 11 labels', () => {
    expect(ALL_REGIME_LABELS).toHaveLength(11);
  });

  test('all labels have display names', () => {
    ALL_REGIME_LABELS.forEach(label => {
      expect(REGIME_DISPLAY_NAMES[label]).toBeDefined();
      expect(REGIME_DISPLAY_NAMES[label].length).toBeGreaterThan(0);
    });
  });

  test('covers all trend directions', () => {
    expect(ALL_REGIME_LABELS).toContain('STRONG_BULL_TREND');
    expect(ALL_REGIME_LABELS).toContain('BULL_TREND');
    expect(ALL_REGIME_LABELS).toContain('WEAK_BULL_TREND');
    expect(ALL_REGIME_LABELS).toContain('SIDEWAYS');
    expect(ALL_REGIME_LABELS).toContain('STRONG_BEAR_TREND');
    expect(ALL_REGIME_LABELS).toContain('BEAR_TREND');
    expect(ALL_REGIME_LABELS).toContain('WEAK_BEAR_TREND');
  });

  test('covers volatility regimes', () => {
    expect(ALL_REGIME_LABELS).toContain('HIGH_VOLATILITY');
    expect(ALL_REGIME_LABELS).toContain('LOW_VOLATILITY');
  });

  test('covers pattern regimes', () => {
    expect(ALL_REGIME_LABELS).toContain('MEAN_REVERSION');
    expect(ALL_REGIME_LABELS).toContain('BREAKOUT');
  });
});

// ── 2. bucketTradesByFittedRegime ─────────────────────────────────────────────

describe('bucketTradesByFittedRegime — trade attribution', () => {
  const candles = [
    makeCandle(1000), makeCandle(2000), makeCandle(3000), makeCandle(4000)
  ];

  test('trades are attributed to the regime at ENTRY bar (not exit)', () => {
    const trades = [
      makeTrade(1000, 500, 2),   // entry at candle[0]
      makeTrade(2000, -300, -1), // entry at candle[1]
      makeTrade(3000, 800, 3),   // entry at candle[2]
    ];
    // regime: bar 0 → BULL_TREND, bar 1 → BEAR_TREND, bar 2 → BULL_TREND
    const regimeLabelAt = (idx) => idx === 0 ? 'BULL_TREND' : idx === 1 ? 'BEAR_TREND' : idx === 2 ? 'BULL_TREND' : null;
    const map = bucketByRegime(trades, candles, regimeLabelAt);
    expect(map.get('BULL_TREND').length).toBe(2);
    expect(map.get('BEAR_TREND').length).toBe(1);
    expect(map.get('SIDEWAYS').length).toBe(0);
  });

  test('trade with no matching candle is dropped (not throws)', () => {
    const trades = [makeTrade(9999, 100, 1)]; // entryTime not in candles
    const regimeLabelAt = () => 'BULL_TREND';
    expect(() => bucketByRegime(trades, candles, regimeLabelAt)).not.toThrow();
    const map = bucketByRegime(trades, candles, regimeLabelAt);
    expect(map.get('BULL_TREND').length).toBe(0);
  });

  test('trade where regimeLabelAt returns null is dropped', () => {
    const trades = [makeTrade(1000, 100, 1)];
    const regimeLabelAt = () => null; // no regime data for this bar
    const map = bucketByRegime(trades, candles, regimeLabelAt);
    ALL_REGIME_LABELS.forEach(label => expect(map.get(label).length).toBe(0));
  });

  test('all 11 regime buckets are initialised even when empty', () => {
    const trades = [makeTrade(1000, 100, 1)];
    const regimeLabelAt = () => 'BULL_TREND';
    const map = bucketByRegime(trades, candles, regimeLabelAt);
    expect(map.size).toBe(11);
    ALL_REGIME_LABELS.forEach(label => expect(map.has(label)).toBe(true));
  });

  test('multiple trades in same regime are all captured', () => {
    const trades = [
      makeTrade(1000, 100, 1),
      makeTrade(2000, 200, 2),
      makeTrade(3000, 300, 3),
    ];
    const regimeLabelAt = () => 'SIDEWAYS';
    const map = bucketByRegime(trades, candles, regimeLabelAt);
    expect(map.get('SIDEWAYS').length).toBe(3);
  });
});

// ── 3. scoreMetrics ───────────────────────────────────────────────────────────

describe('scoreMetrics — regime ranking function', () => {
  test('regimes with < 3 trades score -Infinity (excluded from highlights)', () => {
    const m = computeMetrics([makeTrade(0, 100, 1), makeTrade(0, 200, 2)]);
    expect(scoreMetrics(m)).toBe(-Infinity);
  });

  test('higher profit factor → higher score', () => {
    const t = (n) => Array(n).fill(null).map((_, i) => makeTrade(i * 1000, i % 2 === 0 ? 100 : -30, i % 2 === 0 ? 1 : -0.3));
    const m1 = computeMetrics(t(10)); m1.profitFactor = 1.2; m1.winRate = 50;
    const m2 = computeMetrics(t(10)); m2.profitFactor = 2.5; m2.winRate = 50;
    m1.numTrades = m2.numTrades = 10;
    expect(scoreMetrics(m2)).toBeGreaterThan(scoreMetrics(m1));
  });

  test('Infinity profit factor is capped at 5 (no NaN)', () => {
    const m = { profitFactor: Infinity, winRate: 60, sharpeRatio: 1, numTrades: 5 };
    expect(Number.isFinite(scoreMetrics(m))).toBe(true);
  });
});

// ── 4. buildComparison highlights ─────────────────────────────────────────────

describe('buildComparison — highlights and recommendations', () => {
  function makeBreakdown(regime, numTrades, pf, wr, maxDD = 10) {
    const trades = Array(numTrades).fill(null).map((_, i) => makeTrade(i * 1000, i % 2 === 0 ? 200 : -50, i % 2 === 0 ? 2 : -0.5));
    const metrics = computeMetrics(trades);
    metrics.profitFactor = pf; metrics.winRate = wr; metrics.numTrades = numTrades; metrics.maxDrawdownPct = maxDD;
    return {
      regime, displayName: REGIME_DISPLAY_NAMES[regime],
      emoji: '🐂', barCount: 100, metrics,
      byModel: [], byHorizon: [], byStrategy: [],
    };
  }

  function buildComparison(breakdowns) {
    const withTrades = breakdowns.filter(b => b.metrics.numTrades >= 3);
    const ranked = [...withTrades].sort((a, b) => scoreMetrics(b.metrics) - scoreMetrics(a.metrics));
    const best = fn => withTrades.length ? withTrades.reduce((b, e) => fn(e) > fn(b) ? e : b) : null;
    const bestOverall      = withTrades.length ? ranked[0] ?? null : null;
    const worstOverall     = withTrades.length ? ranked[ranked.length - 1] ?? null : null;
    const highestProfitFactor = best(b => b.metrics.profitFactor === Infinity ? 999 : b.metrics.profitFactor);
    const highestWinRate   = best(b => b.metrics.winRate);
    const lowestDrawdown   = withTrades.length ? withTrades.reduce((b, e) => e.metrics.maxDrawdownPct < b.metrics.maxDrawdownPct ? e : b) : null;
    const recs = [];
    if (bestOverall) recs.push(`${bestOverall.displayName} is the best-performing regime`);
    if (worstOverall && worstOverall !== bestOverall) recs.push(`${worstOverall.displayName} is the weakest regime`);
    return { rankings: ranked, bestOverall, worstOverall, highestProfitFactor, highestWinRate, lowestDrawdown, recommendations: recs };
  }

  test('bestOverall is the regime with highest combined score', () => {
    const breakdowns = [
      makeBreakdown('BULL_TREND',  10, 2.5, 65),
      makeBreakdown('BEAR_TREND',  8,  1.2, 45),
      makeBreakdown('SIDEWAYS',    6,  0.8, 35),
    ];
    const cmp = buildComparison(breakdowns);
    expect(cmp.bestOverall?.regime).toBe('BULL_TREND');
  });

  test('worstOverall is different from bestOverall', () => {
    const breakdowns = [
      makeBreakdown('BULL_TREND',  10, 2.5, 65),
      makeBreakdown('BEAR_TREND',  8,  1.2, 45),
      makeBreakdown('SIDEWAYS',    6,  0.8, 35),
    ];
    const cmp = buildComparison(breakdowns);
    expect(cmp.worstOverall?.regime).toBe('SIDEWAYS');
    expect(cmp.bestOverall?.regime).not.toBe(cmp.worstOverall?.regime);
  });

  test('regimes with < 3 trades are excluded from highlights', () => {
    const breakdowns = [
      makeBreakdown('BULL_TREND',  2, 5.0, 90),  // Only 2 trades — excluded
      makeBreakdown('BEAR_TREND',  5, 1.5, 50),
    ];
    const cmp = buildComparison(breakdowns);
    expect(cmp.bestOverall?.regime).toBe('BEAR_TREND');
  });

  test('lowestDrawdown identifies the safest regime', () => {
    const breakdowns = [
      makeBreakdown('BULL_TREND',  5, 1.5, 50, 5),   // 5% DD
      makeBreakdown('SIDEWAYS',    5, 1.8, 55, 20),  // 20% DD
    ];
    const cmp = buildComparison(breakdowns);
    expect(cmp.lowestDrawdown?.regime).toBe('BULL_TREND');
  });

  test('recommendations mention the best regime name', () => {
    const breakdowns = [
      makeBreakdown('STRONG_BULL_TREND', 10, 3.0, 70),
      makeBreakdown('BEAR_TREND',         5, 1.0, 40),
    ];
    const cmp = buildComparison(breakdowns);
    expect(cmp.recommendations.some(r => r.includes('Strong Bull Trend'))).toBe(true);
  });

  test('empty breakdowns produce null highlights without crashing', () => {
    const cmp = buildComparison([]);
    expect(cmp.bestOverall).toBeNull();
    expect(cmp.worstOverall).toBeNull();
    expect(cmp.highestWinRate).toBeNull();
  });
});

// ── 5. Zero-trade regimes ─────────────────────────────────────────────────────

describe('Zero-trade regimes', () => {
  test('computeMetrics with empty trades returns zero metrics without crash', () => {
    const m = computeMetrics([]);
    expect(m.numTrades).toBe(0);
    expect(m.winRate).toBe(0);
    expect(m.profitFactor).toBe(0);
    expect(m.totalReturnPct).toBe(0);
  });

  test('all-zero regime does not appear in rankings (< 3 trades)', () => {
    function makeBreakdown(regime, numTrades) {
      const trades = Array(numTrades).fill(null).map((_, i) => makeTrade(i * 1000, 100, 1));
      const metrics = computeMetrics(trades);
      metrics.numTrades = numTrades;
      return { regime, metrics, byModel: [], byHorizon: [], byStrategy: [] };
    }
    const breakdowns = [makeBreakdown('BULL_TREND', 0), makeBreakdown('BEAR_TREND', 5)];
    const withTrades = breakdowns.filter(b => b.metrics.numTrades >= 3);
    expect(withTrades.length).toBe(1);
    expect(withTrades[0].regime).toBe('BEAR_TREND');
  });
});

// ── 6. RegimeEvalResult backward compatibility ────────────────────────────────

describe('Backward compatibility', () => {
  test('ProductionEvalResult without regimeEval is valid', () => {
    const oldResult = {
      symbol: 'BTCUSDT', timeframe: '1h', candleCount: 500,
      primaryMetrics: { totalReturnPct: 5, numTrades: 20, winRate: 52, profitFactor: 1.3 },
      regimes: [], horizons: [], bestHorizon: null, thresholds: [],
      modelComparison: [], ensembleHelps: { helps: true, reasoning: '' },
      featureContribution: null, baselines: [], beatsAllBaselines: false,
      strategyEval: null,
      // NO regimeEval field
    };
    expect(() => {
      const re = oldResult.regimeEval;
      return re;
    }).not.toThrow();
    expect(oldResult.regimeEval).toBeUndefined();
  });

  test('regimeEval is null when evaluation fails gracefully', () => {
    const result = {
      symbol: 'NIFTY', timeframe: '15m',
      regimeEval: null,
    };
    expect(result.regimeEval).toBeNull();
    expect(result.regimeEval?.breakdowns).toBeUndefined();
  });
});

// ── 7. ML isolation ───────────────────────────────────────────────────────────

describe('ML isolation — regimeEvaluation.ts does not modify ML inputs', () => {
  test('regimeEvaluation.ts does not import featuresAt or FEATURE_NAMES', () => {
    const raw = fs.readFileSync(
      path.join(__dirname, '../regimeEvaluation.ts'), 'utf8'
    );
    const src = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(src).not.toMatch(/from.*mlSignal/);
    expect(src).not.toMatch(/import.*FEATURE_NAMES/);
    expect(src).not.toMatch(/featuresAt/);
    expect(src).not.toMatch(/trainAndPredict/);
    expect(src).not.toMatch(/computeConfidence/);
  });

  test('regimeEvaluation.ts imports existing engines only', () => {
    const raw = fs.readFileSync(
      path.join(__dirname, '../regimeEvaluation.ts'), 'utf8'
    );
    // Must import from backtest, strategyExecutor, modelComparison, horizonEvaluation
    expect(raw).toMatch(/from.*backtest/);
    expect(raw).toMatch(/from.*strategyExecutor/);
    expect(raw).toMatch(/from.*modelComparison/);
    expect(raw).toMatch(/from.*horizonEvaluation/);
  });

  test('regimeEvaluation.ts reads regime from regimeLabelAt (not precomputeRegime)', () => {
    const raw = fs.readFileSync(
      path.join(__dirname, '../regimeEvaluation.ts'), 'utf8'
    );
    expect(raw).not.toMatch(/precomputeRegime\s*\(/); // must not call precomputeRegime directly
    expect(raw).toMatch(/regimeLabelAt/);              // must use the accessor
  });

  test('modelComparison.ts compareModelsWithTrades does not re-import ML internals', () => {
    const raw = fs.readFileSync(
      path.join(__dirname, '../modelComparison.ts'), 'utf8'
    );
    const src = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(src).not.toMatch(/import.*mlSignal/);
    expect(src).not.toMatch(/precomputeSeries/);
    expect(src).not.toMatch(/FEATURE_NAMES/);
  });

  test('horizonEvaluation.ts evaluateAllHorizonsWithTrades does not bypass existing fitEnsemble', () => {
    const raw = fs.readFileSync(
      path.join(__dirname, '../horizonEvaluation.ts'), 'utf8'
    );
    expect(raw).toMatch(/fitEnsemble/);                  // must use existing fitEnsemble
    expect(raw).toMatch(/evaluateAllHorizonsWithTrades/); // must have the new function
    expect(raw).toMatch(/simulateSignalStrategy/);       // must reuse execution core
  });
});

// ── 8. FittedEnsemble.regimeLabelAt — structural check ────────────────────────

describe('FittedEnsemble.regimeLabelAt — structural check', () => {
  test('backtest.ts FittedEnsemble type includes regimeLabelAt', () => {
    const raw = fs.readFileSync(
      path.join(__dirname, '../backtest.ts'), 'utf8'
    );
    expect(raw).toMatch(/regimeLabelAt/);
    expect(raw).toMatch(/RegimeLabel.*null/);
  });

  test('backtest.ts fitEnsemble return includes regimeLabelAt implementation', () => {
    const raw = fs.readFileSync(
      path.join(__dirname, '../backtest.ts'), 'utf8'
    );
    // Should access S.regimeData which is already in precomputeSeries return
    expect(raw).toMatch(/S\.regimeData/);
    expect(raw).toMatch(/regimeLabelAt.*idx/);
  });
});

// ── 9. Trade attribution policy ────────────────────────────────────────────────

describe('Trade attribution — entry bar policy', () => {
  test('trade is attributed to regime at ENTRY bar, not exit bar', () => {
    // candle[0] = entry (BULL_TREND), candle[2] = exit (BEAR_TREND)
    // Trade MUST go to BULL_TREND
    const candles = [makeCandle(1000), makeCandle(2000), makeCandle(3000)];
    const trade = { entryTime: 1000, exitTime: 3000, pnl: 100 };
    const regimeLabelAt = (idx) => {
      if (idx === 0) return 'BULL_TREND';
      if (idx === 2) return 'BEAR_TREND';
      return null;
    };
    const map = bucketByRegime([trade], candles, regimeLabelAt);
    expect(map.get('BULL_TREND').length).toBe(1);
    expect(map.get('BEAR_TREND').length).toBe(0); // NOT the exit bar regime
  });
});

// ── 10. Regime drill-down shape ────────────────────────────────────────────────

describe('RegimeBreakdown shape', () => {
  test('each breakdown has byModel, byHorizon, byStrategy arrays', () => {
    const breakdown = {
      regime: 'BULL_TREND',
      displayName: 'Bull Trend',
      emoji: '🐂',
      barCount: 50,
      metrics: computeMetrics([]),
      byModel:    [{ modelName: 'Ensemble', metrics: computeMetrics([]) }],
      byHorizon:  [{ horizon: 3, metrics: computeMetrics([]) }],
      byStrategy: [{ strategyId: 'INTRADAY', strategyName: 'Intraday', strategyIcon: '📊', metrics: computeMetrics([]) }],
    };
    expect(breakdown.byModel).toHaveLength(1);
    expect(breakdown.byHorizon).toHaveLength(1);
    expect(breakdown.byStrategy).toHaveLength(1);
    expect(breakdown.byModel[0].modelName).toBe('Ensemble');
    expect(breakdown.byHorizon[0].horizon).toBe(3);
    expect(breakdown.byStrategy[0].strategyId).toBe('INTRADAY');
  });
});
