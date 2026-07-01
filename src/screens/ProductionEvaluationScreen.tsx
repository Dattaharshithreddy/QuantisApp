import React, { useState, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useData } from '../context/DataContext';
import { Card, SectionLabel, Pill } from '../components/Common';
import { MultiSymbolSelector } from '../components/MultiSymbolSelector';
import { useRunProgress } from '../hooks/useRunProgress';
import { evaluateProductionModel, generateRecommendations, ProductionEvalResult } from '../utils/productionEvaluation';
import { computeOptimalConfig, OptimalConfig } from '../utils/modelOptimization';
import { fetchMaxHistoryForAsset } from '../utils/multiSourceFetch';

const TIMEFRAMES = ['5m', '15m', '30m', '1h', '4h', '1D'];

export default function ProductionEvaluationScreen() {
  const { theme: T } = useTheme();
  // TASK 9 (Single Master Symbol Source) — allAssets is the SAME source
  // Markets/Chart/Scanner/everything else reads from. This screen no
  // longer maintains its own list; a symbol added via "+ Add Symbol"
  // appears here automatically on the next render, with zero code changes.
  const { allAssets, aoSession, avKey } = useData();
  const [selectedSymbols, setSelectedSymbols] = useState<string[]>([]);
  const [selectedTf, setSelectedTf] = useState<string[]>(['1h']);
  const [results, setResults] = useState<ProductionEvalResult[]>([]);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [err, setErr] = useState('');
  const [optimalConfigs, setOptimalConfigs] = useState<OptimalConfig[]>([]);
  const progress = useRunProgress();
  const optProgress = useRunProgress();

  // Model Improvement Phase — closes the loop: evaluateAllHorizons/
  // evaluateThresholds already existed for analysis only; this is the
  // explicit step that actually computes and persists a per-(symbol,
  // timeframe) optimum from that same evidence, which trainAndPredict
  // now reads automatically (mlSignal.ts + watchlistScanner.ts +
  // ChartScreen.tsx). Deliberately a separate, explicit action — not run
  // automatically on every evaluation, since it's a real cost (a full
  // horizon sweep, 5 retrains) worth running occasionally, not on a timer.
  const runOptimization = useCallback(async () => {
    setErr(''); setOptimalConfigs([]);
    const assets = allAssets.filter(a => selectedSymbols.includes(a.symbol));
    const combos = assets.flatMap(a => selectedTf.map(tf => ({ asset: a, tf })));
    optProgress.start(combos.length);
    const collected: OptimalConfig[] = [];
    try {
      for (const { asset, tf } of combos) {
        optProgress.setCurrent(`${asset.symbol} / ${tf}`);
        const { candles, note } = await fetchMaxHistoryForAsset(asset, tf, 5000, aoSession, avKey);
        if (note) setSkipped(prev => [...new Set([...prev, note])]);
        if (candles.length >= 120) {
          const config = await computeOptimalConfig(candles, asset.symbol, tf);
          if (config) collected.push(config);
          setOptimalConfigs([...collected]);
        }
        optProgress.advance();
      }
    } catch (e: any) {
      setErr(e.message);
    }
    optProgress.finish();
  }, [selectedSymbols, selectedTf, allAssets, aoSession, avKey]);

  function toggle(arr: string[], set: (v: string[]) => void, val: string) {
    set(arr.includes(val) ? arr.filter(v => v !== val) : [...arr, val]);
  }

  const runEvaluation = useCallback(async () => {
    setErr(''); setResults([]); setSkipped([]);
    const assets = allAssets.filter(a => selectedSymbols.includes(a.symbol));
    const combos = assets.flatMap(a => selectedTf.map(tf => ({ asset: a, tf })));
    progress.start(combos.length);
    const collected: ProductionEvalResult[] = [];
    try {
      for (const { asset, tf } of combos) {
        progress.setCurrent(`${asset.symbol} / ${tf}`);
        const { candles, note } = await fetchMaxHistoryForAsset(asset, tf, 5000, aoSession, avKey);
        if (note) setSkipped(prev => [...new Set([...prev, note])]);
        if (candles.length >= 120) {
          const res = await evaluateProductionModel(candles, asset.symbol, tf);
          if (res) collected.push(res);
          setResults([...collected]); // show results progressively as each completes
        }
        progress.advance();
      }
    } catch (e: any) {
      setErr(e.message);
    }
    progress.finish();
  }, [selectedSymbols, selectedTf, allAssets, aoSession, avKey]);

  const recommendations = results.length ? generateRecommendations(results) : null;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        <Text style={{ color: T.text, fontSize: 22, fontWeight: '800', marginBottom: 4 }}>Production Model Evaluation</Text>
        <Text style={{ color: T.textDim, fontSize: 11, marginBottom: 16, lineHeight: 16 }}>
          Runs the real 38-feature production pipeline against real fetched market data — regime breakdown, horizon evaluation, threshold sweep, leak-safe feature contribution, NN vs. LR vs. Ensemble, and baseline comparison, all in one pass per symbol/timeframe.
        </Text>

        <Text style={{ color: T.textDim, fontSize: 10, marginBottom: 6 }}>SYMBOLS (from the same master list as Markets)</Text>
        <MultiSymbolSelector allAssets={allAssets} selected={selectedSymbols} onChange={setSelectedSymbols} theme={T} />

        <Text style={{ color: T.textDim, fontSize: 10, marginTop: 14, marginBottom: 6 }}>TIMEFRAMES</Text>
        <View style={{ flexDirection: 'row', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
          {TIMEFRAMES.map(t => <Pill key={t} label={t} color={T.purple} active={selectedTf.includes(t)} onPress={() => toggle(selectedTf, setSelectedTf, t)} />)}
        </View>

        <Text style={{ color: T.textDim, fontSize: 10, marginBottom: 10 }}>
          {selectedSymbols.length} symbol{selectedSymbols.length !== 1 ? 's' : ''} × {selectedTf.length} timeframe{selectedTf.length !== 1 ? 's' : ''} = {selectedSymbols.length * selectedTf.length} test{selectedSymbols.length * selectedTf.length !== 1 ? 's' : ''}
        </Text>

        <TouchableOpacity onPress={runEvaluation} disabled={progress.running || !selectedSymbols.length || !selectedTf.length} style={{
          backgroundColor: T.accent, padding: 14, borderRadius: 8, alignItems: 'center', opacity: progress.running ? 0.6 : 1,
        }}>
          {progress.running ? <ActivityIndicator color="#fff" /> : <Text style={{ color: '#fff', fontWeight: '700' }}>RUN EVALUATION ({selectedSymbols.length * selectedTf.length} combination{selectedSymbols.length * selectedTf.length !== 1 ? 's' : ''})</Text>}
        </TouchableOpacity>

        <TouchableOpacity onPress={runOptimization} disabled={optProgress.running || !selectedSymbols.length || !selectedTf.length} style={{
          backgroundColor: T.purple, padding: 14, borderRadius: 8, alignItems: 'center', opacity: optProgress.running ? 0.6 : 1, marginTop: 10,
        }}>
          {optProgress.running ? <ActivityIndicator color="#fff" /> : <Text style={{ color: '#fff', fontWeight: '700' }}>OPTIMIZE HORIZON & THRESHOLD</Text>}
        </TouchableOpacity>
        <Text style={{ color: T.textDim, fontSize: 9, marginTop: 6, lineHeight: 13 }}>
          Computes a real, per-symbol/timeframe optimal prediction horizon and confidence threshold from backtested evidence (reuses the same evaluation tools above), and persists it — the live AI pipeline (Chart screen, Scanner) automatically picks this up afterward instead of using one global default for every asset.
        </Text>

        {(progress.running || optProgress.running) && (() => {
          const p = progress.running ? progress : optProgress;
          return (
            <Card theme={T} style={{ marginTop: 10 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
                <Text style={{ color: T.text, fontSize: 12, fontWeight: '700' }}>{p.currentLabel}</Text>
                <Text style={{ color: T.textDim, fontSize: 11 }}>{p.completed} / {p.total}</Text>
              </View>
              <View style={{ height: 6, backgroundColor: T.bg3, borderRadius: 3, overflow: 'hidden', marginBottom: 6 }}>
                <View style={{ height: 6, width: `${p.total ? (p.completed / p.total) * 100 : 0}%`, backgroundColor: T.accent }} />
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ color: T.textDim, fontSize: 10 }}>Remaining: {p.remaining}</Text>
                <Text style={{ color: T.textDim, fontSize: 10 }}>Elapsed: {p.elapsedLabel}</Text>
                <Text style={{ color: T.textDim, fontSize: 10 }}>ETA: {p.etaLabel}</Text>
              </View>
            </Card>
          );
        })()}
        {skipped.length > 0 && (
          <Card theme={T} style={{ marginTop: 10, borderColor: T.amber + '50' }}>
            <SectionLabel theme={T}>SKIPPED (no usable data source)</SectionLabel>
            {skipped.map((s, i) => <Text key={i} style={{ color: T.amber, fontSize: 10, marginBottom: 4, lineHeight: 14 }}>{s}</Text>)}
          </Card>
        )}
        {err && <Text style={{ color: T.red, fontSize: 12, marginTop: 10 }}>⚠ {err}</Text>}

        {optimalConfigs.map(c => (
          <Card key={`${c.symbol}-${c.timeframe}`} theme={T} style={{ marginTop: 10 }}>
            <SectionLabel theme={T}>{c.symbol} · {c.timeframe} — OPTIMIZED</SectionLabel>
            <Text style={{ color: T.text, fontSize: 12, fontWeight: '700' }}>Horizon: {c.bestHorizon}-bar (was a global 3-bar default)</Text>
            <Text style={{ color: T.textDim, fontSize: 9 }}>{c.bestHorizonEvidence.numTrades} trades, {c.bestHorizonEvidence.returnPct.toFixed(2)}% return, PF {c.bestHorizonEvidence.profitFactor === Infinity ? '∞' : c.bestHorizonEvidence.profitFactor.toFixed(2)}, {c.bestHorizonEvidence.winRate.toFixed(1)}% win rate</Text>
            <Text style={{ color: T.text, fontSize: 12, fontWeight: '700', marginTop: 6 }}>Threshold: {c.bestThreshold} (was a global 0.55 default)</Text>
            <Text style={{ color: T.textDim, fontSize: 9 }}>{c.bestThresholdEvidence.numTrades} trades, {c.bestThresholdEvidence.returnPct.toFixed(2)}% return, PF {c.bestThresholdEvidence.profitFactor === Infinity ? '∞' : c.bestThresholdEvidence.profitFactor.toFixed(2)}, {c.bestThresholdEvidence.winRate.toFixed(1)}% win rate</Text>
          </Card>
        ))}

        {results.map(r => (
          <Card key={r.symbol + r.timeframe} theme={T} style={{ marginTop: 14 }}>
            <SectionLabel theme={T}>{r.symbol} · {r.timeframe} · {r.candleCount} bars</SectionLabel>

            <Text style={{ color: T.text, fontWeight: '700', fontSize: 13, marginBottom: 4 }}>
              {r.primaryMetrics.totalReturnPct >= 0 ? '+' : ''}{r.primaryMetrics.totalReturnPct.toFixed(2)}% return · {r.primaryMetrics.numTrades} trades · {r.primaryMetrics.winRate.toFixed(1)}% win rate
            </Text>
            <Text style={{ color: r.beatsAllBaselines ? T.green : T.red, fontSize: 11, fontWeight: '700', marginBottom: 10 }}>
              {r.beatsAllBaselines ? '✓ Beat every baseline' : '✗ Did not beat all baselines'}
            </Text>

            <Text style={{ color: T.textDim, fontSize: 9, marginBottom: 4 }}>HORIZON COMPARISON</Text>
            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
              {r.horizons.map(h => (
                <Text key={h.horizon} style={{ color: r.bestHorizon?.horizon === h.horizon ? T.green : T.textDim, fontSize: 9, fontWeight: r.bestHorizon?.horizon === h.horizon ? '700' : '400' }}>
                  {h.horizon}b: {h.metrics.totalReturnPct.toFixed(1)}% ({h.metrics.numTrades}tr)
                </Text>
              ))}
            </View>

            <Text style={{ color: T.textDim, fontSize: 9, marginBottom: 4 }}>MODEL COMPARISON</Text>
            <View style={{ marginBottom: 10 }}>
              {r.modelComparison.map(m => (
                <Text key={m.modelName} style={{ color: T.textSub, fontSize: 10 }}>{m.modelName}: {m.metrics.totalReturnPct.toFixed(2)}%, PF {m.metrics.profitFactor === Infinity ? '∞' : m.metrics.profitFactor.toFixed(2)}</Text>
              ))}
              <Text style={{ color: r.ensembleHelps.helps ? T.green : T.amber, fontSize: 9, marginTop: 4 }}>{r.ensembleHelps.reasoning}</Text>
            </View>

            {r.featureContribution && (
              <View style={{ marginBottom: 10 }}>
                <Text style={{ color: T.textDim, fontSize: 9, marginBottom: 4 }}>TOP / BOTTOM FEATURES (permutation importance)</Text>
                {r.featureContribution.entries.slice(0, 3).map(e => <Text key={e.name} style={{ color: T.green, fontSize: 9 }}>↑ {e.name}: {e.baselineAccDrop.toFixed(2)}pt drop</Text>)}
                {r.featureContribution.entries.slice(-3).map(e => <Text key={e.name} style={{ color: T.textDim, fontSize: 9 }}>↓ {e.name}: {e.baselineAccDrop.toFixed(2)}pt drop</Text>)}
              </View>
            )}

            <Text style={{ color: T.textDim, fontSize: 9, marginBottom: 4 }}>BASELINES</Text>
            {r.baselines.map(b => (
              <Text key={b.name} style={{ color: T.textDim, fontSize: 9 }}>{b.name}: {b.metrics.totalReturnPct.toFixed(2)}%</Text>
            ))}
          </Card>
        ))}

        {recommendations && (
          <Card theme={T} style={{ marginTop: 14, borderColor: recommendations.readyForPaperTrading ? T.green + '50' : T.amber + '50' }}>
            <SectionLabel theme={T}>RECOMMENDATIONS (derived only from measured results)</SectionLabel>
            <Text style={{ color: T.textSub, fontSize: 11, marginBottom: 4 }}>Recommended horizon: <Text style={{ fontWeight: '700', color: T.text }}>{recommendations.recommendedHorizon ?? 'insufficient data'}</Text></Text>
            <Text style={{ color: T.textSub, fontSize: 11, marginBottom: 4 }}>Recommended threshold: <Text style={{ fontWeight: '700', color: T.text }}>{recommendations.recommendedThreshold ?? 'insufficient data'}</Text></Text>
            <Text style={{ color: T.textSub, fontSize: 11, marginBottom: 8 }}>Features to consider removing: <Text style={{ fontWeight: '700', color: T.text }}>{recommendations.featuresToConsiderRemoving.length ? recommendations.featuresToConsiderRemoving.join(', ') : 'none flagged'}</Text></Text>
            <Text style={{ color: recommendations.readyForPaperTrading ? T.green : T.red, fontWeight: '800', fontSize: 13, marginBottom: 8 }}>
              {recommendations.readyForPaperTrading ? '✓ Cautiously consistent with paper trading readiness' : '✗ Not yet ready for paper trading'}
            </Text>
            {recommendations.reasoning.map((r, i) => <Text key={i} style={{ color: T.textDim, fontSize: 10, marginBottom: 4, lineHeight: 14 }}>• {r}</Text>)}
          </Card>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
