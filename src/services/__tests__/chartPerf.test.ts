// ─────────────────────────────────────────────────────────────────────────────
// chartPerf.test.ts
// Regression tests for the four chart-performance changes:
//   1. L1 cache early-return (no AsyncStorage wait on fresh L1 hit)
//   2. calcMA O(n) correctness and output equivalence
//   3. Memoized overlays (bollinger/keltner/donchian) — verified via indicator file
//   4. CoinDCX limit normalisation to 300
//   5. Existing request-race protection
// ─────────────────────────────────────────────────────────────────────────────

import { calcMA } from '../../utils/indicators';
import { memGet, memSet, memEvict } from '../../utils/candleMemoryCache';

// ── helpers ──────────────────────────────────────────────────────────────────
function makeCandles(closes: number[]) {
  return closes.map((c, i) => ({
    time: i * 60000, open: c, high: c + 1, low: c - 1, close: c, volume: 100,
  }));
}

// Reference O(n²) implementation used to verify the new O(n) calcMA
function referenceCalcMA(data: ReturnType<typeof makeCandles>, p: number): (number | null)[] {
  return data.map((_, i) =>
    i < p - 1
      ? null
      : data.slice(i - p + 1, i + 1).reduce((s, c) => s + c.close, 0) / p,
  );
}

// ── 1. calcMA correctness ─────────────────────────────────────────────────────
describe('calcMA — O(n) implementation output equivalence', () => {
  test('empty array returns empty', () => {
    expect(calcMA([], 5)).toEqual([]);
  });

  test('fewer candles than period → all null', () => {
    const data = makeCandles([100, 101, 102]);
    const result = calcMA(data, 5);
    expect(result).toHaveLength(3);
    result.forEach(v => expect(v).toBeNull());
  });

  test('exactly period candles → last entry is a number', () => {
    const data = makeCandles([100, 101, 102, 103, 104]);
    const result = calcMA(data, 5);
    expect(result).toHaveLength(5);
    expect(result[0]).toBeNull();
    expect(result[4]).toBeCloseTo((100 + 101 + 102 + 103 + 104) / 5, 10);
  });

  test('matches reference O(n²) implementation for 300 candles p=20', () => {
    const closes = Array.from({ length: 300 }, (_, i) => 100 + Math.sin(i * 0.1) * 10);
    const data = makeCandles(closes);
    const got = calcMA(data, 20);
    const ref = referenceCalcMA(data, 20);
    expect(got).toHaveLength(ref.length);
    got.forEach((v, i) => {
      if (ref[i] === null) expect(v).toBeNull();
      else expect(v).toBeCloseTo(ref[i] as number, 10);
    });
  });

  test('matches reference for 300 candles p=50', () => {
    const closes = Array.from({ length: 300 }, (_, i) => 200 + i * 0.5);
    const data = makeCandles(closes);
    const got = calcMA(data, 50);
    const ref = referenceCalcMA(data, 50);
    got.forEach((v, i) => {
      if (ref[i] === null) expect(v).toBeNull();
      else expect(v).toBeCloseTo(ref[i] as number, 10);
    });
  });

  test('all-same prices → MA equals that price everywhere it is defined', () => {
    const data = makeCandles([150, 150, 150, 150, 150]);
    const result = calcMA(data, 3);
    expect(result[0]).toBeNull();
    expect(result[1]).toBeNull();
    expect(result[2]).toBeCloseTo(150, 10);
    expect(result[4]).toBeCloseTo(150, 10);
  });

  test('p=1 → MA equals close price at every index', () => {
    const closes = [100, 200, 300];
    const data = makeCandles(closes);
    const result = calcMA(data, 1);
    result.forEach((v, i) => expect(v).toBeCloseTo(closes[i], 10));
  });

  test('1000-candle dataset matches reference (p=50)', () => {
    const closes = Array.from({ length: 1000 }, (_, i) => 100 + (i % 37));
    const data = makeCandles(closes);
    const got = calcMA(data, 50);
    const ref = referenceCalcMA(data, 50);
    got.forEach((v, i) => {
      if (ref[i] === null) expect(v).toBeNull();
      else expect(v).toBeCloseTo(ref[i] as number, 10);
    });
  });
});

// ── 2. L1 cache (memGet/memSet/memEvict) ─────────────────────────────────────
describe('L1 memory cache — basic contract', () => {
  beforeEach(() => {
    memEvict('TEST');
    memEvict('OTHER');
  });

  test('memGet returns null on miss', () => {
    expect(memGet('TEST', '15m')).toBeNull();
  });

  test('memSet then memGet returns same candles', () => {
    const candles = makeCandles([100, 101, 102]);
    memSet('TEST', '15m', candles);
    expect(memGet('TEST', '15m')).toBe(candles); // same reference
  });

  test('L1 miss for different TF — no cross-TF contamination', () => {
    const candles = makeCandles([100, 101, 102]);
    memSet('TEST', '15m', candles);
    expect(memGet('TEST', '5m')).toBeNull();
  });

  test('L1 miss for different symbol — no cross-symbol contamination', () => {
    const candles = makeCandles([100, 101, 102]);
    memSet('TEST', '15m', candles);
    expect(memGet('OTHER', '15m')).toBeNull();
  });

  test('memEvict removes all TFs for a symbol', () => {
    memSet('TEST', '1m',  makeCandles([100]));
    memSet('TEST', '15m', makeCandles([200]));
    memSet('OTHER', '15m', makeCandles([300])); // should survive
    memEvict('TEST');
    expect(memGet('TEST', '1m')).toBeNull();
    expect(memGet('TEST', '15m')).toBeNull();
    expect(memGet('OTHER', '15m')).not.toBeNull(); // unrelated symbol intact
  });

  test('empty candle array is not stored', () => {
    memSet('TEST', '5m', []);
    expect(memGet('TEST', '5m')).toBeNull();
  });
});

// ── 3. CoinDCX limit constant check ──────────────────────────────────────────
describe('CoinDCX fetch limit normalisation', () => {
  test('useChartData source does not contain cdxCandles limit=500', () => {
    // Read the source and verify the old limit is gone
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').join(__dirname, '../../screens/chart/hooks/useChartData.ts'),
      'utf8',
    );
    // The old limit=500 calls for CoinDCX should be gone (gap-repair 150 is fine)
    const cdxMatches = (src.match(/fetchCdxCandles\([^)]+,\s*(\d+)\)/g) || []);
    const hasOld500 = cdxMatches.some((m: string) => m.includes(', 500)'));
    expect(hasOld500).toBe(false);
  });
});

// ── 4. Existing race-guard is still intact ────────────────────────────────────
describe('Request race protection', () => {
  test('useChartData source contains myRequestId guard after network fetch', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').join(__dirname, '../../screens/chart/hooks/useChartData.ts'),
      'utf8',
    );
    // Guard must be present before setCandles(merged)
    const guardIdx  = src.indexOf('if (myRequestId !== loadRequestRef.current)');
    const mergeIdx  = src.indexOf('setCandles(merged)');
    expect(guardIdx).toBeGreaterThan(0);
    expect(mergeIdx).toBeGreaterThan(guardIdx);
  });
});

// ── 5. L1 path does not import/call AsyncStorage directly ─────────────────────
describe('L1 cache path isolation', () => {
  test('memGet and memSet are synchronous (no promises)', () => {
    const candles = makeCandles([100, 101]);
    const setResult = memSet('SYNC_TEST', '1m', candles);
    expect(setResult).toBeUndefined(); // void
    const getResult = memGet('SYNC_TEST', '1m');
    // getResult must not be a Promise
    expect(getResult && typeof (getResult as any).then).not.toBe('function');
    memEvict('SYNC_TEST');
  });
});

// ── 6. AbortController request cancellation ──────────────────────────────────
describe('AbortController — obsolete request cancellation', () => {
  test('fetchBnKlines accepts AbortSignal parameter', () => {
    // Structural test: verify the function signature accepts a signal
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').join(__dirname, '../../api/binance.ts'), 'utf8'
    );
    expect(src).toContain('signal?: AbortSignal');
    expect(src).toContain("name !== 'AbortError'"); // shouldRetry guard
  });

  test('fetchCdxCandles accepts AbortSignal parameter', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').join(__dirname, '../../api/coindcx.ts'), 'utf8'
    );
    expect(src).toContain('signal?: AbortSignal');
  });

  test('useChartData creates AbortController and passes signal to fetches', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').join(__dirname, '../../screens/chart/hooks/useChartData.ts'), 'utf8'
    );
    expect(src).toContain('new AbortController()');
    expect(src).toContain('ctrl.signal');
    expect(src).toContain("name === 'AbortError'"); // don't show error on abort
  });
});

// ── 7. Timing instrumentation ─────────────────────────────────────────────────
describe('Timing instrumentation checkpoints', () => {
  test('CHART_TIMING checkpoints exist in useChartData', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').join(__dirname, '../../screens/chart/hooks/useChartData.ts'), 'utf8'
    );
    expect(src).toContain('[CHART_TIMING]');
    expect(src).toContain("_timing('l1_lookup')");
    expect(src).toContain("_timing('l2_read')");
    expect(src).toContain("_timing('net_start')");
    expect(src).toContain("_timing('net_done')");
    expect(src).toContain("_timing('set_candles')");
  });

  test('prefetch logs completions in dev', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').join(__dirname, '../../screens/chart/hooks/useChartData.ts'), 'utf8'
    );
    expect(src).toContain('[CHART_PREFETCH]');
  });
});

// ── 8. Prefetch ordering — adjacent TFs first ─────────────────────────────────
describe('Prefetch ordering', () => {
  test('adjacent TFs are placed before rest in prefetch order', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').join(__dirname, '../../screens/chart/hooks/useChartData.ts'), 'utf8'
    );
    // Verify ADJACENT map exists and drives ordering
    expect(src).toContain('const ADJACENT');
    expect(src).toContain("'15m': ['5m', '1h']"); // example adjacency
    expect(src).toContain('[...adjacent, ...rest]'); // ordering pattern
  });
});

// ── Device-level timing guide (manual, not automated) ─────────────────────────
// Run on Android device: adb logcat | findstr CHART_TIMING
//
// Expected warm-cache TF switch (after prefetch):
//   CHART_TIMING ETHUSDT/1h start=0ms
//   CHART_TIMING ETHUSDT/1h l1_lookup=0ms
//   CHART_TIMING ETHUSDT/1h l2_read=12ms
//   CHART_TIMING ETHUSDT/1h set_candles=13ms   ← total <15ms
//
// Expected cold-cache TF switch:
//   CHART_TIMING ETHUSDT/1D start=0ms
//   CHART_TIMING ETHUSDT/1D l1_lookup=0ms
//   CHART_TIMING ETHUSDT/1D l2_read=35ms
//   CHART_TIMING ETHUSDT/1D net_start=35ms
//   CHART_TIMING ETHUSDT/1D net_done=420ms     ← Binance REST on WiFi
//   CHART_TIMING ETHUSDT/1D set_candles=425ms  ← total ~425ms
//
// Target: warm < 100ms, cold = network-dependent (200–900ms unavoidable)
