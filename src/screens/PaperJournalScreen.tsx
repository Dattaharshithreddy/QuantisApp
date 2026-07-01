import React, { useState, useEffect } from 'react';
import { View, Text, ScrollView, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { Card, IconChip, ExpandableToggle, AnimatedReveal, Skeleton } from '../components/Common';
import { formatTradeQualityScore } from '../utils/tradeQuality';
import { tradeEconomicsWarning } from '../utils/tradeEconomics';
import { pFmt } from '../utils/indicators';
import { getPaperTrades, PaperTradeRecord } from '../utils/paperTradeJournal';
import { RADIUS, SPACING } from '../theme/colors';

export default function PaperJournalScreen({ navigation }: any) {
  const { theme: T } = useTheme();
  const [trades, setTrades] = useState<PaperTradeRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => { getPaperTrades().then(t => { setTrades(t); setLoading(false); }); }, []);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <Text style={{ color: T.text, fontSize: 22, fontWeight: '800' }}>Paper Trade Journal</Text>
          <TouchableOpacity onPress={() => navigation.navigate('PaperAnalytics')} activeOpacity={0.7} style={{ minHeight: 32, justifyContent: 'center' }}>
            <Text style={{ color: T.accent, fontSize: 12, fontWeight: '700' }}>Analytics →</Text>
          </TouchableOpacity>
        </View>
        <Text style={{ color: T.textDim, fontSize: 11, marginBottom: 14 }}>{loading ? 'Loading…' : `${trades.length} completed paper trade${trades.length === 1 ? '' : 's'}, persisted permanently.`}</Text>

        {loading && (
          <View style={{ gap: 10 }}>
            {[0, 1, 2].map(i => (
              <View key={i} style={{ backgroundColor: T.card, borderRadius: RADIUS.md, borderWidth: 1, borderColor: T.cardBorder, padding: SPACING.md }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 }}>
                  <Skeleton width={120} height={14} theme={T} />
                  <Skeleton width={70} height={14} theme={T} />
                </View>
                <Skeleton width={180} height={10} theme={T} />
              </View>
            ))}
          </View>
        )}
        {!loading && trades.length === 0 && (
          <View style={{ alignItems: 'center', paddingVertical: SPACING.xxl, paddingHorizontal: SPACING.xl }}>
            <Text style={{ fontSize: 36, marginBottom: 10 }}>📓</Text>
            <Text style={{ color: T.text, fontSize: 14, fontWeight: '700', marginBottom: 4 }}>No Completed Trades Yet</Text>
            <Text style={{ color: T.textDim, fontSize: 12, textAlign: 'center', lineHeight: 17 }}>Open a paper trade from the Chart screen — once it closes (TP, SL, or manual exit), it'll show up here with a full breakdown.</Text>
          </View>
        )}
        {trades.map(t => {
          const statusLabel = t.pnl > 0 ? 'WIN' : t.pnl < 0 ? 'LOSS' : 'BREAKEVEN';
          const statusColor = t.pnl > 0 ? T.green : t.pnl < 0 ? T.red : T.textDim;
          const isLong = t.direction === 'LONG';
          const dirColor = isLong ? T.green : T.red;
          return (
          <Card key={t.id} theme={T} style={{ marginBottom: 10 }}>
            <TouchableOpacity onPress={() => setExpanded(expanded === t.id ? null : t.id)} activeOpacity={0.75}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
                  <View style={{ backgroundColor: dirColor + '18', borderRadius: RADIUS.sm, paddingHorizontal: 7, paddingVertical: 3 }}>
                    <Text style={{ color: dirColor, fontSize: 9, fontWeight: '800' }}>{isLong ? '▲' : '▼'} {t.direction}</Text>
                  </View>
                  <Text style={{ color: T.text, fontWeight: '800', fontSize: 15 }}>{t.symbol}</Text>
                  <Text style={{ color: T.textDim, fontSize: 10, fontWeight: '600' }}>{t.timeframe}</Text>
                </View>
                <Text style={{ color: T.textDim, fontSize: 13 }}>{expanded === t.id ? '▼' : '▶'}</Text>
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 8 }}>
                <View style={{ backgroundColor: statusColor + '18', borderRadius: RADIUS.sm, paddingHorizontal: 8, paddingVertical: 3 }}>
                  <Text style={{ color: statusColor, fontSize: 10, fontWeight: '800' }}>{statusLabel}</Text>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={{ color: t.pnl >= 0 ? T.green : T.red, fontWeight: '800', fontSize: 16 }}>{t.pnl >= 0 ? '+' : ''}{pFmt(t.pnl)}</Text>
                  <Text style={{ color: t.pnl >= 0 ? T.green : T.red, fontSize: 10, fontWeight: '700' }}>{t.pnlPct >= 0 ? '+' : ''}{t.pnlPct.toFixed(2)}%</Text>
                </View>
              </View>
              <Text style={{ color: T.textDim, fontSize: 9 }}>{new Date(t.entryTime).toLocaleString()} → {new Date(t.exitTime).toLocaleString()}</Text>
              <Text style={{ color: T.textDim, fontSize: 9, marginTop: 1 }}>{t.exitReason} · {(t.holdingMs / 60000).toFixed(0)}m held</Text>
            </TouchableOpacity>
            {expanded === t.id && (
              <AnimatedReveal>
              <View style={{ marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: T.border }}>
                <Row label="Entry / Exit" value={`${pFmt(t.entryPrice)} / ${pFmt(t.exitPrice)}`} T={T} />
                <Row label="Quantity" value={t.qty.toFixed(4)} T={T} />
                <Row label="Gross P&L" value={`${t.grossPnl >= 0 ? '+' : ''}${pFmt(t.grossPnl)}`} color={t.grossPnl >= 0 ? T.green : T.red} T={T} />
                <Row label="Total Fees (entry + exit)" value={`-${pFmt(t.totalFees)}`} color={T.red} T={T} />
                <Row label="Slippage Cost (est.)" value={pFmt(t.slippageCost)} T={T} />
                <Row label="Net P&L" value={`${t.pnl >= 0 ? '+' : ''}${pFmt(t.pnl)}`} color={t.pnl >= 0 ? T.green : T.red} T={T} />
                <View style={{ marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: T.border, flexDirection: 'row', justifyContent: 'space-between' }}>
                  <View>
                    <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', letterSpacing: 1 }}>PREDICTION</Text>
                    <View style={{ backgroundColor: (t.predictionResult === 'CORRECT' ? T.green : t.predictionResult === 'INCORRECT' ? T.red : T.textDim) + '18', borderRadius: RADIUS.sm, paddingHorizontal: 8, paddingVertical: 3, marginTop: 3, alignSelf: 'flex-start' }}>
                      <Text style={{ color: t.predictionResult === 'CORRECT' ? T.green : t.predictionResult === 'INCORRECT' ? T.red : T.textDim, fontSize: 11, fontWeight: '800' }}>
                        {t.predictionResult === 'CORRECT' ? '✅ Correct' : t.predictionResult === 'INCORRECT' ? '❌ Incorrect' : '➖ Neutral'}
                      </Text>
                    </View>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', letterSpacing: 1 }}>FINANCIAL RESULT</Text>
                    <View style={{ backgroundColor: (t.pnl > 0 ? T.green : T.red) + '18', borderRadius: RADIUS.sm, paddingHorizontal: 8, paddingVertical: 3, marginTop: 3, alignSelf: 'flex-end' }}>
                      <Text style={{ color: t.pnl > 0 ? T.green : T.red, fontSize: 11, fontWeight: '800', textAlign: 'right' }}>
                        {t.pnl > 0 ? '🟢 Profit' : t.predictionResult !== 'INCORRECT' ? '🔴 Loss (Fees/Slippage exceeded profit)' : '🔴 Loss'}
                      </Text>
                    </View>
                  </View>
                </View>
                <Text style={{ color: T.textDim, fontSize: 9, marginTop: 4, lineHeight: 13 }}>Gross P&L minus Total Fees = Net P&L. Slippage is already built into the entry/exit prices shown above (not a separate deduction) — the figure here is an informational estimate of its dollar impact.</Text>
                {t.tradeEconomics && (() => {
                  const e = t.tradeEconomics;
                  const warning = tradeEconomicsWarning(e);
                  return (
                    <View style={{ marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: T.border }}>
                      <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', marginBottom: 4, letterSpacing: 1 }}>EXPECTED AT ENTRY (DIAGNOSTIC, NOT ACTUAL)</Text>
                      <Row label="Expected Gross Profit (if TP hit)" value={pFmt(e.expectedGrossProfit)} T={T} />
                      <Row label="Expected Loss (if SL hit)" value={pFmt(e.expectedLoss)} T={T} />
                      <Row label="Expected Round-trip Fees" value={pFmt(e.expectedRoundTripFees)} T={T} />
                      <Row label="Expected Slippage Cost" value={pFmt(e.expectedSlippageCost)} T={T} />
                      <Row label="Expected Net Edge" value={`${e.expectedNetEdge >= 0 ? '+' : ''}${pFmt(e.expectedNetEdge)}`} color={e.expectedNetEdge >= 0 ? T.green : T.red} T={T} />
                      <Row label="Cost as % of Expected Profit" value={e.costAsPctOfExpectedProfit != null ? `${e.costAsPctOfExpectedProfit.toFixed(1)}%` : 'n/a'} T={T} />
                      <Row label="ATR as % of Price" value={`${e.atrPctOfPrice.toFixed(3)}%`} T={T} />
                      <Row label="TP Distance as % of Price" value={`${e.tpDistancePctOfPrice.toFixed(3)}%`} T={T} />
                      {warning && <Text style={{ color: T.amber, fontSize: 10, fontWeight: '700', marginTop: 6 }}>{warning}</Text>}
                    </View>
                  );
                })()}
                <Row label="P&L %" value={`${t.pnlPct.toFixed(2)}%`} T={T} />
                <Row label="Max Unrealized Profit" value={pFmt(t.maxUnrealizedProfit)} T={T} />
                <Row label="Max Drawdown" value={pFmt(t.maxDrawdownDuringTrade)} T={T} />
                <Row label="AI Confidence" value={`${t.aiConfidence.toFixed(0)}/100`} T={T} />
                {t.tradeQuality && <Row label="Trade Quality" value={`${formatTradeQualityScore(t.tradeQuality.score)}/100 ${t.tradeQuality.stars} ${t.tradeQuality.grade}`} color={T.accent} T={T} />}
                <Row label="Model Version" value={`v${t.modelVersion}`} T={T} />
                <Row label="Prediction Horizon" value={`${t.predictionHorizon}-bar`} T={T} />
                <Row label="Market Regime" value={t.marketRegime} T={T} />
                <Row label="Entry Reason" value={t.entryReason} T={T} multiline />
                <Text style={{ color: T.textDim, fontSize: 9, marginTop: 8, marginBottom: 4 }}>TOP FEATURES AT ENTRY</Text>
                {t.topFeatures.slice(0, 3).map(f => <Text key={f.name} style={{ color: T.textSub, fontSize: 9 }}>{f.name}: {f.value.toFixed(4)}</Text>)}
                <TouchableOpacity onPress={() => navigation.navigate('PaperReplay', { trade: t })} activeOpacity={0.8} style={{ marginTop: 10, backgroundColor: T.purple, paddingVertical: 12, borderRadius: RADIUS.sm, alignItems: 'center', minHeight: 44, justifyContent: 'center' }}>
                  <Text style={{ color: '#fff', fontSize: 11, fontWeight: '700' }}>▶ Replay this trade</Text>
                </TouchableOpacity>
              </View>
              </AnimatedReveal>
            )}
          </Card>
          );
        })}
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({ label, value, T, multiline, color }: any) {
  return (
    <View style={{ flexDirection: multiline ? 'column' : 'row', justifyContent: 'space-between', paddingVertical: 3 }}>
      <Text style={{ color: T.textDim, fontSize: 10 }}>{label}</Text>
      <Text style={{ color: color || T.text, fontWeight: '600', fontSize: 10, marginTop: multiline ? 2 : 0 }}>{value}</Text>
    </View>
  );
}
