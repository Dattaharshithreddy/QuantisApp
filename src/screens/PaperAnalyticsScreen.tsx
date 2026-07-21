import React, { useState, useEffect } from 'react';
import { View, Text, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { Card, SectionLabel, Pill, MetricBox, Skeleton } from '../components/Common';
import { pFmt } from '../utils/indicators';
import { computePaperPortfolioStats, PaperPortfolioStats } from '../utils/paperAnalytics';
import { getBestPerformers, getAIPerformanceForSymbol, AIPerformanceSummary } from '../utils/aiPerformanceTracking';
import { formatTradeQualityScore } from '../utils/tradeQuality';
import { getPortfolio } from '../utils/paperPortfolio';
import { computeAllFamilyStats } from '../utils/patternValidation/patternOutcomeStore';
import type { PatternFamilyStats } from '../utils/patternValidation/patternValidationTypes';
import { getPaperTrades } from '../utils/paperTradeJournal';
import { RADIUS, SPACING } from '../theme/colors';

export default function PaperAnalyticsScreen() {
  const { theme: T } = useTheme();
  const [stats, setStats] = useState<PaperPortfolioStats | null>(null);
  const [realizedPnL, setRealizedPnL] = useState<number | null>(null);
  const [bestPerformers, setBestPerformers] = useState<{ bestSymbol: string | null; bestTimeframe: string | null; bestHorizon: number | null } | null>(null);
  const [tradedPairs, setTradedPairs] = useState<{ symbol: string; timeframe: string }[]>([]);
  const [selectedPair, setSelectedPair] = useState<{ symbol: string; timeframe: string } | null>(null);
  const [health, setHealth] = useState<AIPerformanceSummary | null>(null);
  // UI polish — groups the existing 12 cards into 3 tabs to reduce
  // continuous scrolling, exactly the same pattern already used below for
  // the AI Health symbol/timeframe picker. Pure conditional rendering of
  // the same existing cards; no data or logic changes.
  const [activeTab, setActiveTab] = useState<'overview' | 'breakdowns' | 'ai' | 'patterns'>('overview');
  const [patternStats, setPatternStats] = useState<PatternFamilyStats[]>([]);

  useEffect(() => {
    if (!selectedPair) { setHealth(null); return; }
    getAIPerformanceForSymbol(selectedPair.symbol, selectedPair.timeframe).then(setHealth);
  }, [selectedPair]);

  useEffect(() => {
    computeAllFamilyStats().then(setPatternStats).catch(() => {});
    getPortfolio().then(async p => {
      setRealizedPnL(p.realizedPnL);
      setStats(await computePaperPortfolioStats(p.startingCapital));
      setBestPerformers(await getBestPerformers());
      const trades = await getPaperTrades();
      const seen = new Set<string>();
      const pairs: { symbol: string; timeframe: string }[] = [];
      trades.forEach(t => {
        const key = `${t.symbol}|${t.timeframe}`;
        if (!seen.has(key)) { seen.add(key); pairs.push({ symbol: t.symbol, timeframe: t.timeframe }); }
      });
      setTradedPairs(pairs);
      if (pairs.length && !selectedPair) setSelectedPair(pairs[0]);
    });
  }, []);

  if (!stats) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
        <View style={{ padding: SPACING.lg }}>
          <Skeleton width={180} height={22} theme={T} style={{ marginBottom: 18 }} />
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 14 }}>
            <Skeleton width={80} height={32} radius={RADIUS.pill} theme={T} />
            <Skeleton width={100} height={32} radius={RADIUS.pill} theme={T} />
            <Skeleton width={80} height={32} radius={RADIUS.pill} theme={T} />
          </View>
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
            <Skeleton width="48%" height={64} theme={T} />
            <Skeleton width="48%" height={64} theme={T} />
          </View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Skeleton width="48%" height={64} theme={T} />
            <Skeleton width="48%" height={64} theme={T} />
          </View>
        </View>
      </SafeAreaView>
    );
  }
  const te = stats.tradeEconomicsStats;
  const pa = stats.predictionAccuracyStats;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        <Text style={{ color: T.text, fontSize: 22, fontWeight: '800', marginBottom: 16 }}>Portfolio Analytics</Text>

        {stats.totalTrades > 0 && (
          <View style={{ marginBottom: 14 }}>
            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
              <MetricBox label="WIN RATE" value={`${stats.winRate.toFixed(1)}%`} valueColor={stats.winRate >= 50 ? T.green : T.amber} bg={stats.winRate >= 50 ? T.green + '10' : T.amber + '10'} theme={T} />
              <MetricBox label="PREDICTION ACCURACY" value={stats.predictionAccuracyStats.predictionAccuracy != null ? `${stats.predictionAccuracyStats.predictionAccuracy.toFixed(1)}%` : 'n/a'} valueColor={stats.predictionAccuracyStats.predictionAccuracy != null && stats.predictionAccuracyStats.predictionAccuracy >= 50 ? T.green : T.amber} theme={T} />
            </View>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <MetricBox label="REALIZED P&L" value={realizedPnL != null ? pFmt(realizedPnL) : '—'} valueColor={realizedPnL != null ? (realizedPnL >= 0 ? T.green : T.red) : T.text} bg={realizedPnL != null ? (realizedPnL >= 0 ? T.green + '10' : T.red + '10') : T.bg3} theme={T} />
              <MetricBox label="AVG TRADE QUALITY" value={stats.avgTradeQuality != null ? `${formatTradeQualityScore(stats.avgTradeQuality)}/100` : 'n/a'} valueColor={T.accent} theme={T} />
            </View>
          </View>
        )}

        {stats.totalTrades === 0 && (
          <View style={{ alignItems: 'center', paddingVertical: SPACING.xxl, paddingHorizontal: SPACING.xl, marginBottom: 16 }}>
            <Text style={{ fontSize: 36, marginBottom: 10 }}>📊</Text>
            <Text style={{ color: T.text, fontSize: 14, fontWeight: '700', marginBottom: 4 }}>No Trade History Yet</Text>
            <Text style={{ color: T.textDim, fontSize: 12, textAlign: 'center', lineHeight: 17 }}>
              Open a paper trade from the Chart screen — once you have closed trades, your full performance breakdown will appear here.
            </Text>
          </View>
        )}

        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 14 }}>
          <Pill label="Overview" color={T.blue} active={activeTab === 'overview'} onPress={() => setActiveTab('overview')} />
          <Pill label="Breakdowns" color={T.blue} active={activeTab === 'breakdowns'} onPress={() => setActiveTab('breakdowns')} />
          <Pill label="AI Health" color={T.blue} active={activeTab === 'ai'} onPress={() => setActiveTab('ai')} />
          <Pill label="Patterns"  color={T.blue} active={activeTab === 'patterns'} onPress={() => setActiveTab('patterns')} />
        </View>

        {activeTab === 'overview' && (<>
        <Card theme={T} style={{ marginBottom: 14 }}>
          <SectionLabel theme={T}>OVERALL PERFORMANCE</SectionLabel>
          <Row label="Total Trades" value={String(stats.totalTrades)} T={T} />
          <Row label="Winning / Losing" value={`${stats.winningTrades} / ${stats.losingTrades}`} T={T} />
          <Row label="Win Rate" value={`${stats.winRate.toFixed(1)}%`} color={stats.winRate >= 50 ? T.green : T.amber} T={T} />
          <Row label="Prediction Accuracy" value={stats.predictionAccuracyStats.predictionAccuracy != null ? `${stats.predictionAccuracyStats.predictionAccuracy.toFixed(1)}%` : 'n/a'} color={stats.predictionAccuracyStats.predictionAccuracy != null && stats.predictionAccuracyStats.predictionAccuracy >= 50 ? T.green : T.amber} T={T} />
          <Text style={{ color: T.textDim, fontSize: 9, marginTop: 2, marginBottom: 4, lineHeight: 12 }}>Win Rate = net profitability after fees/slippage. Prediction Accuracy = whether the AI called market direction correctly, regardless of cost. Different questions — neither replaces the other.</Text>
          <Row label="Profit Factor" value={stats.profitFactor === Infinity ? '∞' : stats.profitFactor.toFixed(2)} T={T} />
          <Row label="Sharpe Ratio" value={stats.sharpeRatio.toFixed(2)} T={T} />
          <Row label="Max Drawdown" value={`${stats.maxDrawdownPct.toFixed(2)}%`} color={T.red} T={T} />
          <Row label="Avg Win / Avg Loss" value={`${pFmt(stats.avgWin)} / ${pFmt(stats.avgLoss)}`} T={T} />
          <Row label="Avg Holding" value={`${(stats.avgHoldingMs / 60000).toFixed(0)}m`} T={T} />
        </Card>

        <Card theme={T} style={{ marginBottom: 14 }}>
          <SectionLabel theme={T}>LONG VS SHORT</SectionLabel>
          <Row label="Long trades" value={`${stats.longCount} (${stats.longWinRate.toFixed(0)}% WR)`} T={T} />
          <Row label="Short trades" value={`${stats.shortCount} (${stats.shortWinRate.toFixed(0)}% WR)`} T={T} />
          {stats.shortCount === 0 && stats.longCount > 0 && <Text style={{ color: T.textDim, fontSize: 9, marginTop: 6 }}>No short trades yet — shorting is supported, just not used in any closed trade so far.</Text>}
        </Card>

        <Card theme={T} style={{ marginBottom: 14 }}>
          <SectionLabel theme={T}>BEST / WORST TRADE</SectionLabel>
          {stats.bestTrade ? <Row label={`Best: ${stats.bestTrade.symbol}`} value={`${pFmt(stats.bestTrade.pnl)} (${stats.bestTrade.pnlPct.toFixed(1)}%)`} color={T.green} T={T} /> : <Row label="Best trade" value="n/a" T={T} />}
          {stats.worstTrade ? <Row label={`Worst: ${stats.worstTrade.symbol}`} value={`${pFmt(stats.worstTrade.pnl)} (${stats.worstTrade.pnlPct.toFixed(1)}%)`} color={T.red} T={T} /> : <Row label="Worst trade" value="n/a" T={T} />}
        </Card>

        <Card theme={T} style={{ marginBottom: 14 }}>
          <SectionLabel theme={T}>MOST PROFITABLE / MOST ACCURATE</SectionLabel>
          <Row label="Most Profitable Symbol" value={stats.mostProfitableSymbol || 'n/a'} T={T} />
          <Row label="Most Accurate Symbol" value={stats.mostAccurateSymbol || 'n/a (needs 3+ trades)'} T={T} />
          <Row label="Most Profitable Timeframe" value={stats.mostProfitableTimeframe || 'n/a'} T={T} />
          <Row label="Most Accurate Timeframe" value={stats.mostAccurateTimeframe || 'n/a (needs 3+ trades)'} T={T} />
        </Card>

        <Card theme={T} style={{ marginBottom: 14 }}>
          <SectionLabel theme={T}>AVERAGES & TREND</SectionLabel>
          <Row label="Average Confidence" value={`${stats.avgConfidence.toFixed(0)}/100`} T={T} />
          <Row label="Average Risk Score" value={`${stats.avgRisk.toFixed(0)}/100`} T={T} />
          {stats.avgTradeQuality != null && <Row label="Average Trade Quality" value={`${formatTradeQualityScore(stats.avgTradeQuality)}/100`} color={T.accent} T={T} />}
          <Row label="Performance Trend" value={stats.performanceTrend.replace(/_/g, ' ')} color={stats.performanceTrend === 'IMPROVING' ? T.green : stats.performanceTrend === 'DECLINING' ? T.red : T.textDim} T={T} />
        </Card>

        <Card theme={T} style={{ marginBottom: 14 }}>
          <SectionLabel theme={T}>TRADE ECONOMICS (DIAGNOSTIC ONLY)</SectionLabel>
          <Text style={{ color: T.textDim, fontSize: 9, marginBottom: 8, lineHeight: 13 }}>These numbers describe what was EXPECTED at entry time — they have never been used to accept or reject any trade.</Text>
          {te.tradesWithData === 0 ? (
            <Text style={{ color: T.textDim, fontSize: 11 }}>No trades with economic diagnostics yet.</Text>
          ) : (
            <>
              <Row label="Trades with negative expected edge" value={`${te.negativeEdgeCount} of ${te.tradesWithData}`} color={te.negativeEdgeCount > 0 ? T.amber : T.textSub} T={T} />
              <Row label="Win rate — negative-edge trades" value={te.negativeEdgeWinRate != null ? `${te.negativeEdgeWinRate.toFixed(1)}%` : 'n/a'} T={T} />
              <Row label="Win rate — positive-edge trades" value={te.positiveEdgeWinRate != null ? `${te.positiveEdgeWinRate.toFixed(1)}%` : 'n/a'} T={T} />
              <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', marginTop: 10, marginBottom: 4, letterSpacing: 1 }}>AVG P&amp;L BY EXPECTED-EDGE BUCKET</Text>
              {te.avgPnlByEdgeBucket.map(b => (
                <Row key={b.bucket} label={`${b.bucket} (${b.trades} trades)`} value={b.trades ? `${b.avgPnl >= 0 ? '+' : ''}${pFmt(b.avgPnl)}` : 'n/a'} color={b.avgPnl >= 0 ? T.green : T.red} T={T} />
              ))}
              <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', marginTop: 10, marginBottom: 4, letterSpacing: 1 }}>COST AS % OF EXPECTED PROFIT — DISTRIBUTION</Text>
              {(() => {
                const maxCount = Math.max(...te.costProfitRatioDistribution.map(b => b.count), 1);
                return te.costProfitRatioDistribution.map(b => (
                  <View key={b.range} style={{ marginBottom: 4 }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 2 }}>
                      <Text style={{ color: T.textDim, fontSize: 10 }}>{b.range}</Text>
                      <Text style={{ color: T.text, fontSize: 10, fontWeight: '700' }}>{b.count}</Text>
                    </View>
                    <View style={{ height: 5, borderRadius: 3, backgroundColor: T.bg3, overflow: 'hidden' }}>
                      <View style={{ width: `${(b.count / maxCount) * 100}%`, height: '100%', backgroundColor: T.accent, borderRadius: 3 }} />
                    </View>
                  </View>
                ));
              })()}
            </>
          )}
        </Card>

        <Card theme={T} style={{ marginBottom: 14 }}>
          <SectionLabel theme={T}>PREDICTION ACCURACY VS FINANCIAL RESULT</SectionLabel>
          <Text style={{ color: T.textDim, fontSize: 9, marginBottom: 8, lineHeight: 13 }}>Computed only from each trade's real executed entry/exit prices and direction — not from P&L, confidence, or exit reason.</Text>
          <Row label="Correct Predictions" value={String(pa.correctCount)} color={T.green} T={T} />
          <Row label="Incorrect Predictions" value={String(pa.incorrectCount)} color={T.red} T={T} />
          {pa.neutralCount > 0 && <Row label="Neutral (no price movement)" value={String(pa.neutralCount)} T={T} />}
          <Row label="Correct but Losing Trades" value={String(pa.correctButLosingCount)} color={pa.correctButLosingCount > 0 ? T.amber : T.textSub} T={T} />
          <Row label="Incorrect but Winning Trades" value={String(pa.incorrectButWinningCount)} T={T} />
          <Row label="Avg P&L — Correct Predictions" value={pa.avgPnlCorrect != null ? `${pa.avgPnlCorrect >= 0 ? '+' : ''}${pFmt(pa.avgPnlCorrect)}` : 'n/a'} color={pa.avgPnlCorrect != null && pa.avgPnlCorrect >= 0 ? T.green : T.red} T={T} />
          <Row label="Avg P&L — Incorrect Predictions" value={pa.avgPnlIncorrect != null ? `${pa.avgPnlIncorrect >= 0 ? '+' : ''}${pFmt(pa.avgPnlIncorrect)}` : 'n/a'} color={pa.avgPnlIncorrect != null && pa.avgPnlIncorrect >= 0 ? T.green : T.red} T={T} />
        </Card>

        </>)}

        {activeTab === 'breakdowns' && (<>
        <Card theme={T} style={{ marginBottom: 14 }}>
          <SectionLabel theme={T}>PERFORMANCE BY SYMBOL</SectionLabel>
          {stats.bySymbol.map(s => <Row key={s.symbol} label={s.symbol} value={`${s.trades}tr, ${pFmt(s.netPnl)}, ${s.winRate.toFixed(0)}%WR`} color={s.netPnl >= 0 ? T.green : T.red} T={T} />)}
        </Card>

        <Card theme={T} style={{ marginBottom: 14 }}>
          <SectionLabel theme={T}>PERFORMANCE BY ASSET CLASS</SectionLabel>
          {stats.byAssetClass.map(s => <Row key={s.assetClass} label={s.assetClass} value={`${s.trades}tr, ${pFmt(s.netPnl)}, ${s.winRate.toFixed(0)}%WR`} color={s.netPnl >= 0 ? T.green : T.red} T={T} />)}
        </Card>

        <Card theme={T} style={{ marginBottom: 14 }}>
          <SectionLabel theme={T}>PERFORMANCE BY MARKET REGIME</SectionLabel>
          {stats.byRegime.map(s => <Row key={s.regime} label={s.regime} value={`${s.trades}tr, ${pFmt(s.netPnl)}, ${s.winRate.toFixed(0)}%WR`} color={s.netPnl >= 0 ? T.green : T.red} T={T} />)}
        </Card>

        <Card theme={T} style={{ marginBottom: 14 }}>
          <SectionLabel theme={T}>PERFORMANCE BY TIMEFRAME</SectionLabel>
          {stats.byTimeframe.map(s => <Row key={s.timeframe} label={s.timeframe} value={`${s.trades}tr, ${pFmt(s.netPnl)}, ${s.winRate.toFixed(0)}%WR`} color={s.netPnl >= 0 ? T.green : T.red} T={T} />)}
        </Card>

        <Card theme={T} style={{ marginBottom: 14 }}>
          <SectionLabel theme={T}>PERFORMANCE BY PREDICTION HORIZON</SectionLabel>
          {stats.byHorizon.map(s => <Row key={s.horizon} label={`${s.horizon}-bar`} value={`${s.trades}tr, ${pFmt(s.netPnl)}, ${s.winRate.toFixed(0)}%WR`} color={s.netPnl >= 0 ? T.green : T.red} T={T} />)}
        </Card>

        </>)}

        {activeTab === 'ai' && (<>
        {tradedPairs.length > 0 && (
          <Card theme={T} style={{ marginBottom: 14 }}>
            <SectionLabel theme={T}>AI HEALTH</SectionLabel>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 10 }}>
              <View style={{ flexDirection: 'row', gap: 6 }}>
                {tradedPairs.map(p => (
                  <Pill key={`${p.symbol}|${p.timeframe}`} label={`${p.symbol} ${p.timeframe}`} color={T.blue}
                    active={selectedPair?.symbol === p.symbol && selectedPair?.timeframe === p.timeframe}
                    onPress={() => setSelectedPair(p)} />
                ))}
              </View>
            </ScrollView>
            {health && (
              <View>
                <View style={{ backgroundColor: health.modelStatus === 'Healthy' ? T.green + '15' : health.modelStatus === 'Needs Retraining' ? T.red + '15' : T.amber + '15', borderRadius: RADIUS.sm, padding: 10, marginBottom: 10 }}>
                  <Text style={{ color: health.modelStatus === 'Healthy' ? T.green : health.modelStatus === 'Needs Retraining' ? T.red : T.amber, fontWeight: '800', fontSize: 13 }}>{health.modelStatus.toUpperCase()}</Text>
                  <Text style={{ color: T.textDim, fontSize: 9, marginTop: 4, lineHeight: 13 }}>{health.modelStatusReason}</Text>
                </View>
                <Row label="Model Version" value={health.modelVersion != null ? `v${health.modelVersion}` : 'n/a'} T={T} />
                <Row label="Training / Validation Samples" value={`${health.trainingSamples ?? 'n/a'} / ${health.validationSamples ?? 'n/a'}`} T={T} />
                <Row label="Walk-forward Accuracy" value={health.walkForwardAccuracy != null ? `${health.walkForwardAccuracy.toFixed(1)}%` : 'n/a'} T={T} />
                <Row label="Validation Accuracy" value={health.validationAccuracy != null ? `${health.validationAccuracy.toFixed(1)}%` : 'n/a'} T={T} />
                <Row label="Current Loss" value={health.currentLoss != null ? health.currentLoss.toFixed(4) : 'n/a'} T={T} />
                <Row label="Calibration Score" value={health.calibrationScore != null ? health.calibrationScore.toFixed(0) : 'not enough resolved predictions yet'} T={T} />
                <Row label="Prediction Accuracy" value={health.predictionAccuracy != null ? `${health.predictionAccuracy.toFixed(1)}%` : 'n/a'} T={T} />
                <Row label="Average Confidence" value={`${health.avgConfidence.toFixed(0)}/100`} T={T} />
                <Row label="Live Paper Trades" value={String(health.numLivePaperTrades)} T={T} />
                <Row label="Last Retrained" value={health.lastRetrained ? new Date(health.lastRetrained).toLocaleString() : 'n/a'} T={T} />
                {health.mostImportantFeatures.length > 0 && (
                  <View style={{ marginTop: 8 }}>
                    <Text style={{ color: T.textDim, fontSize: 9, marginBottom: 4 }}>MOST IMPORTANT FEATURES (from real trade history)</Text>
                    {health.mostImportantFeatures.map(f => <Row key={f.name} label={f.name} value={f.avgInfluence.toFixed(3)} T={T} />)}
                  </View>
                )}
              </View>
            )}
          </Card>
        )}

        {bestPerformers && (
          <Card theme={T} style={{ marginBottom: 14 }}>
            <SectionLabel theme={T}>BEST PERFORMERS (by total P&L)</SectionLabel>
            <Row label="Best Symbol" value={bestPerformers.bestSymbol || 'n/a'} T={T} />
            <Row label="Best Timeframe" value={bestPerformers.bestTimeframe || 'n/a'} T={T} />
            <Row label="Best Horizon" value={bestPerformers.bestHorizon != null ? `${bestPerformers.bestHorizon}-bar` : 'n/a'} T={T} />
          </Card>
        )}
        </>)}

        {activeTab === 'patterns' && (<>
          <Card theme={T} style={{ marginBottom: 14 }}>
            <SectionLabel theme={T}>PATTERN PERFORMANCE STATISTICS</SectionLabel>
            <Text style={{ color: T.textDim, fontSize: 9, marginBottom: 10, lineHeight: 13 }}>
              Hit rates computed from confirmed patterns tracked since v6.3.24.
              Patterns with fewer than 20 resolved outcomes are flagged as low sample.
            </Text>
            {patternStats.length === 0 ? (
              <View style={{ alignItems: 'center', paddingVertical: 24 }}>
                <Text style={{ fontSize: 28, marginBottom: 8 }}>📐</Text>
                <Text style={{ color: T.text, fontSize: 13, fontWeight: '700', marginBottom: 4 }}>No Pattern Data Yet</Text>
                <Text style={{ color: T.textDim, fontSize: 11, textAlign: 'center', lineHeight: 17 }}>
                  Pattern outcomes accumulate automatically as confirmed patterns are tracked.
                  Keep the Chart screen open or the Scanner running to build this history.
                </Text>
              </View>
            ) : patternStats.map(ps => {
              const tp1Col = ps.tp1HitRate >= 0.6 ? T.green : ps.tp1HitRate >= 0.4 ? T.amber : T.red;
              return (
                <View key={ps.patternName} style={{ marginBottom: 12, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: T.border }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                    <Text style={{ color: T.text, fontSize: 11, fontWeight: '700' }}>{ps.patternName}</Text>
                    <View style={{ flexDirection: 'row', gap: 4 }}>
                      <View style={{ backgroundColor: T.bg3, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 }}>
                        <Text style={{ color: T.textDim, fontSize: 8 }}>{ps.totalConfirmed} confirmed</Text>
                      </View>
                      {!ps.sampleSufficient && (
                        <View style={{ backgroundColor: T.amber + '20', borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 }}>
                          <Text style={{ color: T.amber, fontSize: 8 }}>Low sample</Text>
                        </View>
                      )}
                    </View>
                  </View>
                  <View style={{ flexDirection: 'row', gap: 6, marginBottom: 6 }}>
                    {[{label:'TP1', rate:ps.tp1HitRate, col:tp1Col},{label:'TP2',rate:ps.tp2HitRate,col:T.green},{label:'TP3',rate:ps.tp3HitRate,col:T.accent},{label:'Stop',rate:ps.stopRate,col:T.red}].map(({label,rate,col}) => (
                      <View key={label} style={{ flex:1, backgroundColor: col+'18', borderRadius:4, padding:6, alignItems:'center' }}>
                        <Text style={{ color:col, fontSize:13, fontWeight:'800' }}>{(rate*100).toFixed(0)}%</Text>
                        <Text style={{ color:T.textDim, fontSize:8 }}>{label}</Text>
                      </View>
                    ))}
                  </View>
                  <View style={{ flexDirection:'row', justifyContent:'space-between' }}>
                    <Text style={{ color:T.textDim, fontSize:9 }}>Avg P&L <Text style={{ color:ps.avgRealizedPnLPct>=0?T.green:T.red, fontWeight:'700' }}>{ps.avgRealizedPnLPct>=0?'+':''}{(ps.avgRealizedPnLPct*100).toFixed(2)}%</Text></Text>
                    {ps.expiredRate>0 && <Text style={{ color:T.textDim, fontSize:9 }}>Expired <Text style={{ color:T.amber, fontWeight:'700' }}>{(ps.expiredRate*100).toFixed(0)}%</Text></Text>}
                    {ps.avgBarsToTP1!=null && <Text style={{ color:T.textDim, fontSize:9 }}>Bars to TP1 <Text style={{ color:T.text, fontWeight:'700' }}>{ps.avgBarsToTP1.toFixed(0)}</Text></Text>}
                  </View>
                </View>
              );
            })}
          </Card>
        </>)}
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({ label, value, color, T }: any) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 5 }}>
      <Text style={{ color: T.textDim, fontSize: 11 }}>{label}</Text>
      <Text style={{ color: color || T.text, fontWeight: '700', fontSize: 11 }}>{value}</Text>
    </View>
  );
}
