import React, { useState, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useData } from '../context/DataContext';
import { Card, SectionLabel, PrimaryButton, Pill } from '../components/Common';
import { Candle } from '../utils/indicators';
import { fetchBnKlines } from '../api/binance';
import { aoCandles } from '../api/angelOne';
import { fetchAVKlines } from '../api/alphaVantage';
import { fitEnsemble, runBacktest, DEFAULT_BACKTEST_CONFIG, computeMetrics, FittedEnsemble, BacktestResult } from '../utils/backtest';
import { ExecConfig } from '../utils/strategyExecutor';
import { runBaseline, ALL_BASELINES, BASELINE_LABELS, BaselineResult } from '../utils/baselineStrategies';
import { runMonteCarlo, MonteCarloResult } from '../utils/monteCarlo';
import { runSensitivityAnalysis, SensitivityResult } from '../utils/sensitivityAnalysis';
import { bucketTradesByRegime, RegimeBucket } from '../utils/regimeAnalysis';
import { analyzeModelStability, StabilityResult } from '../utils/modelStability';
import { runEngineValidation, ValidationReport } from '../utils/engineValidation';
import { MultiSymbolSelector } from '../components/MultiSymbolSelector';
import { useRunProgress } from '../hooks/useRunProgress';
import { fetchMaxHistoryForAsset } from '../utils/multiSourceFetch';
import { runStressTestCombo, summarizeStressTest, StressTestEntry, StressTestSummary } from '../utils/stressTest';
import { computeOptimalConfig, OptimalConfig } from '../utils/modelOptimization';

export default function VerificationScreen() {
  const { theme: T } = useTheme();
  const { allAssets, aoSession, avKey } = useData();
  const [symbol, setSymbol] = useState('NIFTY50');
  const [tf, setTf] = useState('15m');
  const [candles, setCandles] = useState<Candle[]>([]);
  const [fitted, setFitted] = useState<FittedEnsemble | null>(null);
  const [baseResult, setBaseResult] = useState<BacktestResult | null>(null);
  const [loading, setLoading] = useState<string>('');
  const [err, setErr] = useState('');

  const [validation, setValidation] = useState<ValidationReport | null>(null);
  const [baselines, setBaselines] = useState<BaselineResult[] | null>(null);
  const [monteCarlo, setMonteCarlo] = useState<MonteCarloResult | null>(null);
  const [sensitivity, setSensitivity] = useState<SensitivityResult[] | null>(null);
  const [regimes, setRegimes] = useState<RegimeBucket[] | null>(null);
  const [stability, setStability] = useState<StabilityResult | null>(null);

  // TASK 7/8 — batch stress test mode. Reuses allAssets (the same master
  // symbol source as Markets/Production Evaluation — never a separate
  // list), the same MultiSymbolSelector and progress-tracking hook as
  // Production Evaluation, and runStressTestCombo/summarizeStressTest
  // (which themselves reuse trainAndPredict and runBacktest — zero new
  // scoring or classification logic introduced here). This is a SEPARATE
  // mode alongside the existing single-symbol deep dive below, which is
  // unchanged and still fully available.
  const [mode, setMode] = useState<'deepdive' | 'batch'>('deepdive');
  const [batchSymbols, setBatchSymbols] = useState<string[]>([]);
  const [batchTf, setBatchTf] = useState<string[]>(['1h']);
  const [batchEntries, setBatchEntries] = useState<StressTestEntry[]>([]);
  const [batchSkipped, setBatchSkipped] = useState<string[]>([]);
  const [batchErr, setBatchErr] = useState('');
  const [bestPairConfig, setBestPairConfig] = useState<OptimalConfig | null>(null);
  const batchProgress = useRunProgress();
  const summary: StressTestSummary | null = batchEntries.length ? summarizeStressTest(batchEntries) : null;

  const runBatchStressTest = useCallback(async () => {
    setBatchErr(''); setBatchEntries([]); setBatchSkipped([]); setBestPairConfig(null);
    const assets = allAssets.filter(a => batchSymbols.includes(a.symbol));
    const combos = assets.flatMap(a => batchTf.map(tf => ({ asset: a, tf })));
    batchProgress.start(combos.length);
    const collected: StressTestEntry[] = [];
    const candlesByCombo = new Map<string, Candle[]>(); // kept so the best-pair optimizer below doesn't need to re-fetch
    try {
      for (const { asset, tf } of combos) {
        batchProgress.setCurrent(`${asset.symbol} / ${tf}`);
        const { candles, note } = await fetchMaxHistoryForAsset(asset, tf, 5000, aoSession, avKey);
        if (note) setBatchSkipped(prev => [...new Set([...prev, note])]);
        if (candles.length >= 120) {
          candlesByCombo.set(`${asset.symbol}|${tf}`, candles);
          const entry = await runStressTestCombo(candles, asset.symbol, tf, asset.type);
          if (entry) collected.push(entry);
          setBatchEntries([...collected]);
        }
        batchProgress.advance();
      }

      // Recommended horizon/threshold: computed for the single
      // best-performing pair, not blended across every combo — averaging
      // a horizon across very different assets would defeat the entire
      // point of the Model Improvement Phase's per-asset optimization.
      if (collected.length) {
        const ranked = [...collected].sort((a, b) => (b.profitFactor === Infinity ? 5 : b.profitFactor) * 0.6 + (b.winRate / 100) * 0.4 - ((a.profitFactor === Infinity ? 5 : a.profitFactor) * 0.6 + (a.winRate / 100) * 0.4));
        const best = ranked[0];
        const bestCandles = candlesByCombo.get(`${best.symbol}|${best.timeframe}`);
        if (bestCandles) {
          const config = await computeOptimalConfig(bestCandles, best.symbol, best.timeframe);
          setBestPairConfig(config);
        }
      }
    } catch (e: any) {
      setBatchErr(e.message);
    }
    batchProgress.finish();
  }, [batchSymbols, batchTf, allAssets, aoSession, avKey]);

  const asset = allAssets.find(a => a.symbol === symbol) || allAssets[0];

  const loadAndFit = useCallback(async () => {
    setLoading('base'); setErr('');
    setValidation(null); setBaselines(null); setMonteCarlo(null); setSensitivity(null); setRegimes(null); setStability(null);
    try {
      let c: Candle[] = [];
      if (asset.src === 'binance' && asset.bnSym) c = await fetchBnKlines(asset.bnSym, tf, 1000);
      else if (asset.src === 'ao' && aoSession?.jwtToken && asset.aoToken && asset.aoEx) c = await aoCandles(asset.aoToken, asset.aoEx, tf, aoSession);
      else if (asset.src === 'av' && asset.avSym && avKey) c = await fetchAVKlines(asset.avSym, tf, avKey);
      else { setErr('No live data source connected for this asset.'); setLoading(''); return; }

      if (c.length < 120) { setErr(`Only ${c.length} candles — need 120+.`); setLoading(''); return; }
      setCandles(c);

      const f = fitEnsemble(c, DEFAULT_BACKTEST_CONFIG.trainSplitPct, DEFAULT_BACKTEST_CONFIG.seed);
      if (!f) { setErr('Could not fit a model on this data.'); setLoading(''); return; }
      setFitted(f);

      const res = await runBacktest(c, {});
      setBaseResult(res);
    } catch (e: any) { setErr(e.message); }
    setLoading('');
  }, [asset, tf, aoSession, avKey]);

  async function runValidation() {
    if (!candles.length) return;
    setLoading('validation');
    const report = await runEngineValidation(candles);
    setValidation(report);
    setLoading('');
  }

  async function runBenchmarks() {
    if (!fitted) return;
    setLoading('benchmarks');
    const execConfig: ExecConfig = DEFAULT_BACKTEST_CONFIG;
    const atrArr = candles.map((_, i) => fitted.atrAt(i));
    const results = ALL_BASELINES.map(name => runBaseline(name, candles, fitted.walkIndices, atrArr, execConfig));
    setBaselines(results);
    setLoading('');
  }

  async function runMC() {
    if (!baseResult) return;
    setLoading('montecarlo');
    const result = runMonteCarlo(baseResult.trades, DEFAULT_BACKTEST_CONFIG.startingCapital, 2000);
    setMonteCarlo(result);
    setLoading('');
  }

  async function runSensitivity() {
    if (!fitted) return;
    setLoading('sensitivity');
    const results = runSensitivityAnalysis(fitted, { ...DEFAULT_BACKTEST_CONFIG });
    setSensitivity(results);
    setLoading('');
  }

  async function runRegimes() {
    if (!fitted || !baseResult) return;
    setLoading('regimes');
    const buckets = bucketTradesByRegime(candles, fitted.walkIndices, baseResult.trades, DEFAULT_BACKTEST_CONFIG.startingCapital);
    setRegimes(buckets);
    setLoading('');
  }

  async function runStability() {
    if (!baseResult) return;
    setLoading('stability');
    const result = analyzeModelStability(baseResult.trades);
    setStability(result);
    setLoading('');
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        <Text style={{ color: T.text, fontSize: 22, fontWeight: '800', marginBottom: 4 }}>Verification & Stress Test</Text>
        <Text style={{ color: T.textDim, fontSize: 11, marginBottom: 16, lineHeight: 16 }}>
          Proves whether the strategy has a genuine, repeatable edge — not whether it can be tuned to maximize one specific history.
        </Text>

        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 14 }}>
          <Pill label="Single Symbol Deep Dive" color={T.blue} active={mode === 'deepdive'} onPress={() => setMode('deepdive')} />
          <Pill label="Batch Stress Test" color={T.blue} active={mode === 'batch'} onPress={() => setMode('batch')} />
        </View>

        {mode === 'deepdive' && (<>
        {/* FIX: previously allAssets.slice(0, 14) artificially capped this
            picker to the first 14 entries regardless of how many symbols
            actually existed — confirmed by reading the code directly, not
            assumed. The full list (already deduplicated and filtered for
            hidden builtins inside allAssets itself) is shown via the
            same horizontal-scroll pattern used elsewhere in the app. */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 10 }}>
          <View style={{ flexDirection: 'row', gap: 6 }}>
            {allAssets.map(a => <Pill key={a.symbol + a.src} label={a.symbol} color={T.blue} active={symbol === a.symbol} onPress={() => setSymbol(a.symbol)} />)}
          </View>
        </ScrollView>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 14 }}>
          <View style={{ flexDirection: 'row', gap: 6 }}>
            {['5m', '15m', '1h', '4h', '1D'].map(t => <Pill key={t} label={t} color={T.purple} active={tf === t} onPress={() => setTf(t)} />)}
          </View>
        </ScrollView>

        <PrimaryButton theme={T} label={loading === 'base' ? 'LOADING & FITTING…' : '1. Load Data & Fit Model'} onPress={loadAndFit} disabled={!!loading} />
        {err && <Text style={{ color: T.red, fontSize: 12, marginTop: 10 }}>⚠ {err}</Text>}

        {baseResult && (
          <Card theme={T} style={{ marginTop: 14 }}>
            <SectionLabel theme={T}>BASE BACKTEST RESULT</SectionLabel>
            <Text style={{ color: T.textSub, fontSize: 11 }}>{baseResult.trades.length} trades · {baseResult.metrics.totalReturnPct.toFixed(2)}% return · {baseResult.metrics.winRate.toFixed(1)}% win rate · PF {baseResult.metrics.profitFactor === Infinity ? '∞' : baseResult.metrics.profitFactor.toFixed(2)}</Text>
          </Card>
        )}

        {fitted && (
          <View style={{ marginTop: 16, gap: 10 }}>
            <Section title="2. Engine Validation" subtitle="No leakage · train/test isolation · reproducibility" running={loading === 'validation'} onRun={runValidation} T={T}>
              {validation && validation.checks.map((c, i) => (
                <View key={i} style={{ marginBottom: 8 }}>
                  <Text style={{ color: c.passed ? T.green : T.red, fontWeight: '700', fontSize: 12 }}>{c.passed ? '✓' : '✗'} {c.name}</Text>
                  <Text style={{ color: T.textDim, fontSize: 10, marginTop: 2 }}>{c.detail}</Text>
                </View>
              ))}
              {validation && <Text style={{ color: validation.allPassed ? T.green : T.red, fontWeight: '800', fontSize: 13, marginTop: 4 }}>{validation.allPassed ? '✓ ALL CHECKS PASSED' : '✗ SOME CHECKS FAILED'}</Text>}
            </Section>

            <Section title="3. Benchmark Comparison" subtitle="AI ensemble vs. 6 standard baselines, identical execution rules" running={loading === 'benchmarks'} onRun={runBenchmarks} T={T}>
              {baseResult && <BenchmarkRow label="AI Ensemble (this strategy)" m={baseResult.metrics} T={T} highlight />}
              {baselines && baselines.map(b => {
                const m = computeMetrics(b.trades, b.equityCurve, DEFAULT_BACKTEST_CONFIG.startingCapital);
                return <BenchmarkRow key={b.name} label={BASELINE_LABELS[b.name]} m={m} T={T} />;
              })}
            </Section>

            <Section title="4. Monte Carlo Analysis" subtitle="2000 bootstrap resamples of the real trades" running={loading === 'montecarlo'} onRun={runMC} T={T}>
              {/* FIX: previously this rendered NOTHING when there weren't
                  enough trades (runMonteCarlo correctly returns null below 5
                  trades, by design) — no crash, just silent absence with no
                  explanation. Now explicitly tells you why. */}
              {monteCarlo === null && loading !== 'montecarlo' && baseResult && baseResult.trades.length < 5 && (
                <Text style={{ color: T.textDim, fontSize: 11, lineHeight: 16 }}>
                  Monte Carlo requires at least 5 completed trades. This backtest produced only {baseResult.trades.length}.
                </Text>
              )}
              {monteCarlo && (
                <View>
                  <Text style={{ color: T.textDim, fontSize: 9, marginBottom: 6 }}>{monteCarlo.iterations} bootstrap simulations</Text>
                  <MetricLine label="Mean simulated return" value={`${monteCarlo.meanReturnPct.toFixed(2)}%`} T={T} />
                  <MetricLine label="Median simulated return" value={`${monteCarlo.medianReturnPct.toFixed(2)}%`} T={T} />
                  <MetricLine label="5th / 95th percentile" value={`${monteCarlo.p5.toFixed(2)}% / ${monteCarlo.p95.toFixed(2)}%`} T={T} />
                  <MetricLine label="25th / 75th percentile" value={`${monteCarlo.p25.toFixed(2)}% / ${monteCarlo.p75.toFixed(2)}%`} T={T} />
                  <MetricLine label="Probability of profit" value={`${monteCarlo.probabilityOfProfit.toFixed(1)}%`} color={monteCarlo.probabilityOfProfit > 60 ? T.green : T.amber} T={T} />
                  <MetricLine label="Probability of loss" value={`${monteCarlo.probabilityOfLoss.toFixed(1)}%`} color={monteCarlo.probabilityOfLoss > 40 ? T.red : T.green} T={T} />
                  <Text style={{ color: T.textDim, fontSize: 9, marginTop: 8, marginBottom: 4 }}>PROBABILITY OF DRAWDOWN EXCEEDING:</Text>
                  {monteCarlo.drawdownExceedance.map(d => (
                    <MetricLine key={d.thresholdPct} label={`> ${d.thresholdPct}%`} value={`${d.probability.toFixed(1)}%`} color={d.probability > 30 ? T.red : T.textSub} T={T} />
                  ))}
                  <MetricLine label="Actual historical return" value={`${monteCarlo.originalReturnPct.toFixed(2)}%`} T={T} />
                  <MetricLine label="...sits at percentile" value={`${monteCarlo.originalPercentile.toFixed(0)}th of simulated outcomes`} T={T} />
                  <MetricLine label="Worst / Best simulated drawdown" value={`${monteCarlo.worstDrawdownPct.toFixed(1)}% / ${monteCarlo.bestDrawdownPct.toFixed(1)}%`} T={T} />
                </View>
              )}
            </Section>

            <Section title="5. Sensitivity Analysis" subtitle="Which settings are robust, not which maximizes history" running={loading === 'sensitivity'} onRun={runSensitivity} T={T}>
              {sensitivity && sensitivity.map(s => (
                <View key={s.paramName} style={{ marginBottom: 10 }}>
                  <Text style={{ color: T.text, fontWeight: '700', fontSize: 11 }}>{s.paramName} — <Text style={{ color: s.robust ? T.green : T.amber }}>{s.robust ? 'ROBUST' : 'SENSITIVE'}</Text></Text>
                  <View style={{ flexDirection: 'row', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                    {s.points.map(p => <Text key={p.paramValue} style={{ color: T.textDim, fontSize: 9 }}>{p.paramValue}: <Text style={{ color: T.textSub }}>{p.totalReturnPct.toFixed(1)}%</Text></Text>)}
                  </View>
                </View>
              ))}
            </Section>

            <Section title="6. Regime Breakdown" subtitle="Performance segmented by detected trend/volatility regime" running={loading === 'regimes'} onRun={runRegimes} T={T}>
              {regimes && regimes.map(r => (
                <View key={r.label} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: T.border }}>
                  <Text style={{ color: T.textSub, fontSize: 11 }}>{r.label.replace('_', ' ')} ({r.barCount} bars)</Text>
                  <Text style={{ color: r.trades.length ? (r.metrics.totalReturnPct >= 0 ? T.green : T.red) : T.textDim, fontSize: 11, fontWeight: '700' }}>
                    {r.trades.length ? `${r.trades.length} trades, ${r.metrics.totalReturnPct.toFixed(1)}%` : 'no trades'}
                  </Text>
                </View>
              ))}
            </Section>

            <Section title="7. Model Stability" subtitle="Drift in win rate / profit factor across the walk-forward period" running={loading === 'stability'} onRun={runStability} T={T}>
              {/* INVESTIGATED: confirmed this is expected, not a bug — verified
                  with realistic data sizes that a conservative 0.55 threshold
                  requiring model agreement legitimately produces very few
                  signals on weak-edge data (e.g. 0-5 signals across 65-490 walk
                  bars in testing). The fix here is accurate messaging, not
                  forcing more trades to appear. */}
              {stability === null && loading !== 'stability' && baseResult && baseResult.trades.length < 15 && (
                <Text style={{ color: T.textDim, fontSize: 11, lineHeight: 16 }}>
                  Model Stability requires at least 15 completed trades. Current backtest produced only {baseResult.trades.length} completed trade{baseResult.trades.length === 1 ? '' : 's'}.
                </Text>
              )}
              {stability && (
                <View>
                  {stability.chunks.map(c => (
                    <Text key={c.chunkIndex} style={{ color: T.textSub, fontSize: 10, marginBottom: 3 }}>
                      Chunk {c.chunkIndex + 1}: {c.tradeCount} trades, {c.winRate.toFixed(0)}% win rate, PF {c.profitFactor.toFixed(2)}
                    </Text>
                  ))}
                  <Text style={{ color: stability.deteriorating ? T.red : T.green, fontWeight: '700', fontSize: 12, marginTop: 6 }}>
                    {stability.deteriorating ? '⚠ Win rate trending down across the walk — possible deterioration' : '✓ No meaningful deterioration trend detected'}
                  </Text>
                </View>
              )}
            </Section>
          </View>
        )}
        </>)}

        {mode === 'batch' && (<>
          <Text style={{ color: T.textDim, fontSize: 10, marginBottom: 6 }}>SYMBOLS (from the same master list as Markets)</Text>
          <MultiSymbolSelector allAssets={allAssets} selected={batchSymbols} onChange={setBatchSymbols} theme={T} />

          <Text style={{ color: T.textDim, fontSize: 10, marginTop: 14, marginBottom: 6 }}>TIMEFRAMES</Text>
          <View style={{ flexDirection: 'row', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
            {['5m', '15m', '30m', '1h', '4h', '1D'].map(t => (
              <Pill key={t} label={t} color={T.purple} active={batchTf.includes(t)} onPress={() => setBatchTf(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t])} />
            ))}
          </View>

          <Text style={{ color: T.textDim, fontSize: 10, marginBottom: 10 }}>
            {batchSymbols.length} symbol{batchSymbols.length !== 1 ? 's' : ''} × {batchTf.length} timeframe{batchTf.length !== 1 ? 's' : ''} = {batchSymbols.length * batchTf.length} test{batchSymbols.length * batchTf.length !== 1 ? 's' : ''}
          </Text>

          <PrimaryButton theme={T} label={batchProgress.running ? 'RUNNING…' : `RUN STRESS TEST (${batchSymbols.length * batchTf.length})`} onPress={runBatchStressTest} disabled={batchProgress.running || !batchSymbols.length || !batchTf.length} />

          {batchProgress.running && (
            <Card theme={T} style={{ marginTop: 10 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
                <Text style={{ color: T.text, fontSize: 12, fontWeight: '700' }}>{batchProgress.currentLabel}</Text>
                <Text style={{ color: T.textDim, fontSize: 11 }}>{batchProgress.completed} / {batchProgress.total}</Text>
              </View>
              <View style={{ height: 6, backgroundColor: T.bg3, borderRadius: 3, overflow: 'hidden', marginBottom: 6 }}>
                <View style={{ height: 6, width: `${batchProgress.total ? (batchProgress.completed / batchProgress.total) * 100 : 0}%`, backgroundColor: T.accent }} />
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ color: T.textDim, fontSize: 10 }}>Remaining: {batchProgress.remaining}</Text>
                <Text style={{ color: T.textDim, fontSize: 10 }}>Elapsed: {batchProgress.elapsedLabel}</Text>
                <Text style={{ color: T.textDim, fontSize: 10 }}>ETA: {batchProgress.etaLabel}</Text>
              </View>
            </Card>
          )}
          {batchSkipped.length > 0 && (
            <Card theme={T} style={{ marginTop: 10, borderColor: T.amber + '50' }}>
              <SectionLabel theme={T}>SKIPPED (no usable data source)</SectionLabel>
              {batchSkipped.map((s, i) => <Text key={i} style={{ color: T.amber, fontSize: 10, marginBottom: 4, lineHeight: 14 }}>{s}</Text>)}
            </Card>
          )}
          {batchErr && <Text style={{ color: T.red, fontSize: 12, marginTop: 10 }}>⚠ {batchErr}</Text>}

          {summary && (
            <Card theme={T} style={{ marginTop: 14 }}>
              <SectionLabel theme={T}>SUMMARY ACROSS {summary.entries.length} COMBINATION{summary.entries.length !== 1 ? 'S' : ''}</SectionLabel>
              <MetricLine label="Accuracy (walk-forward)" value={`${summary.avgAccuracy.toFixed(1)}%`} T={T} />
              <MetricLine label="Precision" value={`${(summary.avgPrecision * 100).toFixed(1)}%`} T={T} />
              <MetricLine label="Recall" value={`${(summary.avgRecall * 100).toFixed(1)}%`} T={T} />
              <MetricLine label="F1 Score" value={`${(summary.avgF1 * 100).toFixed(1)}%`} T={T} />
              <MetricLine label="Win Rate" value={`${summary.avgWinRate.toFixed(1)}%`} color={summary.avgWinRate >= 50 ? T.green : T.amber} T={T} />
              <MetricLine label="Profit Factor" value={summary.avgProfitFactor === Infinity ? '∞' : summary.avgProfitFactor.toFixed(2)} T={T} />
              <MetricLine label="Sharpe Ratio" value={summary.avgSharpe.toFixed(2)} T={T} />
              <MetricLine label="Max Drawdown" value={`${summary.avgMaxDrawdown.toFixed(2)}%`} color={T.red} T={T} />
              <MetricLine label="Average Confidence" value={`${summary.avgConfidence.toFixed(0)}/100`} T={T} />
              <View style={{ marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: T.border }}>
                <MetricLine label="Best Symbol" value={summary.bestSymbol ?? 'n/a (needs 5+ trades)'} color={T.green} T={T} />
                <MetricLine label="Worst Symbol" value={summary.worstSymbol ?? 'n/a'} color={T.red} T={T} />
                <MetricLine label="Best Timeframe" value={summary.bestTimeframe ?? 'n/a'} color={T.green} T={T} />
                <MetricLine label="Worst Timeframe" value={summary.worstTimeframe ?? 'n/a'} color={T.red} T={T} />
              </View>
              {bestPairConfig && (
                <View style={{ marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: T.border }}>
                  <Text style={{ color: T.textDim, fontSize: 9, marginBottom: 4 }}>RECOMMENDED FOR BEST PAIR ({bestPairConfig.symbol}/{bestPairConfig.timeframe}) — not blended across combos, since averaging a horizon across different assets would defeat per-asset optimization</Text>
                  <MetricLine label="Recommended Horizon" value={`${bestPairConfig.bestHorizon}-bar`} T={T} />
                  <MetricLine label="Recommended Threshold" value={String(bestPairConfig.bestThreshold)} T={T} />
                </View>
              )}
            </Card>
          )}

          {batchEntries.map(e => (
            <Card key={`${e.symbol}-${e.timeframe}`} theme={T} style={{ marginTop: 10 }}>
              <SectionLabel theme={T}>{e.symbol} · {e.timeframe} · {e.numTrades} trades</SectionLabel>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                <Text style={{ color: T.textDim, fontSize: 9 }}>Acc {e.accuracy.toFixed(0)}%</Text>
                <Text style={{ color: T.textDim, fontSize: 9 }}>Prec {(e.precision * 100).toFixed(0)}%</Text>
                <Text style={{ color: T.textDim, fontSize: 9 }}>Recall {(e.recall * 100).toFixed(0)}%</Text>
                <Text style={{ color: T.textDim, fontSize: 9 }}>F1 {(e.f1 * 100).toFixed(0)}%</Text>
                <Text style={{ color: e.winRate >= 50 ? T.green : T.amber, fontSize: 9, fontWeight: '700' }}>WR {e.winRate.toFixed(0)}%</Text>
                <Text style={{ color: T.textDim, fontSize: 9 }}>PF {e.profitFactor === Infinity ? '∞' : e.profitFactor.toFixed(2)}</Text>
                <Text style={{ color: T.textDim, fontSize: 9 }}>Sharpe {e.sharpeRatio.toFixed(2)}</Text>
              </View>
            </Card>
          ))}
        </>)}
      </ScrollView>
    </SafeAreaView>
  );
}

function Section({ title, subtitle, running, onRun, children, T }: any) {
  return (
    <Card theme={T}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: T.text, fontWeight: '700', fontSize: 13 }}>{title}</Text>
          <Text style={{ color: T.textDim, fontSize: 9, marginTop: 2 }}>{subtitle}</Text>
        </View>
        <TouchableOpacity onPress={onRun} disabled={running} style={{ backgroundColor: T.accent, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 6, opacity: running ? 0.6 : 1 }}>
          {running ? <ActivityIndicator size="small" color="#fff" /> : <Text style={{ color: '#fff', fontSize: 10, fontWeight: '700' }}>RUN</Text>}
        </TouchableOpacity>
      </View>
      {children}
    </Card>
  );
}

function BenchmarkRow({ label, m, T, highlight }: any) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: T.border, backgroundColor: highlight ? T.accent + '12' : 'transparent' }}>
      <Text style={{ color: highlight ? T.accent : T.textSub, fontSize: 11, fontWeight: highlight ? '700' : '400' }}>{label}</Text>
      <Text style={{ color: m.totalReturnPct >= 0 ? T.green : T.red, fontSize: 11, fontWeight: '700' }}>{m.totalReturnPct >= 0 ? '+' : ''}{m.totalReturnPct.toFixed(2)}% · {m.numTrades}tr</Text>
    </View>
  );
}

function MetricLine({ label, value, color, T }: any) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 }}>
      <Text style={{ color: T.textDim, fontSize: 10.5 }}>{label}</Text>
      <Text style={{ color: color || T.text, fontWeight: '700', fontSize: 10.5 }}>{value}</Text>
    </View>
  );
}
