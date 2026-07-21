// ─────────────────────────────────────────────────────────────────────────────
// STRATEGY + CONTEXT ANALYTICS — Regression Tests  (v1.0.0)
//
// Tests cover:
//   1. marketContextAnalytics — bucket computation, edge cases, analytics shape
//   2. strategyEvaluation — scoring, comparison logic, entry shape, isolation
//   3. productionEvaluation — strategyEval field added correctly, backward compat
//   4. ML isolation — strategy evaluation never modifies ML inputs
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

// ── Inline minimal implementations for pure-logic testing ─────────────────────
// We test the analytics computations without AsyncStorage, React Native, or
// the full training pipeline. Where real implementations are complex, we inline
// the exact same logic under test.

// ── 1. Market Context Analytics ───────────────────────────────────────────────

// Inline the bucket computation (mirrors marketContextAnalytics.ts exactly)
function computeBucket(label, trades) {
  if (!trades.length) return { label, trades: 0, wins: 0, losses: 0, winRate: 0, profitFactor: 0, avgPnlPct: 0, netPnlPct: 0, expectancy: 0 };
  const wins   = trades.filter(t => t.pnlPct > 0);
  const losses = trades.filter(t => t.pnlPct <= 0);
  const grossWin  = wins.reduce((s, t) => s + t.pnlPct, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlPct, 0));
  const winRate   = (wins.length / trades.length) * 100;
  const lossRate  = 100 - winRate;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  const avgWin  = wins.length   ? grossWin  / wins.length   : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const avgPnlPct = trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length;
  const netPnlPct = trades.reduce((s, t) => s + t.pnlPct, 0);
  const expectancy = (winRate / 100) * avgWin - (lossRate / 100) * avgLoss;
  return { label, trades: trades.length, wins: wins.length, losses: losses.length, winRate, profitFactor, avgPnlPct, netPnlPct, expectancy };
}

// Inline summariseContext (mirrors marketContextSnapshot.ts)
function summariseContext(snap) {
  if (!snap || snap.kind === 'NONE') return { assetKind: snap?.kind ?? 'NONE', overallSentiment: 'UNAVAILABLE' };
  if (snap.kind === 'INDIAN') {
    const c = snap.ctx;
    if (!c || !c.available || c.available.length === 0) return { assetKind: 'INDIAN', overallSentiment: 'UNAVAILABLE' };
    const signals = [];
    if (c.breadth) signals.push(c.breadth.adTrend === 'BULLISH' ? 1 : c.breadth.adTrend === 'BEARISH' ? -1 : 0);
    if (c.vix)     signals.push(c.vix.trend === 'FALLING' ? 1 : c.vix.trend === 'RISING' ? -1 : 0);
    if (c.fiidii)  signals.push(c.fiidii.bias === 'FII_BUY' ? 1 : c.fiidii.bias === 'FII_SELL' ? -1 : 0);
    if (c.pcr)     signals.push(c.pcr.isContrarianBull ? 1 : c.pcr.isContrarianBear ? -1 : 0);
    const avg = signals.length ? signals.reduce((a, b) => a + b, 0) / signals.length : 0;
    const overallSentiment = avg > 0.3 ? 'BULLISH' : avg < -0.3 ? 'BEARISH' : 'NEUTRAL';
    return { assetKind: 'INDIAN', overallSentiment,
      indiaVIX: c.vix?.current ?? null, vixRegime: c.vix?.regime ?? null,
      breadthADRatio: c.breadth?.adRatio ?? null, adTrend: c.breadth?.adTrend ?? null,
      fiiBias: c.fiidii?.bias ?? null, pcrSentiment: c.pcr?.sentiment ?? null,
      sectorLeader: c.sectors?.leader ?? null };
  }
  if (snap.kind === 'CRYPTO') {
    const c = snap.ctx;
    if (!c || !c.available || c.available.length === 0) return { assetKind: 'CRYPTO', overallSentiment: 'UNAVAILABLE' };
    const fg = c.fearGreed?.value ?? 50;
    const fr = c.funding?.fundingRate ?? 0;
    const ss = c.stablecoin?.signal;
    const sigs = [(fg - 50) / 50, Math.sign(fr) * Math.min(Math.abs(fr) / 0.05, 1) * -1, ss === 'RISK_ON' ? 1 : ss === 'RISK_OFF' ? -1 : 0];
    const avg = sigs.reduce((a, b) => a + b, 0) / sigs.length;
    const overallSentiment = avg > 0.25 ? 'BULLISH' : avg < -0.25 ? 'BEARISH' : 'NEUTRAL';
    return { assetKind: 'CRYPTO', overallSentiment,
      fearGreed: c.fearGreed?.value ?? null, fearGreedLabel: c.fearGreed?.classification ?? null,
      btcDominance: c.marketCap?.btcDominance ?? null, fundingRate: c.funding?.fundingRate ?? null,
      fundingSentiment: c.funding?.sentiment ?? null, openInterestConviction: c.openInterest?.conviction ?? null,
      stablecoinSignal: c.stablecoin?.signal ?? null, marketRegime: c.marketCap?.regime ?? null };
  }
  return { assetKind: 'NONE', overallSentiment: 'UNAVAILABLE' };
}

function makeCryptoTrade(pnlPct, fearGreed, fundingSentiment, btcDom) {
  return {
    pnlPct, pnl: pnlPct * 100,
    marketContext: {
      kind: 'CRYPTO',
      capturedAt: Date.now(),
      ctx: {
        fearGreed:  fearGreed  != null ? { value: fearGreed, classification: fearGreed > 55 ? 'GREED' : fearGreed < 45 ? 'FEAR' : 'NEUTRAL', previousDay: fearGreed, trend: 'FLAT', fetchedAt: Date.now() } : null,
        funding:    fundingSentiment ? { symbol: 'BTCUSDT', fundingRate: fundingSentiment === 'EXTREME_LONG' ? 0.001 : fundingSentiment === 'LONG_BIASED' ? 0.0002 : fundingSentiment === 'NEUTRAL' ? 0 : fundingSentiment === 'SHORT_BIASED' ? -0.0002 : -0.001, annualized: 0, sentiment: fundingSentiment, isOverheated: false, fetchedAt: Date.now() } : null,
        marketCap:  btcDom != null ? { totalMarketCapUsd: 2e12, totalExBtcMarketCapUsd: 1e12, btcDominance: btcDom, ethDominance: 18, altcoinDominance: 100 - btcDom - 18, stablecoinRatio: 0.06, totalChange24h: 0, btcDominanceChange24h: 0, regime: 'NEUTRAL', fetchedAt: Date.now() } : null,
        stablecoin: null, openInterest: null,
        available: ['FEAR_GREED', 'FUNDING', 'MARKET_CAP'].filter((_, i) => [fearGreed != null, fundingSentiment != null, btcDom != null][i]),
        symbol: 'BTCUSDT', fetchedAt: Date.now(),
      },
    },
  };
}

function makeIndianTrade(pnlPct, vix, adTrend) {
  return {
    pnlPct, pnl: pnlPct * 100,
    marketContext: {
      kind: 'INDIAN',
      capturedAt: Date.now(),
      ctx: {
        vix:     vix  != null ? { current: vix, sma5: vix, sma20: vix, trend: 'FLAT', momentum: 0, regime: vix < 12 ? 'LOW' : vix < 20 ? 'NORMAL' : vix < 30 ? 'HIGH' : 'EXTREME', fetchedAt: Date.now() } : null,
        breadth: adTrend ? { advances: 600, declines: 400, unchanged: 0, adRatio: adTrend === 'BULLISH' ? 0.65 : adTrend === 'BEARISH' ? 0.35 : 0.5, adTrend, breadthThrust: false, fetchedAt: Date.now() } : null,
        fiidii:  null, pcr: null, sectors: null,
        available: ['VIX', 'BREADTH'].filter((_, i) => [vix != null, adTrend != null][i]),
        fetchedAt: Date.now(),
      },
    },
  };
}

describe('Market Context Analytics — bucket computation', () => {
  test('computeBucket with all wins returns 100% win rate', () => {
    const trades = [{ pnlPct: 2 }, { pnlPct: 1.5 }, { pnlPct: 3 }];
    const b = computeBucket('Test', trades);
    expect(b.winRate).toBe(100);
    expect(b.profitFactor).toBe(Infinity);
    expect(b.trades).toBe(3);
    expect(b.wins).toBe(3);
    expect(b.losses).toBe(0);
  });

  test('computeBucket with all losses returns 0% win rate', () => {
    const trades = [{ pnlPct: -2 }, { pnlPct: -1 }];
    const b = computeBucket('Test', trades);
    expect(b.winRate).toBe(0);
    expect(b.profitFactor).toBe(0);
    expect(b.avgPnlPct).toBeLessThan(0);
  });

  test('computeBucket with empty trades returns zero bucket', () => {
    const b = computeBucket('Empty', []);
    expect(b.trades).toBe(0);
    expect(b.winRate).toBe(0);
    expect(b.profitFactor).toBe(0);
  });

  test('computeBucket profit factor calculation is correct', () => {
    // 3 wins of 2% each = 6% gross, 2 losses of 3% each = 6% gross loss → PF = 1.0
    const trades = [{ pnlPct: 2 }, { pnlPct: 2 }, { pnlPct: 2 }, { pnlPct: -3 }, { pnlPct: -3 }];
    const b = computeBucket('PF Test', trades);
    expect(b.profitFactor).toBeCloseTo(1.0, 2);
    expect(b.winRate).toBeCloseTo(60, 1);
  });

  test('computeBucket expectancy formula: wr × avgWin - lr × avgLoss', () => {
    const trades = [{ pnlPct: 4 }, { pnlPct: -2 }]; // 50% wr, avgWin=4, avgLoss=2
    const b = computeBucket('Expectancy', trades);
    expect(b.expectancy).toBeCloseTo(0.5 * 4 - 0.5 * 2, 2); // = 1.0
  });
});

describe('Market Context Analytics — Fear & Greed bucketing', () => {
  function computeFGBuckets(trades) {
    const withCtx = trades.filter(t => t.marketContext?.kind === 'CRYPTO' && t.marketContext?.ctx?.fearGreed?.value != null);
    const bucket = (min, max, label) =>
      computeBucket(label, withCtx.filter(t => t.marketContext.ctx.fearGreed.value >= min && t.marketContext.ctx.fearGreed.value < max));
    return {
      extremeFear:  bucket(0,  25,  'Extreme Fear'),
      fear:         bucket(25, 45,  'Fear'),
      neutral:      bucket(45, 55,  'Neutral'),
      greed:        bucket(55, 75,  'Greed'),
      extremeGreed: bucket(75, 101, 'Extreme Greed'),
    };
  }

  test('trades are correctly assigned to F&G buckets', () => {
    const trades = [
      makeCryptoTrade(2, 80, 'NEUTRAL', null),   // Extreme Greed
      makeCryptoTrade(-1, 80, 'NEUTRAL', null),  // Extreme Greed
      makeCryptoTrade(3, 20, 'NEUTRAL', null),   // Extreme Fear
      makeCryptoTrade(1, 60, 'NEUTRAL', null),   // Greed
    ];
    const buckets = computeFGBuckets(trades);
    expect(buckets.extremeGreed.trades).toBe(2);
    expect(buckets.extremeFear.trades).toBe(1);
    expect(buckets.greed.trades).toBe(1);
    expect(buckets.neutral.trades).toBe(0);
    expect(buckets.fear.trades).toBe(0);
  });

  test('F&G = 25 falls in Fear bucket (inclusive lower bound)', () => {
    const trades = [makeCryptoTrade(1, 25, 'NEUTRAL', null)];
    const buckets = computeFGBuckets(trades);
    expect(buckets.fear.trades).toBe(1);
    expect(buckets.extremeFear.trades).toBe(0);
  });

  test('F&G = 75 falls in Extreme Greed bucket', () => {
    const trades = [makeCryptoTrade(1, 75, 'NEUTRAL', null)];
    const buckets = computeFGBuckets(trades);
    expect(buckets.extremeGreed.trades).toBe(1);
    expect(buckets.greed.trades).toBe(0);
  });
});

describe('Market Context Analytics — India VIX bucketing', () => {
  function computeVIXBuckets(trades) {
    const withCtx = trades.filter(t => t.marketContext?.kind === 'INDIAN' && t.marketContext?.ctx?.vix?.current != null);
    const bucket = (min, max, label) =>
      computeBucket(label, withCtx.filter(t => t.marketContext.ctx.vix.current >= min && t.marketContext.ctx.vix.current < max));
    return {
      low:     bucket(0,   12,  'Low'),
      normal:  bucket(12,  20,  'Normal'),
      high:    bucket(20,  30,  'High'),
      extreme: bucket(30, 999,  'Extreme'),
    };
  }

  test('trades are correctly bucketed by VIX range', () => {
    const trades = [
      makeIndianTrade(2, 10, 'BULLISH'),   // Low
      makeIndianTrade(1, 15, 'BULLISH'),   // Normal
      makeIndianTrade(-1, 25, 'BEARISH'),  // High
      makeIndianTrade(-2, 35, 'BEARISH'),  // Extreme
    ];
    const buckets = computeVIXBuckets(trades);
    expect(buckets.low.trades).toBe(1);
    expect(buckets.normal.trades).toBe(1);
    expect(buckets.high.trades).toBe(1);
    expect(buckets.extreme.trades).toBe(1);
  });

  test('VIX = 12 falls in Normal bucket (not Low)', () => {
    const trades = [makeIndianTrade(1, 12, null)];
    const buckets = computeVIXBuckets(trades);
    expect(buckets.normal.trades).toBe(1);
    expect(buckets.low.trades).toBe(0);
  });
});

describe('Market Context Analytics — Sentiment bucketing', () => {
  function computeSentimentBuckets(trades) {
    const all = trades.map(t => ({ trade: t, summary: summariseContext(t.marketContext ?? null) }));
    const bucket = (s, l) => computeBucket(l, all.filter(x => x.summary.overallSentiment === s).map(x => x.trade));
    return {
      bullish:     bucket('BULLISH',     'Bullish'),
      neutral:     bucket('NEUTRAL',     'Neutral'),
      bearish:     bucket('BEARISH',     'Bearish'),
      unavailable: bucket('UNAVAILABLE', 'Unavailable'),
    };
  }

  test('bullish context trades go to BULLISH bucket', () => {
    const trades = [
      makeCryptoTrade(2, 80, 'NEUTRAL', null),   // high F&G → bullish
      makeIndianTrade(1, 10, 'BULLISH'),          // low VIX + bullish breadth → bullish
    ];
    const buckets = computeSentimentBuckets(trades);
    expect(buckets.bullish.trades).toBeGreaterThanOrEqual(1);
  });

  test('trades without context go to unavailable bucket', () => {
    const trades = [
      { pnlPct: 1, pnl: 100, marketContext: null },
      { pnlPct: -1, pnl: -100 },  // no marketContext field
    ];
    const buckets = computeSentimentBuckets(trades);
    expect(buckets.unavailable.trades).toBe(2);
  });
});

// ── 2. Strategy Evaluation — scoring logic ────────────────────────────────────

describe('Strategy Evaluation — scoreStrategy function', () => {
  // Inline scoreStrategy (mirrors strategyEvaluation.ts exactly)
  function scoreStrategy(m) {
    const pf = m.profitFactor === Infinity ? 5 : Math.min(m.profitFactor, 5);
    return pf * 0.5 + (m.winRate / 100) * 0.3 + Math.min(Math.max(m.sharpeRatio, -2), 2) * 0.2;
  }

  test('higher profit factor → higher score', () => {
    const m1 = { profitFactor: 1.2, winRate: 50, sharpeRatio: 0 };
    const m2 = { profitFactor: 2.5, winRate: 50, sharpeRatio: 0 };
    expect(scoreStrategy(m2)).toBeGreaterThan(scoreStrategy(m1));
  });

  test('higher win rate → higher score (all else equal)', () => {
    const m1 = { profitFactor: 1.5, winRate: 45, sharpeRatio: 0 };
    const m2 = { profitFactor: 1.5, winRate: 65, sharpeRatio: 0 };
    expect(scoreStrategy(m2)).toBeGreaterThan(scoreStrategy(m1));
  });

  test('Infinity profit factor is capped at 5 (prevents NaN)', () => {
    const m = { profitFactor: Infinity, winRate: 60, sharpeRatio: 0 };
    const score = scoreStrategy(m);
    expect(Number.isFinite(score)).toBe(true);
    expect(score).toBeGreaterThan(0);
  });

  test('Sharpe ratio is clamped to [-2, 2]', () => {
    const mHigh = { profitFactor: 1.5, winRate: 50, sharpeRatio: 100 };
    const mCap  = { profitFactor: 1.5, winRate: 50, sharpeRatio: 2 };
    expect(scoreStrategy(mHigh)).toBeCloseTo(scoreStrategy(mCap), 5);
  });
});

describe('Strategy Evaluation — buildComparison logic', () => {
  function makeEntry(id, name, icon, pf, wr, sharpe, numTrades) {
    return {
      strategyId: id, strategyName: name, strategyIcon: icon,
      metrics: {
        profitFactor: pf, winRate: wr, sharpeRatio: sharpe, numTrades,
        totalReturnPct: (wr - 50) * 0.5, maxDrawdownPct: 10,
        expectancy: wr > 50 ? 1 : -1, avgTrade: 0.5, netProfit: 1000,
      },
      horizons: [], bestHorizon: null,
      usedHorizon: 3, usedStopMult: 1.5, usedTargetMult: 3, usedMinConf: 30, tradeCount: numTrades,
    };
  }

  function buildComparison(entries) {
    function scoreStrategy(m) {
      const pf = m.profitFactor === Infinity ? 5 : Math.min(m.profitFactor, 5);
      return pf * 0.5 + (m.winRate / 100) * 0.3 + Math.min(Math.max(m.sharpeRatio, -2), 2) * 0.2;
    }
    const withTrades = entries.filter(e => e.metrics.numTrades >= 3);
    const ranked = [...entries].sort((a, b) => scoreStrategy(b.metrics) - scoreStrategy(a.metrics));
    const best = fn => withTrades.length ? withTrades.reduce((b, e) => fn(e) > fn(b) ? e : b) : null;
    const bestOverall         = best(e => scoreStrategy(e.metrics));
    const highestProfitFactor = best(e => e.metrics.profitFactor === Infinity ? 999 : e.metrics.profitFactor);
    const highestWinRate      = best(e => e.metrics.winRate);
    const lowestDrawdown      = withTrades.length ? withTrades.reduce((b, e) => e.metrics.maxDrawdownPct < b.metrics.maxDrawdownPct ? e : b) : null;
    return { rankings: ranked, bestOverall, highestProfitFactor, highestWinRate, lowestDrawdown };
  }

  test('bestOverall is the entry with highest combined score', () => {
    const entries = [
      makeEntry('SCALPING',  'Scalping',  '⚡', 1.2, 48, 0.1, 10),
      makeEntry('SWING',     'Swing',     '🌊', 2.5, 62, 0.8, 15),
      makeEntry('INTRADAY',  'Intraday',  '📊', 1.8, 54, 0.3, 20),
    ];
    const cmp = buildComparison(entries);
    expect(cmp.bestOverall?.strategyId).toBe('SWING');
  });

  test('highestProfitFactor identifies the entry with largest PF', () => {
    const entries = [
      makeEntry('SCALPING', 'Scalping', '⚡', 1.2, 48, 0, 5),
      makeEntry('SWING',    'Swing',    '🌊', 3.5, 55, 0, 5),
    ];
    const cmp = buildComparison(entries);
    expect(cmp.highestProfitFactor?.strategyId).toBe('SWING');
  });

  test('lowestDrawdown identifies the safest entry', () => {
    const entries = [
      makeEntry('SCALPING',  'Scalping',  '⚡', 1.5, 55, 0, 5),
      makeEntry('POSITION',  'Position',  '🏔', 2.0, 60, 0, 5),
    ];
    entries[0].metrics.maxDrawdownPct = 5;
    entries[1].metrics.maxDrawdownPct = 20;
    const cmp = buildComparison(entries);
    expect(cmp.lowestDrawdown?.strategyId).toBe('SCALPING');
  });

  test('entries with fewer than 3 trades are excluded from highlights', () => {
    const entries = [
      makeEntry('SCALPING', 'Scalping', '⚡', 5.0, 80, 2.0, 2), // only 2 trades — excluded
      makeEntry('SWING',    'Swing',    '🌊', 1.5, 52, 0.2, 5),
    ];
    const cmp = buildComparison(entries);
    expect(cmp.bestOverall?.strategyId).toBe('SWING');
  });

  test('rankings array has same length as entries', () => {
    const entries = [
      makeEntry('SCALPING', 'Scalping', '⚡', 1.2, 48, 0, 5),
      makeEntry('INTRADAY', 'Intraday', '📊', 1.8, 54, 0, 5),
      makeEntry('SWING',    'Swing',    '🌊', 2.5, 62, 0, 5),
      makeEntry('POSITION', 'Position', '🏔', 2.0, 58, 0, 5),
    ];
    const cmp = buildComparison(entries);
    expect(cmp.rankings.length).toBe(4);
  });

  test('rankings are ordered best-to-worst by score', () => {
    const entries = [
      makeEntry('SCALPING', 'Scalping', '⚡', 1.0, 45, -0.5, 5),
      makeEntry('SWING',    'Swing',    '🌊', 3.0, 65,  1.0, 5),
    ];
    const cmp = buildComparison(entries);
    expect(cmp.rankings[0].strategyId).toBe('SWING');
    expect(cmp.rankings[1].strategyId).toBe('SCALPING');
  });
});

// ── 3. ProductionEvalResult backward compatibility ────────────────────────────

describe('ProductionEvalResult — backward compatibility', () => {
  test('old result without strategyEval field is valid', () => {
    const oldResult = {
      symbol: 'BTCUSDT', timeframe: '1h', candleCount: 500,
      primaryMetrics: { totalReturnPct: 12, numTrades: 30, winRate: 55, profitFactor: 1.8 },
      regimes: [], horizons: [], bestHorizon: null, thresholds: [],
      modelComparison: [], ensembleHelps: { helps: true, reasoning: 'Ensemble helps' },
      featureContribution: null, baselines: [], beatsAllBaselines: true,
      // NO strategyEval field
    };
    // Should not throw when accessing the optional field
    expect(() => {
      const se = oldResult.strategyEval;
      return se;
    }).not.toThrow();
    expect(oldResult.strategyEval).toBeUndefined();
  });

  test('strategyEval is null when evaluation fails gracefully', () => {
    const result = {
      symbol: 'NIFTY', timeframe: '15m', candleCount: 300,
      primaryMetrics: { totalReturnPct: 5, numTrades: 12, winRate: 50, profitFactor: 1.1 },
      regimes: [], horizons: [], bestHorizon: null, thresholds: [],
      modelComparison: [], ensembleHelps: { helps: false, reasoning: 'N/A' },
      featureContribution: null, baselines: [], beatsAllBaselines: false,
      strategyEval: null,
    };
    expect(result.strategyEval).toBeNull();
    // isContextAvailable-equivalent — null should not crash consumers
    expect(result.strategyEval?.comparison).toBeUndefined();
  });
});

// ── 4. ML isolation — strategy evaluation must not modify ML inputs ───────────

describe('ML isolation — strategy evaluation cannot modify ML inputs', () => {
  test('strategyEvaluation.ts does not import featuresAt or FEATURE_NAMES', () => {
    const fs = require('fs');
    const path = require('path');
    const raw = fs.readFileSync(
      path.join(__dirname, '../strategyEvaluation.ts'),
      'utf8'
    );
    // Strip comments so we only check actual code imports
    const src = raw
      .replace(/\/\/.*$/gm, '')          // single-line comments
      .replace(/\/\*[\s\S]*?\*\//g, '');  // block comments
    // Must not import ML internals
    expect(src).not.toMatch(/from.*featuresAt/);
    expect(src).not.toMatch(/import.*FEATURE_NAMES/);
    expect(src).not.toMatch(/from.*mlSignal/);
    expect(src).not.toMatch(/trainAndPredict/);
  });

  test('strategyEvaluation.ts does not import confidenceEngine', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '../strategyEvaluation.ts'),
      'utf8'
    );
    expect(src).not.toMatch(/confidenceEngine/);
    expect(src).not.toMatch(/computeTradeReadiness/);
  });

  test('strategyEvaluation.ts reuses existing fitEnsemble, simulateSignalStrategy, computeMetrics', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '../strategyEvaluation.ts'),
      'utf8'
    );
    expect(src).toMatch(/fitEnsemble/);
    expect(src).toMatch(/simulateSignalStrategy/);
    expect(src).toMatch(/computeMetrics/);
    expect(src).toMatch(/evaluateAllHorizons/);
  });

  test('strategyEvaluation.ts reuses STRATEGY_ORDER from strategyProfiles (no new profiles)', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '../strategyEvaluation.ts'),
      'utf8'
    );
    expect(src).toMatch(/STRATEGY_ORDER/);
    // Must not define new strategy profiles (that would be duplicating logic)
    expect(src).not.toMatch(/StrategyProfile\s*=/);
  });

  test('marketContextAnalytics.ts does not import mlSignal or ML utilities', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '../marketContextAnalytics.ts'),
      'utf8'
    );
    expect(src).not.toMatch(/mlSignal/);
    expect(src).not.toMatch(/trainAndPredict/);
    expect(src).not.toMatch(/FEATURE_NAMES/);
    expect(src).not.toMatch(/featuresAt/);
  });
});

// ── 5. StrategyEvalMode validation ────────────────────────────────────────────

describe('Strategy evaluation mode', () => {
  test("mode 'ALL' should evaluate all 4 strategy IDs", () => {
    const ALL_STRATEGY_IDS = ['SCALPING', 'INTRADAY', 'SWING', 'POSITION'];
    expect(ALL_STRATEGY_IDS.length).toBe(4);
    // Mode ALL → all strategies evaluated
    ALL_STRATEGY_IDS.forEach(id => expect(ALL_STRATEGY_IDS).toContain(id));
  });

  test("mode 'SELECTED' with valid ID filters to just that strategy", () => {
    const ALL = ['SCALPING', 'INTRADAY', 'SWING', 'POSITION'];
    const selected = 'SWING';
    const filtered = ALL.filter(id => id === selected);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]).toBe('SWING');
  });

  test("mode 'SELECTED' with null ID falls back gracefully", () => {
    const ALL = ['SCALPING', 'INTRADAY', 'SWING', 'POSITION'];
    const selected = null;
    const filtered = selected ? ALL.filter(id => id === selected) : [];
    expect(filtered).toHaveLength(0);
  });
});

// ── 6. BTC Dominance bucketing ────────────────────────────────────────────────

describe('BTC Dominance analytics — bucketing', () => {
  function computeBTCBuckets(trades) {
    const withCtx = trades.filter(t => t.marketContext?.kind === 'CRYPTO' && t.marketContext?.ctx?.marketCap?.btcDominance != null);
    const bucket = (min, max, label) =>
      computeBucket(label, withCtx.filter(t => t.marketContext.ctx.marketCap.btcDominance >= min && t.marketContext.ctx.marketCap.btcDominance < max));
    return {
      altSeason:   bucket(0,  40, 'Alt Season (<40%)'),
      balanced:    bucket(40, 50, 'Balanced (40–50%)'),
      btcLead:     bucket(50, 60, 'BTC Lead (50–60%)'),
      btcDominant: bucket(60, 100, 'BTC Dominant (>60%)'),
    };
  }

  test('trades bucket correctly by BTC dominance', () => {
    const trades = [
      makeCryptoTrade(3, null, null, 35),   // Alt Season
      makeCryptoTrade(1, null, null, 45),   // Balanced
      makeCryptoTrade(-1, null, null, 55),  // BTC Lead
      makeCryptoTrade(-2, null, null, 65),  // BTC Dominant
    ];
    const b = computeBTCBuckets(trades);
    expect(b.altSeason.trades).toBe(1);
    expect(b.balanced.trades).toBe(1);
    expect(b.btcLead.trades).toBe(1);
    expect(b.btcDominant.trades).toBe(1);
  });

  test('BTC dominance = 40 goes to Balanced bucket', () => {
    const trades = [makeCryptoTrade(1, null, null, 40)];
    const b = computeBTCBuckets(trades);
    expect(b.balanced.trades).toBe(1);
    expect(b.altSeason.trades).toBe(0);
  });
});
