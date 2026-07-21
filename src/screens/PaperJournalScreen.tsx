import React, { useState, useEffect } from 'react';
import { View, Text, ScrollView, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { Card, IconChip, ExpandableToggle, AnimatedReveal, Skeleton } from '../components/Common';
import { formatTradeQualityScore } from '../utils/tradeQuality';
import { tradeEconomicsWarning } from '../utils/tradeEconomics';
import { pFmt } from '../utils/indicators';
import { getPaperTrades, PaperTradeRecord } from '../utils/paperTradeJournal';
import { managementOutcomeLabel } from '../utils/predictionResult';
import { RADIUS, SPACING } from '../theme/colors';
import { MarketContextCard } from '../components/MarketContextCard';

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
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 1, flexWrap: 'wrap' }}>
                <Text style={{ color: T.textDim, fontSize: 9 }}>
                  {(t as any).tradeManagementOutcome
                    ? managementOutcomeLabel((t as any).tradeManagementOutcome).replace(/^[^ ]+ /, '')
                    : t.exitReason} · {(t.holdingMs / 60000).toFixed(0)}m held
                </Text>
                {(t as any).strategyId && (
                  <View style={{ backgroundColor: T.bg3, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1, flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                    <Text style={{ fontSize: 9 }}>{(t as any).strategyIcon ?? '⚙️'}</Text>
                    <Text style={{ color: T.textDim, fontSize: 8, fontWeight: '600' }}>{(t as any).strategyName ?? (t as any).strategyId}</Text>
                  </View>
                )}
              </View>
            </TouchableOpacity>
            {expanded === t.id && (
              <AnimatedReveal>
              <View style={{ marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: T.border }}>

                {/* Strategy chip — only shown when trade has strategy info */}
                {(t as any).strategyId && (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10,
                    backgroundColor: T.bg3, borderRadius: RADIUS.sm, padding: 8,
                    borderWidth: 1, borderColor: T.textDim + '30' }}>
                    <Text style={{ fontSize: 14 }}>{(t as any).strategyIcon ?? '⚙️'}</Text>
                    <View>
                      <Text style={{ color: T.textDim, fontSize: 8, fontWeight: '700', letterSpacing: 0.5 }}>STRATEGY</Text>
                      <Text style={{ color: T.text, fontSize: 12, fontWeight: '700' }}>
                        {(t as any).strategyName ?? (t as any).strategyId}
                      </Text>
                    </View>
                  </View>
                )}

                <Row label="Entry / Exit" value={`${pFmt(t.entryPrice)} / ${pFmt(t.exitPrice)}`} T={T} />
                <Row label="Quantity" value={t.qty.toFixed(4)} T={T} />
                <Row label="Gross P&L" value={`${t.grossPnl >= 0 ? '+' : ''}${pFmt(t.grossPnl)}`} color={t.grossPnl >= 0 ? T.green : T.red} T={T} />
                <Row label="Total Fees (entry + exit)" value={`-${pFmt(t.totalFees)}`} color={T.red} T={T} />
                <Row label="Slippage Cost (est.)" value={pFmt(t.slippageCost)} T={T} />
                <Row label="Net P&L" value={`${t.pnl >= 0 ? '+' : ''}${pFmt(t.pnl)}`} color={t.pnl >= 0 ? T.green : T.red} T={T} />
                {/* Dual outcome block — Prediction Outcome + Trade Management kept separate */}
                <View style={{ marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: T.border }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 }}>
                    {/* PREDICTION OUTCOME: did price move in predicted direction? */}
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', letterSpacing: 1, marginBottom: 3 }}>PREDICTION OUTCOME</Text>
                      <View style={{
                        backgroundColor: (t.predictionResult === 'CORRECT' ? T.green : t.predictionResult === 'INCORRECT' ? T.red : T.textDim) + '18',
                        borderRadius: RADIUS.sm, paddingHorizontal: 8, paddingVertical: 4, alignSelf: 'flex-start'
                      }}>
                        <Text style={{ color: t.predictionResult === 'CORRECT' ? T.green : t.predictionResult === 'INCORRECT' ? T.red : T.textDim, fontSize: 11, fontWeight: '800' }}>
                          {t.predictionResult === 'CORRECT' ? '✅ Correct' : t.predictionResult === 'INCORRECT' ? '❌ Incorrect' : '➖ Neutral'}
                        </Text>
                      </View>
                      <Text style={{ color: T.textDim, fontSize: 9, marginTop: 3, lineHeight: 13 }}>
                        Did price move {t.direction === 'LONG' ? 'up' : 'down'} from entry to exit?
                      </Text>
                    </View>

                    <View style={{ width: 12 }} />

                    {/* TRADE MANAGEMENT: how was the trade closed? */}
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', letterSpacing: 1, marginBottom: 3 }}>TRADE MANAGEMENT</Text>
                      {(() => {
                        const mgmt = (t as any).tradeManagementOutcome ?? null;
                        const label = mgmt ? managementOutcomeLabel(mgmt)
                          : t.exitReason === 'STOP_LOSS' ? '🛑 Stop Loss'
                          : t.exitReason === 'TAKE_PROFIT' ? '✅ Take Profit'
                          : t.exitReason === 'MANUAL_EXIT' || t.exitReason === 'MANUAL_CLOSE' ? '🤚 Manual Close'
                          : t.exitReason === 'TIME_EXIT' ? '⏱ Time Exit'
                          : '🤖 AI Exit';
                        const col = t.exitReason === 'STOP_LOSS' ? T.red
                          : t.exitReason === 'TAKE_PROFIT' ? T.green : T.textDim;
                        return (
                          <View style={{ backgroundColor: col + '18', borderRadius: RADIUS.sm, paddingHorizontal: 8, paddingVertical: 4, alignSelf: 'flex-start' }}>
                            <Text style={{ color: col, fontSize: 11, fontWeight: '800' }}>{label}</Text>
                          </View>
                        );
                      })()}
                      <Text style={{ color: T.textDim, fontSize: 9, marginTop: 3, lineHeight: 13 }}>
                        How the position was closed.
                      </Text>
                    </View>
                  </View>

                  {/* Financial result */}
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
                    <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', letterSpacing: 1 }}>FINANCIAL RESULT</Text>
                    <View style={{ backgroundColor: (t.pnl > 0 ? T.green : T.red) + '18', borderRadius: RADIUS.sm, paddingHorizontal: 8, paddingVertical: 3 }}>
                      <Text style={{ color: t.pnl > 0 ? T.green : T.red, fontSize: 11, fontWeight: '800' }}>
                        {t.pnl > 0 ? '🟢 Profit' : t.pnl < 0 ? '🔴 Loss' : '➖ Breakeven'}
                      </Text>
                    </View>
                  </View>
                  <Text style={{ color: T.textDim, fontSize: 9, marginTop: 4, lineHeight: 13 }}>
                    Gross P&L minus Total Fees = Net P&L. Slippage is built into the entry/exit prices (not a separate deduction).
                  </Text>
                </View>
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
                <Row label="Model Confidence at Entry" value={`${t.aiConfidence.toFixed(0)}/100`} T={T} />
                {t.tradeQuality && <Row label="Trade Quality" value={`${formatTradeQualityScore(t.tradeQuality.score)}/100 ${t.tradeQuality.stars} ${t.tradeQuality.grade}`} color={T.accent} T={T} />}
                <Row label="Model Version" value={`v${t.modelVersion}`} T={T} />
                <Row label="Prediction Horizon" value={`${t.predictionHorizon}-bar`} T={T} />
                <Row label="Market Regime" value={t.marketRegime} T={T} />
                {/* Historical market context at entry — frozen snapshot, never recomputed */}
                <MarketContextCard snapshot={(t as any).marketContext ?? null} T={T} compact />
                <Row label="Entry Reason" value={t.entryReason} T={T} multiline />
                {/* Signal snapshot — shows original AI verdict. Badge only on override trades. */}
                {(t as any).signalSnapshot && (() => {
                  const ss = (t as any).signalSnapshot;
                  if (!ss.overrideUsed) {
                    // Normal trade — show signal state and key AI values quietly
                    return (
                      <View>
                        <Row
                          label="AI Signal"
                          value={`${ss.originalState}${ss.signalType ? '  ·  ' + ss.signalType : ''}`}
                          T={T}
                        />
                        {ss.confidence != null && (
                          <Row label="Confidence at Entry" value={`${ss.confidence.toFixed(0)}/100`} T={T} />
                        )}
                        {ss.modelVersion != null && (
                          <Row label="Model Version" value={`v${ss.modelVersion}`} T={T} />
                        )}
                      </View>
                    );
                  }
                  // Override trade — show prominent banner with full detail
                  return (
                    <View style={{ backgroundColor: '#f97316' + '14', borderRadius: 6, padding: 8, marginTop: 4, borderWidth: 1, borderColor: '#f97316' + '40' }}>
                      <Text style={{ color: '#f97316', fontSize: 9, fontWeight: '800', letterSpacing: 0.8, marginBottom: 4 }}>
                        ⚡ OVERRIDE TRADE
                      </Text>
                      <Row label="Original Verdict"    value={ss.originalState}   T={T} />
                      <Row label="Block Reason"        value={ss.blockReason}     T={T} multiline />
                      {ss.blockSource       && <Row label="Blocked By"        value={ss.blockSource.replace(/_/g, ' ')}  T={T} />}
                      {ss.signalType        && <Row label="Signal Type"       value={ss.signalType}                      T={T} />}
                      {ss.mtfReadinessState && <Row label="MTF State"         value={ss.mtfReadinessState}               T={T} />}
                      {ss.confidence != null && <Row label="Confidence"       value={`${ss.confidence.toFixed(0)}/100`}  T={T} />}
                      {ss.modelVersion != null && <Row label="Model Version"  value={`v${ss.modelVersion}`}              T={T} />}
                      {ss.regimeLabel       && <Row label="Regime at Entry"   value={ss.regimeLabel.replace(/_/g, ' ')}  T={T} />}
                    </View>
                  );
                })()}
                <Text style={{ color: T.textDim, fontSize: 9, marginTop: 8, marginBottom: 4 }}>TOP FEATURES AT ENTRY</Text>
                {t.topFeatures.slice(0, 3).map(f => <Text key={f.name} style={{ color: T.textSub, fontSize: 9 }}>{f.name}: {f.value.toFixed(4)}</Text>)}
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                  <TouchableOpacity
                    onPress={() => navigation.navigate('Chart', {
                      symbol: t.symbol,
                      initialTf: t.timeframe,
                      reviewTrade: t,
                    })}
                    activeOpacity={0.8}
                    style={{ flex: 1, backgroundColor: T.blue, paddingVertical: 12, borderRadius: RADIUS.sm, alignItems: 'center', minHeight: 44, justifyContent: 'center' }}
                  >
                    <Text style={{ color: '#fff', fontSize: 11, fontWeight: '700' }}>📊 Review on Chart</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => navigation.navigate('PaperReplay', { trade: t })}
                    activeOpacity={0.8}
                    style={{ flex: 1, backgroundColor: T.purple, paddingVertical: 12, borderRadius: RADIUS.sm, alignItems: 'center', minHeight: 44, justifyContent: 'center' }}
                  >
                    <Text style={{ color: '#fff', fontSize: 11, fontWeight: '700' }}>▶ Replay</Text>
                  </TouchableOpacity>
                </View>
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
