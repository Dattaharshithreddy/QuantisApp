import React, { useState, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity, TextInput, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Path, Line } from 'react-native-svg';
import { useTheme } from '../context/ThemeContext';
import { useData } from '../context/DataContext';
import { Card, SectionLabel, PrimaryButton, Pill } from '../components/Common';
import { Candle, pFmt } from '../utils/indicators';
import { fetchMaxHistory } from '../utils/maxHistoryFetch';
import { aoCandles } from '../api/angelOne';
import { fetchAVKlines } from '../api/alphaVantage';
import { runBacktest, BacktestResult, DEFAULT_BACKTEST_CONFIG, runComprehensiveBacktest, ComprehensiveBacktestResult } from '../utils/backtest';

export default function BacktestScreen() {
  const { theme: T } = useTheme();
  const { allAssets, aoSession, avKey } = useData();
  const [symbol, setSymbol] = useState('NIFTY50');
  const [tf, setTf] = useState('15m');
  const [capital, setCapital] = useState(String(DEFAULT_BACKTEST_CONFIG.startingCapital));
  const [feePct, setFeePct] = useState(String(DEFAULT_BACKTEST_CONFIG.feePct));
  const [slippagePct, setSlippagePct] = useState(String(DEFAULT_BACKTEST_CONFIG.slippagePct));
  const [riskPct, setRiskPct] = useState(String(DEFAULT_BACKTEST_CONFIG.riskPerTradePct));
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [diagnostics, setDiagnostics] = useState<ComprehensiveBacktestResult | null>(null);
  const [loadingDiagnostics, setLoadingDiagnostics] = useState(false);
  const [lastCandles, setLastCandles] = useState<Candle[]>([]);
  const [showTrades, setShowTrades] = useState(false);

  const asset = allAssets.find(a => a.symbol === symbol) || allAssets[0];

  const run = useCallback(async () => {
    setLoading(true); setErr(''); setResult(null); setDiagnostics(null);
    try {
      let candles: Candle[] = [];
      // FIX (Phase 2 — larger historical datasets): Binance caps a single
      // call at 1000 bars. fetchMaxHistory (already built for the
      // Production Evaluation suite) paginates backward for genuinely
      // deeper history — wiring it in here too, rather than building a
      // second pagination implementation.
      if (asset.src === 'binance' && asset.bnSym) candles = await fetchMaxHistory(asset.bnSym, tf, 5000);
      else if (asset.src === 'ao' && aoSession?.jwtToken && asset.aoToken && asset.aoEx) candles = await aoCandles(asset.aoToken, asset.aoEx, tf, aoSession);
      else if (asset.src === 'av' && asset.avSym && avKey) candles = await fetchAVKlines(asset.avSym, tf, avKey);
      else { setErr('No live data source connected for this asset.'); setLoading(false); return; }

      if (candles.length < 120) { setErr(`Only ${candles.length} candles available — need at least 120 for a meaningful backtest.`); setLoading(false); return; }
      setLastCandles(candles);

      const res = await runBacktest(candles, {
        startingCapital: parseFloat(capital) || 100000,
        feePct: parseFloat(feePct) || 0,
        slippagePct: parseFloat(slippagePct) || 0,
        riskPerTradePct: parseFloat(riskPct) || 2,
      });
      if (!res) { setErr('Not enough valid samples to backtest after feature warmup.'); setLoading(false); return; }
      setResult(res);
    } catch (e: any) {
      setErr(e.message);
    }
    setLoading(false);
  }, [asset, tf, capital, feePct, slippagePct, riskPct, aoSession, avKey]);

  const runDiagnostics = useCallback(async () => {
    if (!lastCandles.length) return;
    setLoadingDiagnostics(true);
    try {
      const diag = await runComprehensiveBacktest(lastCandles, {
        startingCapital: parseFloat(capital) || 100000,
        feePct: parseFloat(feePct) || 0,
        slippagePct: parseFloat(slippagePct) || 0,
        riskPerTradePct: parseFloat(riskPct) || 2,
        useVolatilityFilter: true,
        maxConsecutiveLosses: 5,
      });
      setDiagnostics(diag);
    } catch (e: any) {
      setErr(e.message);
    }
    setLoadingDiagnostics(false);
  }, [lastCandles, capital, feePct, slippagePct, riskPct]);

  // Simple equity curve SVG
  const W = 340, H = 140, PAD = 10;
  let curvePath = '';
  if (result?.equityCurve.length) {
    const eq = result.equityCurve.map(p => p.equity);
    const minE = Math.min(...eq), maxE = Math.max(...eq), range = maxE - minE || 1;
    const toX = (i: number) => PAD + (i / (eq.length - 1)) * (W - PAD * 2);
    const toY = (v: number) => H - PAD - ((v - minE) / range) * (H - PAD * 2);
    eq.forEach((v, i) => { curvePath += (i === 0 ? 'M' : 'L') + `${toX(i)},${toY(v)} `; });
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        <Text style={{ color: T.text, fontSize: 22, fontWeight: '800', marginBottom: 4 }}>Backtesting Engine</Text>
        <Text style={{ color: T.textDim, fontSize: 11, marginBottom: 16, lineHeight: 16 }}>
          Trains a fresh model on the first half of history, then walks forward bar-by-bar through the second half using the same signals as live prediction — never peeking ahead.
        </Text>

        <Text style={{ color: T.textDim, fontSize: 10, marginBottom: 6 }}>SYMBOL</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
          <View style={{ flexDirection: 'row', gap: 6 }}>
            {allAssets.slice(0, 14).map(a => <Pill key={a.symbol + a.src} label={a.symbol} color={T.blue} active={symbol === a.symbol} onPress={() => setSymbol(a.symbol)} />)}
          </View>
        </ScrollView>

        <Text style={{ color: T.textDim, fontSize: 10, marginBottom: 6 }}>TIMEFRAME</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 14 }}>
          <View style={{ flexDirection: 'row', gap: 6 }}>
            {['5m', '15m', '1h', '4h', '1D'].map(t => <Pill key={t} label={t} color={T.purple} active={tf === t} onPress={() => setTf(t)} />)}
          </View>
        </ScrollView>

        <Card theme={T} style={{ marginBottom: 14 }}>
          <SectionLabel theme={T}>CONFIGURATION</SectionLabel>
          <View style={{ flexDirection: 'row', gap: 10, marginBottom: 10 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: T.textDim, fontSize: 9, marginBottom: 4 }}>STARTING CAPITAL</Text>
              <TextInput value={capital} onChangeText={setCapital} keyboardType="numeric" style={inputStyle(T)} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ color: T.textDim, fontSize: 9, marginBottom: 4 }}>RISK / TRADE %</Text>
              <TextInput value={riskPct} onChangeText={setRiskPct} keyboardType="numeric" style={inputStyle(T)} />
            </View>
          </View>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: T.textDim, fontSize: 9, marginBottom: 4 }}>FEE % / SIDE</Text>
              <TextInput value={feePct} onChangeText={setFeePct} keyboardType="numeric" style={inputStyle(T)} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ color: T.textDim, fontSize: 9, marginBottom: 4 }}>SLIPPAGE % / SIDE</Text>
              <TextInput value={slippagePct} onChangeText={setSlippagePct} keyboardType="numeric" style={inputStyle(T)} />
            </View>
          </View>
        </Card>

        <PrimaryButton theme={T} label={loading ? 'RUNNING BACKTEST…' : 'RUN BACKTEST'} onPress={run} disabled={loading} />
        {loading && <ActivityIndicator color={T.blue} style={{ marginTop: 16 }} />}
        {err && <Text style={{ color: T.red, fontSize: 12, marginTop: 12 }}>⚠ {err}</Text>}

        {result && (
          <View style={{ marginTop: 16 }}>
            <Card theme={T} style={{ marginBottom: 14 }}>
              <SectionLabel theme={T}>EQUITY CURVE</SectionLabel>
              <Svg width={W} height={H}>
                <Line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke={T.border} strokeWidth={1} />
                <Path d={curvePath} stroke={result.metrics.netProfit >= 0 ? T.green : T.red} strokeWidth={2} fill="none" />
              </Svg>
              <Text style={{ color: T.textDim, fontSize: 9, marginTop: 6 }}>{result.walkedBars} bars walked forward · {result.trainSampleCount} samples used to fit the model · {result.featureCount} features</Text>
            </Card>

            <Card theme={T} style={{ marginBottom: 14 }}>
              <SectionLabel theme={T}>PERFORMANCE METRICS</SectionLabel>
              <MetricRow label="Total Return" value={`${result.metrics.totalReturnPct >= 0 ? '+' : ''}${result.metrics.totalReturnPct.toFixed(2)}%`} color={result.metrics.totalReturnPct >= 0 ? T.green : T.red} T={T} />
              <MetricRow label="Net Profit" value={`${result.metrics.netProfit >= 0 ? '+' : ''}${pFmt(result.metrics.netProfit)}`} color={result.metrics.netProfit >= 0 ? T.green : T.red} T={T} />
              <MetricRow label="Win Rate / Loss Rate" value={`${result.metrics.winRate.toFixed(1)}% / ${result.metrics.lossRate.toFixed(1)}%`} T={T} />
              <MetricRow label="Profit Factor" value={result.metrics.profitFactor === Infinity ? '∞' : result.metrics.profitFactor.toFixed(2)} T={T} />
              <MetricRow label="Sharpe (per-trade)" value={result.metrics.sharpeRatio.toFixed(2)} T={T} />
              <MetricRow label="Max Drawdown" value={`${result.metrics.maxDrawdownPct.toFixed(2)}%`} color={T.red} T={T} />
              <MetricRow label="Avg Win / Avg Loss" value={`${pFmt(result.metrics.avgWin)} / ${pFmt(result.metrics.avgLoss)}`} T={T} />
              <MetricRow label="Avg Trade" value={pFmt(result.metrics.avgTrade)} T={T} />
              <MetricRow label="Expectancy" value={pFmt(result.metrics.expectancy)} T={T} />
              <MetricRow label="Number of Trades" value={String(result.metrics.numTrades)} T={T} />
              <MetricRow label="Max Consecutive W / L" value={`${result.metrics.maxConsecutiveWins} / ${result.metrics.maxConsecutiveLosses}`} T={T} />
              <MetricRow label="Avg Holding (bars)" value={result.metrics.avgHoldingBars.toFixed(1)} T={T} />
            </Card>

            <TouchableOpacity onPress={() => setShowTrades(v => !v)} style={{ marginBottom: 10 }}>
              <Text style={{ color: T.accent, fontSize: 12, fontWeight: '700' }}>{showTrades ? '▼' : '▶'} Trade Log ({result.trades.length})</Text>
            </TouchableOpacity>
            {showTrades && result.trades.map((t, i) => (
              <Card key={i} theme={T} style={{ marginBottom: 8 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={{ color: T.textSub, fontSize: 10 }}>{new Date(t.entryTime).toLocaleString()}</Text>
                  <Text style={{ color: t.pnl >= 0 ? T.green : T.red, fontWeight: '700', fontSize: 12 }}>{t.pnl >= 0 ? '+' : ''}{pFmt(t.pnl)}</Text>
                </View>
                <Text style={{ color: T.textDim, fontSize: 9, marginTop: 4 }}>Entry {pFmt(t.entryPrice)} → Exit {pFmt(t.exitPrice)} ({t.exitReason}) · {t.holdingBars} bars</Text>
                <Text style={{ color: T.textDim, fontSize: 8.5, marginTop: 2 }}>{t.entryReason}</Text>
              </Card>
            ))}

            {/* Phase 2 — Advanced diagnostics. Reuses the SAME fetched
                candles and config as the backtest above; trains a fresh
                fitted model via the same fitEnsemble used everywhere else. */}
            <TouchableOpacity onPress={runDiagnostics} disabled={loadingDiagnostics} style={{
              backgroundColor: T.purple, padding: 12, borderRadius: 8, alignItems: 'center', marginTop: 16, opacity: loadingDiagnostics ? 0.6 : 1,
            }}>
              {loadingDiagnostics ? <ActivityIndicator color="#fff" /> : <Text style={{ color: '#fff', fontWeight: '700' }}>RUN ADVANCED DIAGNOSTICS</Text>}
            </TouchableOpacity>

            {diagnostics && (
              <View style={{ marginTop: 14 }}>
                <Card theme={T} style={{ marginBottom: 14 }}>
                  <SectionLabel theme={T}>SIGNAL DISTRIBUTION</SectionLabel>
                  <MetricRow label="BUY signals" value={`${diagnostics.signalDistribution.buy} (${diagnostics.signalDistribution.buyPct.toFixed(1)}%)`} color={T.green} T={T} />
                  <MetricRow label="SELL signals" value={`${diagnostics.signalDistribution.sell} (${diagnostics.signalDistribution.sellPct.toFixed(1)}%)`} color={T.red} T={T} />
                  <MetricRow label="HOLD signals" value={`${diagnostics.signalDistribution.hold} (${diagnostics.signalDistribution.holdPct.toFixed(1)}%)`} T={T} />
                  <Text style={{ color: T.textDim, fontSize: 9, marginTop: 8, lineHeight: 13 }}>
                    This engine opens both LONG and SHORT positions, mirroring live paper trading's direction logic exactly. LONG trades executed: {diagnostics.buyTrades}. SHORT trades executed: {diagnostics.sellTrades}.
                  </Text>
                </Card>

                <Card theme={T} style={{ marginBottom: 14 }}>
                  <SectionLabel theme={T}>WHY SIGNALS WERE SKIPPED ({diagnostics.skipReasons.totalSkipped} total)</SectionLabel>
                  {diagnostics.skipReasons.breakdown.map(b => (
                    <MetricRow key={b.reason} label={b.reason.replace(/_/g, ' ')} value={`${b.count} (${b.pct.toFixed(1)}%)`} T={T} />
                  ))}
                </Card>

                <Card theme={T} style={{ marginBottom: 14 }}>
                  <SectionLabel theme={T}>CONFIDENCE</SectionLabel>
                  <MetricRow label="Avg confidence at entry" value={diagnostics.avgEntryConfidence.toFixed(1)} T={T} />
                  <MetricRow label="Avg confidence at exit" value={diagnostics.avgExitConfidence.toFixed(1)} T={T} />
                  <Text style={{ color: T.textDim, fontSize: 9, marginTop: 8, marginBottom: 4 }}>DISTRIBUTION</Text>
                  {diagnostics.confidenceDistribution.map(c => (
                    <MetricRow key={c.range} label={c.range} value={String(c.count)} T={T} />
                  ))}
                </Card>

                <Card theme={T} style={{ marginBottom: 14 }}>
                  <SectionLabel theme={T}>TRADE DURATION HISTOGRAM (bars)</SectionLabel>
                  {diagnostics.durationHistogram.map(d => (
                    <MetricRow key={d.range} label={d.range} value={String(d.count)} T={T} />
                  ))}
                </Card>

                {diagnostics.monthly.length > 0 && (
                  <Card theme={T} style={{ marginBottom: 14 }}>
                    <SectionLabel theme={T}>MONTHLY PERFORMANCE</SectionLabel>
                    {diagnostics.monthly.map(m => (
                      <MetricRow key={m.period} label={m.period} value={`${m.trades}tr, ${pFmt(m.netPnl)}, ${m.winRate.toFixed(0)}% WR`} color={m.netPnl >= 0 ? T.green : T.red} T={T} />
                    ))}
                  </Card>
                )}

                {diagnostics.weekly.length > 0 && (
                  <Card theme={T} style={{ marginBottom: 14 }}>
                    <SectionLabel theme={T}>WEEKLY PERFORMANCE</SectionLabel>
                    {diagnostics.weekly.map(w => (
                      <MetricRow key={w.period} label={w.period} value={`${w.trades}tr, ${pFmt(w.netPnl)}, ${w.winRate.toFixed(0)}% WR`} color={w.netPnl >= 0 ? T.green : T.red} T={T} />
                    ))}
                  </Card>
                )}
              </View>
            )}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function MetricRow({ label, value, color, T }: { label: string; value: string; color?: string; T: any }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: T.border }}>
      <Text style={{ color: T.textDim, fontSize: 11 }}>{label}</Text>
      <Text style={{ color: color || T.text, fontWeight: '700', fontSize: 12 }}>{value}</Text>
    </View>
  );
}

function inputStyle(T: any) {
  return { backgroundColor: T.bg0, borderWidth: 1, borderColor: T.border, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 8, color: T.text, fontSize: 13 };
}
