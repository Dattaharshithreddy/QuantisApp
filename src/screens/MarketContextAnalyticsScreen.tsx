// ─────────────────────────────────────────────────────────────────────────────
// MarketContextAnalyticsScreen  (v1.0.0)
//
// Displays market context performance analytics computed from closed paper
// trades. Purely read-only — zero ML impact, zero prediction changes.
//
// Sections:
//   Crypto  → Fear & Greed | Funding Rate | BTC Dominance
//   Indian  → India VIX | Market Breadth
//   Both    → Overall Market Sentiment
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { Card, SectionLabel } from '../components/Common';
import {
  computeMarketContextAnalytics,
  MarketContextAnalyticsReport,
  ContextBucket,
} from '../utils/marketContextAnalytics';

// ── Metric row ────────────────────────────────────────────────────────────────
function MetricRow({ label, value, color, T }: { label: string; value: string; color?: string; T: any }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2.5, borderBottomWidth: 0.5, borderBottomColor: T.border + '40' }}>
      <Text style={{ color: T.textDim, fontSize: 10 }}>{label}</Text>
      <Text style={{ color: color ?? T.text, fontSize: 10, fontWeight: '700' }}>{value}</Text>
    </View>
  );
}

// ── Single context bucket card ─────────────────────────────────────────────────
function BucketCard({ bucket, T, highlight }: { bucket: ContextBucket; T: any; highlight?: boolean }) {
  if (bucket.trades === 0) return (
    <View style={{ backgroundColor: T.bg3, borderRadius: 8, padding: 10, marginBottom: 6, opacity: 0.5 }}>
      <Text style={{ color: T.textDim, fontSize: 10, fontWeight: '700' }}>{bucket.label}</Text>
      <Text style={{ color: T.textDim, fontSize: 9, marginTop: 2 }}>No trades in this condition</Text>
    </View>
  );
  const winColor = bucket.winRate >= 55 ? T.green : bucket.winRate >= 45 ? T.textSub : T.red;
  const pfColor  = bucket.profitFactor > 1.5 ? T.green : bucket.profitFactor >= 1 ? T.textSub : T.red;
  const borderColor = highlight ? T.green : T.border;
  return (
    <View style={{ backgroundColor: T.bg3, borderRadius: 8, padding: 10, marginBottom: 6, borderWidth: highlight ? 1.5 : 0.5, borderColor }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <Text style={{ color: highlight ? T.green : T.text, fontSize: 11, fontWeight: '700' }}>
          {highlight ? '★ ' : ''}{bucket.label}
        </Text>
        <Text style={{ color: T.textDim, fontSize: 9 }}>{bucket.trades} trade{bucket.trades !== 1 ? 's' : ''}</Text>
      </View>
      <MetricRow label="Win Rate"      value={`${bucket.winRate.toFixed(1)}%`}      color={winColor} T={T} />
      <MetricRow label="Profit Factor" value={bucket.profitFactor === Infinity ? '∞' : bucket.profitFactor.toFixed(2)} color={pfColor} T={T} />
      <MetricRow label="Avg P&L"       value={`${bucket.avgPnlPct >= 0 ? '+' : ''}${bucket.avgPnlPct.toFixed(2)}%`}
        color={bucket.avgPnlPct >= 0 ? T.green : T.red} T={T} />
      <MetricRow label="Expectancy"    value={`${bucket.expectancy >= 0 ? '+' : ''}${bucket.expectancy.toFixed(2)}%`}
        color={bucket.expectancy >= 0 ? T.green : T.red} T={T} />
    </View>
  );
}

// ── Bucket group section ───────────────────────────────────────────────────────
function BucketSection({
  title, subtitle, buckets, T,
}: {
  title: string; subtitle?: string; buckets: ContextBucket[]; T: any;
}) {
  const [expanded, setExpanded] = useState(true);
  // Highlight the best bucket (highest score of winRate+profitFactor, minimum 5 trades)
  const eligible = buckets.filter(b => b.trades >= 5);
  const bestLabel = eligible.length
    ? eligible.reduce((best, b) => {
        const score = (b.winRate / 100) + Math.min(b.profitFactor === Infinity ? 5 : b.profitFactor, 5);
        const bScore = (best.winRate / 100) + Math.min(best.profitFactor === Infinity ? 5 : best.profitFactor, 5);
        return score > bScore ? b : best;
      }).label
    : null;

  return (
    <View style={{ marginBottom: 16 }}>
      <TouchableOpacity onPress={() => setExpanded(!expanded)}
        style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <View>
          <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', letterSpacing: 0.8 }}>{title}</Text>
          {subtitle ? <Text style={{ color: T.textDim, fontSize: 8, marginTop: 1 }}>{subtitle}</Text> : null}
        </View>
        <Text style={{ color: T.accent, fontSize: 9 }}>{expanded ? '▲ Collapse' : '▼ Expand'}</Text>
      </TouchableOpacity>
      {expanded && buckets.map(b => (
        <BucketCard key={b.label} bucket={b} T={T} highlight={b.label === bestLabel} />
      ))}
    </View>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function MarketContextAnalyticsScreen() {
  const { theme: T } = useTheme();
  const [report, setReport] = useState<MarketContextAnalyticsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await computeMarketContextAnalytics();
      setReport(r);
    } catch (e: any) {
      setError(e.message ?? 'Failed to compute analytics');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  if (loading) return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0, justifyContent: 'center', alignItems: 'center' }}>
      <ActivityIndicator color={T.accent} size="large" />
      <Text style={{ color: T.textDim, marginTop: 12, fontSize: 11 }}>Computing context analytics…</Text>
    </SafeAreaView>
  );

  if (error) return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0, padding: 20 }}>
      <Text style={{ color: T.red, fontSize: 13 }}>{error}</Text>
      <TouchableOpacity onPress={loadData} style={{ marginTop: 16 }}>
        <Text style={{ color: T.accent, fontSize: 12 }}>Retry</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );

  if (!report) return null;

  const { totalTrades, tradesWithContext, cryptoTrades, indianTrades } = report;
  const coveragePct = totalTrades > 0 ? ((tradesWithContext / totalTrades) * 100).toFixed(0) : '0';

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        <Text style={{ color: T.text, fontSize: 22, fontWeight: '800', marginBottom: 2 }}>Context Analytics</Text>
        <Text style={{ color: T.textDim, fontSize: 11, marginBottom: 16, lineHeight: 16 }}>
          Performance bucketed by market conditions at entry. Based on {tradesWithContext} of {totalTrades} trades with context ({coveragePct}% coverage).
        </Text>

        {tradesWithContext === 0 && (
          <Card theme={T}>
            <Text style={{ color: T.textDim, fontSize: 12, textAlign: 'center', paddingVertical: 20 }}>
              No trades with market context yet.{'\n'}Context is captured automatically on new paper trades.
            </Text>
          </Card>
        )}

        {/* ── Overall Sentiment (both asset types) ── */}
        {tradesWithContext > 0 && (
          <Card theme={T} style={{ marginBottom: 14 }}>
            <SectionLabel theme={T}>OVERALL MARKET SENTIMENT</SectionLabel>
            <BucketSection
              title="PERFORMANCE BY MARKET SENTIMENT"
              subtitle="All assets — bullish / neutral / bearish at entry"
              buckets={[report.sentiment.bullish, report.sentiment.neutral, report.sentiment.bearish, report.sentiment.unavailable]}
              T={T}
            />
          </Card>
        )}

        {/* ── Crypto analytics ── */}
        {cryptoTrades > 0 && (
          <Card theme={T} style={{ marginBottom: 14 }}>
            <SectionLabel theme={T}>₿ CRYPTO MARKET CONDITIONS</SectionLabel>
            <Text style={{ color: T.textDim, fontSize: 9, marginBottom: 12 }}>
              {cryptoTrades} crypto trades with context
            </Text>

            {report.fearGreed && (
              <BucketSection
                title="WIN RATE BY FEAR & GREED"
                subtitle="Does entry sentiment predict outcomes?"
                buckets={[
                  report.fearGreed.extremeFear,
                  report.fearGreed.fear,
                  report.fearGreed.neutral,
                  report.fearGreed.greed,
                  report.fearGreed.extremeGreed,
                ]}
                T={T}
              />
            )}

            {report.funding && (
              <BucketSection
                title="PROFIT FACTOR BY FUNDING RATE"
                subtitle="How overheated futures positioning affects trade quality"
                buckets={[
                  report.funding.extremeShort,
                  report.funding.shortBiased,
                  report.funding.neutral,
                  report.funding.longBiased,
                  report.funding.extremeLong,
                ]}
                T={T}
              />
            )}

            {report.btcDominance && (
              <BucketSection
                title="PERFORMANCE BY BTC DOMINANCE"
                subtitle="Alt season vs BTC season trade quality"
                buckets={[
                  report.btcDominance.altSeason,
                  report.btcDominance.balanced,
                  report.btcDominance.btcLead,
                  report.btcDominance.btcDominant,
                ]}
                T={T}
              />
            )}
          </Card>
        )}

        {/* ── Indian analytics ── */}
        {indianTrades > 0 && (
          <Card theme={T} style={{ marginBottom: 14 }}>
            <SectionLabel theme={T}>🇮🇳 INDIAN MARKET CONDITIONS</SectionLabel>
            <Text style={{ color: T.textDim, fontSize: 9, marginBottom: 12 }}>
              {indianTrades} Indian equity trades with context
            </Text>

            {report.vix && (
              <BucketSection
                title="WIN RATE BY INDIA VIX RANGE"
                subtitle="Does volatility regime affect trade outcomes?"
                buckets={[
                  report.vix.low,
                  report.vix.normal,
                  report.vix.high,
                  report.vix.extreme,
                ]}
                T={T}
              />
            )}

            {report.breadth && (
              <BucketSection
                title="PERFORMANCE BY MARKET BREADTH"
                subtitle="Advance/Decline trend at entry"
                buckets={[
                  report.breadth.bullish,
                  report.breadth.neutral,
                  report.breadth.bearish,
                ]}
                T={T}
              />
            )}
          </Card>
        )}

        <TouchableOpacity onPress={loadData}
          style={{ backgroundColor: T.bg3, borderRadius: 8, padding: 12, alignItems: 'center', marginTop: 4 }}>
          <Text style={{ color: T.textDim, fontSize: 11 }}>↻ Refresh</Text>
        </TouchableOpacity>

        <Text style={{ color: T.textDim, fontSize: 9, textAlign: 'center', marginTop: 10, lineHeight: 13 }}>
          Generated from closed paper trades only.{'\n'}
          Context data is the frozen snapshot from when each trade was opened.{'\n'}
          Last updated: {new Date(report.generatedAt).toLocaleTimeString()}
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}
