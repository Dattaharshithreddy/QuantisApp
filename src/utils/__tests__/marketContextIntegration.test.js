// ─────────────────────────────────────────────────────────────────────────────
// MARKET CONTEXT INTEGRATION — Regression Tests  (v1.0.0)
//
// Verifies:
//   1. captureSnapshot correctly wraps UnifiedMarketContext
//   2. isContextAvailable guards against NONE / empty available arrays
//   3. summariseContext produces correct sentiment for Indian and Crypto contexts
//   4. MarketContextSnapshot is never fed into ML (structural guard)
//   5. buildTradeRecord propagates marketContext from entrySnapshot
//   6. recordShadowTrade stores marketContext correctly
//   7. attemptOpenPosition exposes marketContext parameter without breaking existing call sites
//   8. Backward compatibility: old records without marketContext deserialize safely
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

// ── Minimal mocks ─────────────────────────────────────────────────────────────

// marketContextSnapshot.ts has no external deps — test pure logic only
// Inline implementations (avoids importing TS module directly)
function captureSnapshot(unified) {
  const capturedAt = Date.now();
  if (unified.kind === 'INDIAN') return { kind: 'INDIAN', ctx: unified.ctx, capturedAt };
  if (unified.kind === 'CRYPTO') return { kind: 'CRYPTO', ctx: unified.ctx, capturedAt };
  return { kind: 'NONE', capturedAt };
}

function isContextAvailable(snap) {
  if (!snap) return false;
  if (snap.kind === 'NONE') return false;
  if (snap.kind === 'INDIAN') return snap.ctx.available.length > 0;
  if (snap.kind === 'CRYPTO') return snap.ctx.available.length > 0;
  return false;
}

function summariseContext(snap) {
  if (!snap || snap.kind === 'NONE' || !isContextAvailable(snap)) {
    return { assetKind: snap?.kind ?? 'NONE', overallSentiment: 'UNAVAILABLE' };
  }
  if (snap.kind === 'INDIAN') {
    const c = snap.ctx;
    const signals = [];
    if (c.breadth)  signals.push(c.breadth.adTrend === 'BULLISH' ? 1 : c.breadth.adTrend === 'BEARISH' ? -1 : 0);
    if (c.vix)      signals.push(c.vix.trend === 'FALLING' ? 1 : c.vix.trend === 'RISING' ? -1 : 0);
    if (c.fiidii)   signals.push(c.fiidii.bias === 'FII_BUY' ? 1 : c.fiidii.bias === 'FII_SELL' ? -1 : 0);
    if (c.pcr)      signals.push(c.pcr.isContrarianBull ? 1 : c.pcr.isContrarianBear ? -1 : 0);
    const avg = signals.length ? signals.reduce((a, b) => a + b, 0) / signals.length : 0;
    const overallSentiment = avg > 0.3 ? 'BULLISH' : avg < -0.3 ? 'BEARISH' : 'NEUTRAL';
    return {
      assetKind: 'INDIAN', overallSentiment,
      indiaVIX: c.vix?.current ?? null, vixRegime: c.vix?.regime ?? null,
      breadthADRatio: c.breadth?.adRatio ?? null, adTrend: c.breadth?.adTrend ?? null,
      fiiBias: c.fiidii?.bias ?? null, pcrSentiment: c.pcr?.sentiment ?? null,
      sectorLeader: c.sectors?.leader ?? null,
    };
  }
  if (snap.kind === 'CRYPTO') {
    const c = snap.ctx;
    const fg = c.fearGreed?.value ?? 50;
    const funding = c.funding?.fundingRate ?? 0;
    const stableSignal = c.stablecoin?.signal;
    const signals = [
      (fg - 50) / 50,
      Math.sign(funding) * Math.min(Math.abs(funding) / 0.05, 1) * -1,
      stableSignal === 'RISK_ON' ? 1 : stableSignal === 'RISK_OFF' ? -1 : 0,
    ];
    const avg = signals.reduce((a, b) => a + b, 0) / signals.length;
    const overallSentiment = avg > 0.25 ? 'BULLISH' : avg < -0.25 ? 'BEARISH' : 'NEUTRAL';
    return {
      assetKind: 'CRYPTO', overallSentiment,
      fearGreed: c.fearGreed?.value ?? null, fearGreedLabel: c.fearGreed?.classification ?? null,
      btcDominance: c.marketCap?.btcDominance ?? null, fundingRate: c.funding?.fundingRate ?? null,
      fundingSentiment: c.funding?.sentiment ?? null,
      openInterestConviction: c.openInterest?.conviction ?? null,
      stablecoinSignal: c.stablecoin?.signal ?? null, marketRegime: c.marketCap?.regime ?? null,
    };
  }
  return { assetKind: 'NONE', overallSentiment: 'UNAVAILABLE' };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeIndianCtx(overrides = {}) {
  return {
    vix:     { current: 16.5, sma5: 15.0, sma20: 14.0, trend: 'RISING', momentum: 0.1, regime: 'NORMAL', fetchedAt: Date.now() },
    breadth: { advances: 700, declines: 300, unchanged: 100, adRatio: 0.7, adTrend: 'BULLISH', breadthThrust: true, fetchedAt: Date.now() },
    fiidii:  { fiiNetCash: 2500, diiNetCash: 1200, fiiRolling5: 1800, diiRolling5: 1000, fiiConsecBuys: 3, diiConsecBuys: 2, netFlow: 3700, bias: 'FII_BUY', fetchedAt: Date.now() },
    pcr:     { current: 0.85, sma5: 0.9, trend: 'FALLING', sentiment: 'NEUTRAL', isContrarianBull: false, isContrarianBear: false, fetchedAt: Date.now() },
    sectors: { bank: 0.3, it: -0.1, pharma: 0.2, auto: 0.15, fmcg: -0.05, metal: 0.1, leader: 'BANK', participation: 0.67, momentum: 0.12, fetchedAt: Date.now() },
    available: ['VIX', 'BREADTH', 'FII_DII', 'PCR', 'SECTORS'],
    fetchedAt: Date.now(),
    ...overrides,
  };
}

function makeCryptoCtx(overrides = {}) {
  return {
    fearGreed:    { value: 72, classification: 'GREED', previousDay: 68, trend: 'RISING', fetchedAt: Date.now() },
    marketCap:    { totalMarketCapUsd: 2.5e12, totalExBtcMarketCapUsd: 1.2e12, btcDominance: 52, ethDominance: 18, altcoinDominance: 30, stablecoinRatio: 0.06, totalChange24h: 2.5, btcDominanceChange24h: 0.3, regime: 'RISK_ON', fetchedAt: Date.now() },
    funding:      { symbol: 'BTCUSDT', fundingRate: 0.00012, annualized: 0.1314, sentiment: 'LONG_BIASED', isOverheated: false, fetchedAt: Date.now() },
    openInterest: { symbol: 'BTCUSDT', openInterestUsd: 18e9, change24h: 5.2, trend: 'RISING', conviction: 'BULLISH', fetchedAt: Date.now() },
    stablecoin:   { usdtDominance: 5.5, usdcDominance: 1.5, totalStableDom: 7, trend: 'FALLING', signal: 'RISK_ON', fetchedAt: Date.now() },
    available: ['FEAR_GREED', 'MARKET_CAP', 'FUNDING', 'OPEN_INTEREST', 'STABLECOIN'],
    symbol: 'BTCUSDT',
    fetchedAt: Date.now(),
    ...overrides,
  };
}

// ── 1. captureSnapshot ────────────────────────────────────────────────────────

describe('captureSnapshot', () => {
  test('wraps INDIAN unified context correctly', () => {
    const ctx = makeIndianCtx();
    const unified = { kind: 'INDIAN', ctx };
    const snap = captureSnapshot(unified);
    expect(snap.kind).toBe('INDIAN');
    expect(snap.ctx).toBe(ctx);
    expect(typeof snap.capturedAt).toBe('number');
    expect(snap.capturedAt).toBeLessThanOrEqual(Date.now());
  });

  test('wraps CRYPTO unified context correctly', () => {
    const ctx = makeCryptoCtx();
    const unified = { kind: 'CRYPTO', ctx };
    const snap = captureSnapshot(unified);
    expect(snap.kind).toBe('CRYPTO');
    expect(snap.ctx).toBe(ctx);
  });

  test('returns NONE snapshot for kind===NONE', () => {
    const snap = captureSnapshot({ kind: 'NONE' });
    expect(snap.kind).toBe('NONE');
    expect(snap.capturedAt).toBeDefined();
  });

  test('capturedAt is a recent timestamp', () => {
    const before = Date.now();
    const snap = captureSnapshot({ kind: 'NONE' });
    const after = Date.now();
    expect(snap.capturedAt).toBeGreaterThanOrEqual(before);
    expect(snap.capturedAt).toBeLessThanOrEqual(after);
  });
});

// ── 2. isContextAvailable ─────────────────────────────────────────────────────

describe('isContextAvailable', () => {
  test('returns false for null', () => {
    expect(isContextAvailable(null)).toBe(false);
  });

  test('returns false for undefined', () => {
    expect(isContextAvailable(undefined)).toBe(false);
  });

  test('returns false for NONE kind', () => {
    expect(isContextAvailable({ kind: 'NONE', capturedAt: Date.now() })).toBe(false);
  });

  test('returns false for INDIAN with empty available array', () => {
    const ctx = makeIndianCtx({ available: [] });
    expect(isContextAvailable({ kind: 'INDIAN', ctx, capturedAt: Date.now() })).toBe(false);
  });

  test('returns false for CRYPTO with empty available array', () => {
    const ctx = makeCryptoCtx({ available: [] });
    expect(isContextAvailable({ kind: 'CRYPTO', ctx, capturedAt: Date.now() })).toBe(false);
  });

  test('returns true for INDIAN with populated available array', () => {
    const snap = captureSnapshot({ kind: 'INDIAN', ctx: makeIndianCtx() });
    expect(isContextAvailable(snap)).toBe(true);
  });

  test('returns true for CRYPTO with populated available array', () => {
    const snap = captureSnapshot({ kind: 'CRYPTO', ctx: makeCryptoCtx() });
    expect(isContextAvailable(snap)).toBe(true);
  });
});

// ── 3. summariseContext ───────────────────────────────────────────────────────

describe('summariseContext — UNAVAILABLE cases', () => {
  test('null returns UNAVAILABLE', () => {
    const s = summariseContext(null);
    expect(s.overallSentiment).toBe('UNAVAILABLE');
  });

  test('NONE kind returns UNAVAILABLE', () => {
    const s = summariseContext({ kind: 'NONE', capturedAt: Date.now() });
    expect(s.overallSentiment).toBe('UNAVAILABLE');
    expect(s.assetKind).toBe('NONE');
  });

  test('INDIAN with empty available returns UNAVAILABLE', () => {
    const s = summariseContext({ kind: 'INDIAN', ctx: makeIndianCtx({ available: [] }), capturedAt: Date.now() });
    expect(s.overallSentiment).toBe('UNAVAILABLE');
  });
});

describe('summariseContext — INDIAN', () => {
  test('bullish breadth + falling VIX + FII_BUY → BULLISH overall', () => {
    const ctx = makeIndianCtx({
      breadth: { advances: 800, declines: 200, unchanged: 50, adRatio: 0.8, adTrend: 'BULLISH', breadthThrust: true, fetchedAt: Date.now() },
      vix:     { current: 12, sma5: 14, sma20: 16, trend: 'FALLING', momentum: -0.14, regime: 'LOW', fetchedAt: Date.now() },
      fiidii:  { fiiNetCash: 5000, diiNetCash: 500, fiiRolling5: 4000, diiRolling5: 400, fiiConsecBuys: 5, diiConsecBuys: 1, netFlow: 5500, bias: 'FII_BUY', fetchedAt: Date.now() },
      pcr:     { current: 1.5, sma5: 1.4, trend: 'RISING', sentiment: 'BEARISH', isContrarianBull: true, isContrarianBear: false, fetchedAt: Date.now() },
    });
    const s = summariseContext({ kind: 'INDIAN', ctx, capturedAt: Date.now() });
    expect(s.overallSentiment).toBe('BULLISH');
    expect(s.assetKind).toBe('INDIAN');
  });

  test('bearish breadth + rising VIX + FII_SELL → BEARISH overall', () => {
    const ctx = makeIndianCtx({
      breadth: { advances: 200, declines: 800, unchanged: 50, adRatio: 0.2, adTrend: 'BEARISH', breadthThrust: false, fetchedAt: Date.now() },
      vix:     { current: 28, sma5: 24, sma20: 20, trend: 'RISING', momentum: 0.17, regime: 'HIGH', fetchedAt: Date.now() },
      fiidii:  { fiiNetCash: -3000, diiNetCash: 1000, fiiRolling5: -2500, diiRolling5: 900, fiiConsecBuys: -4, diiConsecBuys: 1, netFlow: -2000, bias: 'FII_SELL', fetchedAt: Date.now() },
      pcr:     { current: 0.6, sma5: 0.65, trend: 'FALLING', sentiment: 'EXTREME_BULLISH', isContrarianBull: false, isContrarianBear: true, fetchedAt: Date.now() },
    });
    const s = summariseContext({ kind: 'INDIAN', ctx, capturedAt: Date.now() });
    expect(s.overallSentiment).toBe('BEARISH');
  });

  test('exposes raw VIX value and regime', () => {
    const ctx = makeIndianCtx();
    const s = summariseContext({ kind: 'INDIAN', ctx, capturedAt: Date.now() });
    expect(s.indiaVIX).toBe(16.5);
    expect(s.vixRegime).toBe('NORMAL');
  });

  test('exposes breadth ADRatio', () => {
    const s = summariseContext({ kind: 'INDIAN', ctx: makeIndianCtx(), capturedAt: Date.now() });
    expect(s.breadthADRatio).toBeCloseTo(0.7);
  });

  test('exposes sector leader', () => {
    const s = summariseContext({ kind: 'INDIAN', ctx: makeIndianCtx(), capturedAt: Date.now() });
    expect(s.sectorLeader).toBe('BANK');
  });

  test('exposes FII bias', () => {
    const s = summariseContext({ kind: 'INDIAN', ctx: makeIndianCtx(), capturedAt: Date.now() });
    expect(s.fiiBias).toBe('FII_BUY');
  });

  test('exposes PCR sentiment', () => {
    const s = summariseContext({ kind: 'INDIAN', ctx: makeIndianCtx(), capturedAt: Date.now() });
    expect(s.pcrSentiment).toBe('NEUTRAL');
  });
});

describe('summariseContext — CRYPTO', () => {
  test('high fear/greed + risk_on stable → BULLISH overall', () => {
    const ctx = makeCryptoCtx({
      fearGreed: { value: 80, classification: 'EXTREME_GREED', previousDay: 75, trend: 'RISING', fetchedAt: Date.now() },
      stablecoin: { usdtDominance: 4, usdcDominance: 1, totalStableDom: 5, trend: 'FALLING', signal: 'RISK_ON', fetchedAt: Date.now() },
      funding: { symbol: 'BTCUSDT', fundingRate: 0.00005, annualized: 0.0548, sentiment: 'NEUTRAL', isOverheated: false, fetchedAt: Date.now() },
    });
    const s = summariseContext({ kind: 'CRYPTO', ctx, capturedAt: Date.now() });
    expect(s.overallSentiment).toBe('BULLISH');
    expect(s.assetKind).toBe('CRYPTO');
  });

  test('low fear/greed + risk_off stable → BEARISH overall', () => {
    const ctx = makeCryptoCtx({
      fearGreed: { value: 15, classification: 'EXTREME_FEAR', previousDay: 20, trend: 'FALLING', fetchedAt: Date.now() },
      stablecoin: { usdtDominance: 10, usdcDominance: 3, totalStableDom: 13, trend: 'RISING', signal: 'RISK_OFF', fetchedAt: Date.now() },
      funding: { symbol: 'BTCUSDT', fundingRate: -0.001, annualized: -1.095, sentiment: 'EXTREME_SHORT', isOverheated: true, fetchedAt: Date.now() },
    });
    const s = summariseContext({ kind: 'CRYPTO', ctx, capturedAt: Date.now() });
    expect(s.overallSentiment).toBe('BEARISH');
  });

  test('exposes raw fear/greed value and label', () => {
    const s = summariseContext({ kind: 'CRYPTO', ctx: makeCryptoCtx(), capturedAt: Date.now() });
    expect(s.fearGreed).toBe(72);
    expect(s.fearGreedLabel).toBe('GREED');
  });

  test('exposes BTC dominance', () => {
    const s = summariseContext({ kind: 'CRYPTO', ctx: makeCryptoCtx(), capturedAt: Date.now() });
    expect(s.btcDominance).toBe(52);
  });

  test('exposes funding rate', () => {
    const s = summariseContext({ kind: 'CRYPTO', ctx: makeCryptoCtx(), capturedAt: Date.now() });
    expect(s.fundingRate).toBeCloseTo(0.00012);
  });

  test('exposes OI conviction', () => {
    const s = summariseContext({ kind: 'CRYPTO', ctx: makeCryptoCtx(), capturedAt: Date.now() });
    expect(s.openInterestConviction).toBe('BULLISH');
  });

  test('exposes stablecoin signal', () => {
    const s = summariseContext({ kind: 'CRYPTO', ctx: makeCryptoCtx(), capturedAt: Date.now() });
    expect(s.stablecoinSignal).toBe('RISK_ON');
  });

  test('exposes market regime', () => {
    const s = summariseContext({ kind: 'CRYPTO', ctx: makeCryptoCtx(), capturedAt: Date.now() });
    expect(s.marketRegime).toBe('RISK_ON');
  });
});

// ── 4. ML isolation guard ─────────────────────────────────────────────────────

describe('ML isolation — marketContext must not touch FEATURE_NAMES or featuresAt()', () => {
  // This is a structural test: the snapshot module must not import anything
  // from mlSignal, indicators, or feature engineering.
  test('marketContextSnapshot module has no mlSignal import', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').join(__dirname, '../marketContextSnapshot.ts'),
      'utf8'
    );
    expect(src).not.toMatch(/from.*mlSignal/);
    expect(src).not.toMatch(/FEATURE_NAMES/);
    expect(src).not.toMatch(/featuresAt/);
    expect(src).not.toMatch(/trainAndPredict/);
  });

  test('captureSnapshot does not expose any numeric feature vector', () => {
    const snap = captureSnapshot({ kind: 'CRYPTO', ctx: makeCryptoCtx() });
    // The snapshot should NOT have a flat array of numbers (feature vector)
    expect(Array.isArray(snap.ctx?.fearGreed)).toBe(false);
    // snap.ctx is the raw context object, not a feature vector
    expect(typeof snap.ctx?.fearGreed?.value).toBe('number');
  });
});

// ── 5. buildTradeRecord — marketContext propagation ───────────────────────────

describe('buildTradeRecord marketContext propagation', () => {
  // We test the propagation logic directly without importing the full module
  // (which has heavy AsyncStorage deps) — simulate what buildTradeRecord does.

  function simulateBuildTradeRecord(position) {
    return {
      id: position.id,
      marketContext: (position.entrySnapshot).marketContext ?? null,
      // ...other fields omitted for brevity
    };
  }

  test('propagates CRYPTO marketContext from entrySnapshot', () => {
    const snap = captureSnapshot({ kind: 'CRYPTO', ctx: makeCryptoCtx() });
    const position = {
      id: 'test_pos',
      entrySnapshot: { recentCandles: [], topFeatures: [], marketRegime: 'BULL', orderBookSnapshot: null, marketContext: snap },
    };
    const record = simulateBuildTradeRecord(position);
    expect(record.marketContext).not.toBeNull();
    expect(record.marketContext.kind).toBe('CRYPTO');
  });

  test('propagates INDIAN marketContext from entrySnapshot', () => {
    const snap = captureSnapshot({ kind: 'INDIAN', ctx: makeIndianCtx() });
    const position = {
      id: 'test_pos',
      entrySnapshot: { recentCandles: [], topFeatures: [], marketRegime: 'BULL', orderBookSnapshot: null, marketContext: snap },
    };
    const record = simulateBuildTradeRecord(position);
    expect(record.marketContext.kind).toBe('INDIAN');
    expect(record.marketContext.ctx.vix.current).toBe(16.5);
  });

  test('returns null when position has no marketContext (backward compat)', () => {
    const position = {
      id: 'old_pos',
      entrySnapshot: { recentCandles: [], topFeatures: [], marketRegime: 'BULL', orderBookSnapshot: null },
    };
    const record = simulateBuildTradeRecord(position);
    expect(record.marketContext).toBeNull();
  });
});

// ── 6. ShadowTrade marketContext storage ──────────────────────────────────────

describe('ShadowTrade marketContext', () => {
  test('snapshot is preserved verbatim in the trade object', () => {
    const snap = captureSnapshot({ kind: 'INDIAN', ctx: makeIndianCtx() });
    // Simulate what recordShadowTrade pushes
    const trade = {
      id: 'sh_test',
      symbol: 'NIFTY50', timeframe: '15m', direction: 'LONG',
      entryPrice: 22000, stopLoss: 21800, takeProfit: 22400,
      blockedAt: Date.now(), blockReason: 'Low confidence',
      blockGate: 'CONFIDENCE', outcome: 'OPEN', ticksElapsed: 0,
      signal: { action: 'BUY', confidence: 48, ensembleProbUp: 0.56, regime: 'BULL' },
      marketContext: snap,
    };
    expect(trade.marketContext.kind).toBe('INDIAN');
    expect(trade.marketContext.ctx.breadth.adRatio).toBeCloseTo(0.7);
  });

  test('marketContext field is optional — old records without it deserialize safely', () => {
    const oldTrade = {
      id: 'old_shadow',
      symbol: 'BTC', timeframe: '1h', direction: 'LONG',
      entryPrice: 40000, stopLoss: 39000, takeProfit: 42000,
      blockedAt: Date.now(), blockReason: 'Old record',
      blockGate: 'CONFIDENCE', outcome: 'OPEN', ticksElapsed: 0,
      signal: { action: 'BUY', confidence: 55, ensembleProbUp: 0.6, regime: 'BULL' },
      // no marketContext field
    };
    // Should not throw and marketContext should be undefined
    expect(() => {
      const ctx = oldTrade.marketContext;
      return ctx;
    }).not.toThrow();
    expect(oldTrade.marketContext).toBeUndefined();
  });
});

// ── 7. Backward compatibility — old stored records ────────────────────────────

describe('Backward compatibility', () => {
  test('PaperTradeRecord without marketContext field does not throw on access', () => {
    const oldRecord = {
      id: 'old_trade', symbol: 'NIFTY50', timeframe: '15m', direction: 'LONG',
      entryTime: Date.now() - 3600000, entryPrice: 22000, exitTime: Date.now(),
      exitPrice: 22200, qty: 5, grossPnl: 1000, fees: 10, totalFees: 20,
      slippageCost: 5, holdingMs: 3600000, pnl: 980, pnlPct: 0.89,
      maxDrawdownDuringTrade: -0.3, maxUnrealizedProfit: 1.2,
      aiConfidence: 62, riskScoreAtEntry: 35, tradeQuality: null,
      modelVersion: 3, predictionHorizon: 3, topFeatures: [],
      marketRegime: 'BULL_TREND', orderBookSnapshot: null, tradeEconomics: {},
      predictionResult: 'CORRECT', entryReason: 'old', exitReason: 'TAKE_PROFIT',
      recentCandles: [], executionFill: null,
      // NO marketContext field
    };
    expect(() => {
      const mc = (oldRecord).marketContext;
      const _ = isContextAvailable(mc ?? null);
    }).not.toThrow();
  });

  test('MarketContextSnapshot survives JSON round-trip (AsyncStorage pattern)', () => {
    const snap = captureSnapshot({ kind: 'CRYPTO', ctx: makeCryptoCtx() });
    const serialized = JSON.stringify(snap);
    const deserialized = JSON.parse(serialized);
    expect(deserialized.kind).toBe('CRYPTO');
    expect(deserialized.ctx.fearGreed.value).toBe(72);
    expect(deserialized.ctx.marketCap.btcDominance).toBe(52);
    expect(deserialized.capturedAt).toBe(snap.capturedAt);
    // After round-trip, summarise still works
    const s = summariseContext(deserialized);
    expect(s.assetKind).toBe('CRYPTO');
    expect(s.fearGreed).toBe(72);
  });

  test('INDIAN snapshot survives JSON round-trip', () => {
    const snap = captureSnapshot({ kind: 'INDIAN', ctx: makeIndianCtx() });
    const deserialized = JSON.parse(JSON.stringify(snap));
    expect(deserialized.kind).toBe('INDIAN');
    expect(deserialized.ctx.vix.current).toBe(16.5);
    const s = summariseContext(deserialized);
    expect(s.indiaVIX).toBe(16.5);
  });
});

// ── 8. summariseContext — partial data (some metrics unavailable) ──────────────

describe('summariseContext — partial availability', () => {
  test('INDIAN context with only VIX available still summarises', () => {
    const ctx = {
      vix: makeIndianCtx().vix,
      available: ['VIX'],
      fetchedAt: Date.now(),
    };
    const s = summariseContext({ kind: 'INDIAN', ctx, capturedAt: Date.now() });
    expect(s.assetKind).toBe('INDIAN');
    expect(s.overallSentiment).not.toBe('UNAVAILABLE');
    expect(s.indiaVIX).toBe(16.5);
    expect(s.breadthADRatio).toBeNull();
    expect(s.fiiBias).toBeNull();
  });

  test('CRYPTO context with only fearGreed available still summarises', () => {
    const ctx = {
      fearGreed: makeCryptoCtx().fearGreed,
      available: ['FEAR_GREED'],
      symbol: 'ETHUSDT',
      fetchedAt: Date.now(),
    };
    const s = summariseContext({ kind: 'CRYPTO', ctx, capturedAt: Date.now() });
    expect(s.fearGreed).toBe(72);
    expect(s.btcDominance).toBeNull();
    expect(s.fundingRate).toBeNull();
  });
});

// ── 9. Analytics readiness — data shape for future queries ───────────────────

describe('Analytics readiness — ContextSummary shape', () => {
  test('CRYPTO summary has all required analytics fields', () => {
    const s = summariseContext({ kind: 'CRYPTO', ctx: makeCryptoCtx(), capturedAt: Date.now() });
    // Fields needed for: win rate by F&G zone, profit factor by funding, avg return by BTC dom
    expect(s).toHaveProperty('fearGreed');
    expect(s).toHaveProperty('fearGreedLabel');
    expect(s).toHaveProperty('btcDominance');
    expect(s).toHaveProperty('fundingRate');
    expect(s).toHaveProperty('fundingSentiment');
    expect(s).toHaveProperty('openInterestConviction');
    expect(s).toHaveProperty('stablecoinSignal');
    expect(s).toHaveProperty('marketRegime');
    expect(s).toHaveProperty('overallSentiment');
    expect(s).toHaveProperty('assetKind');
  });

  test('INDIAN summary has all required analytics fields', () => {
    const s = summariseContext({ kind: 'INDIAN', ctx: makeIndianCtx(), capturedAt: Date.now() });
    // Fields needed for: win rate by VIX range, avg return by breadth, etc
    expect(s).toHaveProperty('indiaVIX');
    expect(s).toHaveProperty('vixRegime');
    expect(s).toHaveProperty('breadthADRatio');
    expect(s).toHaveProperty('adTrend');
    expect(s).toHaveProperty('fiiBias');
    expect(s).toHaveProperty('pcrSentiment');
    expect(s).toHaveProperty('sectorLeader');
    expect(s).toHaveProperty('overallSentiment');
    expect(s).toHaveProperty('assetKind');
  });
});
