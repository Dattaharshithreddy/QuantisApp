// ─────────────────────────────────────────────────────────────────────────────
// TradingCoachScreen  (v1.0.0)
//
// Personalised trading coach powered by real trade history.
// Shows structured insight cards (no API needed) + optional AI narrative
// (requires Anthropic key). Every insight shows its sample size so the
// user knows how much data it's based on.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity,
         ActivityIndicator, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import {
  computeCoachInsights, getCoachNarrative, getFuturesCoachSummary,
  CoachReport, CoachInsight, InsightSentiment, FuturesCoachSummary,
} from '../utils/tradingCoach';
import { SPACING, RADIUS } from '../theme/colors';
import { OnboardingTooltip } from '../components/OnboardingTooltip';
import { TOOLTIP_IDS } from '../utils/onboarding';

// ── Helpers ───────────────────────────────────────────────────────────────────
function sentimentColor(s: InsightSentiment, T: any): string {
  switch (s) {
    case 'positive': return T.green;
    case 'negative': return T.red;
    case 'warning':  return T.amber;
    default:         return T.textSub ?? T.textDim;
  }
}

function sentimentIcon(s: InsightSentiment): string {
  switch (s) {
    case 'positive': return '▲';
    case 'negative': return '▼';
    case 'warning':  return '⚠';
    default:         return '◆';
  }
}

function categoryLabel(c: string): string {
  const map: Record<string, string> = {
    OVERRIDE: 'Override Behaviour', CONFIDENCE: 'Confidence Calibration',
    REGIME: 'Market Regime', STRATEGY: 'Strategy Profile',
    DIRECTION: 'Direction Bias', TIMING: 'Exit Timing',
    SIGNAL_TYPE: 'Signal Type', MODEL_VERSION: 'Model Version',
    EXITS: 'Exit Patterns', GENERAL: 'Overall',
  };
  return map[c] ?? c;
}

function gradeColor(grade: string, T: any): string {
  if (grade === 'A+' || grade === 'A') return T.green;
  if (grade === 'B')                   return T.accent;
  if (grade === 'C')                   return T.amber;
  return T.red;
}

// ── Insight Card ──────────────────────────────────────────────────────────────
function InsightCard({ insight, T }: { insight: CoachInsight; T: any }) {
  const color = sentimentColor(insight.sentiment, T);
  return (
    <View style={{ backgroundColor: T.card, borderRadius: 10, padding: 14,
      marginBottom: 10, borderWidth: 1, borderColor: T.border,
      borderLeftWidth: 3, borderLeftColor: color }}>
      {/* Category tag */}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between',
        alignItems: 'center', marginBottom: 6 }}>
        <View style={{ backgroundColor: color + '15', borderRadius: 4,
          paddingHorizontal: 7, paddingVertical: 3 }}>
          <Text style={{ color, fontSize: 8, fontWeight: '800' }}>
            {sentimentIcon(insight.sentiment)} {categoryLabel(insight.category)}
          </Text>
        </View>
        <Text style={{ color: T.textDim, fontSize: 8 }}>
          {insight.sampleSize} trades
        </Text>
      </View>
      {/* Headline */}
      <Text style={{ color: T.text, fontSize: 13, fontWeight: '700',
        lineHeight: 18, marginBottom: 6 }}>
        {insight.headline}
      </Text>
      {/* Detail */}
      <Text style={{ color: T.textDim, fontSize: 11, lineHeight: 16,
        marginBottom: 8 }}>
        {insight.detail}
      </Text>
      {/* Evidence */}
      <View style={{ backgroundColor: T.bg3, borderRadius: 6, padding: 8 }}>
        <Text style={{ color: T.textDim, fontSize: 9, fontFamily: 'monospace',
          lineHeight: 14 }}>
          {insight.evidence}
        </Text>
      </View>
    </View>
  );
}

// ── Main Screen ───────────────────────────────────────────────────────────────
export default function TradingCoachScreen() {
  const { theme: T } = useTheme();
  const [report,    setReport]    = useState<CoachReport | null>(null);
  const [narrative, setNarrative] = useState<string>('');
  const [loading,   setLoading]   = useState(true);
  const [generating,  setGenerating]  = useState(false);
  const [futuresSummary, setFuturesSummary] = useState<FuturesCoachSummary | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [r, fs] = await Promise.all([
        computeCoachInsights(),
        getFuturesCoachSummary(),
      ]);
      setReport(r);
      setFuturesSummary(fs);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function generateNarrative() {
    if (!report || !report.hasSufficientData) return;
    setGenerating(true);
    try {
      const text = await getCoachNarrative(report);
      setNarrative(text);
    } catch (e: any) {
      Alert.alert('Coach Narrative', e.message);
    } finally { setGenerating(false); }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      <ScrollView contentContainerStyle={{ padding: SPACING.md, paddingBottom: 50 }}
>

        <OnboardingTooltip id={TOOLTIP_IDS.TRADING_COACH} T={T}
          title="AI Trading Coach"
          body="The coach analyses your trade history and tells you where you lose money. It unlocks after 10 completed trades. Every insight is based on your real data.">
          <View />
        </OnboardingTooltip>
        <Text style={{ color: T.text, fontSize: 22, fontWeight: '800', marginBottom: 4 }}>
          AI Trading Coach
        </Text>
        <Text style={{ color: T.textDim, fontSize: 11, marginBottom: 20, lineHeight: 16 }}>
          Personalised insights from your completed trade history.{'\n'}
          Every finding is based on your actual data — no generic advice.{'\n'}
          Also analyses override decisions and signals blocked by the AI.
        </Text>

        {loading && <ActivityIndicator color={T.accent} style={{ marginTop: 40 }} />}

        {!loading && report && !report.hasSufficientData && (
          <View style={{ backgroundColor: T.card, borderRadius: 12, padding: 20,
            borderWidth: 1, borderColor: T.border, alignItems: 'center' }}>
            <Text style={{ fontSize: 40, marginBottom: 12 }}>📊</Text>
            <Text style={{ color: T.text, fontSize: 16, fontWeight: '700',
              textAlign: 'center', marginBottom: 8 }}>
              Building your profile…
            </Text>
            <Text style={{ color: T.textDim, fontSize: 12, textAlign: 'center',
              lineHeight: 18 }}>
              {report.insufficientReason}
            </Text>
            <View style={{ backgroundColor: T.accent + '20', borderRadius: 20,
              paddingHorizontal: 14, paddingVertical: 6, marginTop: 14 }}>
              <Text style={{ color: T.accent, fontSize: 11, fontWeight: '700' }}>
                {report.totalTrades} / 10 trades completed
              </Text>
            </View>
            {/* Shadow Journal cross-reference */}
            <View style={{ marginTop: 18, backgroundColor: T.bg3, borderRadius: 8,
              padding: 12, width: '100%' }}>
              <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '800',
                letterSpacing: 0.8, marginBottom: 5 }}>💡 WHILE YOU WAIT</Text>
              <Text style={{ color: T.textDim, fontSize: 11, lineHeight: 17 }}>
                The <Text style={{ color: T.accent, fontWeight: '700' }}>Shadow Journal</Text> is already tracking every trade the AI has blocked. Once you complete 10 paper trades, the Coach will analyse both your executed trades and your override decisions together.
              </Text>
            </View>
          </View>
        )}

        {!loading && report && report.hasSufficientData && (
          <>
            {/* Grade card */}
            <View style={{ backgroundColor: T.card, borderRadius: 12, padding: 16,
              borderWidth: 1, borderColor: T.border, marginBottom: 16,
              flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <View>
                <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700',
                  letterSpacing: 1, marginBottom: 4 }}>OVERALL GRADE</Text>
                <Text style={{ color: T.text, fontSize: 13, lineHeight: 18 }}>
                  {report.oneLiner}
                </Text>
                <Text style={{ color: T.textDim, fontSize: 9, marginTop: 4 }}>
                  Based on {report.totalTrades} trades
                </Text>
              </View>
              <View style={{ backgroundColor: gradeColor(report.overallGrade, T) + '20',
                borderRadius: 10, width: 56, height: 56, justifyContent: 'center',
                alignItems: 'center', borderWidth: 2,
                borderColor: gradeColor(report.overallGrade, T) }}>
                <Text style={{ color: gradeColor(report.overallGrade, T),
                  fontSize: 22, fontWeight: '800' }}>
                  {report.overallGrade}
                </Text>
              </View>
            </View>


            {/* Futures accounts summary */}
            {futuresSummary && (futuresSummary.nse.realizedPnL !== 0 || futuresSummary.bn.realizedPnL !== 0 || futuresSummary.nse.openPositions > 0 || futuresSummary.bn.openPositions > 0) && (
              <View style={{ backgroundColor: T.card, borderRadius: 10, padding: 14,
                borderWidth: 1, borderColor: T.border, marginBottom: 16 }}>
                <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700',
                  letterSpacing: 0.8, marginBottom: 10 }}>FUTURES ACCOUNTS</Text>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <View style={{ flex: 1, marginRight: 8 }}>
                    <Text style={{ color: T.textDim, fontSize: 9, marginBottom: 4 }}>🇮🇳 NSE F&O</Text>
                    <Text style={{ color: futuresSummary.nse.returnPct >= 0 ? T.green : T.red,
                      fontSize: 14, fontWeight: '800' }}>
                      {futuresSummary.nse.returnPct >= 0 ? '+' : ''}{futuresSummary.nse.returnPct.toFixed(1)}%
                    </Text>
                    <Text style={{ color: T.textDim, fontSize: 9, marginTop: 1 }}>
                      ₹{futuresSummary.nse.cashBalance.toFixed(0)} balance · {futuresSummary.nse.openPositions} open
                    </Text>
                  </View>
                  <View style={{ width: 1, backgroundColor: T.border }} />
                  <View style={{ flex: 1, marginLeft: 8 }}>
                    <Text style={{ color: T.textDim, fontSize: 9, marginBottom: 4 }}>₿ Crypto Perps</Text>
                    <Text style={{ color: futuresSummary.bn.returnPct >= 0 ? T.green : T.red,
                      fontSize: 14, fontWeight: '800' }}>
                      {futuresSummary.bn.returnPct >= 0 ? '+' : ''}{futuresSummary.bn.returnPct.toFixed(1)}%
                    </Text>
                    <Text style={{ color: T.textDim, fontSize: 9, marginTop: 1 }}>
                      ${futuresSummary.bn.usdtBalance.toFixed(0)} balance · {futuresSummary.bn.openPositions} open
                    </Text>
                  </View>
                </View>
              </View>
            )}

            {/* AI Narrative section */}
            <View style={{ backgroundColor: T.card, borderRadius: 10, padding: 14,
              borderWidth: 1, borderColor: T.border, marginBottom: 16 }}>
              <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700',
                letterSpacing: 0.8, marginBottom: 8 }}>AI COACHING NARRATIVE</Text>
              {narrative ? (
                <Text style={{ color: T.text, fontSize: 12, lineHeight: 20 }}>
                  {narrative}
                </Text>
              ) : (
                <Text style={{ color: T.textDim, fontSize: 11, marginBottom: 10, lineHeight: 16 }}>
                  Get a personalised written coaching session based on your insights.
                  Requires your Anthropic API key (set in Settings).
                </Text>
              )}
              <TouchableOpacity onPress={generateNarrative} disabled={generating}
                style={{ backgroundColor: T.accent + (generating ? '60' : 'ff'),
                  borderRadius: RADIUS.sm, padding: 10, alignItems: 'center',
                  marginTop: narrative ? 10 : 0 }}>
                {generating
                  ? <ActivityIndicator color="#fff" size="small" />
                  : <Text style={{ color: '#fff', fontWeight: '700', fontSize: 11 }}>
                      {narrative ? '↺ Regenerate' : '✦ Generate AI Narrative'}
                    </Text>
                }
              </TouchableOpacity>
            </View>

            {/* Insights */}
            <Text style={{ color: T.textDim, fontSize: 10, fontWeight: '700',
              letterSpacing: 0.8, marginBottom: 10 }}>
              INSIGHTS ({report.insights.length}) — ranked by impact
            </Text>
            {report.insights.map(insight => (
              <InsightCard key={insight.id} insight={insight} T={T} />
            ))}

            {report.insights.length === 0 && (
              <View style={{ alignItems: 'center', paddingVertical: 20 }}>
                <Text style={{ color: T.textDim, fontSize: 12 }}>
                  No significant patterns detected yet.
                </Text>
                <Text style={{ color: T.textDim, fontSize: 11, marginTop: 4 }}>
                  Keep trading — more data produces more insights.
                </Text>
              </View>
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
